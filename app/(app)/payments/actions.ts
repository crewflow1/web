"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { parseBankCsv, scoreInvoiceMatch } from "@/lib/payments/schema";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

const uuid = z.string().uuid();

/**
 * Bank statement + reconciliation actions.
 *
 * These return `FormState` (the client navigates via `redirectTo` through
 * <StateForm>, a full document load) instead of calling `redirect()`. A
 * Server-Action redirect on the reconcile page swaps the route tree at depth 5
 * and this file revalidated up to three paths per action — the exact
 * weight/depth class measured losing 60-100% of navigations to the Next 15.5
 * stranded-commit race under `next start` (rows written, URL frozen, no error
 * anywhere; upstream vercel/next.js#83386). See components/forms/StateForm.tsx
 * and the fleet fix (8e4a846).
 *
 * No revalidatePath, deliberately: every payments surface renders per-request
 * (cookie-authed reads, no Next data cache), so the post-navigation document
 * load is always fresh — revalidation only added weight to the racy response.
 */

/**
 * Upload a CSV bank statement.
 *
 * On submit:
 *   1. Parse CSV → rows
 *   2. Insert bank_statements + bank_statement_lines
 *   3. For each incoming line (amount > 0), score against unpaid invoices
 *      in the org. If a single invoice scores >= 70, write a 'suggested'
 *      match. Otherwise leave 'unmatched'.
 *   4. Navigate to /payments/reconcile/[statementId]
 */
export async function uploadBankCsv(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  // Permission: admins-only — bank statements are sensitive. Role comes from
  // ctx (the caller's own membership in the ACTIVE org); an unfiltered
  // memberships read would return every member's row and `.single()` would
  // error in any org with ≥2 members, locking everyone out.
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect("/payments?error=forbidden");
  }

  const file = formData.get("file") as File | null;
  if (!file || !(file instanceof File) || file.size === 0) {
    return formError("Choose a CSV file to upload.");
  }
  if (file.size > 5 * 1024 * 1024) {
    return formError("That file is too large — 5 MB at most.");
  }
  const text = await file.text();

  let rows: ReturnType<typeof parseBankCsv>;
  try {
    rows = parseBankCsv(text);
  } catch (err) {
    return formError(err instanceof Error ? err.message : "CSV parse failed");
  }
  if (rows.length === 0) {
    return formError("No usable rows found in that CSV.");
  }

  // 1. Create the statement row.
  const { data: stmt, error: stmtErr } = await supabase
    .from("bank_statements")
    .insert({
      org_id: ctx.org.id,
      filename: file.name,
      uploaded_by: user.id,
      line_count: rows.length,
      matched_count: 0,
    })
    .select("id")
    .single();
  if (stmtErr || !stmt) {
    console.error("[payments] statement insert failed", stmtErr);
    return formError("Upload failed — try again.");
  }

  // 2. Pull unpaid invoices for scoring (RLS scopes to org).
  const { data: invoices } = await supabase
    .from("invoices")
    .select(
      `
        id, number, total, sent_at, status,
        quote:quotes ( customer:customers ( name ) )
      `,
    )
    .in("status", ["sent", "awaiting_payment", "partially_paid", "overdue"]);

  type ScoredInv = {
    id: string;
    number: string;
    total: number;
    sent_at: string | null;
    customer_name: string | null;
  };
  const scored: ScoredInv[] = (invoices ?? []).map((inv) => ({
    id: inv.id,
    number: inv.number,
    total: Number(inv.total ?? 0),
    sent_at: inv.sent_at,
    customer_name: inv.quote?.customer?.name ?? null,
  }));

  // 3. Insert bank lines + best-match suggestion in one batch.
  const linesToInsert = rows.map((r) => {
    let bestId: string | null = null;
    let bestScore = 0;
    if (r.amount > 0) {
      for (const inv of scored) {
        const score = scoreInvoiceMatch(r, inv);
        if (score > bestScore) {
          bestScore = score;
          bestId = inv.id;
        }
      }
    }
    return {
      org_id: ctx.org.id,
      bank_statement_id: stmt.id,
      posted_at: r.posted_at,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
      matched_invoice_id: bestScore >= 70 ? bestId : null,
      match_confidence: bestScore > 0 ? bestScore : null,
      match_status: bestScore >= 70 ? "suggested" : "unmatched",
    };
  });

  const { error: linesErr } = await supabase
    .from("bank_statement_lines")
    .insert(linesToInsert);
  if (linesErr) {
    console.error("[payments] lines insert failed", linesErr);
    return formSuccess({ redirectTo: `/payments/reconcile/${stmt.id}?error=lines_failed` });
  }

  return formSuccess({ redirectTo: `/payments/reconcile/${stmt.id}?saved=uploaded` });
}

export async function confirmBankMatch(
  bankLineId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  if (!uuid.safeParse(bankLineId).success) return formError("That line link looks wrong — reload and try again.");

  const targetInvoiceId = String(formData.get("invoice_id") ?? "");
  if (!uuid.safeParse(targetInvoiceId).success) {
    return formError("Pick an invoice to match against.");
  }

  const supabase = await createClient();
  const { data: line } = await supabase
    .from("bank_statement_lines")
    .select("id, org_id, bank_statement_id, amount, posted_at, reference, description")
    .eq("id", bankLineId)
    .maybeSingle();
  if (!line) return formError("Bank line not found.");
  if (line.org_id !== ctx.org.id) return formError("Bank line not found.");
  if (line.amount <= 0) return formError("Only incoming payments can be matched to invoices.");

  // SECURITY: `invoice_id` arrives from the form and was previously trusted.
  // The bank line above is org-checked; the invoice was not, and nothing
  // downstream re-checks it:
  //   - invoice_payments' INSERT policy is `with check (is_org_member(org_id))`
  //     (20260524000000_payment_tracking.sql) — it constrains only the org_id
  //     column we set ourselves, never invoice_id, so an insert naming another
  //     org's invoice satisfies it;
  //   - _tg_invoice_payments_sync_status is SECURITY DEFINER
  //     (20260618000000_fix_invoice_payments_sync_trigger.sql), so it then reads
  //     and updates that invoice with RLS bypassed.
  // A crafted invoice_id therefore recorded a payment against ANOTHER org's
  // invoice and moved its status. Resolve the invoice through the RLS client
  // (invoices are select-scoped to the caller's orgs) and re-check org_id —
  // mirroring the bank-line checks above, and matching addInvoicePayment, which
  // already resolves its invoice this way. Fails closed.
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, org_id")
    .eq("id", targetInvoiceId)
    .maybeSingle();
  if (!inv) return formError("Invoice not found.");
  if (inv.org_id !== ctx.org.id) return formError("Invoice not found.");

  // Insert payment + link the line in one round trip (the trigger
  // auto-derives invoice status).
  const { data: payment, error: payErr } = await supabase
    .from("invoice_payments")
    .insert({
      org_id: ctx.org.id,
      invoice_id: targetInvoiceId,
      amount: line.amount,
      paid_at: line.posted_at,
      reference: line.reference ?? null,
      notes: line.description ?? null,
      source: "bank_csv",
      bank_line_id: line.id,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (payErr || !payment) {
    console.error("[payments] match payment insert failed", payErr);
    return formError("Couldn't record the payment — try again.");
  }

  const { error: updErr } = await supabase
    .from("bank_statement_lines")
    .update({
      matched_invoice_id: targetInvoiceId,
      matched_payment_id: payment.id,
      match_status: "confirmed",
    })
    .eq("id", line.id);
  if (updErr) {
    console.error("[payments] line update failed", updErr);
    // Payment is recorded — don't unwind, but flag.
    return formSuccess({
      redirectTo: `/payments/reconcile/${line.bank_statement_id}?error=match_partially_failed`,
    });
  }

  // Recompute matched_count from the lines table — single source of truth.
  const { count: confirmedCount } = await supabase
    .from("bank_statement_lines")
    .select("id", { count: "exact", head: true })
    .eq("bank_statement_id", line.bank_statement_id)
    .eq("match_status", "confirmed");
  if (typeof confirmedCount === "number") {
    await supabase
      .from("bank_statements")
      .update({ matched_count: confirmedCount })
      .eq("id", line.bank_statement_id);
  }

  return formSuccess({ redirectTo: `/payments/reconcile/${line.bank_statement_id}?saved=matched` });
}

export async function ignoreBankLine(
  bankLineId: string,
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!uuid.safeParse(bankLineId).success) return formError("That line link looks wrong — reload and try again.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("bank_statement_lines")
    .update({ match_status: "ignored" })
    .eq("id", bankLineId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[payments] ignore failed", error);
  }
  return formSuccess({ redirectTo: "/payments?saved=ignored" });
}

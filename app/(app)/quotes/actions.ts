"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { quoteFormSchema, type LineItem } from "@/lib/quotes/schema";
import { computeTotals } from "@/lib/quotes/totals";
import type { Database } from "@/lib/supabase/types";

/**
 * Quote CRUD + lifecycle server actions.
 *
 * Lifecycle:
 *   draft  (created)
 *     ↓ sendQuote()
 *   sent   (status updated; public_token allocated if not already)
 *     ↓ public view loaded (handled in /q/[token] page)
 *   viewed (viewed_at stamped)
 *     ↓ acceptQuote/declineQuote (public-portal or owner)
 *   accepted / declined
 *
 * Acceptance auto-creates an invoice via the existing invoices endpoint
 * pattern: copy amounts, allocate next_invoice_number, status=draft.
 */

type LineItemInsert = Database["public"]["Tables"]["quote_line_items"]["Insert"];

const idSchema = z.string().uuid();

function parseLineItemsJson(raw: FormDataEntryValue | null): LineItem[] {
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function parseForm(formData: FormData) {
  return quoteFormSchema.safeParse({
    customer_id: formData.get("customer_id") ?? "",
    property_id: formData.get("property_id") ?? "",
    lead_id: formData.get("lead_id") ?? "",
    valid_until: formData.get("valid_until") ?? "",
    notes: formData.get("notes") ?? "",
    terms: formData.get("terms") ?? "",
    line_items: parseLineItemsJson(formData.get("line_items")),
  });
}

export async function createQuote(formData: FormData) {
  const { user, ctx } = await requireOrgContext();
  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid quote";
    redirect(`/quotes/new?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();

  // Allocate next per-org quote number via SECURITY DEFINER RPC.
  const { data: numberRpc, error: numErr } = await supabase.rpc(
    "next_quote_number",
    { target_org: ctx.org.id },
  );
  if (numErr || !numberRpc) {
    console.error("[quotes] number allocation failed", numErr);
    redirect("/quotes/new?error=create_failed");
  }

  const totals = computeTotals(parsed.data.line_items);

  // Generate a public token now so the quote is shareable immediately
  // (we don't wait for send). crypto.randomUUID() is fine here — same
  // standard as the seed.
  const publicToken = crypto.randomUUID();

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .insert({
      org_id: ctx.org.id,
      customer_id: parsed.data.customer_id,
      property_id: parsed.data.property_id ?? null,
      lead_id: parsed.data.lead_id ?? null,
      number: numberRpc as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      total: totals.total,
      notes: parsed.data.notes ?? null,
      terms: parsed.data.terms ?? null,
      valid_until: parsed.data.valid_until ?? null,
      public_token: publicToken,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (qErr || !quote) {
    console.error("[quotes] insert failed", qErr);
    redirect("/quotes/new?error=create_failed");
  }

  // Insert line items.
  const rows: LineItemInsert[] = parsed.data.line_items.map((li, idx) => ({
    quote_id: quote.id,
    org_id: ctx.org.id,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  const { error: liErr } = await supabase.from("quote_line_items").insert(rows);
  if (liErr) {
    console.error("[quotes] line items insert failed", liErr);
    // Best-effort: leave the parent row so the user can re-add lines from edit.
    redirect(`/quotes/${quote.id}?error=line_items_failed`);
  }

  // Pipeline integration: if a lead was linked AND it's still in an
  // earlier stage, advance it to "quoted" so the kanban reflects reality.
  // Won/lost/job_booked are not overwritten.
  if (parsed.data.lead_id) {
    const { data: leadRow } = await supabase
      .from("leads")
      .select("status")
      .eq("id", parsed.data.lead_id)
      .maybeSingle();
    const stalled = leadRow?.status === "new" ||
      leadRow?.status === "contacted" ||
      leadRow?.status === "qualified";
    if (stalled) {
      await supabase
        .from("leads")
        .update({
          status: "quoted",
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", parsed.data.lead_id);
    }
  }

  revalidatePath("/quotes");
  revalidatePath("/leads");
  redirect(`/quotes/${quote.id}`);
}

export async function updateQuote(id: string, formData: FormData) {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/quotes");

  const parsed = parseForm(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid quote";
    redirect(`/quotes/${id}?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const totals = computeTotals(parsed.data.line_items);

  // Update parent row.
  const { error: qErr } = await supabase
    .from("quotes")
    .update({
      customer_id: parsed.data.customer_id,
      property_id: parsed.data.property_id ?? null,
      lead_id: parsed.data.lead_id ?? null,
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      total: totals.total,
      notes: parsed.data.notes ?? null,
      terms: parsed.data.terms ?? null,
      valid_until: parsed.data.valid_until ?? null,
    })
    .eq("id", id);
  if (qErr) {
    console.error("[quotes] update failed", qErr);
    redirect(`/quotes/${id}?error=update_failed`);
  }

  // Replace line items (delete + insert is simpler than diffing for v1).
  const { error: delErr } = await supabase
    .from("quote_line_items")
    .delete()
    .eq("quote_id", id);
  if (delErr) {
    console.error("[quotes] line items delete failed", delErr);
    redirect(`/quotes/${id}?error=update_failed`);
  }

  // Need org_id for the inserts; pull from the parent row.
  const { data: parent } = await supabase
    .from("quotes")
    .select("org_id")
    .eq("id", id)
    .single();
  if (!parent) redirect(`/quotes/${id}?error=update_failed`);

  const rows: LineItemInsert[] = parsed.data.line_items.map((li, idx) => ({
    quote_id: id,
    org_id: parent.org_id,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  const { error: insErr } = await supabase.from("quote_line_items").insert(rows);
  if (insErr) {
    console.error("[quotes] line items re-insert failed", insErr);
    redirect(`/quotes/${id}?error=update_failed`);
  }

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  redirect(`/quotes/${id}?saved=1`);
}

export async function sendQuote(id: string) {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/quotes");

  const supabase = await createClient();
  const { error } = await supabase
    .from("quotes")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[quotes] send failed", error);
    redirect(`/quotes/${id}?error=send_failed`);
  }
  revalidatePath(`/quotes/${id}`);
  redirect(`/quotes/${id}?saved=sent`);
}

export async function deleteQuote(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  // RLS on quotes inherits from the broader members policy: DELETE allowed
  // for any member (no admin gating on quotes table by default).
  // quote_line_items cascade-delete via FK ON DELETE CASCADE.
  const { error } = await supabase.from("quotes").delete().eq("id", id);
  if (error) {
    console.error("[quotes] delete failed", error);
    redirect(`/quotes/${id}?error=delete_failed`);
  }
  revalidatePath("/quotes");
  redirect("/quotes");
}

/**
 * Owner-side acceptance shortcut — handy for "client confirmed by phone"
 * cases. Same downstream behaviour as the public portal accept: stamps
 * accepted_at, status=accepted, then auto-creates an invoice from the
 * source quote.
 */
export async function acceptQuoteAsOwner(id: string, formData: FormData) {
  await requireOrgContext();
  const signerName = String(formData.get("signer_name") ?? "Owner accepted on customer's behalf");

  const supabase = await createClient();
  const now = new Date().toISOString();
  const { data: quote, error } = await supabase
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, source: "owner" },
    })
    .eq("id", id)
    .select("id, org_id, subtotal, vat_total")
    .single();

  if (error || !quote) {
    console.error("[quotes] accept failed", error);
    redirect(`/quotes/${id}?error=accept_failed`);
  }

  // Auto-create invoice using the next_invoice_number RPC (mirrors what
  // /api/invoices POST does — duplicated here so the owner gets one
  // round trip).
  const { data: invNumber, error: numErr } = await supabase.rpc(
    "next_invoice_number",
    { target_org: quote.org_id },
  );
  if (numErr || !invNumber) {
    console.error("[quotes] invoice number alloc failed", numErr);
    redirect(`/quotes/${id}?saved=accepted&warn=invoice_skipped`);
  }
  const { error: invErr } = await supabase.from("invoices").insert({
    org_id: quote.org_id,
    quote_id: quote.id,
    number: invNumber as unknown as string,
    amount: quote.subtotal,
    vat_total: quote.vat_total,
    status: "draft",
  });
  if (invErr) {
    console.error("[quotes] auto-invoice failed", invErr);
    redirect(`/quotes/${id}?saved=accepted&warn=invoice_skipped`);
  }

  // Pipeline integration: if the quote was linked to a lead, advance
  // the lead to "won" so the kanban reflects the close.
  const { data: quoteWithLead } = await supabase
    .from("quotes")
    .select("lead_id")
    .eq("id", id)
    .maybeSingle();
  if (quoteWithLead?.lead_id) {
    await supabase
      .from("leads")
      .update({
        status: "won",
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", quoteWithLead.lead_id);
  }

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/leads");
  redirect(`/quotes/${id}?saved=accepted`);
}

export async function declineQuoteAsOwner(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase
    .from("quotes")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error("[quotes] decline failed", error);
    redirect(`/quotes/${id}?error=decline_failed`);
  }
  revalidatePath(`/quotes/${id}`);
  redirect(`/quotes/${id}?saved=declined`);
}

/**
 * Service-role helper used by the public portal (which has no user JWT).
 * Exposed via separate file at /q/[token]/actions.ts so this module
 * keeps user-context only.
 */
export async function acceptQuoteByToken(
  token: string,
  signerName: string,
  ipHash: string | null,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Find the quote by public_token.
  const { data: quote, error: lookupErr } = await admin
    .from("quotes")
    .select("id, org_id, status, subtotal, vat_total, valid_until, lead_id")
    .eq("public_token", token)
    .maybeSingle();

  if (lookupErr || !quote) return { ok: false, error: "Quote not found" };
  if (quote.status === "accepted") return { ok: true, quoteId: quote.id };
  if (quote.status === "declined") return { ok: false, error: "Quote already declined" };
  if (quote.status === "expired") return { ok: false, error: "Quote has expired" };
  if (quote.valid_until && quote.valid_until < now.slice(0, 10)) {
    await admin.from("quotes").update({ status: "expired" }).eq("id", quote.id);
    return { ok: false, error: "Quote has expired" };
  }

  const { error: updErr } = await admin
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, ip_hash: ipHash, source: "public" },
    })
    .eq("id", quote.id);
  if (updErr) {
    console.error("[quotes] public accept failed", updErr);
    return { ok: false, error: "Couldn't record acceptance" };
  }

  // Auto-create invoice (draft) from the accepted quote.
  const { data: invNumber } = await admin.rpc("next_invoice_number", {
    target_org: quote.org_id,
  });
  if (invNumber) {
    await admin.from("invoices").insert({
      org_id: quote.org_id,
      quote_id: quote.id,
      number: invNumber as unknown as string,
      amount: quote.subtotal,
      vat_total: quote.vat_total,
      status: "draft",
    });
  }

  // Pipeline integration: advance the linked lead to "won" so the kanban
  // reflects the close — applies whether owner-accepted or public-accepted.
  if (quote.lead_id) {
    await admin
      .from("leads")
      .update({
        status: "won",
        last_activity_at: now,
      })
      .eq("id", quote.lead_id);
  }

  return { ok: true, quoteId: quote.id };
}

export async function declineQuoteByToken(
  token: string,
  reason: string | null,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: quote } = await admin
    .from("quotes")
    .select("id, status, notes")
    .eq("public_token", token)
    .maybeSingle();
  if (!quote) return { ok: false, error: "Quote not found" };
  if (quote.status === "accepted") return { ok: false, error: "Quote already accepted" };
  if (quote.status === "declined") return { ok: true, quoteId: quote.id };

  // Append decline reason into the existing notes field for the audit trail.
  const nextNotes = reason
    ? `${quote.notes ?? ""}\n\n[Declined ${now}] ${reason}`.trim()
    : quote.notes;

  const { error } = await admin
    .from("quotes")
    .update({
      status: "declined",
      declined_at: now,
      notes: nextNotes,
    })
    .eq("id", quote.id);
  if (error) {
    console.error("[quotes] public decline failed", error);
    return { ok: false, error: "Couldn't record decline" };
  }
  return { ok: true, quoteId: quote.id };
}

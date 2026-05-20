"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { quoteFormSchema, type LineItem } from "@/lib/quotes/schema";
import { computeTotals } from "@/lib/quotes/totals";
import { sendInvoiceEmail } from "@/lib/email/send-invoice";
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
  // Cast the entire chain: job_id / variation_number are in the
  // 20260520180000 migration but not yet in the generated Supabase types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: quoteRaw, error } = await (supabase as any)
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, source: "owner" },
    })
    .eq("id", id)
    .select("id, org_id, subtotal, vat_total, job_id, variation_number")
    .single();
  const quote = quoteRaw as
    | {
        id: string;
        org_id: string;
        subtotal: number;
        vat_total: number;
        job_id: string | null;
        variation_number: number | null;
      }
    | null;

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
  // Cast: invoices.job_id is in the 20260520150000 migration but not
  // yet in the generated Supabase types. Pass through so revenue from
  // accepted quotes (including variations) rolls up on the dashboard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: newInvoice, error: invErr } = await (supabase as any)
    .from("invoices")
    .insert({
      org_id: quote.org_id,
      quote_id: quote.id,
      number: invNumber as unknown as string,
      amount: quote.subtotal,
      vat_total: quote.vat_total,
      status: "draft",
      job_id: quote.job_id,
    })
    .select("id")
    .single();
  if (invErr || !newInvoice) {
    console.error("[quotes] auto-invoice failed", invErr);
    redirect(`/quotes/${id}?saved=accepted&warn=invoice_skipped`);
  }

  // Auto-email the invoice PDF to the customer. Best-effort: a send
  // failure (missing key, customer has no email, Resend rejection) does
  // NOT block the accept response — the invoice still exists and the
  // owner can manually re-send from /invoices/[id].
  const emailRes = await sendInvoiceEmail(supabase, newInvoice.id);
  if (!emailRes.sent) {
    console.warn("[quotes] auto-email after accept skipped", emailRes);
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
  customerComment: string | null = null,
): Promise<{ ok: true; quoteId: string } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Find the quote by public_token. job_id / variation_number are
  // cast-selected because the 20260520180000 migration adds them but
  // they aren't in the generated Supabase types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: quoteRaw, error: lookupErr } = await (admin as any)
    .from("quotes")
    .select(
      "id, org_id, status, subtotal, vat_total, valid_until, lead_id, job_id, variation_number",
    )
    .eq("public_token", token)
    .maybeSingle();
  const quote = quoteRaw as
    | {
        id: string;
        org_id: string;
        status: string;
        subtotal: number;
        vat_total: number;
        valid_until: string | null;
        lead_id: string | null;
        job_id: string | null;
        variation_number: number | null;
      }
    | null;

  if (lookupErr || !quote) return { ok: false, error: "Quote not found" };
  if (quote.status === "accepted") return { ok: true, quoteId: quote.id };
  if (quote.status === "declined") return { ok: false, error: "Quote already declined" };
  if (quote.status === "expired") return { ok: false, error: "Quote has expired" };
  if (quote.valid_until && quote.valid_until < now.slice(0, 10)) {
    await admin.from("quotes").update({ status: "expired" }).eq("id", quote.id);
    return { ok: false, error: "Quote has expired" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (admin as any)
    .from("quotes")
    .update({
      status: "accepted",
      accepted_at: now,
      accept_signature: { name: signerName, signed_at: now, ip_hash: ipHash, source: "public" },
      customer_comment: customerComment,
    })
    .eq("id", quote.id);
  if (updErr) {
    console.error("[quotes] public accept failed", updErr);
    return { ok: false, error: "Couldn't record acceptance" };
  }

  // Auto-create invoice (draft) from the accepted quote. When the source
  // is a variation, the new invoice picks up the same job_id so revenue
  // rolls up to the job on the profitability dashboard.
  const { data: invNumber } = await admin.rpc("next_invoice_number", {
    target_org: quote.org_id,
  });
  let newInvoiceId: string | null = null;
  if (invNumber) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newInvoice, error: invErr } = await (admin as any)
      .from("invoices")
      .insert({
        org_id: quote.org_id,
        quote_id: quote.id,
        number: invNumber as unknown as string,
        amount: quote.subtotal,
        vat_total: quote.vat_total,
        status: "draft",
        job_id: quote.job_id,
      })
      .select("id")
      .single();
    if (invErr) {
      console.error("[quotes] public auto-invoice failed", invErr);
    } else {
      newInvoiceId = newInvoice?.id ?? null;
    }
  }

  // Auto-email the invoice PDF to the customer. Best-effort — accept must
  // succeed even if Resend rejects, the customer email is missing, or
  // RESEND_API_KEY is not configured yet.
  if (newInvoiceId) {
    const emailRes = await sendInvoiceEmail(admin, newInvoiceId);
    if (!emailRes.sent) {
      console.warn("[quotes] public auto-email after accept skipped", emailRes);
    }
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
  customerComment: string | null = null,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("quotes")
    .update({
      status: "declined",
      declined_at: now,
      notes: nextNotes,
      customer_comment: customerComment,
    })
    .eq("id", quote.id);
  if (error) {
    console.error("[quotes] public decline failed", error);
    return { ok: false, error: "Couldn't record decline" };
  }
  return { ok: true, quoteId: quote.id };
}



/**
 * Create a Variation Order — a quote scoped to a specific job with a
 * per-job sequence number. Uses the same quotes/quote_line_items
 * pipeline so PDF + public portal + accept/decline + auto-invoice all
 * work for free.
 *
 * The form captures the operator's cost breakdown (labour/materials/
 * subcontractors/misc) + desired margin %; revenue is derived. Each
 * non-zero cost bucket becomes a quote_line_item so the PDF reads
 * cleanly, while the customer-facing line shows the bucket as a
 * description and the bucket's net-of-margin price as the unit_price.
 *
 * For the customer the variation looks like a small quote with a few
 * line items. Internally we mark it as a variation via the new
 * quotes.variation_number column. On accept, an invoice is generated
 * exactly as for a normal quote — and because we carry the job_id
 * through, the new invoice automatically rolls up under the same job
 * on the profitability dashboard.
 */
export async function createVariation(jobId: string, formData: FormData) {
  const { user } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) redirect("/jobs");

  const { variationFormSchema, computeVariation } = await import(
    "@/lib/variations/schema"
  );

  const parsed = variationFormSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    labour_cost: formData.get("labour_cost") ?? 0,
    materials_cost: formData.get("materials_cost") ?? 0,
    subcontractor_cost: formData.get("subcontractor_cost") ?? 0,
    misc_cost: formData.get("misc_cost") ?? 0,
    margin_pct: formData.get("margin_pct") ?? 0,
    vat_rate: formData.get("vat_rate") ?? 20,
    note: formData.get("note") ?? "",
    target_completion_date: formData.get("target_completion_date") ?? "",
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid variation";
    redirect(`/jobs/${jobId}/variations/new?error=${encodeURIComponent(msg)}`);
  }

  const computed = computeVariation(parsed.data);
  const supabase = await createClient();

  // Resolve job: org check + customer_id for the quote FK.
  const { data: job } = await supabase
    .from("jobs")
    .select("id, org_id, customer_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) redirect("/jobs?error=job_not_found");
  if (!job.customer_id) {
    redirect(`/jobs/${jobId}?error=variation_needs_customer`);
  }

  // Allocate per-org quote number AND per-job variation number.
  const [{ data: quoteNumber }, { data: varNumber }] = await Promise.all([
    supabase.rpc("next_quote_number", { target_org: job.org_id }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("next_variation_number", { target_job: jobId }),
  ]);
  if (!quoteNumber || !varNumber) {
    console.error("[variations] number allocation failed", { quoteNumber, varNumber });
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  const publicToken = crypto.randomUUID();

  // Insert the variation as a quote. Cast: job_id / variation_number
  // not yet in generated Supabase types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: variation, error: qErr } = await (supabase as any)
    .from("quotes")
    .insert({
      org_id: job.org_id,
      customer_id: job.customer_id,
      lead_id: null,
      job_id: jobId,
      variation_number: varNumber,
      number: quoteNumber as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: computed.subtotal,
      vat_total: computed.vat_total,
      total: computed.total,
      notes: parsed.data.description
        ? `${parsed.data.title}\n\n${parsed.data.description}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim()
        : `${parsed.data.title}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim(),
      terms: null,
      valid_until: parsed.data.target_completion_date ?? null,
      public_token: publicToken,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (qErr || !variation) {
    console.error("[variations] insert failed", qErr);
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  // Build customer-facing line items from the cost breakdown. We split
  // the variation revenue across buckets in proportion to their costs
  // so the customer sees a meaningful breakdown rather than a single
  // opaque "variation" line.
  const { labour, materials, subcontractors, misc } = computed.cost_breakdown;
  const totalCost = computed.total_cost;
  type LIRow = { label: string; cost: number };
  const buckets: LIRow[] = [
    { label: "Labour", cost: labour },
    { label: "Materials", cost: materials },
    { label: "Subcontractors", cost: subcontractors },
    { label: "Other", cost: misc },
  ].filter((b) => b.cost > 0);

  let lineItems: LineItemInsert[];
  if (totalCost === 0 || buckets.length === 0) {
    // Fallback: a single line representing the whole revenue.
    lineItems = [
      {
        quote_id: variation.id,
        org_id: job.org_id,
        description: parsed.data.title,
        qty: 1,
        unit_price: computed.subtotal,
        vat_rate: parsed.data.vat_rate,
        line_total: computed.subtotal,
        sort_order: 0,
      },
    ];
  } else {
    lineItems = buckets.map((b, idx) => {
      const share = b.cost / totalCost;
      const unit_price = Math.round(computed.subtotal * share * 100) / 100;
      return {
        quote_id: variation.id,
        org_id: job.org_id,
        description: b.label,
        qty: 1,
        unit_price,
        vat_rate: parsed.data.vat_rate,
        line_total: unit_price,
        sort_order: idx,
      };
    });
    // Adjust the last line to ensure sum == computed.subtotal (rounding).
    const summed = lineItems.reduce((s, l) => s + Number(l.unit_price ?? 0), 0);
    const delta = Math.round((computed.subtotal - summed) * 100) / 100;
    if (delta !== 0 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1]!;
      last.unit_price = Math.round((Number(last.unit_price ?? 0) + delta) * 100) / 100;
      last.line_total = last.unit_price;
    }
  }

  const { error: liErr } = await supabase
    .from("quote_line_items")
    .insert(lineItems);
  if (liErr) {
    console.error("[variations] line items insert failed", liErr);
    redirect(`/jobs/${jobId}?error=variation_line_items_failed`);
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/quotes/${variation.id}`);
  redirect(`/quotes/${variation.id}?saved=variation_created`);
}

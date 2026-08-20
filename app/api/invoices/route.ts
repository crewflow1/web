import { type NextRequest } from "next/server";
import * as respond from "@/lib/api/respond";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createInvoiceSchema, INVOICE_STATUSES } from "@/lib/invoices/schema";
import { invoiceDueDate } from "@/lib/invoices/due-date";

/**
 * Invoices list + create-from-quote.
 *
 *   POST /api/invoices    body: { quote_id, due_date?, notes? }
 *                         creates an invoice copying amount/vat_total
 *                         from the source quote and assigning a per-org
 *                         sequential number via next_invoice_number().
 *
 *   GET  /api/invoices    list (paginated, filterable by status).
 *
 * RLS scopes everything to the caller's org.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const url = request.nextUrl;
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  const status = url.searchParams.get("status");

  let q = supabase
    .from("invoices")
    .select(
      "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at, quote_id, created_at",
      { count: "exact" },
    )
    // ACTIVE-org pin + unique `id` tiebreaker — the POST half already stamps
    // `org_id: ctx.org.id`; the GET list did not scope by it.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status && (INVOICE_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status as (typeof INVOICE_STATUSES)[number]);
  }

  const { data, error, count } = await q;
  if (error) {
    console.error("[invoices] list failed", error);
    return respond.error(500, "Failed to load invoices");
  }
  return respond.json({ data: data ?? [], count: count ?? 0, limit, offset });
}

export async function POST(request: NextRequest) {
  const { ctx } = await requireOrgContext();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond.error(400, "Invalid JSON body");
  }
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return respond.error(400, "Invalid input", { extra: { issues: parsed.error.flatten() } });
  }

  const supabase = await createClient();

  // Verify the quote belongs to the caller's org (RLS does this, but we
  // need its totals).
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, subtotal, vat_total, total, currency, org_id, status, customer_id")
    .eq("id", parsed.data.quote_id)
    .maybeSingle();
  if (qErr) {
    console.error("[invoices] quote lookup failed", qErr);
    return respond.error(500, "Failed to load quote");
  }
  if (!quote) {
    return respond.error(404, "Quote not found");
  }
  // Only accepted quotes are billable. The UI already scopes its dropdown to
  // accepted, but a stale dropdown or a direct POST must not be able to bill a
  // draft/sent/declined quote the customer never accepted. The auto-invoice
  // path (quotes/actions.ts) inserts directly and is unaffected by this gate.
  if (quote.status !== "accepted") {
    return respond.error(409, "Only accepted quotes can be invoiced.");
  }

  // Do NOT standalone-bill a variation already captured in a non-cancelled interim
  // valuation: it is billed via the valuation invoice, so a second invoice here
  // double-bills. The valuation LINK TABLE is the persistent fence — the variation's
  // draft accept-invoice is deleted when it is linked to a valuation (freeing the
  // invoices(quote_id) unique slot), so the DB unique index no longer guards this
  // path. Two-step (avoids a PostgREST embed the ambiguity guard would flag).
  type QB = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }> & {
    select: (c: string) => QB;
    eq: (k: string, v: unknown) => QB;
    in: (k: string, v: unknown[]) => QB;
    neq: (k: string, v: unknown) => QB;
    limit: (n: number) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
  };
  const looseDb = supabase as unknown as { from: (t: string) => QB };
  const { data: vlinks, error: vlinkErr } = await looseDb
    .from("job_valuation_variations")
    .select("valuation_id")
    .eq("variation_quote_id", quote.id)
    .eq("org_id", ctx.org.id)
    .limit(500);
  if (vlinkErr) {
    console.error("[invoices] valuation-link check failed", vlinkErr);
    return respond.error(500, "Failed to verify billing eligibility");
  }
  const linkedValuationIds = (vlinks ?? []).map((r) => String(r.valuation_id));
  if (linkedValuationIds.length > 0) {
    const { data: liveVals, error: liveErr } = await looseDb
      .from("job_valuations")
      .select("id")
      .eq("org_id", ctx.org.id)
      .in("id", linkedValuationIds)
      .neq("status", "cancelled")
      .limit(1);
    if (liveErr) {
      console.error("[invoices] valuation-status check failed", liveErr);
      return respond.error(500, "Failed to verify billing eligibility");
    }
    if ((liveVals ?? []).length > 0) {
      return respond.error(
        409,
        "This variation is billed via an interim valuation and cannot be invoiced separately.",
      );
    }
  }

  // Allocate the next per-org invoice number via the SECURITY DEFINER RPC.
  const { data: numberRpc, error: numErr } = await supabase.rpc(
    "next_invoice_number",
    { target_org: ctx.org.id },
  );
  if (numErr || !numberRpc) {
    console.error("[invoices] number allocation failed", numErr);
    return respond.error(500, "Failed to allocate invoice number");
  }

  const { data: inserted, error: insErr } = await supabase
    .from("invoices")
    .insert({
      org_id: ctx.org.id,
      quote_id: quote.id,
      // Denormalised customer anchor (Issue #349 Phase 1): stamp it at creation
      // from the source quote so the invoice keeps its customer identity even if
      // the quote is later deleted. The composite FK (customer_id, org_id) ->
      // customers (id, org_id) guarantees it's a same-org customer.
      customer_id: (quote as { customer_id: string | null }).customer_id ?? null,
      number: numberRpc as unknown as string,
      amount: Number(quote.subtotal ?? 0),
      vat_total: Number(quote.vat_total ?? 0),
      // total is generated as amount + vat_total
      status: "draft",
      // Honour an explicit due date; otherwise default to net-14 so the
      // invoice never goes out with a blank payment deadline.
      due_date: parsed.data.due_date ?? invoiceDueDate(new Date().toISOString()),
      notes: parsed.data.notes ?? null,
    })
    .select("id, number, total")
    .single();

  if (insErr || !inserted) {
    console.error("[invoices] insert failed", insErr);
    return respond.error(500, "Failed to create invoice");
  }

  return respond.json(inserted, { status: 201 });
}

import { NextResponse, type NextRequest } from "next/server";
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
    return NextResponse.json({ error: "Failed to load invoices" }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [], count: count ?? 0, limit, offset });
}

export async function POST(request: NextRequest) {
  const { ctx } = await requireOrgContext();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
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
    return NextResponse.json({ error: "Failed to load quote" }, { status: 500 });
  }
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  // Only accepted quotes are billable. The UI already scopes its dropdown to
  // accepted, but a stale dropdown or a direct POST must not be able to bill a
  // draft/sent/declined quote the customer never accepted. The auto-invoice
  // path (quotes/actions.ts) inserts directly and is unaffected by this gate.
  if (quote.status !== "accepted") {
    return NextResponse.json(
      { error: "Only accepted quotes can be invoiced." },
      { status: 409 },
    );
  }

  // Allocate the next per-org invoice number via the SECURITY DEFINER RPC.
  const { data: numberRpc, error: numErr } = await supabase.rpc(
    "next_invoice_number",
    { target_org: ctx.org.id },
  );
  if (numErr || !numberRpc) {
    console.error("[invoices] number allocation failed", numErr);
    return NextResponse.json(
      { error: "Failed to allocate invoice number" },
      { status: 500 },
    );
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
    return NextResponse.json({ error: "Failed to create invoice" }, { status: 500 });
  }

  return NextResponse.json(inserted, { status: 201 });
}

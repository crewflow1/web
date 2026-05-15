import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createInvoiceSchema, INVOICE_STATUSES } from "@/lib/invoices/schema";

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
  await requireOrgContext();
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
    .order("created_at", { ascending: false })
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
    .select("id, subtotal, vat_total, total, currency, org_id")
    .eq("id", parsed.data.quote_id)
    .maybeSingle();
  if (qErr) {
    console.error("[invoices] quote lookup failed", qErr);
    return NextResponse.json({ error: "Failed to load quote" }, { status: 500 });
  }
  if (!quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
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
      number: numberRpc as unknown as string,
      amount: Number(quote.subtotal ?? 0),
      vat_total: Number(quote.vat_total ?? 0),
      // total is generated as amount + vat_total
      status: "draft",
      due_date: parsed.data.due_date ?? null,
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

import "server-only";

import { fetchAllRows } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import type {
  AccrualInvoiceRow,
  InvoicePaymentRow,
  VatScheme,
} from "@/lib/tax/compute";

/**
 * The PAGED read layer behind the single VAT authority (lib/tax/compute.ts).
 *
 * `computeVatQuarter` / `computeVatNetTotals` are PURE — they sum whatever rows
 * they are handed. This module gathers the two inputs those functions need but
 * cannot read themselves, so every statutory VAT surface (the /tax tile, the
 * quarterly PDF and the frozen HMRC 9-box return) builds them the SAME way and
 * can never drift:
 *
 *   1. The invoice_payments LEDGER over the quarter window. Output VAT (box 1)
 *      and net sales (box 6) are CASH-basis: the trigger stamps invoices.paid_at
 *      only on FULL settlement, so a status-gated sum drops every partial payment
 *      (a deposit on a still-open invoice, an instalment). The ledger carries the
 *      cash on the date it landed. Each payment is enriched with its parent
 *      invoice's vat_total / amount / total so the pure function can apportion.
 *
 *   2. The domestic reverse-charge totals over the quarter window. CIS S55A
 *      reverse-charge VAT is frozen on supplier_payment_allocations
 *      .cis_reverse_charge_vat (the DB is the control — lib/cis/deduction.ts is
 *      its twin). The contractor self-accounts it: the notional VAT enters BOX 1
 *      and BOX 4 (net-neutral). This module SUMS that frozen VAT; it never
 *      re-derives it. The net PURCHASE value already reaches BOX 7 via the
 *      finance row the reverse-charge bill itself is (see lib/tax/compute.ts
 *      computeVatNetTotals) — so this module does NOT re-sum it here, which would
 *      double-count box 7.
 *
 *      WINDOW BASIS (C73-A). The reverse-charge VAT is windowed on the BILL's
 *      tax point — the `finances.created_at` of the reverse-charge bill — the
 *      SAME date column boxes 4 and 7 use, NOT `supplier_payments.paid_at`. A
 *      reverse-charge bill IS a `finances` row (allocations point at it via
 *      `finance_id`), and its net already lands in box 7 on `created_at`; keying
 *      the notional VAT off `paid_at` split a bill LOGGED in one quarter but PAID
 *      in the next (a normal CIS payables flow) across two returns — box 7 net in
 *      the bill's quarter, boxes 1/4 VAT in the payment's quarter — breaking the
 *      "single window, all boxes reconcile" invariant HMRC cross-checks. Keying
 *      on `finances.created_at` makes a single RC transaction's net (box 7) and
 *      notional VAT (boxes 1/4) always land in ONE quarter.
 *
 * PAGING (F-1). finances, supplier_payments and supplier_payment_allocations are
 * all HIGH-VALUE tables: a bare `.select()` truncates at the 1000-row cap and
 * would silently under-state a filed VAT figure. The window reads page via
 * `fetchAllRows`; the id-keyed lookups are chunked strictly below the cap.
 *
 * ORG-PINNED + LOUD. Every read is `.eq("org_id", orgId)` (RLS admits every org a
 * multi-org admin belongs to, so an unpinned read would blend two companies' VAT)
 * and throws via `readFailure` on error — a failed read must never silently
 * become £0 of output VAT on an HMRC-facing figure.
 */

/** Chunk size for id-keyed `.in(...)` lookups — strictly below the 1000-row cap. */
const IN_CHUNK = 500;

/** The reverse-charge totals for one quarter window. */
export type ReverseChargeQuarterTotals = {
  /** Σ frozen cis_reverse_charge_vat — the notional VAT (→ BOX 1 and BOX 4). */
  vat: number;
};

/**
 * A ledger row for the pure VAT authority, plus display-only fields the quarterly
 * PDF audit trail needs. `computeVatQuarter` / `computeVatNetTotals` accept the
 * `InvoicePaymentRow` subset structurally and ignore the extras.
 */
export type VatLedgerRow = InvoicePaymentRow & {
  /** invoices.number — for the PDF "payments received" audit rows. */
  invoiceRef: string | null;
};

export type VatQuarterInputs = {
  /** Every payment received in the window, enriched with its parent invoice figures. */
  invoicePayments: VatLedgerRow[];
  /** Domestic reverse-charge totals for the window. */
  reverseCharge: ReverseChargeQuarterTotals;
  /**
   * ISSUED invoices whose tax point (created_at) is in the window — the ACCRUAL
   * (standard-scheme) output-VAT source. Empty for cash-basis orgs (the default):
   * this read only runs when the caller asks for the `standard` scheme, so a
   * cash-basis org pays no extra query and sees no change.
   */
  accrualInvoices: AccrualInvoiceRow[];
};

/** The minimal, read-only PostgREST surface this module needs (real client or cast). */
type Builder = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  gte: (k: string, v: unknown) => Builder;
  lt: (k: string, v: unknown) => Builder;
  is: (k: string, v: unknown) => Builder;
  in: (k: string, v: readonly unknown[]) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
};
export type VatInputsDb = { from: (t: string) => Builder };

type RawPayment = { invoice_id: string | null; amount: number | string | null; paid_at: string | null };
type RawInvoice = {
  id: string;
  number: string | null;
  vat_total: number | string | null;
  amount: number | string | null;
  total: number | string | null;
};
type RawAllocation = {
  payment_id: string;
  cis_reverse_charge_vat: number | string | null;
};

/**
 * The invoice_payments ledger for the window, each row carrying its parent
 * invoice's VAT figures. `quarterEndExclusiveIso` is the EXCLUSIVE upper bound
 * (start of the next quarter) so a future-dated payment cannot leak in.
 */
async function gatherInvoicePaymentLedger(
  db: VatInputsDb,
  orgId: string,
  quarterStartIso: string,
  quarterEndExclusiveIso: string,
): Promise<VatLedgerRow[]> {
  // PAGED window read: order by the unique (paid_at, id) so no page-edge row is
  // dropped (invoice_payments.paid_at alone is non-unique).
  const { data: payRows, error: payErr } = await fetchAllRows<RawPayment>((from, to) =>
    db
      .from("invoice_payments")
      .select("id, invoice_id, amount, paid_at")
      .eq("org_id", orgId)
      .gte("paid_at", quarterStartIso)
      .lt("paid_at", quarterEndExclusiveIso)
      .order("paid_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RawPayment[] | null; error: unknown }>,
  );
  if (payErr) throw readFailure("vat inputs: invoice payments", payErr);
  const payments = payRows ?? [];
  if (payments.length === 0) return [];

  // Parent invoice figures for the payments in the window. CHUNKED (F-1): the
  // distinct invoice-id set can exceed the 1000-row cap in a busy quarter, so a
  // single `.in(...)` would truncate; each chunk is ≤ IN_CHUNK unique PKs.
  const invoiceIds = [...new Set(payments.map((p) => p.invoice_id).filter((id): id is string => !!id))];
  const invoiceById = new Map<string, RawInvoice>();
  for (let i = 0; i < invoiceIds.length; i += IN_CHUNK) {
    const chunk = invoiceIds.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("invoices")
      .select("id, number, vat_total, amount, total")
      .eq("org_id", orgId)
      .in("id", chunk);
    if (error) throw readFailure("vat inputs: payment parent invoices", error);
    for (const inv of (data ?? []) as RawInvoice[]) invoiceById.set(inv.id, inv);
  }

  const out: VatLedgerRow[] = [];
  for (const p of payments) {
    const inv = p.invoice_id ? invoiceById.get(p.invoice_id) : undefined;
    // A payment whose parent invoice we could not read contributes no apportioned
    // VAT (invoice_total unresolved ⇒ the pure function's divide-by-zero guard
    // skips it). Better a dropped row than an invented one on an HMRC figure.
    out.push({
      amount: p.amount,
      paid_at: p.paid_at,
      invoice_vat_total: inv?.vat_total ?? null,
      invoice_amount: inv?.amount ?? null,
      invoice_total: inv?.total ?? null,
      invoiceRef: inv?.number ?? null,
    });
  }
  return out;
}

/**
 * The frozen domestic reverse-charge totals for the window, keyed off the
 * reverse-charge BILL's tax point (`finances.created_at`) — the SAME date column
 * that feeds boxes 4 and 7 — and excluding voided payments.
 *
 * WHY NOT `supplier_payments.paid_at` (C73-A). A reverse-charge bill IS a
 * `finances` row (the allocation names it via `finance_id`), and its net already
 * lands in box 7 on `created_at`. Windowing the notional VAT on the PAYMENT date
 * split a bill logged in one quarter but paid in the next across two returns —
 * box 7 net in the bill's quarter, boxes 1/4 VAT in the payment's — so the frozen
 * 9-box return no longer reconciled. Windowing on the SAME `finances.created_at`
 * as box 7 keeps a single RC transaction's net and notional VAT in ONE quarter.
 *
 * COUNTED ONCE. Each allocation carries its INCREMENTAL frozen
 * `cis_reverse_charge_vat` (the cumulative method in lib/cis/deduction.ts), so Σ
 * over a bill's LIVE (non-voided) allocations is exactly that bill's settled RC
 * VAT — no double-count (the C69 box-7 lesson: we still sum notional VAT only for
 * boxes 1/4 here; box 7's net comes from the finances loop in computeVatNetTotals).
 */
async function gatherReverseChargeQuarter(
  db: VatInputsDb,
  orgId: string,
  quarterStartIso: string,
  quarterEndExclusiveIso: string,
): Promise<ReverseChargeQuarterTotals> {
  // 1. The reverse-charge BILLS whose tax point (finances.created_at) is in the
  //    window. PAGED (F-1): finances is high-value; a bare select truncates at the
  //    1000-row cap. Order by the unique (created_at, id) so no page-edge row is
  //    dropped. This is the SAME window/column boxes 4 and 7 use.
  const { data: finRows, error: finErr } = await fetchAllRows<{ id: string }>((from, to) =>
    db
      .from("finances")
      .select("id")
      .eq("org_id", orgId)
      .gte("created_at", quarterStartIso)
      .lt("created_at", quarterEndExclusiveIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { id: string }[] | null; error: unknown }>,
  );
  if (finErr) throw readFailure("vat inputs: reverse-charge bills (finances)", finErr);
  const financeIds = (finRows ?? []).map((f) => f.id);
  if (financeIds.length === 0) return { vat: 0 };

  // 2. The allocations against those in-window bills, each carrying its frozen
  //    notional VAT and the payment it belongs to (for the void filter). CHUNKED
  //    (F-1): the finance-id set can exceed the cap in a busy quarter, so a single
  //    `.in(...)` would truncate; each chunk is ≤ IN_CHUNK unique PKs. Standard
  //    (non-RC) allocations carry cis_reverse_charge_vat = 0 (M3 CHECK), so summing
  //    the whole set naturally yields only the RC total.
  const allocations: RawAllocation[] = [];
  for (let i = 0; i < financeIds.length; i += IN_CHUNK) {
    const chunk = financeIds.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("supplier_payment_allocations")
      .select("payment_id, cis_reverse_charge_vat")
      .eq("org_id", orgId)
      .in("finance_id", chunk);
    if (error) throw readFailure("vat inputs: reverse-charge allocations", error);
    for (const a of (data ?? []) as RawAllocation[]) allocations.push(a);
  }
  if (allocations.length === 0) return { vat: 0 };

  // 3. Exclude VOIDED payments (KEEP the void exclusion). A voided payment's
  //    allocations survive as the record of what the voided payment claimed, but
  //    they must not count toward a filed VAT figure. Read the parent payments and
  //    keep only the LIVE ones. CHUNKED (F-1): supplier_payments.id is unique so
  //    each chunk yields ≤ IN_CHUNK rows.
  const paymentIds = [...new Set(allocations.map((a) => a.payment_id))];
  const livePaymentIds = new Set<string>();
  for (let i = 0; i < paymentIds.length; i += IN_CHUNK) {
    const chunk = paymentIds.slice(i, i + IN_CHUNK);
    const { data, error } = await db
      .from("supplier_payments")
      .select("id")
      .eq("org_id", orgId)
      .is("voided_at", null)
      .in("id", chunk);
    if (error) throw readFailure("vat inputs: supplier payments (reverse charge)", error);
    for (const p of (data ?? []) as { id: string }[]) livePaymentIds.add(p.id);
  }

  let vat = 0;
  for (const a of allocations) {
    if (!livePaymentIds.has(a.payment_id)) continue;
    vat += Number(a.cis_reverse_charge_vat ?? 0);
  }
  return { vat: Math.round(vat * 100) / 100 };
}

type RawAccrualInvoice = {
  status: string;
  created_at: string;
  vat_total: number | string | null;
  amount: number | string | null;
  total: number | string | null;
};

/**
 * The ISSUED invoices whose tax point (`created_at`) falls in the window — the
 * ACCRUAL (standard-scheme) output-VAT source. The status filter (draft ≠ tax
 * point) is applied by the pure authority via `isIssuedStatus`; this reads the raw
 * rows on the SAME window/column corp-tax accrual revenue uses, ORG-PINNED + LOUD
 * + PAGED (F-1: invoices is high-value, a bare select truncates at the 1000-row
 * cap and would under-state a filed accrual VAT figure).
 */
export async function gatherAccrualInvoices(
  db: VatInputsDb,
  orgId: string,
  quarterStartIso: string,
  quarterEndExclusiveIso: string,
): Promise<AccrualInvoiceRow[]> {
  const { data, error } = await fetchAllRows<RawAccrualInvoice>((from, to) =>
    db
      .from("invoices")
      .select("status, created_at, vat_total, amount, total")
      .eq("org_id", orgId)
      .gte("created_at", quarterStartIso)
      .lt("created_at", quarterEndExclusiveIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: RawAccrualInvoice[] | null;
      error: unknown;
    }>,
  );
  if (error) throw readFailure("vat inputs: accrual invoices", error);
  return (data ?? []).map((inv) => ({
    status: inv.status,
    tax_point: inv.created_at,
    vat_total: inv.vat_total,
    amount: inv.amount,
    total: inv.total,
  }));
}

/**
 * Gather the VAT-authority inputs for one org over `[quarterStartIso,
 * quarterEndExclusiveIso)`. Pass the result straight into computeVatQuarter /
 * computeVatNetTotals so the tile, PDF and frozen return reconcile.
 *
 * `scheme` (default `cash`) decides whether the ACCRUAL invoice source is read: it
 * is skipped entirely for cash-basis orgs, so the common path pays no extra query.
 */
export async function gatherVatQuarterInputs(
  db: VatInputsDb,
  orgId: string,
  quarterStartIso: string,
  quarterEndExclusiveIso: string,
  scheme: VatScheme = "cash",
): Promise<VatQuarterInputs> {
  const [invoicePayments, reverseCharge, accrualInvoices] = await Promise.all([
    gatherInvoicePaymentLedger(db, orgId, quarterStartIso, quarterEndExclusiveIso),
    gatherReverseChargeQuarter(db, orgId, quarterStartIso, quarterEndExclusiveIso),
    scheme === "standard"
      ? gatherAccrualInvoices(db, orgId, quarterStartIso, quarterEndExclusiveIso)
      : Promise.resolve<AccrualInvoiceRow[]>([]),
  ]);
  return { invoicePayments, reverseCharge, accrualInvoices };
}

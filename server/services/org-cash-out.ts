import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { startOfQuarterIso } from "@/lib/tax/compute";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import type { CisPaymentSnapshotRow } from "@/lib/cis/statements";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";
import { daysUntil } from "@/lib/cis/statements";
import {
  buildCashOutComponents,
  computeCashPosition,
  computeCisHmrcDue,
  computeOrgCashOut,
  buildUnpaidBillQueue,
  EMPTY_CASH_OUT,
  type CashOutBillRow,
  type CashOutComponent,
  type CashOutPayrollLineRow,
  type CashOutPayrollRunRow,
  type CashOutPoRow,
  type CashOutQueueItem,
  type CashOutVatFinanceRow,
  type CashOutVatPaymentRow,
  type OrgCashOutSummary,
  type OrgCashPosition,
} from "@/lib/commercial/cash-out";

/**
 * H2-CASH M4 — the money-OUT read layer for /cash.
 *
 * This module FETCHES and COMPOSES. It never decides and it NEVER WRITES: there
 * is no insert / update / upsert / delete / rpc anywhere in the file, and
 * `CashOutClient` structurally exposes only read verbs, so a write cannot be
 * added without also widening the type. Every number comes from a pure lib via
 * `lib/commercial/cash-out.ts`; nothing in this file does money arithmetic.
 * `__tests__/security/cash-out-no-new-arithmetic.test.ts` pins both properties.
 *
 * SCOPING — belt and braces, deliberately:
 *   1. RLS: reads run on the caller's client (the user's JWT).
 *   2. `org_id` PINNED on EVERY read. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so an RLS-only read BLENDS tenants for a dual-org
 *      member — the class fixed in #456 and repeatedly since. On a MONEY page
 *      that would merge two companies' payables, VAT and CIS liabilities into
 *      one position. RLS is the floor here, never the scoping mechanism.
 *
 * PAGING: `fetchAllRows` needs a UNIQUE total order or rows sharing the sort key
 * can be dropped or duplicated at a 500-row page edge (the F-1 silent-truncation
 * class). Every read here orders by the primary key `id`, EXCEPT the three tables
 * that have no single-column `id` exposed to us — those append `id`-equivalent
 * unique columns explicitly (see `PAGED_READS` below). Understating a liability
 * is the failure mode this guards against.
 *
 * LOUD READS (#480): a failed read must NEVER render as "£0 owed". Any read
 * error sets `loadError`, the page shows a banner, and the figures are labelled
 * as possibly incomplete. Best-effort stands (partial rows are used) but the
 * partial-ness is always visible.
 *
 * ROLE POSTURE: `/cash` already redirects `staff`, and the membership role domain
 * is `owner | admin | staff` (20260521000000), so every viewer of this page
 * satisfies `is_org_admin`. That matters: `supplier_payments`,
 * `supplier_payment_allocations`, `cis_payment_snapshots`, `payroll_runs` and
 * `payroll_lines` are all ADMIN-ONLY at the database. If a non-admin role were
 * ever added and allowed onto /cash, the settlement read would come back empty
 * and every bill would read as fully unpaid — an OVERSTATED payables figure. The
 * page's role gate is therefore load-bearing, not cosmetic, and
 * `assertCashOutViewerIsAdmin` below makes that refusal explicit rather than
 * implicit.
 *
 * TESTABILITY: `gatherCashOutFacts` takes the client as an argument rather than
 * creating it, so the integration suite drives the EXACT same queries with a
 * real dual-org user's JWT against real Postgres (mirrors
 * server/services/operations-snapshot.ts and job-site-hub.ts).
 */

type Row = Record<string, unknown>;

/** Minimal, self-returning, READ-ONLY view of the PostgREST builder. */
export type CashOutClient = { from: (t: string) => CashOutBuilder };
type CashOutBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => CashOutBuilder;
  eq: (k: string, v: unknown) => CashOutBuilder;
  not: (k: string, op: string, v: unknown) => CashOutBuilder;
  gte: (k: string, v: unknown) => CashOutBuilder;
  order: (k: string, o: { ascending: boolean }) => CashOutBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

/**
 * How many CIS tax months of frozen snapshots to read. Thirteen matches
 * `recentTaxMonthEnds`'s default in server/services/cis-statements.ts, so the
 * two CIS surfaces cover the same span. It BOUNDS the read (a ten-year-old
 * contractor does not page its entire deduction history to render one row) and
 * it bounds the honesty claim with it: the "past the deadline" line covers the
 * last thirteen tax months, and the UI says so.
 */
export const CIS_LOOKBACK_TAX_MONTHS = 13;

/** How many open bills the payables card lists before deferring to /suppliers. */
export const CASH_OUT_BILL_LIMIT = 8;

const BILL_COLS =
  "id, supplier_id, purchase_order_id, amount, vat_total, reference, bill_date, category, job_id, created_at";
const PAYMENT_COLS = "id, paid_at, method, reference, gross_amount, cis_withheld, net_paid, voided_at, created_at";
const ALLOCATION_COLS = "id, payment_id, finance_id, amount";
const PO_COLS = "id, number, status, total, supplier_id, expected_date";
const PAYROLL_RUN_COLS = "id, status, cycle, period_start, period_end";
const PAYROLL_LINE_COLS = "id, payroll_run_id, net_pay";
const SNAPSHOT_COLS =
  "payment_id, supplier_id, cis_status, deduction_rate, verification_reference, legal_name, " +
  "utr_masked, cis_gross_payment, materials_total, cis_deduction, tax_month_start, tax_month_end";
const INVOICE_VAT_COLS = "id, status, vat_total, total, amount, paid_at, created_at";
const INVOICE_PAYMENT_COLS = "id, invoice_id, amount, paid_at";
const SUPPLIER_COLS = "id, name";

export interface OrgCashOutView {
  summary: OrgCashOutSummary;
  /** Ordered, most-certain-first rows for the UI. */
  components: CashOutComponent[];
  /** The biggest open bills, largest outstanding first. */
  unpaidBillQueue: CashOutQueueItem[];
  /** Total open bills found (the queue is truncated for display). */
  unpaidBillTotalCount: number;
  /** How many CIS tax months the CIS figures cover. */
  cisLookbackMonths: number;
  /**
   * True when ANY read failed. The page must show its banner rather than a
   * falsely-reassuring "nothing owed" — an understated liability is the one
   * failure mode this surface must never produce silently.
   */
  loadError: boolean;
}

export const EMPTY_CASH_OUT_VIEW: OrgCashOutView = {
  summary: EMPTY_CASH_OUT,
  components: [],
  unpaidBillQueue: [],
  unpaidBillTotalCount: 0,
  cisLookbackMonths: CIS_LOOKBACK_TAX_MONTHS,
  loadError: true,
};

/**
 * Page an org-pinned read to completion.
 *
 * `orderKey` MUST be unique within the org. `build` adds narrowing filters. A
 * read error is reported (never swallowed) so the caller can raise `loadError`.
 */
async function paged(
  db: CashOutClient,
  table: string,
  cols: string,
  orgId: string,
  orderKey: string,
  build: (b: CashOutBuilder) => CashOutBuilder = (b) => b,
  pageSize?: number,
): Promise<{ rows: Row[]; failed: boolean }> {
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      // THE ORG PIN. Every read in this file passes through here.
      build(db.from(table).select(cols).eq("org_id", orgId))
        .order(orderKey, { ascending: true })
        .range(from, to),
    pageSize,
  );
  return { rows: data, failed: error != null };
}

/**
 * The CIS tax-month end that is `CIS_LOOKBACK_TAX_MONTHS - 1` months before the
 * one containing today — the floor for the snapshot read. Falls back to reading
 * everything (a wider, still-correct answer) if the date can't be resolved,
 * because a bad bound must never silently hide a tax liability.
 */
export function cisSnapshotFloor(todayIso: string, months = CIS_LOOKBACK_TAX_MONTHS): string | null {
  const current = cisTaxMonthEnd(todayIso);
  if (!current) return null;
  const [y, m, d] = current.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1 - (months - 1), d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

export interface CashOutFacts {
  bills: CashOutBillRow[];
  /** Every finance row, including non-supplier costs — input VAT is on all of them. */
  allFinances: CashOutVatFinanceRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
  purchaseOrders: CashOutPoRow[];
  payrollRuns: CashOutPayrollRunRow[];
  payrollLines: CashOutPayrollLineRow[];
  cisSnapshots: CisPaymentSnapshotRow[];
  /** CASH-basis output-VAT source: invoice_payments enriched with invoice figures. */
  invoicePayments: CashOutVatPaymentRow[];
  supplierNames: Map<string, string>;
  failed: boolean;
}

/**
 * Read every money-out fact for ONE org, in one parallel wave.
 *
 * `finances` is read ONCE and used twice — supplier bills (rows with a
 * `supplier_id`) and the input-VAT population (all rows). Reading it twice would
 * be two chances for the two figures to disagree.
 *
 * The CIS snapshots need their payment's `paid_at` / `voided_at` to be usable by
 * `buildMonthlyReturnDataset`; those come from the `supplier_payments` read this
 * wave already performs, so there is no extra hop and no N+1.
 */
export async function gatherCashOutFacts(
  db: CashOutClient,
  orgId: string,
  todayIso: string,
  pageSize?: number,
): Promise<CashOutFacts> {
  const snapshotFloor = cisSnapshotFloor(todayIso);

  const results = await Promise.all([
    paged(db, "finances", BILL_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "supplier_payments", PAYMENT_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "supplier_payment_allocations", ALLOCATION_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "purchase_orders", PO_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "payroll_runs", PAYROLL_RUN_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "payroll_lines", PAYROLL_LINE_COLS, orgId, "id", (b) => b, pageSize),
    // `cis_payment_snapshots` has a COMPOSITE primary key (org_id, payment_id)
    // and no `id`, so `payment_id` is the unique order within the pinned org.
    paged(
      db,
      "cis_payment_snapshots",
      SNAPSHOT_COLS,
      orgId,
      "payment_id",
      (b) => (snapshotFloor ? b.gte("tax_month_end", snapshotFloor) : b),
      pageSize,
    ),
    paged(db, "invoices", INVOICE_VAT_COLS, orgId, "id", (b) => b, pageSize),
    // The invoice_payments LEDGER — CASH-basis output VAT (box 1). The trigger
    // stamps invoices.paid_at only on FULL settlement, so a status-gated read
    // dropped every partial payment; the ledger carries the cash on the day it
    // landed. computeVatQuarter applies its own quarter window.
    paged(db, "invoice_payments", INVOICE_PAYMENT_COLS, orgId, "id", (b) => b, pageSize),
    paged(db, "suppliers", SUPPLIER_COLS, orgId, "id", (b) => b, pageSize),
  ]);

  const failed = results.some((r) => r.failed);
  const [
    financeRows = [],
    paymentRows = [],
    allocationRows = [],
    poRows = [],
    payrollRunRows = [],
    payrollLineRows = [],
    snapshotRows = [],
    invoiceRows = [],
    invoicePaymentRows = [],
    supplierRows = [],
  ] = results.map((r) => r.rows);

  const payments: SupplierPaymentRow[] = paymentRows.map((p) => ({
    id: String(p.id),
    paid_at: String(p.paid_at ?? ""),
    method: String(p.method ?? ""),
    reference: (p.reference as string | null) ?? null,
    gross_amount: p.gross_amount as number | string | null,
    cis_withheld: p.cis_withheld as number | string | null,
    net_paid: p.net_paid as number | string | null,
    voided_at: (p.voided_at as string | null) ?? null,
    created_at: (p.created_at as string | null) ?? null,
  }));
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  return {
    // Supplier bills ONLY. A `finances` row with no supplier has no settlement
    // ledger (`supplier_payment_allocations`' composite FK refuses one), so it
    // could never be marked paid and would sit in payables forever.
    bills: financeRows
      .filter((f) => f.supplier_id != null)
      .map((f) => ({
        id: String(f.id),
        supplier_id: (f.supplier_id as string | null) ?? null,
        purchase_order_id: (f.purchase_order_id as string | null) ?? null,
        amount: f.amount as number | string | null,
        vat_total: f.vat_total as number | string | null,
        reference: (f.reference as string | null) ?? null,
        bill_date: (f.bill_date as string | null) ?? null,
        category: (f.category as string | null) ?? null,
        job_id: (f.job_id as string | null) ?? null,
        created_at: (f.created_at as string | null) ?? null,
      })),
    allFinances: financeRows.map((f) => ({
      vat_total: f.vat_total as number | string | null,
      amount: f.amount as number | string | null,
      created_at: String(f.created_at ?? ""),
    })),
    payments,
    allocations: allocationRows.map((a) => ({
      payment_id: String(a.payment_id),
      finance_id: String(a.finance_id),
      amount: a.amount as number | string | null,
    })),
    purchaseOrders: poRows.map((p) => ({
      id: String(p.id),
      number: (p.number as string | null) ?? null,
      status: String(p.status ?? ""),
      total: p.total as number | string | null,
      supplier_id: (p.supplier_id as string | null) ?? null,
      expected_date: (p.expected_date as string | null) ?? null,
    })),
    payrollRuns: payrollRunRows.map((r) => ({
      id: String(r.id),
      status: String(r.status ?? ""),
      cycle: (r.cycle as string | null) ?? null,
      period_start: (r.period_start as string | null) ?? null,
      period_end: (r.period_end as string | null) ?? null,
    })),
    payrollLines: payrollLineRows.map((l) => ({
      payroll_run_id: String(l.payroll_run_id),
      net_pay: l.net_pay as number | string | null,
    })),
    // A snapshot whose payment we could not read is DROPPED, not defaulted to
    // live: `buildMonthlyReturnDataset` excludes voided payments, and guessing
    // `voided_at: null` would resurrect a voided payment's deduction into a tax
    // liability. Dropping understates a figure we already flag as incomplete;
    // guessing would fabricate one.
    cisSnapshots: snapshotRows.flatMap((s) => {
      const p = paymentById.get(String(s.payment_id));
      if (!p) return [];
      return [
        {
          ...(s as unknown as CisPaymentSnapshotRow),
          paid_at: p.paid_at,
          voided_at: p.voided_at ?? null,
        },
      ];
    }),
    // The invoice_payments ledger, each payment enriched with its parent
    // invoice's VAT figures so computeVatQuarter can apportion the cash received.
    // A payment whose invoice we could not read carries null figures ⇒ the pure
    // function's divide-by-zero guard skips it (never an invented VAT figure).
    invoicePayments: (() => {
      const invoiceById = new Map(invoiceRows.map((i) => [String(i.id), i]));
      return invoicePaymentRows.map((p) => {
        const inv = invoiceById.get(String(p.invoice_id));
        return {
          amount: p.amount as number | string | null,
          paid_at: (p.paid_at as string | null) ?? null,
          invoice_vat_total: (inv?.vat_total as number | string | null) ?? null,
          invoice_amount: (inv?.amount as number | string | null) ?? null,
          invoice_total: (inv?.total as number | string | null) ?? null,
        };
      });
    })(),
    supplierNames: new Map(supplierRows.map((s) => [String(s.id), String(s.name ?? "")])),
    failed,
  };
}

/**
 * Build the money-out view for one org.
 *
 * Best-effort like every sibling snapshot: a thrown failure degrades to the
 * EMPTY view with `loadError` true, so /cash renders its "couldn't load" banner
 * instead of a 500 — and, critically, never a confident "£0 owed".
 */
export async function buildOrgCashOut(
  orgId: string,
  options: { now?: Date } = {},
): Promise<OrgCashOutView> {
  const now = options.now ?? new Date();
  const todayIso = invoiceBusinessToday(now);
  try {
    const supabase = await createClient();
    const facts = await gatherCashOutFacts(supabase as unknown as CashOutClient, orgId, todayIso);

    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoicePayments: facts.invoicePayments,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(now),
      todayIso,
    });

    const queue = buildUnpaidBillQueue({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      supplierNames: facts.supplierNames,
    });

    return {
      summary,
      components: buildCashOutComponents(summary),
      unpaidBillQueue: queue.slice(0, CASH_OUT_BILL_LIMIT),
      unpaidBillTotalCount: queue.length,
      cisLookbackMonths: CIS_LOOKBACK_TAX_MONTHS,
      loadError: facts.failed,
    };
  } catch (err) {
    console.warn("[org-cash-out] buildOrgCashOut failed", err);
    return EMPTY_CASH_OUT_VIEW;
  }
}

// ---------------------------------------------------------------------------
// The Daily Briefing signal (narrow, bounded, best-effort)
// ---------------------------------------------------------------------------

export interface CisHmrcSignal {
  amount: number;
  /** Whole days to the HMRC deadline. Never negative — a passed deadline is dropped. */
  dueInDays: number | null;
  payBy: string | null;
}

/**
 * The CIS-to-HMRC figure for the Daily Briefing.
 *
 * TWO reads, not the whole money-out wave: the dashboard must not pay for nine
 * paged reads to render one line. It reuses `computeCisHmrcDue` — the SAME pure
 * authority /cash uses — so the briefing and the cash page can never disagree
 * about what is owed to HMRC. (The briefing already applies this rule to the
 * receivables side, where it calls `buildOrgCash` rather than re-summing
 * invoices.)
 *
 * Returns undefined — never a zero — when there is nothing to say: no
 * subcontractor payments, a passed deadline, a read failure, or a caller without
 * the admin rights the ledger requires. An absent signal emits no briefing line;
 * a zero would be a claim.
 */
export async function loadCisHmrcSignal(
  db: CashOutClient,
  orgId: string,
  todayIso: string,
): Promise<CisHmrcSignal | undefined> {
  try {
    const floor = cisSnapshotFloor(todayIso);
    const [snaps, pays] = await Promise.all([
      paged(db, "cis_payment_snapshots", SNAPSHOT_COLS, orgId, "payment_id", (b) =>
        floor ? b.gte("tax_month_end", floor) : b,
      ),
      paged(db, "supplier_payments", "id, paid_at, voided_at", orgId, "id"),
    ]);
    // Fail QUIET, not zero: a failed read must not tell the owner their CIS
    // liability is nil. No line at all is the honest output.
    if (snaps.failed || pays.failed) return undefined;
    if (snaps.rows.length === 0) return undefined;

    const byId = new Map(
      pays.rows.map((p) => [String(p.id), { paid_at: String(p.paid_at ?? ""), voided_at: (p.voided_at as string | null) ?? null }]),
    );
    const rows = snaps.rows.flatMap((s) => {
      const p = byId.get(String(s.payment_id));
      if (!p) return [];
      return [{ ...(s as unknown as CisPaymentSnapshotRow), paid_at: p.paid_at, voided_at: p.voided_at }];
    });

    const due = computeCisHmrcDue(rows, todayIso);
    if (due.dueNow <= 0 || due.dueOn == null) return undefined;
    const days = daysUntil(due.dueOn, todayIso);
    if (days == null || days < 0) return undefined;
    return { amount: due.dueNow, dueInDays: days, payBy: due.dueOn };
  } catch (err) {
    console.warn("[org-cash-out] loadCisHmrcSignal failed", err);
    return undefined;
  }
}

/**
 * The role gate, stated as code rather than left implicit in the page.
 *
 * Every table this module reads beyond `finances`, `invoices`, `purchase_orders`
 * and `suppliers` is admin-only at the database. A viewer without admin rights
 * would get an EMPTY settlement ledger and see every bill as fully unpaid — a
 * payables figure that is not merely incomplete but WRONG IN THE DANGEROUS
 * DIRECTION. So the money-out section is shown to owner/admin only.
 */
export function cashOutVisibleToRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

export { computeCashPosition };
export type { OrgCashPosition, OrgCashOutSummary, CashOutComponent, CashOutQueueItem };

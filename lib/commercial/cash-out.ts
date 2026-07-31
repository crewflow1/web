import { round2, sumMoney, toPounds } from "@/lib/money";
import {
  computeBillSettlements,
  type BillSettlement,
  type SupplierAllocationRow,
  type SupplierBillRow,
  type SupplierPaymentRow,
} from "@/lib/suppliers/payments";
import { computeCommittedCosts, type CommittedCostPosition } from "@/lib/purchase-orders/committed";
import { computePoBilling } from "@/lib/purchase-orders/billing";
import { computeVatQuarter } from "@/lib/tax/compute";
import { buildMonthlyReturnDataset, type CisPaymentSnapshotRow } from "@/lib/cis/statements";
import { cisPaymentDueDate, cisTaxMonthLabel } from "@/lib/cis/tax-month";

/**
 * H2-CASH M4 — the money-OUT half of the cash position. PURE: no Supabase, no
 * server-only, no I/O. Imported by the /cash page's service, the tests and
 * nothing else.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `lib/commercial/org-cash.ts` and `server/services/org-cash.ts` are
 * RECEIVABLES-ONLY: collectable, overdue, due-this-week/month, retention held,
 * ready-to-invoice. Money in is not a cash position. This module adds the other
 * side so "cash position" means a position, and it does so by COMPOSITION.
 *
 * ── THIS MODULE COMPUTES NO NEW MONEY MATHS ─────────────────────────────────
 * Every figure below is produced by an EXISTING authority and then summed:
 *
 *   unpaid supplier bills   `computeBillSettlements`   (lib/suppliers/payments)
 *   VAT quarter liability   `computeVatQuarter`        (lib/tax/compute)
 *   CIS due to HMRC         `buildMonthlyReturnDataset`(lib/cis/statements)
 *   CIS deadlines           `cisPaymentDueDate`        (lib/cis/tax-month)
 *   committed spend         `computeCommittedCosts`    (lib/purchase-orders/committed)
 *   ordered-not-yet-billed  `computePoBilling`         (lib/purchase-orders/billing)
 *   payroll                 `payroll_lines.net_pay`    (a stored column, summed)
 *
 * There is no VAT rate here, no CIS rate, no basis apportionment and no
 * settlement formula. If a figure is wrong the defect is in the authority above
 * and must be fixed THERE — a second calculator is how two answers to the same
 * money question come into existence. `__tests__/security/cash-out-no-new-
 * arithmetic.test.ts` asserts that on source.
 *
 * The ONE arithmetic operation this module owns is the position itself:
 * `net = collectableNow − outflowDueNow`. That is the definition of the
 * deliverable, not a re-derivation.
 *
 * ── NON-OVERLAPPING BY CONSTRUCTION (the double-count precedence) ───────────
 * The money-IN doctrine is that categories never double-count. Money out holds
 * the same line, and the precedence is stated once, here:
 *
 *  1. A SUPPLIER BILL BEATS A PURCHASE ORDER. A `finances` row carrying
 *     `purchase_order_id` is the SAME money as the PO that ordered it — the PO
 *     is an intention, the bill is a debt with a settlement ledger behind it. So
 *     the bill wins: `committedNotBilled` is Σ per-PO `computePoBilling().remaining`
 *     floored at 0 (ordered − already invoiced), NEVER the raw PO total. A fully
 *     billed PO therefore contributes ZERO to committed spend and its money is
 *     counted once, in `unpaidBills`.
 *
 *  2. CIS WITHHELD AND UNPAID BILLS ARE ALREADY DISJOINT. `cis_deduction` is
 *     frozen on payments that have ALREADY been made, and those payments'
 *     allocations have already reduced the bill's outstanding balance. Withheld
 *     tax therefore attaches to SETTLED bill value and `unpaidBills` to UNSETTLED
 *     bill value. Nothing to net — but the invariant is tested, because the
 *     tempting shortcut (subtracting withholding from the bill) would be wrong
 *     in the other direction: withholding is not a cost saving, it is a
 *     re-routing of the same cash to HMRC (see lib/suppliers/payments' header).
 *
 *  3. VAT IS AN OFFSET, NOT AN OVERLAP. Input VAT on an unpaid bill appears in
 *     `unpaidBills` (the bill's outstanding is GROSS, VAT included) and reduces
 *     `computeVatQuarter().net_payable`. Those pull in OPPOSITE directions, so
 *     adding both understates nothing and double-counts nothing.
 *
 *  4. PAYROLL IS NET PAY ONLY, AND THAT IS THE CORRECT CASH FIGURE — not a gap.
 *     `net_pay` is the wages leaving on payday. PAYE + employee NI go to HMRC by
 *     the 22nd of the FOLLOWING month, employer NI likewise, and pension reaches
 *     the provider on its own date. Those are employment COST — an accrual on a
 *     different clock — and folding them into a cash position would claim money
 *     leaves the bank on a day it does not. gross = net + PAYE + NI, so nothing
 *     overlaps either. This matches the payroll lane's own `payrollDueThisWeek`,
 *     which stays net-pay-only for exactly this reason; the two surfaces must not
 *     drift apart on what "payroll due" means.
 *
 * ── HONEST CERTAINTY (the existing forecast convention, applied to outflows) ─
 * `lib/commercial/cash-forecast.ts` distinguishes OVERDUE / DUE / PLANNED /
 * UNSCHEDULED with no fake probability. The money-out ladder mirrors it:
 *
 *   OWED       a supplier has invoiced you and it is not settled   (ledger fact)
 *   DUE        a statutory liability with a known deadline         (dated)
 *   COMMITTED  ordered, no invoice yet — the money-out twin of PLANNED
 *   UNTRACKED  CrewFlow cannot know the answer, and says so
 *
 * `isEstimate` is a SEPARATE axis, because a figure can be dated AND estimated
 * (VAT). An estimate is never presented as a liability: it carries the flag, the
 * UI prints the word, and `outflowEstimated` states how much of the headline is
 * estimated so the net position can never be read as a hard number.
 *
 * ── WHAT CREWFLOW CANNOT KNOW, AND THEREFORE DOES NOT CLAIM ─────────────────
 * There is no record anywhere in the product that money was paid to HMRC: the
 * CIS return status domain is `prepared | exported` and deliberately contains no
 * "filed" (20261055000000), and payroll's `finalised` means LOCKED, not PAID. So:
 *   · CIS deductions for tax months whose payment deadline has NOT passed are a
 *     live liability (`cisDueNow`) — nothing could have fallen due yet.
 *   · Deductions for months whose deadline HAS passed are reported separately as
 *     UNTRACKED and are EXCLUDED from the position, because assuming they are
 *     still owed would overstate the outflow for every contractor who pays on
 *     time, and assuming they are paid would hide a real debt. Saying "we don't
 *     track this" is the only honest option.
 *   · Payroll uses DRAFT (not yet finalised) runs only, for the same reason.
 */

// ---------------------------------------------------------------------------
// The certainty ladder
// ---------------------------------------------------------------------------

/** Descending certainty, mirroring cash-forecast's OVERDUE/DUE/PLANNED/UNSCHEDULED. */
export const CASH_OUT_CERTAINTY = ["OWED", "DUE", "COMMITTED", "UNTRACKED"] as const;
export type CashOutCertainty = (typeof CASH_OUT_CERTAINTY)[number];

export const CASH_OUT_COMPONENT_KEYS = [
  "supplier_bills",
  "cis_hmrc",
  "vat_quarter",
  "payroll_draft",
  "committed_not_billed",
  "cis_past_deadline",
] as const;
export type CashOutComponentKey = (typeof CASH_OUT_COMPONENT_KEYS)[number];

/** One row of the money-out breakdown, ready for the UI. */
export interface CashOutComponent {
  key: CashOutComponentKey;
  label: string;
  amount: number;
  certainty: CashOutCertainty;
  /** True when the figure comes from an ESTIMATOR, not a ledger. Never hidden. */
  isEstimate: boolean;
  /** True when this row is inside `outflowDueNow` (and so inside the position). */
  inPosition: boolean;
  /** Plain English: where the number comes from and what it does not include. */
  basis: string;
  /** Drill-through to the underlying records. */
  href: string;
  /** Row count behind the figure (bills, POs, runs), or null when not a count. */
  count: number | null;
  /** Statutory deadline where one exists. */
  dueOn: string | null;
}

// ---------------------------------------------------------------------------
// Row shapes (as the service reads them)
// ---------------------------------------------------------------------------

/** A supplier bill: a `finances` row with `supplier_id` set. */
export type CashOutBillRow = SupplierBillRow & {
  supplier_id: string | null;
  purchase_order_id: string | null;
};

/** A `purchase_orders` row. `total` is the generated gross (subtotal + vat_total). */
export type CashOutPoRow = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  supplier_id: string | null;
  expected_date: string | null;
};

/** A `payroll_runs` row. `status` is `draft | finalised` — finalised means LOCKED. */
export type CashOutPayrollRunRow = {
  id: string;
  status: string;
  cycle: string | null;
  period_start: string | null;
  period_end: string | null;
};

/** A `payroll_lines` row. `net_pay` is a stored column; nothing here re-derives it. */
export type CashOutPayrollLineRow = {
  payroll_run_id: string;
  net_pay: number | string | null;
};

/** The invoice shape `computeVatQuarter` reads (output VAT on PAID invoices). */
export type CashOutVatInvoiceRow = {
  status: string;
  vat_total: number | string | null;
  total: number | string | null;
  amount: number | string | null;
  paid_at: string | null;
  created_at: string;
};

/** The finance shape `computeVatQuarter` reads (input VAT on logged costs). */
export type CashOutVatFinanceRow = {
  vat_total: number | string | null;
  amount: number | string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface OrgCashOutSummary {
  /** Σ per-bill outstanding (GROSS), each capped at its own bill. computeBillSettlements. */
  unpaidBills: number;
  /** Bills with anything still outstanding. */
  unpaidBillCount: number;
  /** Bill value already settled by live payments — carried so the split reconciles. */
  billsSettled: number;

  /** computeVatQuarter().net_payable, floored at 0. AN ESTIMATE (mixed bases). */
  vatDue: number;
  /**
   * A NEGATIVE net_payable as a positive number: HMRC owes you. Reported, never
   * added to money-in — it is an estimate on a different accounting basis and
   * the receivables side is a ledger. Flooring `vatDue` at 0 keeps the outflow
   * from going negative and quietly inflating the net position.
   */
  vatReclaim: number;
  vatQuarterStart: string;

  /** Σ frozen `cis_deduction` for tax months whose HMRC deadline has NOT passed. */
  cisDueNow: number;
  /** The soonest of those deadlines (the 22nd, electronic). */
  cisDueOn: string | null;
  /** Human label of the tax months inside `cisDueNow`. */
  cisDueMonths: string[];
  /**
   * Σ frozen `cis_deduction` for tax months whose deadline HAS passed. UNTRACKED
   * and OUTSIDE the position — CrewFlow holds no record of paying HMRC.
   */
  cisPastDeadline: number;

  /** Σ `payroll_lines.net_pay` for DRAFT runs. AN ESTIMATE (see the header). */
  payrollDraft: number;
  payrollDraftRunCount: number;

  /** Σ per-PO (ordered − already invoiced), floored at 0. Bills take precedence. */
  committedNotBilled: number;
  /** Non-cancelled POs with anything still un-invoiced. */
  committedPoCount: number;
  /** The whole PO commitment picture, unchanged (computeCommittedCosts). */
  committed: CommittedCostPosition;

  /** unpaidBills + cisDueNow + vatDue + payrollDraft. The outflow side of the position. */
  outflowDueNow: number;
  /** The part of `outflowDueNow` that is an ESTIMATE rather than a ledger fact. */
  outflowEstimated: number;
}

export const EMPTY_CASH_OUT: OrgCashOutSummary = {
  unpaidBills: 0,
  unpaidBillCount: 0,
  billsSettled: 0,
  vatDue: 0,
  vatReclaim: 0,
  vatQuarterStart: "",
  cisDueNow: 0,
  cisDueOn: null,
  cisDueMonths: [],
  cisPastDeadline: 0,
  payrollDraft: 0,
  payrollDraftRunCount: 0,
  committedNotBilled: 0,
  committedPoCount: 0,
  committed: { committed: 0, onOrder: 0, partiallyReceived: 0, received: 0, count: 0 },
  outflowDueNow: 0,
  outflowEstimated: 0,
};

/** Non-cancelled PO statuses — the committed authority's own live set. */
const PO_CANCELLED = "cancelled";

/** What CrewFlow can honestly say about CIS you have withheld. */
export interface CisHmrcDue {
  /** Withheld in tax months whose HMRC payment deadline has NOT passed. A debt. */
  dueNow: number;
  /** The soonest of those deadlines (the 22nd, electronic). */
  dueOn: string | null;
  /** Human labels of the tax months inside `dueNow`. */
  dueMonths: string[];
  /** Withheld in months whose deadline HAS passed — CrewFlow cannot know if it was paid. */
  pastDeadline: number;
}

/**
 * Split the frozen CIS snapshots by tax month and classify each month by whether
 * its HMRC payment deadline has passed.
 *
 * `buildMonthlyReturnDataset` is THE authority for a tax month's total
 * deduction (it drops voided payments and folds one line per subcontractor); it
 * is called once per distinct `tax_month_end` present in the rows. Nothing here
 * touches a rate, a basis or a materials figure.
 *
 * Exported because the Daily Briefing's CIS-deadline line needs the SAME answer
 * /cash shows. Two callers, one definition — the briefing has burned this lesson
 * before (it reuses buildOrgCash rather than re-summing invoices).
 */
export function computeCisHmrcDue(
  snapshots: CisPaymentSnapshotRow[],
  todayIso: string,
): CisHmrcDue {
  const monthEnds = [...new Set(snapshots.map((s) => s.tax_month_end))].sort();
  let dueNow = 0;
  let pastDeadline = 0;
  let dueOn: string | null = null;
  const dueMonths: string[] = [];

  for (const end of monthEnds) {
    const dataset = buildMonthlyReturnDataset(snapshots, end);
    if (dataset.totalDeduction <= 0) continue;
    const payBy = cisPaymentDueDate(end);
    // No parsable deadline → treat as UNTRACKED rather than inventing one.
    if (payBy == null || payBy < todayIso) {
      pastDeadline = round2(pastDeadline + dataset.totalDeduction);
      continue;
    }
    dueNow = round2(dueNow + dataset.totalDeduction);
    dueMonths.push(cisTaxMonthLabel(end) ?? end);
    if (dueOn == null || payBy < dueOn) dueOn = payBy;
  }

  return { dueNow, dueOn, dueMonths, pastDeadline };
}

/**
 * Compose the whole money-out side for one org from already-fetched rows.
 *
 * `bills` MUST already be filtered to supplier bills (`supplier_id` set): a
 * `finances` row with no supplier has no settlement ledger and can never be
 * allocated against, so counting it would report every logged receipt as an
 * unpaid payable forever. The service applies that filter; this function does
 * not silently re-scope its input.
 */
export function computeOrgCashOut(input: {
  /** Supplier bills only (`supplier_id` set). */
  bills: CashOutBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
  purchaseOrders: CashOutPoRow[];
  payrollRuns: CashOutPayrollRunRow[];
  payrollLines: CashOutPayrollLineRow[];
  cisSnapshots: CisPaymentSnapshotRow[];
  /** Every invoice — computeVatQuarter applies its own period filter. */
  vatInvoices: CashOutVatInvoiceRow[];
  /** Every finance row (not just bills) — input VAT is on all logged costs. */
  vatFinances: CashOutVatFinanceRow[];
  quarterStartIso: string;
  todayIso: string;
}): OrgCashOutSummary {
  // ── 1. Unpaid supplier bills — the settlement authority, per bill ─────────
  const settlements: BillSettlement[] = computeBillSettlements({
    bills: input.bills,
    payments: input.payments,
    allocations: input.allocations,
  });
  const open = settlements.filter((s) => s.outstanding > 0);
  const unpaidBills = sumMoney(open.map((s) => s.outstanding));
  const billsSettled = sumMoney(settlements.map((s) => s.settled));

  // ── 2. VAT quarter — the tax authority, unchanged ─────────────────────────
  const vat = computeVatQuarter(input.vatInvoices, input.vatFinances, input.quarterStartIso);
  const vatDue = round2(Math.max(0, vat.net_payable));
  const vatReclaim = round2(Math.max(0, -vat.net_payable));

  // ── 3. CIS withheld — the frozen M3/M4 ledger, split by HMRC deadline ─────
  const cis = computeCisHmrcDue(input.cisSnapshots, input.todayIso);

  // ── 4. Payroll — DRAFT runs only (finalised means locked, not paid) ───────
  const draftRunIds = new Set(
    input.payrollRuns.filter((r) => r.status === "draft").map((r) => r.id),
  );
  const draftLines = input.payrollLines.filter((l) => draftRunIds.has(l.payroll_run_id));
  const payrollDraft = sumMoney(draftLines.map((l) => l.net_pay));
  const payrollDraftRunCount = new Set(draftLines.map((l) => l.payroll_run_id)).size;

  // ── 5. Committed spend — PO value NOT yet invoiced (bills take precedence) ─
  const livePos = input.purchaseOrders.filter((p) => p.status !== PO_CANCELLED);
  const committed = computeCommittedCosts(
    input.purchaseOrders.map((p) => ({ status: p.status, total: p.total })),
  );
  const billsByPo = new Map<string, Array<{ amount: number | string | null; vat_total: number | string | null }>>();
  for (const b of input.bills) {
    if (!b.purchase_order_id) continue;
    const list = billsByPo.get(b.purchase_order_id);
    if (list) list.push({ amount: b.amount, vat_total: b.vat_total });
    else billsByPo.set(b.purchase_order_id, [{ amount: b.amount, vat_total: b.vat_total }]);
  }
  let committedNotBilled = 0;
  let committedPoCount = 0;
  for (const po of livePos) {
    // The PO-vs-bills authority. `remaining` may be negative (over-billed); the
    // floor is a floor, not arithmetic — an over-billed PO commits nothing more.
    const billing = computePoBilling({ poTotal: po.total, bills: billsByPo.get(po.id) ?? [] });
    const left = round2(Math.max(0, billing.remaining));
    if (left <= 0) continue;
    committedNotBilled = round2(committedNotBilled + left);
    committedPoCount += 1;
  }

  // ── 6. The outflow side of the position ──────────────────────────────────
  // COMMITTED spend is deliberately OUTSIDE this total, exactly as `plannedCapped`
  // sits outside `collectableNow` on the money-in side: an order with no invoice
  // is not yet a liability. `cisPastDeadline` is outside it too (UNTRACKED).
  const outflowDueNow = round2(unpaidBills + cis.dueNow + vatDue + payrollDraft);
  const outflowEstimated = round2(vatDue + payrollDraft);

  return {
    unpaidBills,
    unpaidBillCount: open.length,
    billsSettled,
    vatDue,
    vatReclaim,
    vatQuarterStart: input.quarterStartIso,
    cisDueNow: cis.dueNow,
    cisDueOn: cis.dueOn,
    cisDueMonths: cis.dueMonths,
    cisPastDeadline: cis.pastDeadline,
    payrollDraft,
    payrollDraftRunCount,
    committedNotBilled,
    committedPoCount,
    committed,
    outflowDueNow,
    outflowEstimated,
  };
}

// ---------------------------------------------------------------------------
// The position
// ---------------------------------------------------------------------------

export interface OrgCashPosition {
  /** From computeOrgCashSummary — retention-netted chase-now cash. A ledger fact. */
  collectableNow: number;
  /** From computeOrgCashOut. */
  outflowDueNow: number;
  /** collectableNow − outflowDueNow. THE position. Signed: a deficit is negative. */
  net: number;
  /** How much of the outflow is an estimate rather than a ledger fact. */
  estimatedOutflow: number;
  /** True when any part of the outflow is estimated — the UI must say so. */
  hasEstimate: boolean;
}

/**
 * The position: what you can collect now, minus what you owe now.
 *
 * NOT floored. A builder who owes more than they can collect needs to see the
 * deficit, and a "position" that cannot go negative is not a position. The
 * estimated share travels WITH the number so no surface can print it as a hard
 * figure without also having the caveat to hand.
 */
export function computeCashPosition(input: {
  collectableNow: number;
  outflowDueNow: number;
  estimatedOutflow: number;
}): OrgCashPosition {
  const collectableNow = round2(Math.max(0, toPounds(input.collectableNow)));
  const outflowDueNow = round2(Math.max(0, toPounds(input.outflowDueNow)));
  const estimatedOutflow = round2(
    Math.min(outflowDueNow, Math.max(0, toPounds(input.estimatedOutflow))),
  );
  return {
    collectableNow,
    outflowDueNow,
    net: round2(collectableNow - outflowDueNow),
    estimatedOutflow,
    hasEstimate: estimatedOutflow > 0,
  };
}

// ---------------------------------------------------------------------------
// The UI breakdown
// ---------------------------------------------------------------------------

/**
 * Turn the summary into the ordered rows the page prints — most certain first,
 * each carrying its own certainty word, estimate flag and drill-through.
 *
 * Zero-value rows are dropped EXCEPT `supplier_bills`, which is always shown: an
 * absent payables line reads as "we have no idea", whereas "£0 owed to
 * suppliers" is a statement. The two rows outside the position
 * (`committed_not_billed`, `cis_past_deadline`) appear only when non-zero,
 * because each one needs a sentence of explanation and a page should not spend
 * that on a nil.
 */
export function buildCashOutComponents(s: OrgCashOutSummary): CashOutComponent[] {
  const rows: CashOutComponent[] = [
    {
      key: "supplier_bills",
      label: "Unpaid supplier bills",
      amount: s.unpaidBills,
      certainty: "OWED",
      isEstimate: false,
      inPosition: true,
      basis:
        "Supplier invoices you've recorded, minus what you've already paid against them. VAT included, because that's the cash the supplier is owed.",
      href: "/suppliers",
      count: s.unpaidBillCount,
      dueOn: null,
    },
    {
      key: "cis_hmrc",
      label: "CIS deductions to pay HMRC",
      amount: s.cisDueNow,
      certainty: "DUE",
      isEstimate: false,
      inPosition: true,
      basis:
        "Tax you withheld from subcontractors and still hold. Pay HMRC by the 22nd (19th by post). Deductions whose deadline has already passed are listed separately — CrewFlow doesn't record HMRC payments.",
      href: "/cis",
      count: null,
      dueOn: s.cisDueOn,
    },
    {
      key: "vat_quarter",
      label: "VAT this quarter",
      amount: s.vatDue,
      certainty: "DUE",
      isEstimate: true,
      inPosition: true,
      basis:
        "Output VAT on invoices marked paid this quarter, less input VAT on costs logged this quarter. An estimate — the two halves use different bases, and a VAT stagger or the cash scheme changes it.",
      href: "/tax",
      count: null,
      dueOn: null,
    },
    {
      key: "payroll_draft",
      label: "Draft payroll",
      amount: s.payrollDraft,
      certainty: "DUE",
      isEstimate: true,
      inPosition: true,
      basis:
        "Net pay on payroll runs you haven't finalised yet — the wages themselves, which is the cash leaving on payday. Employer NI and the PAYE/NI you owe HMRC are due by the 22nd of the following month, and pension goes to the provider on its own date, so they are NOT in this figure: employment cost is an accrual, this is a cash position. The net-pay figure is itself an estimate until the run is finalised.",
      href: "/payroll",
      count: s.payrollDraftRunCount,
      dueOn: null,
    },
    {
      key: "committed_not_billed",
      label: "Ordered, not yet invoiced",
      amount: s.committedNotBilled,
      certainty: "COMMITTED",
      isEstimate: false,
      inPosition: false,
      basis:
        "Purchase orders you've raised that the supplier hasn't invoiced yet. Money you've committed, not money you owe — so it's outside the position above. Anything already invoiced sits in unpaid bills instead, never in both.",
      href: "/purchase-orders",
      count: s.committedPoCount,
      dueOn: null,
    },
    {
      key: "cis_past_deadline",
      label: "CIS past the HMRC deadline",
      amount: s.cisPastDeadline,
      certainty: "UNTRACKED",
      isEstimate: false,
      inPosition: false,
      basis:
        "CIS you withheld in tax months whose payment deadline has already passed. CrewFlow has no record of what you've paid HMRC, so this is neither counted as owed nor assumed settled — check it against your bank.",
      href: "/cis",
      count: null,
      dueOn: null,
    },
  ];
  return rows.filter((r) => r.key === "supplier_bills" || r.amount > 0);
}

// ---------------------------------------------------------------------------
// The payables queue (drill-through)
// ---------------------------------------------------------------------------

/** An actionable unpaid-bill row — the money-out twin of `CashQueueItem`. */
export interface CashOutQueueItem {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  reference: string | null;
  billDate: string | null;
  /** Bill gross (amount + vat_total). */
  gross: number;
  /** Still outstanding on this bill. */
  outstanding: number;
  /** "unpaid" | "part_paid" — a fully-paid bill never reaches the queue. */
  status: BillSettlement["status"];
  href: string;
}

/**
 * The biggest open bills, largest outstanding first.
 *
 * Every figure comes straight off `computeBillSettlements` — this function
 * chooses an order and a link and computes nothing. The link goes to the
 * supplier's PAYMENTS surface, which is where a bill is actually settled.
 */
export function buildUnpaidBillQueue(input: {
  bills: CashOutBillRow[];
  payments: SupplierPaymentRow[];
  allocations: SupplierAllocationRow[];
  /** supplier id → display name. */
  supplierNames: Map<string, string>;
}): CashOutQueueItem[] {
  const settlements = computeBillSettlements({
    bills: input.bills,
    payments: input.payments,
    allocations: input.allocations,
  });
  const byId = new Map(settlements.map((s) => [s.billId, s]));
  const items: CashOutQueueItem[] = [];
  for (const bill of input.bills) {
    const s = byId.get(bill.id);
    if (!s || s.outstanding <= 0) continue;
    const supplierId = bill.supplier_id ?? null;
    items.push({
      id: bill.id,
      supplierId,
      supplierName: supplierId ? input.supplierNames.get(supplierId) ?? null : null,
      reference: bill.reference ?? null,
      billDate: bill.bill_date ?? null,
      gross: s.gross,
      outstanding: s.outstanding,
      status: s.status,
      href: supplierId ? `/suppliers/${supplierId}/payments` : "/suppliers",
    });
  }
  // Stable total order: biggest debt first, then oldest bill, then id.
  items.sort(
    (a, b) =>
      b.outstanding - a.outstanding ||
      (a.billDate ?? "").localeCompare(b.billDate ?? "") ||
      a.id.localeCompare(b.id),
  );
  return items;
}

/** Certainty words for the UI — plain English, never a fake percentage. */
export const CASH_OUT_CERTAINTY_LABEL: Record<CashOutCertainty, string> = {
  OWED: "Owed",
  DUE: "Due",
  COMMITTED: "Committed",
  UNTRACKED: "Not tracked",
};

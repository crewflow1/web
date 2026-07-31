import { round2 } from "@/lib/money";
import type { BriefingCategory, BriefingItem, BriefingSeverity } from "./types";

/**
 * Structured, already-fetched facts for one org+user. The composer is PURE —
 * server/services/briefing.ts does the RLS-scoped reads and hands the
 * aggregates here, so all thresholds and ranking are unit-testable without a
 * database, and the exact same numbers a builder sees are the ones asserted.
 *
 * Each field maps to AT MOST ONE briefing item, emitted only when its trigger
 * condition holds — the briefing is a short "here are the few things that need
 * you", never a firehose of individual rows.
 */
export interface BriefingInput {
  now: Date;
  /** Overdue receivables (isInvoiceOverdue authority). */
  overdue: { count: number; totalAmount: number; maxDaysOverdue: number };
  /** Quotes sent but not yet accepted/declined and going stale. */
  followUpQuotes: { count: number; totalAmount: number; oldestDaysStale: number };
  /** Jobs scheduled for tomorrow with nobody assigned. */
  jobsTomorrowUnassigned: number;
  /** Live H&S exceptions (from buildHealthSafetySnapshot). */
  permitsExpiredLive: number;
  permitsExpiringSoon: number;
  ramsReviewOverdue: number;
  activeJobsNoCurrentRams: number;
  toolboxAwaitingAck: number;
  /** Compliance documents approaching expiry. */
  complianceExpiring: { count: number; soonestDays: number | null };
  /** High-value leads in an open stage that have aged without a decision. */
  coldLeads: { count: number; totalValue: number };
  /** Construction retention now due for release. */
  retentionDue: { dueNow: number; dueJobCount: number };
  /** H2-CASH: planned billing-stage work not yet invoiced (money ready to bill). */
  readyToInvoice: { totalAmount: number; jobCount: number };
  /** H2-CASH M3: issued invoices falling due within the next 7 days (forward cash). */
  cashDueSoon: number;
  /** H2-CASH M3: agreed contract value with no billing stage and no invoice. */
  unscheduled: { totalAmount: number; jobCount: number };
  /**
   * H2-CASH M4: CIS you withheld from subcontractors and must pay HMRC, with the
   * statutory deadline (server/services/org-cash-out.ts → loadCisHmrcSignal).
   *
   * OPTIONAL, and absent means "no signal" rather than "nothing due". A tenant
   * with no subcontractors, a viewer without admin rights (the ledger is
   * admin-only at the database), and a failed read all produce the same quiet
   * output — the briefing can miss a line, never invent one.
   *
   * THE ONLY MONEY-OUT LINE, and deliberately so. The money-out surface has five
   * other components and none of them earns a briefing row:
   *   · unpaid supplier bills carry no due date, so there is no day on which
   *     they "need you" — a permanent line is wallpaper;
   *   · VAT and draft payroll are ESTIMATES, and the briefing must not spend a
   *     row on a number it would then have to hedge;
   *   · committed spend is not a liability at all;
   *   · a NEGATIVE net position is the NORMAL state of a construction business
   *     that pays suppliers on 30 days and gets paid on 60. A signal that fires
   *     for a healthy company is noise, and noise is how people learn to ignore
   *     the safety lines above.
   * CIS is different on every count: a frozen ledger fact, a statutory date, an
   * HMRC penalty for missing it, and one clear action.
   *
   * `dueInDays` is whole UK days to the deadline and is never negative — a
   * passed deadline emits NOTHING, because CrewFlow holds no record of what was
   * paid to HMRC and must not accuse a contractor of being late.
   */
  cisDueToHmrc?: { amount: number; dueInDays: number | null; payBy: string | null };
  /**
   * LANE C: deterministic schedule conflicts found in the next fortnight
   * (server/services/schedule-integrity.ts). Read-only detection — the briefing
   * reports and explains them; nothing is ever moved automatically.
   *
   * `soonestDays` is whole UK days from today (0 = today) and drives severity,
   * so a double-booking today outranks one next month. Two of the five detected
   * classes are deliberately absent here and live only on the detector page:
   * `assignment_off_rota` is a records mismatch rather than a person in two
   * places, and `asset_double_booked` is a data-integrity fault the DB's own
   * unique index makes near-unreachable — neither earns a line in a morning brief.
   */
  scheduleConflicts: {
    doubleBooked: { count: number; soonestDays: number | null };
    leaveClashes: { count: number; soonestDays: number | null };
    /**
     * Imminent jobs with NOBODY on them, counted from the day AFTER tomorrow.
     * `jobs_unassigned_tomorrow` already owns tomorrow, so the two windows are
     * disjoint by construction and the same job is never counted twice.
     */
    unassignedLater: { count: number; soonestDays: number | null };
  };
  /**
   * FLEET: deterministic vehicle-compliance detection (lib/fleet/compliance.ts).
   * Detection only — nothing is sent, booked or renewed automatically.
   *
   * `legalBreach` is the one fleet signal that reaches `critical`, and it is
   * narrow on purpose: an expired MOT or insurance on a vehicle the company
   * still has IN SERVICE. Driving on either is a Road Traffic Act offence
   * (s.47 / s.143), which is the same class of live legal exposure the
   * expired-permit and no-RAMS lines already spend `critical` on. Expired road
   * tax, and any lapse on a vehicle that is off road or in the workshop, land in
   * `otherOverdue` at `high` — real, but not a vehicle being driven illegally
   * today. That split is what stops `critical` inflating into wallpaper.
   */
  fleetCompliance: {
    legalBreach: { count: number; vehicleCount: number; maxDaysOverdue: number };
    otherOverdue: { count: number; vehicleCount: number; maxDaysOverdue: number };
    dueSoon: { count: number; vehicleCount: number; soonestDays: number | null };
  };
  /**
   * O3 OPERATIONAL STOCK: items at or below their own reorder level, and items
   * with nothing left at all (server/services/stock.ts → loadLowStockSignal).
   *
   * OPTIONAL, and absent means "no signal" rather than "zero". A tenant that
   * tracks no stock, and a build where the read failed, both produce the same
   * quiet output — the briefing can miss a line, never invent one.
   *
   * DETECTION ONLY. Nothing is ordered, no purchase order is drafted and no
   * supplier is contacted; the item links to /stock and a human decides. And
   * nothing here carries money: stock in this milestone is quantities, because
   * materials are already expensed when the supplier's bill is recorded.
   */
  lowStock?: { low: number; out: number; worstName: string | null };
  /**
   * H2-COMMERCIAL THREE-WAY MATCH: purchase orders where ORDERED, DELIVERED and
   * INVOICED disagree (server/services/po-matching.ts →
   * loadSupplierBillVarianceSignal). All figures gross £, exact to the penny.
   *
   * THE FIRST MONEY-OUT SIGNAL IN THIS BRIEF, and it duplicates nothing. Every
   * money line above is money COMING IN or waiting to be billed — overdue
   * invoices, retention due back, ready-to-invoice, cash due this week,
   * unscheduled contract value. None of them can tell an owner that a supplier
   * has invoiced more than was ordered, or that a delivery has been sitting
   * unbilled and the job's cost is understated. That is a different pocket.
   *
   * OPTIONAL, and absent means "no signal" rather than "zero": a company with no
   * purchase orders and a build where the read failed produce the same quiet
   * output. The briefing can miss a line, never invent one.
   *
   * DETECTION ONLY — no bill is credited, no cost is posted, no supplier is
   * contacted. The line links to the queue and a human rings the merchant.
   */
  supplierBillVariance?: {
    count: number;
    /**
     * Money the suppliers are asking for that the orders do not justify —
     * Σ per-order (billed − min(committed, received)). Already double-count-free:
     * over-billed and billed-not-received are often the SAME pounds seen from
     * two angles, so this must never be reconstructed by adding the two
     * per-kind figures below (see lib/purchase-orders/matching.ts).
     */
    moneyOutAtRisk: number;
    overBilled: number;
    billedNotReceived: number;
    /** The accrual. NEVER added to the money at risk: nothing has been overpaid. */
    receivedNotBilled: number;
  };
  /** Item keys the caller dismissed today — excluded from the output. */
  dismissedKeys: ReadonlySet<string>;
}

// Band gaps (1000) exceed the maximum secondary bonus (money ≤200 + urgency ≤150
// = 350), so severity STRICTLY dominates: money/urgency only order items WITHIN a
// severity band, never lift a lower-severity item above a higher one.
const SEVERITY_BASE: Record<BriefingSeverity, number> = {
  critical: 4000,
  high: 3000,
  medium: 2000,
  low: 1000,
};

/** Saturating money weight so £18k outranks £500 without ever dwarfing severity. */
function moneyWeight(amount: number): number {
  if (amount <= 0) return 0;
  return Math.min(200, Math.round(Math.log10(amount + 1) * 40));
}

/**
 * Deterministic rank. Severity dominates; money and urgency are secondary
 * nudges within a severity band. `urgencyDays <= 0` means overdue/expired
 * (worse the further past), `> 0` means upcoming (sooner ranks higher).
 */
function rankScore(
  severity: BriefingSeverity,
  opts: { amount?: number | null; urgencyDays?: number | null },
): number {
  let s = SEVERITY_BASE[severity];
  const amt = opts.amount ?? 0;
  if (amt > 0) s += moneyWeight(amt);
  const u = opts.urgencyDays;
  if (u != null) {
    if (u <= 0) s += Math.min(150, 30 + Math.abs(u) * 4);
    else s += Math.max(0, 60 - u * 6);
  }
  return s;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return Math.abs(n) === 1 ? singular : pluralForm;
}

/**
 * Severity for a schedule conflict, from proximity alone. Mirrors
 * `conflictSeverity` in lib/schedule/conflicts.ts and is capped at "high" for
 * the same reason: `critical` is reserved for live safety/legal breaches.
 */
function scheduleSeverity(soonestDays: number | null): BriefingSeverity {
  if (soonestDays == null) return "medium";
  if (soonestDays <= 1) return "high";
  if (soonestDays <= 7) return "medium";
  return "low";
}

/** ", the soonest today" / " — the soonest in 4 days". Empty when unknown. */
function whenPhrase(soonestDays: number | null): string {
  if (soonestDays == null) return "";
  if (soonestDays <= 0) return ", the soonest today";
  if (soonestDays === 1) return ", the soonest tomorrow";
  return `, the soonest in ${soonestDays} days`;
}

function gbp(n: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Money for the supplier-bill variance line, EXACT to the penny.
 *
 * `gbp` above rounds to whole pounds, which is right for a £14k receivables
 * headline and WRONG here. The three-way match's promise is that no variance is
 * hidden and no threshold is applied, so a one-penny over-billing rendered as
 * "£0" would break that promise in the one place the number matters most.
 * Whole amounts still read as whole pounds, so the common case is unchanged.
 */
function gbpExact(n: number): string {
  const v = round2(n);
  const dp = Number.isInteger(v) ? 0 : 2;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(v);
}

/**
 * Build the ranked briefing for one org+user. Emits one aggregate item per
 * triggered signal family, filters the caller's dismissed keys, and sorts by
 * score desc with a stable tiebreak on key — so a given input always produces
 * the identical, order-stable output.
 */
export function composeBriefing(input: BriefingInput): BriefingItem[] {
  const items: BriefingItem[] = [];
  const add = (
    key: string,
    category: BriefingCategory,
    severity: BriefingSeverity,
    title: string,
    detail: string,
    href: string,
    extra: { amount?: number | null; count?: number | null; urgencyDays?: number | null } = {},
  ): void => {
    items.push({
      key,
      category,
      severity,
      title,
      detail,
      href,
      amount: extra.amount ?? null,
      count: extra.count ?? null,
      score: rankScore(severity, { amount: extra.amount, urgencyDays: extra.urgencyDays }),
    });
  };

  // --- SAFETY (highest consequence) ----------------------------------------
  if (input.activeJobsNoCurrentRams > 0) {
    const n = input.activeJobsNoCurrentRams;
    add(
      "jobs_without_rams", "safety", "critical",
      `${n} active ${plural(n, "job")} without a current RAMS`,
      `${n} in-progress ${plural(n, "job")} with no issued risk assessment. Issue one before work continues on site.`,
      "/health-safety", { count: n },
    );
  }
  if (input.permitsExpiredLive > 0) {
    const n = input.permitsExpiredLive;
    add(
      "permits_expired", "safety", "critical",
      `${n} live ${plural(n, "permit")} past expiry`,
      `${n} permit-to-work ${plural(n, "permit")} still marked active but past the expiry date. Close or reissue.`,
      "/health-safety", { count: n, urgencyDays: 0 },
    );
  }
  if (input.permitsExpiringSoon > 0) {
    const n = input.permitsExpiringSoon;
    add(
      "permits_expiring", "safety", "high",
      `${n} ${plural(n, "permit")} expiring within 24h`,
      `${n} permit-to-work ${plural(n, "permit")} due to expire in the next 24 hours.`,
      "/health-safety", { count: n, urgencyDays: 1 },
    );
  }
  if (input.ramsReviewOverdue > 0) {
    const n = input.ramsReviewOverdue;
    add(
      "rams_review_overdue", "safety", "high",
      `${n} RAMS ${plural(n, "review")} overdue`,
      `${n} issued risk ${plural(n, "assessment")} past the scheduled review date.`,
      "/health-safety", { count: n, urgencyDays: 0 },
    );
  }
  if (input.complianceExpiring.count > 0) {
    const n = input.complianceExpiring.count;
    const soon = input.complianceExpiring.soonestDays;
    add(
      "compliance_expiring", "safety", soon != null && soon <= 7 ? "high" : "medium",
      `${n} compliance ${plural(n, "document")} expiring`,
      `${n} insurance / certificate ${plural(n, "document")} nearing expiry${soon != null ? `, the soonest in ${soon} ${plural(soon, "day")}` : ""}.`,
      "/compliance", { count: n, urgencyDays: soon },
    );
  }
  if (input.toolboxAwaitingAck > 0) {
    const n = input.toolboxAwaitingAck;
    add(
      "toolbox_awaiting_ack", "safety", "medium",
      `${n} toolbox ${plural(n, "talk")} awaiting sign-off`,
      `${n} delivered toolbox ${plural(n, "talk")} still waiting on operative acknowledgement.`,
      "/health-safety", { count: n },
    );
  }

  // Fleet compliance (TRAIN C). Categorised as `safety` rather than
  // `operations`: an untaxed, untested or uninsured vehicle on the road is a
  // legal exposure for the company and its driver, not a scheduling nuisance.
  const fleet = input.fleetCompliance;
  if (fleet.legalBreach.count > 0) {
    const v = fleet.legalBreach.vehicleCount;
    add(
      "fleet_legal_breach", "safety", "critical",
      `${v} in-service ${plural(v, "vehicle")} without valid MOT or insurance`,
      `${v} ${plural(v, "vehicle")} marked in service ${v === 1 ? "has" : "have"} an expired MOT or insurance — ` +
        `the oldest by ${fleet.legalBreach.maxDaysOverdue} ${plural(fleet.legalBreach.maxDaysOverdue, "day")}. ` +
        `Driving on either is an offence. Take ${v === 1 ? "it" : "them"} off road or renew today.`,
      "/fleet/compliance", { count: v, urgencyDays: -fleet.legalBreach.maxDaysOverdue },
    );
  }
  if (fleet.otherOverdue.count > 0) {
    const n = fleet.otherOverdue.count;
    add(
      "fleet_compliance_overdue", "safety", "high",
      `${n} vehicle compliance ${plural(n, "date")} passed`,
      `${n} MOT / insurance / road tax / service ${plural(n, "date")} across ${fleet.otherOverdue.vehicleCount} ` +
        `${plural(fleet.otherOverdue.vehicleCount, "vehicle")} ${n === 1 ? "is" : "are"} past due — ` +
        `the oldest by ${fleet.otherOverdue.maxDaysOverdue} ${plural(fleet.otherOverdue.maxDaysOverdue, "day")}.`,
      "/fleet/compliance", { count: n, urgencyDays: -fleet.otherOverdue.maxDaysOverdue },
    );
  }
  if (fleet.dueSoon.count > 0) {
    const n = fleet.dueSoon.count;
    const d = fleet.dueSoon.soonestDays;
    add(
      "fleet_compliance_due_soon", "safety", d != null && d <= 7 ? "high" : "medium",
      `${n} vehicle ${plural(n, "renewal")} coming up`,
      `${n} MOT / insurance / road tax / service ${plural(n, "renewal")} due across ` +
        `${fleet.dueSoon.vehicleCount} ${plural(fleet.dueSoon.vehicleCount, "vehicle")}` +
        `${d != null ? `, the soonest in ${d} ${plural(d, "day")}` : ""}. Book ${n === 1 ? "it" : "them"} in.`,
      "/fleet/compliance", { count: n, urgencyDays: d },
    );
  }

  // --- OPERATIONS: stock ---------------------------------------------------
  // CAPPED AT "high", and only when something is actually at zero. Running out
  // of blocks stops a gang working today, which is a real operational cost —
  // but it is not a safety breach or a legal exposure, and `critical` is
  // reserved for those (the same cap `scheduleSeverity` applies, for the same
  // reason). Merely LOW is "medium": it is a nudge with days of warning in it,
  // and a nudge that shouts is a nudge people learn to ignore.
  //
  // ONE line, never two: out-of-stock and low are the same conversation ("order
  // this"), and splitting them would put two stock rows in a five-row brief.
  const stock = input.lowStock;
  if (stock && (stock.out > 0 || stock.low > 0)) {
    const n = stock.out + stock.low;
    const named = stock.worstName ? ` — ${stock.worstName}` : "";
    add(
      "stock_low",
      "operations",
      stock.out > 0 ? "high" : "medium",
      stock.out > 0
        ? `${stock.out} stock ${plural(stock.out, "item")} at zero`
        : `${stock.low} stock ${plural(stock.low, "item")} running low`,
      stock.out > 0
        ? `${stock.out} ${plural(stock.out, "item")} you track ${stock.out === 1 ? "has" : "have"} nothing left` +
          `${stock.low > 0 ? `, and ${stock.low} more ${stock.low === 1 ? "is" : "are"} at or below the reorder level` : ""}` +
          `${named}. Order before someone drives to the merchant.`
        : `${stock.low} ${plural(stock.low, "item")} ${stock.low === 1 ? "is" : "are"} at or below the reorder level you set${named}.`,
      "/stock",
      { count: n, urgencyDays: stock.out > 0 ? 0 : null },
    );
  }

  // --- MONEY ---------------------------------------------------------------
  if (input.overdue.count > 0 && input.overdue.totalAmount > 0) {
    const n = input.overdue.count;
    const sev: BriefingSeverity =
      input.overdue.totalAmount >= 5000 || input.overdue.maxDaysOverdue >= 30 ? "high" : "medium";
    add(
      "overdue_invoices", "money", sev,
      `${gbp(input.overdue.totalAmount)} overdue`,
      `${gbp(input.overdue.totalAmount)} across ${n} ${plural(n, "invoice")} is overdue — the oldest by ${input.overdue.maxDaysOverdue} ${plural(input.overdue.maxDaysOverdue, "day")}.`,
      "/invoices?status=overdue",
      { amount: input.overdue.totalAmount, count: n, urgencyDays: -input.overdue.maxDaysOverdue },
    );
  }
  if (input.retentionDue.dueNow > 0) {
    const n = input.retentionDue.dueJobCount;
    add(
      "retention_due", "money", input.retentionDue.dueNow >= 5000 ? "high" : "medium",
      `${gbp(input.retentionDue.dueNow)} retention due back`,
      `${gbp(input.retentionDue.dueNow)} of held retention across ${n} ${plural(n, "job")} has reached its release date.`,
      "/dashboard", { amount: input.retentionDue.dueNow, count: n },
    );
  }
  if (input.readyToInvoice.totalAmount > 0) {
    const n = input.readyToInvoice.jobCount;
    add(
      "billing_ready", "money", "medium",
      `${gbp(input.readyToInvoice.totalAmount)} ready to invoice`,
      `${gbp(input.readyToInvoice.totalAmount)} of planned work across ${n} ${plural(n, "job")} is ready to invoice.`,
      "/cash", { amount: input.readyToInvoice.totalAmount, count: n },
    );
  }
  // Forward-looking cash — LOW severity so it can never rank above a safety
  // breach or overdue debt (severity strictly dominates). Planned billing is a
  // plan, never presented as guaranteed cash.
  if (input.cashDueSoon > 0) {
    add(
      "cash_due_soon", "money", "low",
      `${gbp(input.cashDueSoon)} due from customers this week`,
      `${gbp(input.cashDueSoon)} of issued invoices falls due in the next 7 days.`,
      "/cash", { amount: input.cashDueSoon, urgencyDays: 3 },
    );
  }
  // Money OUT — the one outflow line that earns a row (see the field's note).
  // Capped at "high": missing the 22nd is an HMRC penalty, which is a real
  // financial and legal exposure but not a live safety breach, and `critical` is
  // reserved for those. Only fires while the deadline is still ahead.
  const cis = input.cisDueToHmrc;
  if (cis && cis.amount > 0 && cis.dueInDays != null && cis.dueInDays >= 0) {
    const d = cis.dueInDays;
    add(
      "cis_due_hmrc",
      "money",
      d <= 7 ? "high" : "medium",
      `${gbp(cis.amount)} CIS to pay HMRC`,
      `${gbp(cis.amount)} of CIS you've deducted from subcontractors is due to HMRC ` +
        `${d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`}` +
        `${cis.payBy ? ` (by ${cis.payBy})` : ""}. ` +
        `Pay by the 22nd — the 19th if you're paying by post. CrewFlow doesn't file or pay for you.`,
      "/cis",
      { amount: cis.amount, urgencyDays: d },
    );
  }
  // Supplier-bill three-way match. ONE line, never three: over-billed, billed-
  // not-received and the unbilled accrual are the same conversation ("go through
  // the merchant's paperwork"), and splitting them would put three rows in a
  // five-row brief. Capped at "high" — being over-billed is money leaving that
  // shouldn't, but `critical` stays reserved for live safety and legal exposure.
  //
  // The headline number is `moneyOutAtRisk` — the money the company is being
  // asked to pay and may not owe — and it is taken AS GIVEN, never rebuilt by
  // adding overBilled + billedNotReceived: those two are usually the same pounds
  // seen from two angles, and summing them would overstate the exposure (a £120
  // over-billing on a fully delivered order is £120, not £240). The accrual is
  // excluded for a different reason: nothing has been overpaid there, the cost is
  // simply missing from the job.
  const variance = input.supplierBillVariance;
  if (variance && variance.count > 0) {
    const atRisk = round2(variance.moneyOutAtRisk);
    const n = variance.count;
    const wrongWay = atRisk > 0;
    add(
      "supplier_bill_variance",
      "money",
      wrongWay ? "high" : "medium",
      wrongWay
        ? `${gbpExact(atRisk)} billed above what was ordered or delivered`
        : `${gbpExact(variance.receivedNotBilled)} delivered and not yet billed`,
      wrongWay
        ? `${n} purchase ${plural(n, "order")} where the supplier has invoiced more than the order commits ` +
          `or more than has arrived on site — ${gbpExact(atRisk)} in total. Check the paperwork before paying.`
        : `${gbpExact(variance.receivedNotBilled)} of goods across ${n} ${plural(n, "order")} has been delivered with ` +
          `no supplier bill against it, so ${n === 1 ? "that job's" : "those jobs'"} cost is understated until the invoice arrives.`,
      "/purchase-orders/matching",
      { amount: wrongWay ? atRisk : variance.receivedNotBilled, count: n },
    );
  }

  if (input.unscheduled.totalAmount > 0 && input.unscheduled.jobCount > 0) {
    const n = input.unscheduled.jobCount;
    add(
      "unscheduled_value", "money", "low",
      `${gbp(input.unscheduled.totalAmount)} not yet scheduled to bill`,
      `${n} ${plural(n, "job")} ${n === 1 ? "has" : "have"} ${gbp(input.unscheduled.totalAmount)} of agreed contract value with no billing stage or invoice yet — plan how you'll bill it.`,
      "/cash", { amount: input.unscheduled.totalAmount, count: n },
    );
  }

  // --- OPERATIONS ----------------------------------------------------------
  if (input.jobsTomorrowUnassigned > 0) {
    const n = input.jobsTomorrowUnassigned;
    add(
      "jobs_unassigned_tomorrow", "operations", "high",
      `${n} ${plural(n, "job")} tomorrow with nobody assigned`,
      `${n} ${plural(n, "job")} scheduled for tomorrow with no one assigned yet.`,
      "/jobs/calendar", { count: n, urgencyDays: 1 },
    );
  }

  // Schedule integrity (LANE C). Capped at "high" on purpose: a clash costs a
  // day, a safety breach costs a prosecution — these must never out-shout the
  // safety block above. Ordering within the band carries the urgency instead.
  const sched = input.scheduleConflicts;
  if (sched.doubleBooked.count > 0) {
    const n = sched.doubleBooked.count;
    const d = sched.doubleBooked.soonestDays;
    add(
      "schedule_double_booked", "operations", scheduleSeverity(d),
      `${n} scheduling ${plural(n, "clash", "clashes")} in the next fortnight`,
      `${n} ${plural(n, "case")} where the same person is on two overlapping shifts${whenPhrase(d)}. ` +
        `Nobody can be in two places — move or shorten one shift.`,
      "/staff/rota/conflicts", { count: n, urgencyDays: d },
    );
  }
  if (sched.leaveClashes.count > 0) {
    const n = sched.leaveClashes.count;
    const d = sched.leaveClashes.soonestDays;
    add(
      "schedule_leave_clash", "operations", scheduleSeverity(d),
      `${n} ${plural(n, "shift")} booked during approved leave`,
      `${n} rostered ${plural(n, "shift")} ${n === 1 ? "falls" : "fall"} inside leave you have already approved${whenPhrase(d)}. ` +
        `Arrange cover or revisit the leave.`,
      "/staff/rota/conflicts", { count: n, urgencyDays: d },
    );
  }
  if (sched.unassignedLater.count > 0) {
    const n = sched.unassignedLater.count;
    const d = sched.unassignedLater.soonestDays;
    add(
      "schedule_unassigned_soon", "operations", scheduleSeverity(d),
      `${n} upcoming ${plural(n, "job")} with nobody on ${n === 1 ? "it" : "them"}`,
      `${n} ${plural(n, "job")} in the next fortnight ${n === 1 ? "has" : "have"} no assignee and nobody on the rota${whenPhrase(d)}.`,
      "/staff/rota/conflicts", { count: n, urgencyDays: d },
    );
  }

  // --- SALES ---------------------------------------------------------------
  if (input.followUpQuotes.count > 0) {
    const n = input.followUpQuotes.count;
    add(
      "quotes_follow_up", "sales", "medium",
      `${n} ${plural(n, "quote")} to follow up`,
      `${n} sent ${plural(n, "quote")} worth ${gbp(input.followUpQuotes.totalAmount)} with no decision yet — the oldest ${input.followUpQuotes.oldestDaysStale} ${plural(input.followUpQuotes.oldestDaysStale, "day")} old.`,
      "/quotes", { amount: input.followUpQuotes.totalAmount, count: n, urgencyDays: -input.followUpQuotes.oldestDaysStale },
    );
  }
  if (input.coldLeads.count > 0) {
    const n = input.coldLeads.count;
    add(
      "leads_cold", "sales", "medium",
      `${n} high-value ${plural(n, "lead")} still open`,
      `${n} open ${plural(n, "lead")} worth ${gbp(input.coldLeads.totalValue)} opened more than two weeks ago and not yet won or lost.`,
      "/leads", { amount: input.coldLeads.totalValue, count: n },
    );
  }

  return items
    // A live safety BREACH (work without a RAMS, an expired-but-active permit) must
    // not be snoozable — hiding it for a day would bury a legal exposure. Those keys
    // persist until the underlying condition clears; everything else is dismissible.
    .filter((it) => !(isDismissibleBriefingKey(it.key) && input.dismissedKeys.has(it.key)))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/**
 * Always-critical safety breaches that a user cannot snooze off their briefing.
 * `fleet_legal_breach` joins them for the same reason the other two are here:
 * it only ever fires on a vehicle the company has in service with no valid MOT
 * or insurance, and hiding a live Road Traffic Act exposure for a day would
 * bury exactly the thing a director is personally on the hook for.
 */
const NON_DISMISSIBLE_KEYS: readonly string[] = [
  "jobs_without_rams",
  "permits_expired",
  "fleet_legal_breach",
];

export function isDismissibleBriefingKey(key: string): boolean {
  return !NON_DISMISSIBLE_KEYS.includes(key);
}

/** Every key the composer can emit — the allowlist the dismiss action validates against. */
export const BRIEFING_ITEM_KEYS = [
  "jobs_without_rams",
  "permits_expired",
  "permits_expiring",
  "rams_review_overdue",
  "compliance_expiring",
  "toolbox_awaiting_ack",
  "fleet_legal_breach",
  "fleet_compliance_overdue",
  "fleet_compliance_due_soon",
  "overdue_invoices",
  "retention_due",
  "billing_ready",
  "cash_due_soon",
  "cis_due_hmrc",
  "unscheduled_value",
  "supplier_bill_variance",
  "jobs_unassigned_tomorrow",
  "stock_low",
  "schedule_double_booked",
  "schedule_leave_clash",
  "schedule_unassigned_soon",
  "quotes_follow_up",
  "leads_cold",
] as const;

export type BriefingItemKey = (typeof BRIEFING_ITEM_KEYS)[number];

export function isBriefingItemKey(v: string): v is BriefingItemKey {
  return (BRIEFING_ITEM_KEYS as readonly string[]).includes(v);
}

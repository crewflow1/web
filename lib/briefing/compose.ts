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

/** Always-critical safety breaches that a user cannot snooze off their briefing. */
const NON_DISMISSIBLE_KEYS: readonly string[] = ["jobs_without_rams", "permits_expired"];

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
  "overdue_invoices",
  "retention_due",
  "billing_ready",
  "cash_due_soon",
  "unscheduled_value",
  "jobs_unassigned_tomorrow",
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

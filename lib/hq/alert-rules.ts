/**
 * CrewFlow HQ — Alerts + AI COO deterministic rules engine.
 *
 * Pure, no Supabase imports, no LLM. Takes a denormalised
 * `AlertsSnapshot` and returns a stable list of Alert objects that
 * the /admin/alerts page renders.
 *
 * Why deterministic first:
 *   - We can unit-test every rule with synthetic input.
 *   - Re-running the engine yields the same alerts, so the
 *     state table (admin_alert_state) keys cleanly on (rule_id,
 *     org_id).
 *   - When OpenAI / Claude eventually plug in, they layer ON TOP
 *     of these signals (re-ranking, summarising) rather than
 *     replacing them.
 *
 * Future-compat:
 *   - Channel dispatchers (email / WhatsApp / SMS) can iterate the
 *     same alert list and fan-out.
 *   - The "today needs attention" picker (`pickActionCentre`) is
 *     trivially swappable for an LLM reranker — the input/output
 *     contract is just Alert[].
 */

import type { OrgStatus } from "@/server/auth/session";
import type { SetupFeeStatus, HealthRisk } from "@/lib/hq/customer-financials";
import {
  BILLING_INVOICE_STATUSES,
  type BillingInvoiceKind,
  type BillingInvoiceStatus,
} from "@/lib/hq/billing";

// ---------------------------------------------------------------------
// Severity + rule id
// ---------------------------------------------------------------------

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export const SEVERITY_PILL: Record<AlertSeverity, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-amber-100 text-amber-900 border-amber-200",
  info: "bg-blue-100 text-blue-900 border-blue-200",
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

/**
 * Stable rule identifiers. CHANGING ONE OF THESE BREAKS the
 * (rule_id, org_id) state row mapping — only rename when you also
 * write a migration to update existing rows.
 */
export const ALERT_RULE_IDS = [
  // CRITICAL
  "failed_payment",
  "high_mrr_low_health",
  "migration_stalled",
  "subscription_ending",
  "customer_inactive",
  "invoice_overdue",
  // WARNING
  "setup_fee_unpaid",
  "low_usage",
  "low_onboarding",
  "trial_ending",
  "declining_health",
  // INFO
  "demo_booked",
  "customer_activated",
  "migration_completed",
  "payment_received",
] as const;
export type AlertRuleId = (typeof ALERT_RULE_IDS)[number];

export const ALERT_RULE_SEVERITY: Record<AlertRuleId, AlertSeverity> = {
  failed_payment: "critical",
  high_mrr_low_health: "critical",
  migration_stalled: "critical",
  subscription_ending: "critical",
  customer_inactive: "critical",
  invoice_overdue: "critical",
  setup_fee_unpaid: "warning",
  low_usage: "warning",
  low_onboarding: "warning",
  trial_ending: "warning",
  declining_health: "warning",
  demo_booked: "info",
  customer_activated: "info",
  migration_completed: "info",
  payment_received: "info",
};

export const ALERT_RULE_LABEL: Record<AlertRuleId, string> = {
  failed_payment: "Failed payment",
  high_mrr_low_health: "High MRR + low health",
  migration_stalled: "Migration stalled",
  subscription_ending: "Subscription ending",
  customer_inactive: "Customer inactive",
  invoice_overdue: "Invoice overdue",
  setup_fee_unpaid: "Setup fee unpaid",
  low_usage: "Low usage",
  low_onboarding: "Low onboarding %",
  trial_ending: "Trial ending",
  declining_health: "Declining health",
  demo_booked: "Demo booked",
  customer_activated: "Customer activated",
  migration_completed: "Migration completed",
  payment_received: "Payment received",
};

// ---------------------------------------------------------------------
// Snapshot shape (the input to the rules engine)
// ---------------------------------------------------------------------

export type AlertOrg = {
  id: string;
  name: string;
  status: OrgStatus | string;
  setup_fee_status: SetupFeeStatus | string;
  setup_fee_paid_at: string | null;
  trial_ends_at: string | null;
  next_renewal_at: string | null;
  approved_at: string | null;
  cancelled_at: string | null;
  suspended_at: string | null;
  created_at: string;
  updated_at: string | null;
  mrr_gbp: number;
  /** Cached health if available, else null (compute live). */
  health_score: number | null;
  last_login_at: string | null;
  onboarding_percent: number;
  migration_percent: number;
};

export type AlertInvoice = {
  id: string;
  org_id: string;
  kind: BillingInvoiceKind | string;
  status: BillingInvoiceStatus | string;
  amount_gbp: number;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  failed_at: string | null;
  created_at: string;
};

export type AlertImport = {
  id: string;
  org_id: string;
  status: string;
  created_at: string;
  /** Latest row activity for this org's imports — used for the
   * "migration stalled" detector. NULL when the org has no rows yet. */
  last_row_activity_at: string | null;
  committed_at: string | null;
};

export type AlertDemo = {
  id: string;
  org_id: string | null;
  email: string | null;
  company: string;
  status: string;
  /** Stamp on which the demo was booked. We approximate with
   * updated_at when status flipped to demo_booked — the snapshot
   * service sets this only for the relevant rows. */
  booked_at: string | null;
  created_at: string;
};

export type AlertSnapshotRow = {
  org: AlertOrg;
  /** All open / recently-touched invoices for this org. */
  invoices: ReadonlyArray<AlertInvoice>;
  /** Most recent imports for this org. */
  imports: ReadonlyArray<AlertImport>;
  /** Most recent demo records linked to this org (by email join). */
  demos: ReadonlyArray<AlertDemo>;
};

export type AlertsSnapshot = {
  rows: ReadonlyArray<AlertSnapshotRow>;
  /** "Now" used by the rules — passed in so tests are deterministic. */
  now: string;
};

// ---------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------

export type Alert = {
  /** Composite of (rule_id, org_id) — stable across re-runs. */
  key: string;
  ruleId: AlertRuleId;
  ruleLabel: string;
  severity: AlertSeverity;
  orgId: string;
  orgName: string;
  mrr: number;
  /** Live or cached score; null if neither available. */
  health: number | null;
  /** Risk band ('high' / 'medium' / 'low') when health is known. */
  healthRisk: HealthRisk | null;
  /** Free-form bullet evidence the panel renders under "Reason". */
  reason: ReadonlyArray<string>;
  /** Single-line suggested action ("Call customer today"). */
  suggestion: string;
  /** Sort key for "newest" — when the underlying condition fired. */
  occurredAt: string;
};

// ---------------------------------------------------------------------
// Constants — thresholds the CEO directive pinned
// ---------------------------------------------------------------------

export const THRESHOLDS = {
  /** Health below this number is "low" for HQ alerting. */
  lowHealthScore: 40,
  /** MRR at/above this number is "high MRR" — qualifies for
   * high_mrr_low_health and the COO panel ranking nudge. */
  highMrrGbp: 500,
  /** Migration considered stalled after this many days of no row
   * activity AND org is still pre-completion. */
  migrationStalledDays: 7,
  /** Org is "inactive" after this many days without a login. */
  customerInactiveDays: 14,
  /** Days a "subscription is ending" warning should fire from. */
  subscriptionEndingDays: 14,
  /** Invoice considered overdue after this many days past due. */
  invoiceOverdueDays: 30,
  /** Days before trial expiry to flag warn. */
  trialEndingDays: 5,
  /** Onboarding % below this is "low onboarding". */
  lowOnboardingPercent: 40,
  /** Days a usage gap of 7-14 days qualifies for "low usage"
   * (a lighter warning before customer_inactive). */
  lowUsageDays: 7,
  /** Look-back window for INFO events (demo booked, payment
   * received, customer activated, migration completed). */
  infoWindowDays: 2,
  /** Number of alerts the AI COO panel surfaces. */
  cooPanelLimit: 3,
} as const;

// ---------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------

type RuleFn = (row: AlertSnapshotRow, ctx: RuleContext) => Alert | null;

type RuleContext = {
  now: number;
};

const RULES: ReadonlyArray<{ id: AlertRuleId; fn: RuleFn }> = [
  // CRITICAL ----------------------------------------------------------
  {
    id: "failed_payment",
    fn: (row, ctx) => {
      const failed = row.invoices.filter((i) => i.status === "failed");
      if (failed.length === 0) return null;
      const latest = failed
        .map((i) => i.failed_at ?? i.created_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop();
      const totalFailed = failed.reduce(
        (acc, i) => acc + Number(i.amount_gbp),
        0,
      );
      return buildAlert(row, ctx, "failed_payment", {
        reason: [
          `${failed.length} failed invoice${failed.length === 1 ? "" : "s"}`,
          `£${totalFailed.toLocaleString("en-GB")} unrecovered`,
          ...failed
            .slice(0, 2)
            .map((f) => `Reason: ${f.id.slice(0, 8)} · ${shortDate(f.failed_at)}`),
        ],
        suggestion: "Retry payment or call customer today",
        occurredAt: latest ?? row.org.updated_at ?? row.org.created_at,
      });
    },
  },
  {
    id: "high_mrr_low_health",
    fn: (row, ctx) => {
      const health = row.org.health_score;
      if (health === null) return null;
      if (
        row.org.mrr_gbp < THRESHOLDS.highMrrGbp ||
        health >= THRESHOLDS.lowHealthScore
      ) {
        return null;
      }
      if (!isPayingOrTrial(row.org.status)) return null;
      return buildAlert(row, ctx, "high_mrr_low_health", {
        reason: [
          `MRR £${row.org.mrr_gbp.toLocaleString("en-GB")}`,
          `Health ${health}/100`,
          row.org.last_login_at
            ? `Last login ${daysAgo(row.org.last_login_at, ctx.now)}`
            : "Has never logged in",
        ],
        suggestion: "Call account owner today — retention call",
        occurredAt: row.org.updated_at ?? row.org.created_at,
      });
    },
  },
  {
    id: "migration_stalled",
    fn: (row, ctx) => {
      // Only fire while migration hasn't completed.
      if (row.org.migration_percent >= 100) return null;
      if (!isPayingOrTrial(row.org.status)) return null;
      const inFlight = row.imports.filter((i) => i.committed_at === null);
      if (inFlight.length === 0) return null;
      const latestActivity = inFlight
        .map((i) => i.last_row_activity_at ?? i.created_at)
        .sort()
        .pop();
      if (!latestActivity) return null;
      const days = daysBetween(latestActivity, ctx.now);
      if (days < THRESHOLDS.migrationStalledDays) return null;
      return buildAlert(row, ctx, "migration_stalled", {
        reason: [
          `Migration ${row.org.migration_percent}%`,
          `No row activity for ${days} days`,
          `${inFlight.length} import${inFlight.length === 1 ? "" : "s"} in flight`,
        ],
        suggestion: "Reach out — unblock the data handover",
        occurredAt: latestActivity,
      });
    },
  },
  {
    id: "subscription_ending",
    fn: (row, ctx) => {
      const next = row.org.next_renewal_at ?? row.org.trial_ends_at;
      if (!next) return null;
      if (!isPayingOrTrial(row.org.status)) return null;
      const days = daysBetween(next, ctx.now, /*signed=*/ true);
      if (days < -THRESHOLDS.subscriptionEndingDays || days > THRESHOLDS.subscriptionEndingDays) {
        return null;
      }
      // Only "ending" if the date is in the future or freshly passed.
      const phrase =
        days < 0
          ? `${-days} days overdue`
          : days === 0
            ? "Today"
            : `In ${days} days`;
      return buildAlert(row, ctx, "subscription_ending", {
        reason: [
          row.org.next_renewal_at
            ? `Next renewal ${shortDate(row.org.next_renewal_at)}`
            : `Trial ends ${shortDate(row.org.trial_ends_at)}`,
          phrase,
          `MRR £${row.org.mrr_gbp.toLocaleString("en-GB")}`,
        ],
        suggestion:
          days < 0
            ? "Renewal is overdue — confirm or cancel"
            : "Confirm renewal before it lapses",
        occurredAt: next,
      });
    },
  },
  {
    id: "customer_inactive",
    fn: (row, ctx) => {
      if (!isPayingOrTrial(row.org.status)) return null;
      if (!row.org.last_login_at) return null;
      const days = daysBetween(row.org.last_login_at, ctx.now);
      if (days < THRESHOLDS.customerInactiveDays) return null;
      return buildAlert(row, ctx, "customer_inactive", {
        reason: [
          `No login in ${days} days`,
          `Last login ${shortDate(row.org.last_login_at)}`,
          `MRR £${row.org.mrr_gbp.toLocaleString("en-GB")}`,
        ],
        suggestion: "Reach out — re-engage before they churn",
        occurredAt: row.org.last_login_at,
      });
    },
  },
  {
    id: "invoice_overdue",
    fn: (row, ctx) => {
      const overdue = row.invoices.filter((i) => {
        if (i.status !== "sent") return false;
        if (!i.due_date) return false;
        return daysBetween(i.due_date, ctx.now) > THRESHOLDS.invoiceOverdueDays;
      });
      if (overdue.length === 0) return null;
      const total = overdue.reduce((acc, i) => acc + Number(i.amount_gbp), 0);
      const dueDates = overdue
        .map((i) => i.due_date as string)
        .sort();
      const oldest = dueDates[0] ?? overdue[0]!.created_at;
      const oldestDays = daysBetween(oldest, ctx.now);
      return buildAlert(row, ctx, "invoice_overdue", {
        reason: [
          `${overdue.length} overdue invoice${overdue.length === 1 ? "" : "s"}`,
          `£${total.toLocaleString("en-GB")} outstanding`,
          `Oldest ${oldestDays} days overdue`,
        ],
        suggestion: "Chase payment today",
        occurredAt: oldest,
      });
    },
  },

  // WARNING -----------------------------------------------------------
  {
    id: "setup_fee_unpaid",
    fn: (row, ctx) => {
      const s = row.org.setup_fee_status;
      // Only fire for customers in/past trial.
      if (!isPayingOrTrial(row.org.status)) return null;
      // Already paid or doesn't apply.
      if (s === "paid" || s === "waived" || s === "refunded") return null;
      const ageDays = daysBetween(row.org.created_at, ctx.now);
      return buildAlert(row, ctx, "setup_fee_unpaid", {
        reason: [
          `Status: ${s}`,
          `Customer age ${ageDays} days`,
          `£1,000 setup unpaid`,
        ],
        suggestion: "Send setup invoice or follow up",
        occurredAt: row.org.created_at,
      });
    },
  },
  {
    id: "low_usage",
    fn: (row, ctx) => {
      if (!isPayingOrTrial(row.org.status)) return null;
      if (!row.org.last_login_at) return null;
      const days = daysBetween(row.org.last_login_at, ctx.now);
      // Sit between low_usage (7-13d) and customer_inactive (14d+)
      // so we don't double-fire.
      if (days < THRESHOLDS.lowUsageDays || days >= THRESHOLDS.customerInactiveDays) {
        return null;
      }
      return buildAlert(row, ctx, "low_usage", {
        reason: [
          `No login in ${days} days`,
          `Last login ${shortDate(row.org.last_login_at)}`,
        ],
        suggestion: "Soft nudge — email check-in",
        occurredAt: row.org.last_login_at,
      });
    },
  },
  {
    id: "low_onboarding",
    fn: (row, ctx) => {
      if (!isPayingOrTrial(row.org.status)) return null;
      if (row.org.onboarding_percent >= THRESHOLDS.lowOnboardingPercent) return null;
      // Don't fire in the first week — onboarding is naturally low.
      const ageDays = daysBetween(row.org.created_at, ctx.now);
      if (ageDays < 7) return null;
      return buildAlert(row, ctx, "low_onboarding", {
        reason: [
          `Onboarding ${row.org.onboarding_percent}%`,
          `${ageDays} days since signup`,
          `Migration ${row.org.migration_percent}%`,
        ],
        suggestion: "Walk them through onboarding checklist",
        occurredAt: row.org.created_at,
      });
    },
  },
  {
    id: "trial_ending",
    fn: (row, ctx) => {
      if (row.org.status !== "trial") return null;
      if (!row.org.trial_ends_at) return null;
      const days = daysBetween(row.org.trial_ends_at, ctx.now, /*signed=*/ true);
      // Window: from 5 days before expiry up to 1 day after.
      if (days > THRESHOLDS.trialEndingDays || days < -1) return null;
      const phrase = days <= 0 ? "Trial expired" : `Trial ends in ${days} days`;
      return buildAlert(row, ctx, "trial_ending", {
        reason: [
          phrase,
          `Trial ends ${shortDate(row.org.trial_ends_at)}`,
          `MRR £${row.org.mrr_gbp.toLocaleString("en-GB")}`,
        ],
        suggestion: "Confirm conversion to paid",
        occurredAt: row.org.trial_ends_at,
      });
    },
  },
  {
    id: "declining_health",
    fn: (row, ctx) => {
      if (row.org.health_score === null) return null;
      // Fire when health sits in the medium band (40-59) AND the
      // customer is paying — that's "not critical yet, but worth a
      // nudge". Critical-tier (<40) is handled by high_mrr_low_health.
      if (
        row.org.health_score >= 60 ||
        row.org.health_score < THRESHOLDS.lowHealthScore
      ) {
        return null;
      }
      if (row.org.status !== "active") return null;
      return buildAlert(row, ctx, "declining_health", {
        reason: [
          `Health ${row.org.health_score}/100`,
          `Migration ${row.org.migration_percent}%`,
          row.org.last_login_at
            ? `Last login ${daysAgo(row.org.last_login_at, ctx.now)}`
            : "Has never logged in",
        ],
        suggestion: "Schedule check-in call this week",
        occurredAt: row.org.updated_at ?? row.org.created_at,
      });
    },
  },

  // INFO --------------------------------------------------------------
  {
    id: "demo_booked",
    fn: (row, ctx) => {
      const booked = row.demos.filter(
        (d) => d.status === "demo_booked" && !!d.booked_at,
      );
      if (booked.length === 0) return null;
      const latest = booked
        .map((d) => d.booked_at as string)
        .sort()
        .pop();
      if (!latest || daysBetween(latest, ctx.now) > THRESHOLDS.infoWindowDays) {
        return null;
      }
      return buildAlert(row, ctx, "demo_booked", {
        reason: [
          `Demo booked ${shortDate(latest)}`,
          `Company ${row.org.name}`,
        ],
        suggestion: "Prep deck — confirm attendees",
        occurredAt: latest,
      });
    },
  },
  {
    id: "customer_activated",
    fn: (row, ctx) => {
      if (row.org.status !== "active") return null;
      if (!row.org.approved_at) return null;
      const days = daysBetween(row.org.approved_at, ctx.now);
      if (days > THRESHOLDS.infoWindowDays) return null;
      return buildAlert(row, ctx, "customer_activated", {
        reason: [
          `Activated ${shortDate(row.org.approved_at)}`,
          `MRR £${row.org.mrr_gbp.toLocaleString("en-GB")}`,
        ],
        suggestion: "Welcome call + onboarding kickoff",
        occurredAt: row.org.approved_at,
      });
    },
  },
  {
    id: "migration_completed",
    fn: (row, ctx) => {
      if (row.org.migration_percent < 100) return null;
      const completed = row.imports.find((i) => !!i.committed_at);
      const at = completed?.committed_at ?? row.org.updated_at;
      if (!at) return null;
      if (daysBetween(at, ctx.now) > THRESHOLDS.infoWindowDays) return null;
      return buildAlert(row, ctx, "migration_completed", {
        reason: [
          `Migration 100% on ${shortDate(at)}`,
          `Onboarding ${row.org.onboarding_percent}%`,
        ],
        suggestion: "Confirm in-app — celebrate, ask for referrals",
        occurredAt: at,
      });
    },
  },
  {
    id: "payment_received",
    fn: (row, ctx) => {
      const recentlyPaid = row.invoices.filter(
        (i) =>
          i.status === "paid" &&
          !!i.paid_at &&
          daysBetween(i.paid_at, ctx.now) <= THRESHOLDS.infoWindowDays,
      );
      if (recentlyPaid.length === 0) return null;
      const latest = recentlyPaid
        .map((i) => i.paid_at as string)
        .sort()
        .pop();
      const total = recentlyPaid.reduce(
        (acc, i) => acc + Number(i.amount_gbp),
        0,
      );
      return buildAlert(row, ctx, "payment_received", {
        reason: [
          `£${total.toLocaleString("en-GB")} received`,
          `${recentlyPaid.length} invoice${recentlyPaid.length === 1 ? "" : "s"}`,
          `Latest ${shortDate(latest)}`,
        ],
        suggestion: "Send thank-you email · log in CRM",
        occurredAt: latest ?? row.org.updated_at ?? row.org.created_at,
      });
    },
  },
];

/**
 * Run every rule against every row. Returns a flat Alert[].
 */
export function runAlertRules(snapshot: AlertsSnapshot): Alert[] {
  const ctx: RuleContext = { now: new Date(snapshot.now).getTime() };
  const out: Alert[] = [];
  for (const row of snapshot.rows) {
    for (const rule of RULES) {
      const alert = rule.fn(row, ctx);
      if (alert) out.push(alert);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Sorting + filtering
// ---------------------------------------------------------------------

export const ALERT_SORTS = ["severity", "mrr", "newest", "health"] as const;
export type AlertSort = (typeof ALERT_SORTS)[number];

export const ALERT_SORT_LABELS: Record<AlertSort, string> = {
  severity: "Severity (critical first)",
  mrr: "MRR (high first)",
  newest: "Newest",
  health: "Health (sickest first)",
};

export function sortAlerts<T extends Alert>(
  alerts: ReadonlyArray<T>,
  sort: AlertSort,
): T[] {
  const out = alerts.slice();
  if (sort === "severity") {
    out.sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      return b.mrr - a.mrr;
    });
  } else if (sort === "mrr") {
    out.sort((a, b) => b.mrr - a.mrr);
  } else if (sort === "newest") {
    out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  } else if (sort === "health") {
    out.sort((a, b) => {
      const ha = a.health ?? 999;
      const hb = b.health ?? 999;
      return ha - hb;
    });
  }
  return out;
}

export function filterAlerts<T extends Alert>(
  alerts: ReadonlyArray<T>,
  filters: {
    severity?: AlertSeverity | "all";
    q?: string | null;
    /** If true, only show un-snoozed un-resolved alerts (default). */
    showResolved?: boolean;
  },
): T[] {
  const q = filters.q?.trim().toLowerCase() ?? "";
  return alerts.filter((a) => {
    if (filters.severity && filters.severity !== "all") {
      if (a.severity !== filters.severity) return false;
    }
    if (q) {
      const blob = `${a.orgName} ${a.ruleLabel} ${a.reason.join(" ")}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

/**
 * The "Today needs attention" picker — pure ranking, no LLM.
 *
 * Criteria:
 *   1. Critical alerts first.
 *   2. Among critical, highest MRR first.
 *   3. Within the same MRR band, lowest health first (sickest).
 *   4. Falls through to top warnings if there aren't enough critical.
 *   5. Returns at most THRESHOLDS.cooPanelLimit (3 by default).
 */
export function pickActionCentre<T extends Alert>(
  alerts: ReadonlyArray<T>,
  limit: number = THRESHOLDS.cooPanelLimit,
): T[] {
  const sorted = sortAlerts(alerts, "severity");
  // De-dup by org so we don't surface 3 lines about the same customer.
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of sorted) {
    if (a.severity === "info") continue;
    if (seen.has(a.orgId)) continue;
    seen.add(a.orgId);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Lifecycle state (read / snooze / resolve / assign)
// ---------------------------------------------------------------------

export type AlertState = {
  read_at: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  assigned_to: string | null;
  resolution_note: string | null;
};

export type AlertWithState = Alert & {
  state: AlertState | null;
  unread: boolean;
  snoozed: boolean;
  resolved: boolean;
};

export function applyStateToAlerts(
  alerts: ReadonlyArray<Alert>,
  states: ReadonlyMap<string, AlertState>,
  now: string,
): AlertWithState[] {
  const nowMs = new Date(now).getTime();
  return alerts.map((a) => {
    const state = states.get(a.key) ?? null;
    const snoozed =
      !!state?.snoozed_until && new Date(state.snoozed_until).getTime() > nowMs;
    const resolved = !!state?.resolved_at;
    const unread = !state?.read_at && !resolved;
    return { ...a, state, unread, snoozed, resolved };
  });
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildAlert(
  row: AlertSnapshotRow,
  _ctx: RuleContext,
  ruleId: AlertRuleId,
  parts: {
    reason: string[];
    suggestion: string;
    occurredAt: string;
  },
): Alert {
  const health = row.org.health_score;
  const healthRisk: HealthRisk | null =
    health === null ? null : health < 40 ? "high" : health < 70 ? "medium" : "low";
  return {
    key: `${ruleId}:${row.org.id}`,
    ruleId,
    ruleLabel: ALERT_RULE_LABEL[ruleId],
    severity: ALERT_RULE_SEVERITY[ruleId],
    orgId: row.org.id,
    orgName: row.org.name,
    mrr: row.org.mrr_gbp,
    health,
    healthRisk,
    reason: parts.reason,
    suggestion: parts.suggestion,
    occurredAt: parts.occurredAt,
  };
}

function daysBetween(iso: string, now: number, signed = false): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return signed ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const ms = now - t;
  const d = Math.floor(ms / 86_400_000);
  return signed ? -d : d;
}

function daysAgo(iso: string, now: number): string {
  const d = daysBetween(iso, now);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function isPayingOrTrial(status: string): boolean {
  return status === "active" || status === "trial";
}

// re-export BILLING_INVOICE_STATUSES for tests so the test file
// doesn't pull from billing.ts when it shouldn't.
export { BILLING_INVOICE_STATUSES };

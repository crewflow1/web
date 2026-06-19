/**
 * CrewFlow HQ — Customer Health Deep Dive pure compute (HQ-11).
 *
 * Server/client-safe. Powers the /admin/health screen + the
 * customer-detail health section. Reuses HQ-6's existing health
 * score + health_score_events. The recommendation engine is
 * deterministic — no LLM.
 */

import {
  bandFromScore,
  type HealthBand,
  type HealthRisk,
} from "@/lib/hq/customer-financials";

/**
 * `bandFromScore` + `HealthBand` are the single source of truth, defined
 * in customer-financials alongside the score heuristic and its risk
 * mapping so the 40/70 cutoffs live in exactly one place. They're
 * re-exported here so the callers that already import them from
 * health-deep-dive keep their import path.
 */
export { bandFromScore };
export type { HealthBand, HealthRisk };

export const HEALTH_BAND_LABEL: Record<HealthBand, string> = {
  red: "Critical",
  yellow: "At risk",
  green: "Healthy",
  unknown: "Unscored",
};

export const HEALTH_BAND_PILL: Record<HealthBand, string> = {
  red: "bg-red-100 text-red-800 border-red-200",
  yellow: "bg-amber-100 text-amber-900 border-amber-200",
  green: "bg-emerald-100 text-emerald-900 border-emerald-200",
  unknown: "bg-slate-100 text-slate-700 border-slate-200",
};

// ---------------------------------------------------------------------
// Per-customer health row — what the deep-dive page aggregates.
// ---------------------------------------------------------------------

export type HealthDeepDiveRow = {
  org_id: string;
  org_name: string;
  status: string;
  /** Cached score (organizations.health_score) or null. */
  health_score: number | null;
  health_recomputed_at: string | null;
  /** Most recent 5 score events, oldest first — for sparkline. */
  trend: ReadonlyArray<{ recomputed_at: string; score: number }>;
  mrr_gbp: number;
  setup_fee_status: string;
  /** Days since the most recent customer login. null if never. */
  days_since_login: number | null;
  /** Days since org creation. */
  days_since_signup: number;
  onboarding_percent: number;
  migration_percent: number;
  /** Active support tickets count (open / in_progress / waiting_on_customer). */
  active_support_tickets: number;
  /** Urgent support tickets count. */
  urgent_support_tickets: number;
  /** Outstanding billing_invoices total in GBP. */
  outstanding_gbp: number;
  /** Failed payment count in last 90 days. */
  failed_payments_90d: number;
  /** Notification events seen in last 7 days (HQ-side only). */
  notifications_7d: number;
};

/**
 * Pure deterministic ranking — what action should HQ take next for
 * this customer? Returns ONE recommendation per row (the most
 * urgent). The recommendation IDs are stable and re-orderable.
 */
export type HealthRecommendation = {
  id: string;
  /** Higher = more urgent. */
  weight: number;
  label: string;
  detail: string;
  action_url: string;
};

export function recommendForRow(
  row: HealthDeepDiveRow,
): HealthRecommendation | null {
  const recs: HealthRecommendation[] = [];

  // Failed payments — highest urgency.
  if (row.failed_payments_90d > 0) {
    recs.push({
      id: "chase_failed_payment",
      weight: 100,
      label: "Chase failed payment",
      detail: `${row.failed_payments_90d} failed payment${row.failed_payments_90d === 1 ? "" : "s"} in last 90d. Contact customer.`,
      action_url: `/admin/billing?status=failed&org_id=${row.org_id}`,
    });
  }

  // Urgent support tickets.
  if (row.urgent_support_tickets > 0) {
    recs.push({
      id: "respond_urgent_support",
      weight: 95,
      label: "Respond to urgent support",
      detail: `${row.urgent_support_tickets} urgent ticket${row.urgent_support_tickets === 1 ? "" : "s"} waiting.`,
      action_url: `/admin/support?priority=urgent&q=${encodeURIComponent(row.org_name)}`,
    });
  }

  // Critical health band.
  if (bandFromScore(row.health_score) === "red") {
    recs.push({
      id: "retention_call_critical",
      weight: 90,
      label: "Retention call today",
      detail: `Health ${row.health_score}/100. Schedule a call before they cancel.`,
      action_url: `/admin/customers/${row.org_id}`,
    });
  }

  // Outstanding balance.
  if (row.outstanding_gbp > 5000) {
    recs.push({
      id: "collect_outstanding",
      weight: 80,
      label: `Collect £${Math.round(row.outstanding_gbp).toLocaleString("en-GB")}`,
      detail: "Outstanding balance over £5k.",
      action_url: `/admin/billing?org_id=${row.org_id}`,
    });
  } else if (row.outstanding_gbp > 0) {
    recs.push({
      id: "chase_invoice",
      weight: 50,
      label: `Chase £${Math.round(row.outstanding_gbp).toLocaleString("en-GB")}`,
      detail: "Outstanding invoice — send reminder.",
      action_url: `/admin/billing?org_id=${row.org_id}`,
    });
  }

  // Inactive customer.
  if (row.days_since_login === null && row.days_since_signup > 7) {
    recs.push({
      id: "first_login_followup",
      weight: 75,
      label: "Onboard — hasn't logged in",
      detail: `${row.days_since_signup} days since signup, never logged in.`,
      action_url: `/admin/customers/${row.org_id}`,
    });
  } else if (row.days_since_login !== null && row.days_since_login > 30) {
    recs.push({
      id: "re_engage_inactive",
      weight: 70,
      label: "Re-engagement check-in",
      detail: `No login for ${row.days_since_login} days.`,
      action_url: `/admin/customers/${row.org_id}`,
    });
  } else if (row.days_since_login !== null && row.days_since_login > 14) {
    recs.push({
      id: "soft_check_in",
      weight: 40,
      label: "Soft check-in",
      detail: `No login for ${row.days_since_login} days.`,
      action_url: `/admin/customers/${row.org_id}`,
    });
  }

  // Onboarding stuck.
  if (
    row.days_since_signup > 14 &&
    row.onboarding_percent < 50 &&
    row.status !== "cancelled"
  ) {
    recs.push({
      id: "onboarding_stuck",
      weight: 60,
      label: "Unblock onboarding",
      detail: `${row.onboarding_percent}% onboarded after ${row.days_since_signup}d — likely stuck.`,
      action_url: `/admin/customers/${row.org_id}`,
    });
  }

  // Migration stalled.
  if (
    row.migration_percent > 0 &&
    row.migration_percent < 100 &&
    row.days_since_signup > 30
  ) {
    recs.push({
      id: "migration_stalled",
      weight: 55,
      label: "Help migrate data",
      detail: `Migration ${row.migration_percent}% after ${row.days_since_signup}d.`,
      action_url: `/admin/onboarding`,
    });
  }

  // Setup fee unpaid (active or trial).
  if (
    (row.status === "active" || row.status === "trial") &&
    row.setup_fee_status !== "paid" &&
    row.setup_fee_status !== "waived"
  ) {
    recs.push({
      id: "setup_fee_unpaid",
      weight: 65,
      label: "Collect setup fee",
      detail: `Setup status: ${row.setup_fee_status}.`,
      action_url: `/admin/billing?org_id=${row.org_id}`,
    });
  }

  // Healthy: no action needed.
  if (recs.length === 0) {
    return null;
  }

  // Pick the most urgent.
  recs.sort((a, b) => b.weight - a.weight);
  return recs[0] ?? null;
}

// ---------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------

export type HealthDeepDiveFilter =
  | "all"
  | "red"
  | "yellow"
  | "green"
  | "unscored"
  | "inactive"
  | "unpaid"
  | "onboarding_stuck"
  | "high_support";

export const HEALTH_FILTER_LABEL: Record<HealthDeepDiveFilter, string> = {
  all: "All customers",
  red: "Critical (red)",
  yellow: "At risk (yellow)",
  green: "Healthy (green)",
  unscored: "Unscored",
  inactive: "Inactive (>14d no login)",
  unpaid: "Setup fee unpaid",
  onboarding_stuck: "Onboarding stuck",
  high_support: "High support volume (2+ active)",
};

export function applyHealthFilter<T extends HealthDeepDiveRow>(
  rows: ReadonlyArray<T>,
  filter: HealthDeepDiveFilter,
): T[] {
  if (filter === "all") return rows.slice();
  return rows.filter((r) => {
    switch (filter) {
      case "red":
        return bandFromScore(r.health_score) === "red";
      case "yellow":
        return bandFromScore(r.health_score) === "yellow";
      case "green":
        return bandFromScore(r.health_score) === "green";
      case "unscored":
        return r.health_score === null;
      case "inactive":
        return r.days_since_login !== null && r.days_since_login > 14;
      case "unpaid":
        return (
          (r.status === "active" || r.status === "trial") &&
          r.setup_fee_status !== "paid" &&
          r.setup_fee_status !== "waived"
        );
      case "onboarding_stuck":
        return (
          r.days_since_signup > 14 &&
          r.onboarding_percent < 50 &&
          r.status !== "cancelled"
        );
      case "high_support":
        return r.active_support_tickets >= 2;
      default:
        return true;
    }
  });
}

/**
 * CrewFlow HQ — Customers OS pure compute.
 *
 * Server/client-safe. No Supabase imports. Per-customer maths the
 * detail page renders + the snapshot service feeds.
 *
 * Business model (CEO directive):
 *   - £1,000 one-off setup fee per customer
 *   - £500/month per active or trial customer
 *   - Manual subscription management until Stripe lands; these
 *     numbers are operator-edited via /admin/customers/[id].
 */

import type { OrgStatus } from "@/server/auth/session";

/**
 * Business-model pricing — the single source of truth for the CEO's
 * £1,000 one-off setup fee + £500/month per active-or-trial customer.
 * Every HQ surface (metrics, the snapshot, demo conversion, Stripe
 * checkout, the organizations dashboard) imports these rather than
 * re-declaring the literals.
 */
export const SETUP_FEE_GBP = 1000;
export const MONTHLY_PRICE_GBP = 500;

export const SETUP_FEE_STATUSES = [
  "pending",
  "sent",
  "paid",
  "waived",
  "refunded",
] as const;
export type SetupFeeStatus = (typeof SETUP_FEE_STATUSES)[number];

export const SETUP_FEE_LABELS: Record<SetupFeeStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  paid: "Paid",
  waived: "Waived",
  refunded: "Refunded",
};

export const SETUP_FEE_PILL: Record<SetupFeeStatus, string> = {
  pending: "bg-amber-100 text-amber-900 border-amber-200",
  sent: "bg-blue-100 text-blue-900 border-blue-200",
  paid: "bg-emerald-100 text-emerald-900 border-emerald-200",
  waived: "bg-slate-200 text-slate-700 border-slate-300",
  refunded: "bg-red-100 text-red-800 border-red-200",
};

/**
 * Subscription status — derived from the existing org status enum
 * rather than introduced as a new column. Keeps the HQ vocabulary
 * in sync with the access gate without a denormalised second field.
 */
export type SubscriptionStatus =
  | "trial"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled"
  | "pending";

export function subscriptionStatusFromOrg(
  status: OrgStatus | string,
  setupFee: SetupFeeStatus,
): SubscriptionStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "suspended") return "suspended";
  if (status === "rejected") return "cancelled";
  if (status === "pending") return "pending";
  if (status === "trial") return "trial";
  if (status === "active") {
    // Paid customers without a setup fee paid yet are technically
    // past-due on the one-off. We surface that here so the dashboard
    // can chase it.
    return setupFee === "paid" || setupFee === "waived" ? "active" : "past_due";
  }
  return "pending";
}

export const SUBSCRIPTION_PILL: Record<SubscriptionStatus, string> = {
  trial: "bg-blue-100 text-blue-900 border-blue-200",
  active: "bg-emerald-100 text-emerald-900 border-emerald-200",
  past_due: "bg-amber-100 text-amber-900 border-amber-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  cancelled: "bg-slate-200 text-slate-700 border-slate-300",
  pending: "bg-amber-100 text-amber-900 border-amber-200",
};

/**
 * Lifetime value — naive estimate from MRR × months-since-active.
 *
 * Once Stripe ships we'll cache the actual paid-invoice sum on the
 * org row (`ltv_gbp`) and prefer it; until then this is the best
 * approximation we have for the CEO's portfolio MRR vs LTV view.
 */
export function estimateLtvGbp(input: {
  mrrGbp: number;
  approvedAt: string | null;
  createdAt: string;
  setupFeeStatus: SetupFeeStatus;
  cachedLtvGbp?: number;
}): number {
  // If we have a manually-set cached LTV, trust it.
  if (input.cachedLtvGbp && input.cachedLtvGbp > 0) {
    return input.cachedLtvGbp;
  }
  const anchor = input.approvedAt ?? input.createdAt;
  const monthsActive = monthsSince(anchor);
  const subscriptionLtv = Math.max(0, input.mrrGbp * monthsActive);
  const setupLtv =
    input.setupFeeStatus === "paid" ? SETUP_FEE_GBP : 0;
  return Math.round((subscriptionLtv + setupLtv) * 100) / 100;
}

function monthsSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms / (1000 * 60 * 60 * 24 * 30.4375); // average month length
}

/**
 * Migration ETA in days — friendly relative label.
 */
export function formatMigrationEta(date: string | null): string {
  if (!date) return "—";
  const now = Date.now();
  const target = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(target)) return date;
  const days = Math.ceil((target - now) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 0) return `In ${days} days · ${date}`;
  return `${-days} days overdue · ${date}`;
}

/**
 * Health score heuristic.
 *
 * 0-100 derived from a handful of low-cost signals we already have
 * today (no separate caching pipeline needed yet — HQ-6 will add
 * the cron-driven cache + richer signals like job/quote/invoice
 * activity).
 *
 * Inputs:
 *   - access state (active / trial / suspended / cancelled)
 *   - setup fee paid?
 *   - last_login_at within 14 days?
 *   - onboarding % (0-100)
 *   - migration % (0-100)
 *
 * Output also carries a `risk` band so the list view can colour the
 * row without re-applying the threshold logic.
 */
export type HealthRisk = "high" | "medium" | "low";

/**
 * Health band — the single source of truth for turning a 0-100 health
 * score into a traffic-light bucket. Every HQ health surface (this
 * heuristic's `risk`, the /admin/health deep-dive page, the customer
 * detail header) derives from `bandFromScore` so the 40/70 cutoffs can
 * never drift apart. `lib/hq/health-deep-dive` re-exports both for the
 * callers that already import them from there.
 */
export type HealthBand = "red" | "yellow" | "green" | "unknown";

/** Score → band. red <40, yellow 40-69, green ≥70, unknown when unscored. */
export function bandFromScore(score: number | null): HealthBand {
  if (score === null) return "unknown";
  if (score < 40) return "red";
  if (score < 70) return "yellow";
  return "green";
}

/** Band → coarse risk used by the customer-list row colouring. */
export function riskFromBand(band: HealthBand): HealthRisk {
  return band === "red" ? "high" : band === "yellow" ? "medium" : "low";
}

export type HealthInput = {
  status: OrgStatus | string;
  setupFeeStatus: SetupFeeStatus;
  lastLoginAt: string | null;
  onboardingPercent: number;
  migrationPercent: number;
};

export type HealthResult = { score: number; risk: HealthRisk; reasons: string[] };

export function computeHealthScore(input: HealthInput): HealthResult {
  let score = 50;
  const reasons: string[] = [];

  // Access state — 25 point swing.
  if (input.status === "active") {
    score += 20;
    reasons.push("Active subscription (+20)");
  } else if (input.status === "trial") {
    score += 10;
    reasons.push("On trial (+10)");
  } else if (input.status === "suspended") {
    score -= 25;
    reasons.push("Suspended (−25)");
  } else if (input.status === "cancelled") {
    score -= 35;
    reasons.push("Cancelled (−35)");
  }

  // Setup fee — 10 point swing.
  if (input.setupFeeStatus === "paid" || input.setupFeeStatus === "waived") {
    score += 10;
    reasons.push("Setup paid (+10)");
  } else if (input.setupFeeStatus === "pending" || input.setupFeeStatus === "sent") {
    score -= 5;
    reasons.push("Setup fee outstanding (−5)");
  } else if (input.setupFeeStatus === "refunded") {
    score -= 15;
    reasons.push("Setup refunded (−15)");
  }

  // Recency of login — 20 point swing.
  if (input.lastLoginAt) {
    const days = Math.floor(
      (Date.now() - new Date(input.lastLoginAt).getTime()) / 86_400_000,
    );
    if (days <= 7) {
      score += 15;
      reasons.push("Active in last 7 days (+15)");
    } else if (days <= 30) {
      score += 5;
      reasons.push("Active in last 30 days (+5)");
    } else if (days <= 90) {
      score -= 5;
      reasons.push("No login in 30 days (−5)");
    } else {
      score -= 15;
      reasons.push("No login in 90 days (−15)");
    }
  } else {
    score -= 5;
    reasons.push("Has never logged in (−5)");
  }

  // Onboarding completion — up to +5.
  if (input.onboardingPercent >= 80) {
    score += 5;
    reasons.push("Onboarding ≥80% (+5)");
  } else if (input.onboardingPercent <= 20) {
    score -= 5;
    reasons.push("Onboarding ≤20% (−5)");
  }

  // Migration completion — up to +5.
  if (input.migrationPercent >= 80) {
    score += 5;
    reasons.push("Migration ≥80% (+5)");
  } else if (input.migrationPercent <= 20 && input.status === "active") {
    score -= 5;
    reasons.push("Active but migration ≤20% (−5)");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const risk: HealthRisk = riskFromBand(bandFromScore(score));
  return { score, risk, reasons };
}

/**
 * Canonical HQ whole-pound formatter — `£1,234` with `en-GB` separators,
 * `—` for null / blank / non-finite. The single home for the
 * `£${Math.round(x).toLocaleString("en-GB")}` shape that billing, the
 * notification events, and the analytics PDF each used to re-implement.
 * (The abbreviated variants — executive's `formatGbpCompact` and the sales
 * model's `£1.2M`/`£450k` — are deliberately separate: different output.)
 */
export function formatGbp(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return `£${Math.round(v).toLocaleString("en-GB")}`;
}

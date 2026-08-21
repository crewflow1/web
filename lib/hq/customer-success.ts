import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";

/**
 * CrewFlow HQ — Customer-Success AI, pure retention / adoption compute
 * (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-customer-success.ts`) gathers the raw signals
 * from the EXISTING read models — CrewFlow's own post-sale demo-request lifecycle
 * (payment → onboarding → live) and the HQ analytics snapshot (org health,
 * activation, onboarding progress, churn) — and hands a plain
 * `CustomerSuccessInput` to `computeCustomerSuccessBoard` here.
 *
 * ── SCOPE: RETENTION & ADOPTION, not acquisition ─────────────────────────────
 * Customer Success owns what happens AFTER a customer signs — how they onboard,
 * activate, stay healthy, and (don't) churn: trial→paid conversion, onboarding
 * completion, 30-day activation, health segmentation, at-risk / churn signals and
 * an onboarding time-to-value proxy. It does NOT own the top of the funnel
 * (demo-request volume, lead sources, channel/campaign attribution) — those
 * belong to the Marketing AI (lib/hq/marketing.ts). No acquisition figure appears
 * here, by design.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/marketing.ts & product.ts) ───────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (active/trial
 *                orgs, health-segment counts, never-logged-in). Nothing beyond
 *                counting.
 *   derived      Exact arithmetic over facts (trial→paid = active ÷ (active +
 *                trial); 30-day activation = active-in-30d ÷ base; onboarding
 *                completion average; churn MoM). Reproducible from the inputs.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real, and NEVER a green card conjured from
 *                absent data.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction:
 *   · NPS / CSAT — there is NO survey / satisfaction-score table in the schema,
 *     so a Net Promoter or customer-satisfaction score cannot be computed.
 *   · Renewal / retention cohort — there is NO subscription-term / renewal-date
 *     table; 30-day churn is a point-in-time proxy, not a cohort retention curve,
 *     so a cohort renewal rate is not invented.
 *   · Support satisfaction — support tickets carry NO satisfaction rating, so a
 *     post-resolution CSAT is not fabricated.
 *   · Time-to-first-value — no first-meaningful-product-action timestamp is
 *     recorded, so true time-to-value cannot be measured. The average
 *     onboarding-completion duration is surfaced as an honest proxy instead.
 * Each carries no input field at all and is emitted as an honest no-data card,
 * never a fabricated number.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (the period label is measured against the injected clock).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type CustomerSuccessMetricKind = "fact" | "derived" | "insufficient";

export const CUSTOMER_SUCCESS_KIND_LABEL: Record<
  CustomerSuccessMetricKind,
  string
> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type CustomerSuccessFormat = "int" | "pct" | "days";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface CustomerSuccessMetric {
  key: string;
  /** Display name — "Active customers", "Onboarding completion", … */
  label: string;
  kind: CustomerSuccessMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: CustomerSuccessFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** One stage of the post-sale onboarding funnel, widest → narrowest. */
export interface CustomerSuccessStage {
  key: string;
  label: string;
  /** Count at this stage (a fact from CrewFlow's own demo-request lifecycle). */
  value: number;
}

/** One segment of the customer-health distribution. */
export interface CustomerSuccessHealthSegment {
  key: string;
  label: string;
  /** Paying-or-trial organisations in this health band. */
  value: number;
}

export interface CustomerSuccessBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: CustomerSuccessMetric[];
  /**
   * The post-sale onboarding funnel as ORDERED STAGE COUNTS (widest → narrowest),
   * from CrewFlow's OWN demo-request lifecycle: payment received → onboarding →
   * live. These are stage counts within one table (not a cross-table cohort), and
   * the array is empty when the lifecycle source could not be read.
   */
  onboardingFunnel: ReadonlyArray<CustomerSuccessStage>;
  /**
   * The customer-health distribution — healthy / at-risk / critical / unscored —
   * from the analytics snapshot. Null when the snapshot could not be read this
   * cycle (never a fabricated all-healthy split).
   */
  healthSegments: ReadonlyArray<CustomerSuccessHealthSegment> | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** A lean demo-request row — status/created_at only, NO PII, no bodies. */
export interface CustomerSuccessLifecycleRow {
  /** demo_requests lifecycle status. */
  status: string;
  created_at: string;
}

/**
 * Post-sale lifecycle signal — CrewFlow's OWN demo-request rows (a single global
 * table on the service-role path, NOT the tenant `leads` product table).
 */
export interface CustomerSuccessLifecycleInput {
  demoRequests: ReadonlyArray<CustomerSuccessLifecycleRow>;
}

/**
 * Retention / adoption posture, folded from the HQ analytics snapshot
 * (`computeCustomerAnalytics` + `computeRevenueAnalytics`). Every field is a
 * count or exact figure already derived from the existing snapshot.
 */
export interface CustomerSuccessHealthInput {
  /** Organisations with status = active (the paid base). */
  activeOrgs: number;
  /** Organisations with status = trial. */
  trialOrgs: number;
  /** Paying-or-trial orgs with health_score >= 70. */
  healthyCustomers: number;
  /** Paying-or-trial orgs with health_score 40–69. */
  atRiskCustomers: number;
  /** Paying-or-trial orgs with health_score < 40. */
  criticalCustomers: number;
  /** Paying-or-trial orgs whose health_score has never been computed. */
  unscoredCustomers: number;
  /** Paying-or-trial orgs that logged in within the last 30 days. */
  usageActive30d: number;
  /** Paying-or-trial orgs that have never logged in (activation gap). */
  neverLoggedIn: number;
  /** The paying-or-trial base the usage / activation figures are measured against. */
  payingOrTrialBase: number;
  /** Average onboarding (data-migration) completion %, across paying-or-trial orgs. */
  onboardingAveragePct: number;
  /** Paying-or-trial orgs whose onboarding (migration) has reached 100%. */
  onboardingCompleted: number;
  /** Paying-or-trial orgs stalled mid-onboarding (>7 days, under 100%). */
  onboardingStalled: number;
  /**
   * Average days from approval to onboarding (migration) completion, for the orgs
   * that have completed. `null` when no org has completed onboarding yet — a
   * time-to-value proxy is then undefined rather than fabricated.
   */
  avgDaysToOnboard: number | null;
  /** Churn % over the last 30 days vs the 30-day-ago active base. */
  churnPct: number;
}

export interface CustomerSuccessInput {
  lifecycle: CustomerSuccessLifecycleInput | null;
  health: CustomerSuccessHealthInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: CustomerSuccessFormat,
  basis: string,
): CustomerSuccessMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: CustomerSuccessFormat,
  basis: string,
): CustomerSuccessMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: CustomerSuccessFormat,
  basis: string,
): CustomerSuccessMetric {
  return { key, label, kind: "insufficient", value: null, format, basis };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero.`;

// demo_requests lifecycle vocab (superset from the CHECK in
// 20260604000000_hq_shell_demos_lifecycle.sql). Customer Success owns the
// POST-SALE stages only — the sales handoff onward.
/** A demo request that has paid but not yet started onboarding. */
const CS_PAID = new Set(["payment_received"]);
/** A demo request actively being onboarded (data migration / setup). */
const CS_ONBOARDING = new Set(["active_onboarding"]);
/** A demo request that has reached fully-live active use. */
const CS_LIVE = new Set(["active"]);

interface LifecycleCounts {
  paid: number;
  onboarding: number;
  live: number;
}

/** Fold the demo-request rows into the post-sale onboarding stage counts. */
function foldLifecycle(
  rows: ReadonlyArray<CustomerSuccessLifecycleRow>,
): LifecycleCounts {
  let paid = 0;
  let onboarding = 0;
  let live = 0;
  for (const r of rows) {
    if (CS_PAID.has(r.status)) paid += 1;
    else if (CS_ONBOARDING.has(r.status)) onboarding += 1;
    else if (CS_LIVE.has(r.status)) live += 1;
  }
  return { paid, onboarding, live };
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeCustomerSuccessBoard(
  input: CustomerSuccessInput,
  now: Date,
): CustomerSuccessBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  const metrics: CustomerSuccessMetric[] = [];
  const onboardingFunnel: CustomerSuccessStage[] = [];
  let healthSegments: CustomerSuccessBoard["healthSegments"] = null;

  // ── Post-sale lifecycle — CrewFlow's own demo-request capture ─────────
  let lc: LifecycleCounts | null = null;
  if (input.lifecycle == null) {
    metrics.push(
      insufficient("onboarding_in_progress", "Accounts onboarding", "int", SOURCE_UNAVAILABLE("demo-request lifecycle")),
      insufficient("fully_live", "Accounts fully live", "int", SOURCE_UNAVAILABLE("demo-request lifecycle")),
      insufficient("activation_completion_rate", "Onboarding→live completion", "pct", SOURCE_UNAVAILABLE("demo-request lifecycle")),
    );
  } else {
    lc = foldLifecycle(input.lifecycle.demoRequests);
    const handedOff = lc.onboarding + lc.live;
    metrics.push(
      fact(
        "onboarding_in_progress",
        "Accounts onboarding",
        lc.onboarding,
        "int",
        "Demo-request accounts in active onboarding (post-payment, not yet fully live) — CrewFlow's own post-sale lifecycle, the live success workload.",
      ),
      fact(
        "fully_live",
        "Accounts fully live",
        lc.live,
        "int",
        "Demo-request accounts that have reached fully-live active use — onboarding completed on CrewFlow's own lifecycle.",
      ),
      handedOff > 0
        ? derived(
            "activation_completion_rate",
            "Onboarding→live completion",
            round1((lc.live / handedOff) * 100),
            "pct",
            `${lc.live} live of ${handedOff} handed-off accounts (onboarding + live); a point-in-time snapshot ratio, not a cohort.`,
          )
        : insufficient(
            "activation_completion_rate",
            "Onboarding→live completion",
            "pct",
            "No accounts have reached the onboarding-or-live post-sale stages yet, so a completion ratio is undefined.",
          ),
    );
    onboardingFunnel.push(
      { key: "funnel_paid", label: "Paid, awaiting onboarding", value: lc.paid },
      { key: "funnel_onboarding", label: "Onboarding", value: lc.onboarding },
      { key: "funnel_live", label: "Fully live", value: lc.live },
    );
  }

  // ── Retention / adoption — analytics snapshot ─────────────────────────
  if (input.health == null) {
    metrics.push(
      insufficient("active_customers", "Active customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("trial_customers", "Trial customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("trial_to_paid", "Trial→paid conversion", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("activation_rate_30d", "30-day activation rate", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("never_logged_in", "Never logged in", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("onboarding_completion", "Onboarding completion", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("onboarding_completed_count", "Onboarding completed", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("onboarding_stalled", "Onboarding stalled", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("avg_time_to_onboard", "Avg onboarding time", "days", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("healthy_customers", "Healthy customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("at_risk_customers", "At-risk customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("critical_customers", "Critical customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("unscored_customers", "Unscored customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("churn_30d", "Churn (30d)", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
    );
  } else {
    const h = input.health;
    const base = h.activeOrgs + h.trialOrgs;
    metrics.push(
      fact(
        "active_customers",
        "Active customers",
        h.activeOrgs,
        "int",
        "Organisations with an active subscription status — the paying base Customer Success retains.",
      ),
      fact(
        "trial_customers",
        "Trial customers",
        h.trialOrgs,
        "int",
        "Organisations currently in trial — the conversion mid-funnel Customer Success shepherds to paid.",
      ),
      base > 0
        ? derived(
            "trial_to_paid",
            "Trial→paid conversion",
            round1((h.activeOrgs / base) * 100),
            "pct",
            `${h.activeOrgs} active of ${base} active-plus-trial organisations — a point-in-time snapshot ratio, NOT a cohort conversion (no trial-start cohort stamp is recorded).`,
          )
        : insufficient(
            "trial_to_paid",
            "Trial→paid conversion",
            "pct",
            "No active-or-trial organisations on record, so a trial→paid ratio is undefined.",
          ),
      h.payingOrTrialBase > 0
        ? derived(
            "activation_rate_30d",
            "30-day activation rate",
            round1((h.usageActive30d / h.payingOrTrialBase) * 100),
            "pct",
            `${h.usageActive30d} of ${h.payingOrTrialBase} paying-or-trial organisations logged in within the last 30 days.`,
          )
        : insufficient(
            "activation_rate_30d",
            "30-day activation rate",
            "pct",
            "No paying-or-trial organisations on record, so an activation rate is undefined.",
          ),
      fact(
        "never_logged_in",
        "Never logged in",
        h.neverLoggedIn,
        "int",
        "Paying-or-trial organisations that have never logged in — an activation gap and an early churn risk, not a healthy zero.",
      ),
      h.payingOrTrialBase > 0
        ? derived(
            "onboarding_completion",
            "Onboarding completion",
            round1(h.onboardingAveragePct),
            "pct",
            "Average data-migration onboarding completion across paying-or-trial organisations, from the analytics snapshot.",
          )
        : insufficient(
            "onboarding_completion",
            "Onboarding completion",
            "pct",
            "No paying-or-trial organisations on record, so an average onboarding completion is undefined.",
          ),
      fact(
        "onboarding_completed_count",
        "Onboarding completed",
        h.onboardingCompleted,
        "int",
        "Paying-or-trial organisations whose data-migration onboarding has reached 100%.",
      ),
      fact(
        "onboarding_stalled",
        "Onboarding stalled",
        h.onboardingStalled,
        "int",
        "Paying-or-trial organisations stalled mid-onboarding (over 7 days without completing) — the intervention queue, not a healthy zero.",
      ),
      h.avgDaysToOnboard != null
        ? derived(
            "avg_time_to_onboard",
            "Avg onboarding time",
            round1(h.avgDaysToOnboard),
            "days",
            "Average days from approval to onboarding (migration) completion, for organisations that have completed — a time-to-value proxy, not a first-product-action measure.",
          )
        : insufficient(
            "avg_time_to_onboard",
            "Avg onboarding time",
            "days",
            "No organisation has completed onboarding yet, so an average onboarding time is undefined.",
          ),
      fact(
        "healthy_customers",
        "Healthy customers",
        h.healthyCustomers,
        "int",
        "Paying-or-trial organisations with a health score of 70 or above.",
      ),
      fact(
        "at_risk_customers",
        "At-risk customers",
        h.atRiskCustomers,
        "int",
        "Paying-or-trial organisations with a health score of 40–69 — the at-risk watchlist.",
      ),
      fact(
        "critical_customers",
        "Critical customers",
        h.criticalCustomers,
        "int",
        "Paying-or-trial organisations with a health score below 40 — the highest churn risk.",
      ),
      fact(
        "unscored_customers",
        "Unscored customers",
        h.unscoredCustomers,
        "int",
        "Paying-or-trial organisations whose health score has never been computed — a blind spot, surfaced honestly rather than counted as healthy.",
      ),
      derived(
        "churn_30d",
        "Churn (30d)",
        round1(h.churnPct),
        "pct",
        "Organisations cancelled in the last 30 days as a share of the 30-day-ago active base — a point-in-time churn rate, not a cohort retention curve.",
      ),
    );

    healthSegments = [
      { key: "seg_healthy", label: "Healthy (70+)", value: h.healthyCustomers },
      { key: "seg_at_risk", label: "At risk (40–69)", value: h.atRiskCustomers },
      { key: "seg_critical", label: "Critical (<40)", value: h.criticalCustomers },
      { key: "seg_unscored", label: "Unscored", value: h.unscoredCustomers },
    ];
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "nps_csat",
      "NPS / CSAT",
      "int",
      "No survey / satisfaction-score table exists in the schema; a Net Promoter or customer-satisfaction score cannot be computed and is not fabricated.",
    ),
    insufficient(
      "renewal_retention_cohort",
      "Renewal retention (cohort)",
      "pct",
      "No subscription-term / renewal-date table exists in the schema; 30-day churn is shown as a point-in-time proxy, but a cohort renewal-retention rate is not fabricated.",
    ),
    insufficient(
      "support_satisfaction",
      "Support satisfaction",
      "pct",
      "Support tickets carry no satisfaction rating in the schema; a post-resolution CSAT is not recorded anywhere queryable, so it is not fabricated.",
    ),
    insufficient(
      "time_to_first_value",
      "Time to first value",
      "days",
      "No first-meaningful-product-action timestamp is recorded, so true time-to-value cannot be measured; the average onboarding-completion duration is surfaced above as an honest proxy instead.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    onboardingFunnel,
    healthSegments,
  };
}

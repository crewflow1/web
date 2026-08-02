import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";

/**
 * CrewFlow HQ — Marketing AI, pure top-of-funnel / acquisition compute
 * (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-marketing.ts`) gathers the raw signals from
 * the EXISTING read models — the demo-request lead capture (CrewFlow's own
 * marketing-site funnel top) and the HQ analytics snapshot (orgs + the 12-month
 * acquisition series) — and hands a plain `MarketingInput` to
 * `computeMarketingBoard` here.
 *
 * ── SCOPE: ACQUISITION, not adoption ─────────────────────────────────────────
 * Marketing owns the TOP of the funnel — how prospects arrive and convert into
 * customers: demo-request volume, lead sources, the demo → trial → paid funnel,
 * trial→paid conversion, and month-on-month customer growth. It does NOT own
 * adoption/usage (logins, activation, feature demand) — those belong to the
 * Product AI (lib/hq/product.ts), which measures what customers do AFTER they
 * sign up. No usage/login figure appears here, by design.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/operations.ts & product.ts) ──────────
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (demo-request
 *                volume, trial orgs, active customers). Nothing beyond counting.
 *   derived      Exact arithmetic over facts (demo approval rate = approved ÷
 *                decided; trial→paid conversion = active ÷ (active + trial);
 *                growth MoM). Reproducible from the inputs alone.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction:
 *   · Marketing channel attribution — `demo_requests.source` is a FORM-ORIGIN
 *     tag (defaulted to 'landing' at insert, never a captured UTM/medium), so a
 *     paid/organic/social/referral channel split is not recorded anywhere. The
 *     raw source distribution is shown as honest facts in its own panel, but
 *     CHANNEL attribution is emitted insufficient rather than invented.
 *   · Campaign performance — there is NO campaign table in the schema.
 *   · Ad spend & CAC — there is NO marketing-cost / ad-spend data anywhere, so
 *     customer-acquisition cost cannot be computed.
 *   · SEO keyword rankings — there is NO keyword-ranking data source.
 * Each of these carries no input field at all and is emitted as an honest no-data
 * card, never a fabricated number.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (the 30-day lead window is measured against the injected
 * clock).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type MarketingMetricKind = "fact" | "derived" | "insufficient";

export const MARKETING_KIND_LABEL: Record<MarketingMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type MarketingFormat = "int" | "pct";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface MarketingMetric {
  key: string;
  /** Display name — "Demo requests (all-time)", "Trial→paid conversion", … */
  label: string;
  kind: MarketingMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: MarketingFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** One row of the lead-source distribution (grouped by `demo_requests.source`). */
export interface MarketingSource {
  /** The raw stored source value. */
  source: string;
  /** Human label — humanised source value. */
  label: string;
  /** Demo requests stamped with this source (all-time). */
  total: number;
  /** Demo requests stamped with this source in the last 30 days. */
  new30d: number;
}

/** One stage of the acquisition funnel, presented widest → narrowest. */
export interface MarketingFunnelStage {
  key: string;
  label: string;
  /** Count at this stage (a fact from its own source). */
  value: number;
  /** Which read model the stage count comes from (kept honest — no cohort join). */
  source: "demo_requests" | "organizations";
}

export interface MarketingBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: MarketingMetric[];
  /**
   * The lead-source distribution — every `demo_requests.source` value with its
   * all-time and 30-day counts, surfaced so the page shows WHERE leads are
   * stamped as originating. Honest facts, not channel attribution (see the
   * `channel_attribution` insufficient card). Null when the demo-request source
   * could not be read this cycle.
   */
  sources: {
    breakdown: ReadonlyArray<MarketingSource>;
    total: number;
  } | null;
  /**
   * The acquisition funnel as ORDERED STAGE COUNTS (widest → narrowest). Each
   * stage is a fact from its own source; demo requests and organisations are
   * tracked in SEPARATE tables with no per-lead linkage, so these are stage
   * counts, NOT a single cohort flowing through — the page states that. A stage
   * is omitted (not zeroed) when its source group could not be read; the array
   * is empty when neither source is readable.
   */
  funnel: ReadonlyArray<MarketingFunnelStage>;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** A lean demo-request row — status/source/created_at only, NO PII, no bodies. */
export interface MarketingDemoRow {
  /** demo_requests lifecycle status. */
  status: string;
  /** demo_requests.source — form-origin tag (defaulted to 'landing' at insert). */
  source: string;
  created_at: string;
}

/** Top-of-funnel signal — the lean demo-request rows (CrewFlow's own capture). */
export interface MarketingLeadsInput {
  demoRequests: ReadonlyArray<MarketingDemoRow>;
}

/** Acquisition posture, folded from the HQ analytics snapshot. */
export interface MarketingAcquisitionInput {
  /** Organisations with status = active (the paid base). */
  activeOrgs: number;
  /** Organisations with status = trial (the conversion mid-funnel). */
  trialOrgs: number;
  /** Organisations with status = pending (awaiting approval / not yet a customer). */
  pendingOrgs: number;
  /** New active-or-trial customers created in the current (latest) month bucket. */
  newCustomersThisMonth: number;
  /** Cumulative customer growth vs the previous month, from the 12-month series. */
  growthPct: number;
}

export interface MarketingInput {
  leads: MarketingLeadsInput | null;
  acquisition: MarketingAcquisitionInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: MarketingFormat,
  basis: string,
): MarketingMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: MarketingFormat,
  basis: string,
): MarketingMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: MarketingFormat,
  basis: string,
): MarketingMetric {
  return { key, label, kind: "insufficient", value: null, format, basis };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const DAY_MS = 86_400_000;
/** Leads created within this window (in days) count toward 30-day momentum. */
const NEW_WINDOW_DAYS = 30;

// demo_requests lifecycle vocab is a superset: the current sales kanban writes
// the new lifecycle (`won`/`lost`/`payment_*`/`active*`/`cancelled`), while
// legacy panel flows wrote `approved`/`rejected`/`closed_won`/`closed_lost`.
// All values below are drawn from the CHECK in
// 20260604000000_hq_shell_demos_lifecycle.sql. We match the rest of the
// codebase's win convention (bootstrap-account/hq-sales/hq-executive treat
// `won` as terminal, alongside legacy `approved`).
/** demo_requests statuses at/past greenlight — a "won"/approved outcome. */
const DEMO_WON = new Set([
  "won",
  "approved",
  "closed_won",
  "payment_sent",
  "payment_received",
  "active_onboarding",
  "active",
]);
/** demo_requests statuses classed as a "lost"/rejected outcome. */
const DEMO_LOST = new Set(["lost", "rejected", "closed_lost", "cancelled"]);
/** demo_requests lifecycle statuses classed as "awaiting first contact". */
const DEMO_PENDING = new Set(["pending_demo", "new"]);

/** Known source labels; anything else is humanised generically. */
const LEAD_SOURCE_LABEL: Record<string, string> = {
  landing: "Landing page",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero.`;

function humaniseSource(source: string): string {
  const known = LEAD_SOURCE_LABEL[source];
  if (known) return known;
  const cleaned = source.trim();
  if (cleaned === "") return "Unspecified";
  return cleaned
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface DemoCounts {
  total: number;
  new30d: number;
  pending: number;
  booked: number;
  won: number;
  lost: number;
}

/** Fold the demo-request rows into the top-of-funnel facts the board surfaces. */
function foldDemos(rows: ReadonlyArray<MarketingDemoRow>, nowMs: number): DemoCounts {
  let total = 0;
  let new30d = 0;
  let pending = 0;
  let booked = 0;
  let won = 0;
  let lost = 0;
  for (const r of rows) {
    total += 1;
    const created = Date.parse(r.created_at);
    const age = nowMs - created;
    if (!Number.isNaN(created) && age >= 0 && age <= NEW_WINDOW_DAYS * DAY_MS) {
      new30d += 1;
    }
    if (DEMO_PENDING.has(r.status)) pending += 1;
    else if (r.status === "demo_booked") booked += 1;
    else if (DEMO_WON.has(r.status)) won += 1;
    else if (DEMO_LOST.has(r.status)) lost += 1;
  }
  return { total, new30d, pending, booked, won, lost };
}

/** Group demo requests by their stored source into the deterministic breakdown. */
function buildSourceBreakdown(
  rows: ReadonlyArray<MarketingDemoRow>,
  nowMs: number,
): MarketingSource[] {
  const bySource = new Map<string, { total: number; new30d: number }>();
  for (const r of rows) {
    const key = r.source && r.source.trim() !== "" ? r.source : "unspecified";
    const entry = bySource.get(key) ?? { total: 0, new30d: 0 };
    entry.total += 1;
    const created = Date.parse(r.created_at);
    const age = nowMs - created;
    if (!Number.isNaN(created) && age >= 0 && age <= NEW_WINDOW_DAYS * DAY_MS) {
      entry.new30d += 1;
    }
    bySource.set(key, entry);
  }
  return [...bySource.entries()]
    .map(([source, c]) => ({
      source,
      label: humaniseSource(source),
      total: c.total,
      new30d: c.new30d,
    }))
    // Deterministic order: highest volume first, ties broken by source name.
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeMarketingBoard(input: MarketingInput, now: Date): MarketingBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: MarketingMetric[] = [];
  const funnel: MarketingFunnelStage[] = [];

  // ── Top of funnel — demo-request lead capture ─────────────────────────
  let demos: DemoCounts | null = null;
  let sources: MarketingBoard["sources"] = null;
  if (input.leads == null) {
    metrics.push(
      insufficient("lead_volume_total", "Demo requests (all-time)", "int", SOURCE_UNAVAILABLE("demo-request")),
      insufficient("lead_volume_new_30d", "New demo requests (30d)", "int", SOURCE_UNAVAILABLE("demo-request")),
      insufficient("demos_pending", "Demos awaiting contact", "int", SOURCE_UNAVAILABLE("demo-request")),
      insufficient("demos_approved", "Demos approved", "int", SOURCE_UNAVAILABLE("demo-request")),
      insufficient("demo_approval_rate", "Demo approval rate", "pct", SOURCE_UNAVAILABLE("demo-request")),
    );
  } else {
    const rows = input.leads.demoRequests;
    demos = foldDemos(rows, nowMs);
    sources = { breakdown: buildSourceBreakdown(rows, nowMs), total: demos.total };
    const decided = demos.won + demos.lost;
    metrics.push(
      fact(
        "lead_volume_total",
        "Demo requests (all-time)",
        demos.total,
        "int",
        "Demo requests captured from the marketing site — CrewFlow's own top-of-funnel lead volume (all statuses).",
      ),
      fact(
        "lead_volume_new_30d",
        "New demo requests (30d)",
        demos.new30d,
        "int",
        "Demo requests captured in the last 30 days — top-of-funnel momentum.",
      ),
      fact(
        "demos_pending",
        "Demos awaiting contact",
        demos.pending,
        "int",
        "Demo requests still awaiting first contact (pending) — the unworked top of the funnel, not a healthy zero.",
      ),
      fact(
        "demos_approved",
        "Demos approved",
        demos.won,
        "int",
        "Demo requests greenlit or beyond (won/approved, payment sent/received, onboarding/active) — qualified demand that has converted or is converting.",
      ),
      decided > 0
        ? derived(
            "demo_approval_rate",
            "Demo approval rate",
            round1((demos.won / decided) * 100),
            "pct",
            `${demos.won} greenlit of ${decided} decided demo requests (decided = won + lost terminals); undecided demos are excluded.`,
          )
        : insufficient(
            "demo_approval_rate",
            "Demo approval rate",
            "pct",
            "No demo requests have reached a won or lost decision yet, so an approval rate is undefined.",
          ),
    );
  }

  // ── Acquisition / customer funnel — analytics snapshot ────────────────
  let acq: MarketingAcquisitionInput | null = null;
  if (input.acquisition == null) {
    metrics.push(
      insufficient("trial_signups", "Trial organisations", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("active_customers", "Active customers", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("trial_to_paid", "Trial→paid conversion", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("new_customers_month", "New customers this month", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("growth_mom", "Customer growth (MoM)", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
    );
  } else {
    acq = input.acquisition;
    const base = acq.activeOrgs + acq.trialOrgs;
    metrics.push(
      fact(
        "trial_signups",
        "Trial organisations",
        acq.trialOrgs,
        "int",
        "Organisations currently in trial — the mid-funnel between a booked demo and a paying customer.",
      ),
      fact(
        "active_customers",
        "Active customers",
        acq.activeOrgs,
        "int",
        "Organisations with an active subscription status — the paying base at the bottom of the funnel.",
      ),
      base > 0
        ? derived(
            "trial_to_paid",
            "Trial→paid conversion",
            round1((acq.activeOrgs / base) * 100),
            "pct",
            `${acq.activeOrgs} active of ${base} active-plus-trial organisations — a point-in-time snapshot ratio, NOT a cohort conversion (no trial-start cohort stamp is recorded).`,
          )
        : insufficient(
            "trial_to_paid",
            "Trial→paid conversion",
            "pct",
            "No active-or-trial organisations on record, so a trial→paid ratio is undefined.",
          ),
      fact(
        "new_customers_month",
        "New customers this month",
        acq.newCustomersThisMonth,
        "int",
        "Organisations that became active or trial in the current month, from the 12-month acquisition series.",
      ),
      derived(
        "growth_mom",
        "Customer growth (MoM)",
        round1(acq.growthPct),
        "pct",
        "Cumulative customer growth vs the previous month, from the 12-month acquisition series.",
      ),
    );
  }

  // ── Acquisition funnel stages (ordered widest → narrowest) ────────────
  // Each stage is a fact from its own source; demo requests and organisations
  // live in SEPARATE tables with no per-lead linkage, so these are stage counts,
  // not a single cohort flowing through (stated on the page). A stage is omitted
  // (not zeroed) when its source group could not be read.
  if (demos != null) {
    funnel.push(
      { key: "funnel_demo_requests", label: "Demo requests", value: demos.total, source: "demo_requests" },
      { key: "funnel_demos_approved", label: "Demos approved", value: demos.won, source: "demo_requests" },
    );
  }
  if (acq != null) {
    funnel.push(
      { key: "funnel_trials", label: "Trials", value: acq.trialOrgs, source: "organizations" },
      { key: "funnel_active", label: "Active customers", value: acq.activeOrgs, source: "organizations" },
    );
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "channel_attribution",
      "Marketing channel attribution",
      "pct",
      "demo_requests.source is a form-origin tag (defaulted to 'landing' at insert), not a captured UTM/medium; no paid/organic/social/referral channel attribution is recorded anywhere queryable, so a channel split is not fabricated. The raw source distribution is shown as facts in its own panel.",
    ),
    insufficient(
      "campaign_performance",
      "Campaign performance",
      "int",
      "No marketing-campaign table exists in the schema; campaign-level performance is not recorded anywhere queryable, so it is not fabricated.",
    ),
    insufficient(
      "ad_spend_cac",
      "Ad spend & CAC",
      "int",
      "No ad-spend / marketing-cost data exists anywhere in the schema; customer-acquisition cost cannot be computed and is not fabricated.",
    ),
    insufficient(
      "seo_rankings",
      "SEO keyword rankings",
      "int",
      "No keyword-ranking data source exists in the schema; search-ranking positions are not recorded anywhere queryable, so they are not fabricated.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    sources,
    funnel,
  };
}

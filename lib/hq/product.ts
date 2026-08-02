import { SIGNAL_KIND_LABEL } from "@/lib/intelligence/provenance";
import {
  SUPPORT_CATEGORY_LABEL,
  isActiveStatus,
  type SupportCategory,
} from "@/lib/hq/support";

/**
 * CrewFlow HQ — Product AI, pure voice-of-customer / product-signal compute
 * (super-admin surface).
 *
 * Server- AND client-safe: NO Supabase imports, NO clock. The server-only
 * aggregator (`server/services/hq-product.ts`) gathers the raw signals from the
 * EXISTING read models — the lean feature-request/support-ticket reader and the
 * HQ analytics snapshot — and hands a plain `ProductInput` to
 * `computeProductBoard` here.
 *
 * ── THE HONESTY DOCTRINE (mirrors lib/hq/cto.ts, finance.ts & support-ai.ts) ──
 * Every figure this board emits LABELS ITSELF and carries a plain-English
 * `basis`. There are exactly three labels:
 *
 *   fact         A count read straight from an existing read model (feature-
 *                request volume, open bugs, active orgs). Nothing beyond counting.
 *   derived      Exact arithmetic over facts (30-day activation rate =
 *                active-in-30d ÷ paying-or-trial base). Reproducible from inputs.
 *   insufficient The input this figure needs DOES NOT EXIST in the schema, or a
 *                source it depends on could not be read this cycle. We return
 *                `value: null` and a one-line basis saying why — NEVER a
 *                fabricated 0-as-real.
 *
 * DELIBERATELY-ABSENT SOURCES, honest by construction. There is NO competitor-
 * monitoring table and NO roadmap/prioritisation table anywhere in the schema, so
 * competitor signals and a roadmap-priority score are ALWAYS `insufficient` — they
 * carry no input field at all and are emitted as honest no-data cards, not invented
 * numbers. Keyword-level themes are likewise `insufficient`: extracting them would
 * require reading ticket subject/body, which the lean reader DELIBERATELY excludes
 * to avoid exposing customer PII cross-tenant. Category-level themes (which the
 * schema DOES record) are surfaced as real facts instead.
 *
 * `now` is injected so the layer is deterministic and replayable — there is no
 * `Date.now()` here (the request-aging and 30-day windows are computed against the
 * injected `now`).
 */

// ---------------------------------------------------------------------------
// The label ladder — fact / derived reuse the provenance wording; insufficient
// is this board's honest no-data state (absence is an answer, never a zero).
// ---------------------------------------------------------------------------

export type ProductMetricKind = "fact" | "derived" | "insufficient";

export const PRODUCT_KIND_LABEL: Record<ProductMetricKind, string> = {
  fact: SIGNAL_KIND_LABEL.fact, // "Fact"
  derived: SIGNAL_KIND_LABEL.derived, // "Derived"
  insufficient: "Insufficient data",
};

export type ProductFormat = "int" | "pct";

/**
 * A board figure that carries its own label + basis. `value` is `null` if and
 * only if `kind === "insufficient"` — a labelled figure with a real value can
 * never be an insufficient one, and vice versa (enforced by the constructors and
 * asserted in the tests).
 */
export interface ProductMetric {
  key: string;
  /** Display name — "Open feature requests", "30-day activation rate", … */
  label: string;
  kind: ProductMetricKind;
  /** The figure, or `null` when the input source does not exist / was unreadable. */
  value: number | null;
  format: ProductFormat;
  /** Plain English: where the number comes from, or why it can't be computed. */
  basis: string;
}

/** One row of the voice-of-customer demand distribution (grouped by category). */
export interface ProductTheme {
  category: string;
  /** Human label — SUPPORT_CATEGORY_LABEL where known, else the raw category. */
  label: string;
  /** Tickets in this category (all statuses). */
  total: number;
  /** Tickets in this category still in an active status. */
  open: number;
}

export interface ProductBoard {
  /** ISO timestamp the board was assembled at (from the injected `now`). */
  asOf: string;
  /** Human month label, e.g. "August 2026". */
  periodLabel: string;
  metrics: ProductMetric[];
  /**
   * The demand distribution — every support-ticket category with a count,
   * surfaced as its own view so the page can list where customer demand and
   * friction concentrate rather than just a total. Null when the support-ticket
   * source could not be read this cycle.
   */
  demand: {
    themes: ReadonlyArray<ProductTheme>;
    totalTickets: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Input — every raw signal the board derives from, each already gathered from an
// EXISTING read model by the aggregator. A group is `null` when its source could
// not be read this cycle (loud-read failure) → its metrics render as honest
// `insufficient`, never a swallowed zero.
// ---------------------------------------------------------------------------

/** A lean support ticket — category/status/created_at only, NO PII, no bodies. */
export interface ProductTicketRow {
  category: string;
  status: string;
  created_at: string;
}

/** Demand signal — the lean support-ticket rows (all categories). */
export interface ProductDemandInput {
  tickets: ReadonlyArray<ProductTicketRow>;
}

/** Adoption / usage posture, folded from the HQ analytics snapshot. */
export interface ProductAdoptionInput {
  /** Organisations with status = active. */
  activeOrgs: number;
  /** Organisations with status = trial. */
  trialOrgs: number;
  /** Paying-or-trial orgs that logged in within the last 30 days. */
  usageActive30d: number;
  /** Paying-or-trial orgs that have never logged in (activation gap). */
  usageNeverLoggedIn: number;
  /** The paying-or-trial base the usage figures are measured against. */
  payingOrTrialBase: number;
  /** Cumulative customer growth vs the previous month, from the 12-month series. */
  growthPct: number;
}

export interface ProductInput {
  demand: ProductDemandInput | null;
  adoption: ProductAdoptionInput | null;
}

// ---------------------------------------------------------------------------
// Metric constructors — the ONLY way a figure gets onto the board, so the
// value/kind invariant holds by construction.
// ---------------------------------------------------------------------------

function fact(
  key: string,
  label: string,
  value: number,
  format: ProductFormat,
  basis: string,
): ProductMetric {
  return { key, label, kind: "fact", value, format, basis };
}

function derived(
  key: string,
  label: string,
  value: number,
  format: ProductFormat,
  basis: string,
): ProductMetric {
  return { key, label, kind: "derived", value, format, basis };
}

function insufficient(
  key: string,
  label: string,
  format: ProductFormat,
  basis: string,
): ProductMetric {
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
/** Requests older than this (in days) count as an aging backlog item. */
const AGING_DAYS = 30;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The source-unavailable basis, reused wherever a group could not be read. */
const SOURCE_UNAVAILABLE = (what: string) =>
  `The ${what} source could not be read this cycle; no figure is shown rather than a fabricated zero.`;

const FEATURE_REQUEST = "feature_request";
const BUG = "bug";

/** Fold the ticket window into the demand facts the board surfaces. */
function demandCounts(tickets: ReadonlyArray<ProductTicketRow>, nowMs: number) {
  let featureTotal = 0;
  let featureOpen = 0;
  let featureNew30d = 0;
  let featureAging = 0;
  let bugOpen = 0;
  for (const t of tickets) {
    const created = Date.parse(t.created_at);
    const ageMs = Number.isNaN(created) ? NaN : nowMs - created;
    const active = isActiveStatus(t.status);
    if (t.category === FEATURE_REQUEST) {
      featureTotal += 1;
      if (active) {
        featureOpen += 1;
        if (!Number.isNaN(ageMs) && ageMs > AGING_DAYS * DAY_MS) featureAging += 1;
      }
      if (!Number.isNaN(ageMs) && ageMs <= 30 * DAY_MS) featureNew30d += 1;
    } else if (t.category === BUG && active) {
      bugOpen += 1;
    }
  }
  return { featureTotal, featureOpen, featureNew30d, featureAging, bugOpen };
}

/** Group all tickets by category into the deterministic demand distribution. */
function buildThemes(tickets: ReadonlyArray<ProductTicketRow>): ProductTheme[] {
  const byCat = new Map<string, { total: number; open: number }>();
  for (const t of tickets) {
    const entry = byCat.get(t.category) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (isActiveStatus(t.status)) entry.open += 1;
    byCat.set(t.category, entry);
  }
  return [...byCat.entries()]
    .map(([category, c]) => ({
      category,
      label: SUPPORT_CATEGORY_LABEL[category as SupportCategory] ?? category,
      total: c.total,
      open: c.open,
    }))
    // Deterministic order: highest demand first, ties broken by category name.
    .sort((a, b) => (b.total - a.total) || a.category.localeCompare(b.category));
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

export function computeProductBoard(input: ProductInput, now: Date): ProductBoard {
  const periodLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  const nowMs = now.getTime();

  const metrics: ProductMetric[] = [];

  // ── Demand (support tickets) ──────────────────────────────────────────
  if (input.demand == null) {
    metrics.push(
      insufficient("feature_requests_total", "Feature requests (all-time)", "int", SOURCE_UNAVAILABLE("support-ticket")),
      insufficient("feature_requests_open", "Open feature requests", "int", SOURCE_UNAVAILABLE("support-ticket")),
      insufficient("feature_requests_new_30d", "New feature requests (30d)", "int", SOURCE_UNAVAILABLE("support-ticket")),
      insufficient("feature_requests_aging", "Aging feature requests", "int", SOURCE_UNAVAILABLE("support-ticket")),
      insufficient("bug_reports_open", "Open bug reports", "int", SOURCE_UNAVAILABLE("support-ticket")),
    );
  } else {
    const c = demandCounts(input.demand.tickets, nowMs);
    metrics.push(
      fact(
        "feature_requests_total",
        "Feature requests (all-time)",
        c.featureTotal,
        "int",
        "Support tickets filed under the feature_request category, all statuses.",
      ),
      fact(
        "feature_requests_open",
        "Open feature requests",
        c.featureOpen,
        "int",
        "Feature-request tickets still in an active status (open / in progress / waiting on customer) — the live demand backlog.",
      ),
      fact(
        "feature_requests_new_30d",
        "New feature requests (30d)",
        c.featureNew30d,
        "int",
        "Feature-request tickets created in the last 30 days — demand momentum.",
      ),
      fact(
        "feature_requests_aging",
        "Aging feature requests",
        c.featureAging,
        "int",
        `Open feature requests older than ${AGING_DAYS} days — demand that has waited without resolution.`,
      ),
      fact(
        "bug_reports_open",
        "Open bug reports",
        c.bugOpen,
        "int",
        "Active-status tickets filed under the bug category — the quality signal competing with feature work for roadmap time.",
      ),
    );
  }

  // ── Adoption / usage (analytics snapshot) ─────────────────────────────
  if (input.adoption == null) {
    metrics.push(
      insufficient("active_orgs", "Active organisations", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("trial_orgs", "Trial organisations", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("usage_active_30d", "Active in last 30 days", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("usage_never_logged_in", "Never logged in", "int", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("activation_rate_30d", "30-day activation rate", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
      insufficient("customer_growth_mom", "Customer growth (MoM)", "pct", SOURCE_UNAVAILABLE("analytics snapshot")),
    );
  } else {
    const a = input.adoption;
    metrics.push(
      fact(
        "active_orgs",
        "Active organisations",
        a.activeOrgs,
        "int",
        "Organisations with an active subscription status — the paying adoption base.",
      ),
      fact(
        "trial_orgs",
        "Trial organisations",
        a.trialOrgs,
        "int",
        "Organisations currently in trial — the top of the conversion funnel.",
      ),
      fact(
        "usage_active_30d",
        "Active in last 30 days",
        a.usageActive30d,
        "int",
        "Paying-or-trial organisations that logged in within the last 30 days.",
      ),
      fact(
        "usage_never_logged_in",
        "Never logged in",
        a.usageNeverLoggedIn,
        "int",
        "Paying-or-trial organisations that have never logged in — an activation gap, not a healthy zero.",
      ),
      a.payingOrTrialBase > 0
        ? derived(
            "activation_rate_30d",
            "30-day activation rate",
            round1((a.usageActive30d / a.payingOrTrialBase) * 100),
            "pct",
            `${a.usageActive30d} of ${a.payingOrTrialBase} paying-or-trial organisations logged in within the last 30 days.`,
          )
        : insufficient(
            "activation_rate_30d",
            "30-day activation rate",
            "pct",
            "No paying-or-trial organisations on record, so an activation rate is undefined.",
          ),
      derived(
        "customer_growth_mom",
        "Customer growth (MoM)",
        round1(a.growthPct),
        "pct",
        "Cumulative customer growth vs the previous month, from the 12-month acquisition series.",
      ),
    );
  }

  // ── Deliberately-absent sources — ALWAYS insufficient, never fabricated ─
  metrics.push(
    insufficient(
      "keyword_themes",
      "Keyword themes",
      "int",
      "Keyword-level theme extraction would require reading ticket subject/body; the lean reader deliberately excludes those to avoid exposing customer PII cross-tenant, so no keyword themes are fabricated. Category-level demand is shown instead.",
    ),
    insufficient(
      "competitor_signals",
      "Competitor signals",
      "int",
      "No competitor-monitoring table exists in the schema; competitor activity is not recorded anywhere queryable, so it is not fabricated.",
    ),
    insufficient(
      "roadmap_priority_score",
      "Roadmap priority score",
      "int",
      "No roadmap / prioritisation table exists in the schema; a priority score cannot be computed from any stored data and is not fabricated.",
    ),
  );

  return {
    asOf: now.toISOString(),
    periodLabel,
    metrics,
    demand:
      input.demand == null
        ? null
        : {
            themes: buildThemes(input.demand.tickets),
            totalTickets: input.demand.tickets.length,
          },
  };
}

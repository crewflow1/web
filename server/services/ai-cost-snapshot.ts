import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  AI_MONTHLY_CEILING_PENCE,
  budgetPercent,
  detectSpike,
  evaluateBudget,
  trailingAverage,
  ukMonthKeyOf,
  ukMonthWindow,
  type BudgetStatus,
  type MonthKey,
} from "@/lib/ai/governor";
import { SPIKE_BASELINE_MONTHS, trailingMonths } from "@/lib/ai/governor/policy";
import { featureDefinition } from "@/lib/ai/governor/registry";
import { getAiGovernorReadiness, type AiGovernorReadiness } from "@/lib/ai/governor/readiness";

/**
 * /admin/ai-costs snapshot — the HQ read for AI spend.
 *
 * Service-role throughout, exactly like `ops-snapshot.ts`: the page that calls
 * this is HQ-gated at app/admin/layout.tsx (`requireHqPage` → 404 for anyone
 * not on the allowlist), and the ledger's own RLS is admin-read-only PER ORG,
 * which by construction cannot answer an estate-wide question. Aggregation is
 * pushed into the two SQL rollups (20261062000000), both invoker-rights, so
 * this module holds no privilege the service-role client did not already carry.
 *
 * Every number here is derived from `ai_invocations`. While the governor is
 * dark that table is EMPTY, so this page renders zeros over an activation
 * checklist — which is the honest picture, and the reason the readiness block
 * is rendered first rather than as a footnote.
 */

export type AiCostOrgRow = {
  orgId: string;
  orgName: string;
  /** COMMITTED spend — ledger rows only. Reconciles against `ai_invocations`. */
  spentPence: number;
  /**
   * Budget claimed by calls IN FLIGHT right now. Not spend: it either becomes
   * spend or is given back. Shown separately because conflating the two would
   * make the ledger's own totals unreconcilable — and counted in `status`
   * because whether the org's NEXT call is permitted depends on both.
   */
  reservedPence: number;
  /** Calls in flight right now. */
  liveReservations: number;
  /**
   * Settled claims whose real cost EXCEEDED the estimate they were admitted on.
   * The one way committed spend can pass the ceiling, so it is surfaced rather
   * than buried: a non-zero figure means the reservation envelope on the bound
   * model (lib/ai/governor/registry.ts) is too tight.
   */
  overrunCount: number;
  /** Claims abandoned by a crashed process and reclaimed by their TTL. */
  expiredReservations: number;
  invocations: number;
  failures: number;
  status: BudgetStatus;
  percentOfCeiling: number;
  /** Mean monthly spend over the preceding months — the spike baseline. */
  trailingAveragePence: number;
  /** This month is more than 3× the org's own trailing average. */
  spiking: boolean;
};

export type AiCostFeatureRow = {
  feature: string;
  label: string;
  spentPence: number;
  invocations: number;
  failures: number;
};

/**
 * One Europe/London budget month in the trend window.
 *
 * `totalPence` is COMMITTED spend only — the same ledger figure the monthly
 * rollup returns, summed across the estate. In-flight reservations are
 * deliberately absent: a trend answers "what did each month cost", and a
 * reservation is not yet a cost. `deltaPence` is the month-over-month change in
 * committed spend, and is null for the OLDEST month in the window because there
 * is no earlier month inside it to compare against.
 */
export type AiCostTrendMonth = {
  /** The Europe/London budget month, `YYYY-MM`. */
  month: MonthKey;
  /** Human label, e.g. `Aug 2026`. Derived from the key, never re-bucketed. */
  label: string;
  totalPence: number;
  invocations: number;
  /** Change in committed spend vs the previous month in the window; null for the oldest. */
  deltaPence: number | null;
  /** True for the budget month the trend is anchored on (the newest in the window). */
  isCurrent: boolean;
};

export type AiCostTrend = {
  /** The Europe/London budget month the window ends on (its newest month). */
  asOfMonth: MonthKey;
  /** How many months the window spans, oldest → newest. */
  windowMonths: number;
  /** One entry per window month, OLDEST first, zero-filled where the ledger is silent. */
  months: ReadonlyArray<AiCostTrendMonth>;
  /** Sum of committed spend across the whole window. */
  totalPence: number;
  /** The single most expensive month's committed spend. Zero when nothing spent. */
  peakPence: number;
  /** The month that peak belongs to, or null while the window is all zeros. */
  peakMonth: MonthKey | null;
  /** How many months in the window recorded any committed spend. */
  monthsWithSpend: number;
  /**
   * Whether ANY month in the window recorded spend. False while the governor is
   * dark — which is the honest state today, and the signal the empty view keys
   * on rather than inventing a series.
   */
  hasAnySpend: boolean;
  /** Per-capability contribution aggregated across the whole window, most expensive first. */
  byFeature: ReadonlyArray<AiCostFeatureRow>;
  generatedAt: string;
};

export type AiCostSnapshot = {
  /** The Europe/London budget month these figures cover, `YYYY-MM`. */
  month: MonthKey;
  ceilingPence: number;
  /** Whether anything can actually reach a provider. False while dark. */
  readiness: AiGovernorReadiness;
  totalPence: number;
  /** Estate-wide budget claimed by in-flight calls. Zero while the governor is dark. */
  totalReservedPence: number;
  totalInvocations: number;
  totalFailures: number;
  /** Estate-wide count of settled claims that cost more than they reserved. */
  totalOverruns: number;
  /** Orgs with spend this month, most expensive first. */
  byOrg: ReadonlyArray<AiCostOrgRow>;
  /** Features with spend this month, most expensive first. */
  byFeature: ReadonlyArray<AiCostFeatureRow>;
  /** Orgs at or over the ceiling right now. */
  blockedOrgs: ReadonlyArray<AiCostOrgRow>;
  /** Orgs whose spend is anomalous against their own history. */
  spikingOrgs: ReadonlyArray<AiCostOrgRow>;
  generatedAt: string;
};

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string } | null };
/**
 * A set-returning RPC call that can be PAGED. `.order()` gives it the stable,
 * unique ordering `fetchAllRows` requires; `.range()` is the per-page window.
 * The builder is itself awaitable so an un-paged single-row call (governor,
 * feature rollup) can still `await db(c).rpc(fn, args)` unchanged.
 */
type RpcBuilder = PromiseLike<RpcResult> & {
  order(col: string, opts?: { ascending?: boolean }): RpcBuilder;
  range(from: number, to: number): PromiseLike<RpcResult>;
};
type Rpc = {
  rpc(fn: string, args: Record<string, unknown>): RpcBuilder;
  from(t: string): {
    select(cols: string): {
      in(col: string, vals: readonly string[]): PromiseLike<{ data: Row[] | null; error: unknown }>;
    };
  };
};
const db = (c: unknown) => c as unknown as Rpc;

/**
 * Read EVERY per-org row from an estate-wide rollup RPC (`p_org_id = null`),
 * paged under the PostgREST cap.
 *
 * THE F-1 TRUNCATION THIS CLOSES. The two estate rollups group by `org_id` —
 * one row per org with spend — and PostgREST clamps any set-returning response
 * at `max_rows = 1000` (supabase/config.toml) with NO error and NO GUC override.
 * The rollups carry no ORDER BY, so once >1000 orgs have AI spend in a month an
 * un-paged read returns a NONDETERMINISTIC 1000 rows, and the estate
 * total/invocations/failures summed over them SILENTLY UNDER-REPORT. Paging with
 * a deterministic `order("org_id")` (unique — the rollup emits one row per org)
 * makes the read complete for any org count. Throws on any page error so the
 * caller degrades to an empty map rather than aggregating a partial set.
 */
async function pagedEstateRollup(fn: string, probe: string): Promise<Row[]> {
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db(admin)
        .rpc(fn, { p_org_id: null, p_month: probe })
        .order("org_id", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<Row>>,
  );
  if (error) throw error;
  return data;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Any date inside a UK budget month, as `YYYY-MM-DD`, for the SQL rollups. */
function probeDateFor(month: MonthKey): string | null {
  const { startMs } = ukMonthWindow(month);
  if (!Number.isFinite(startMs)) return null;
  // Midday on the 2nd: safely inside the month under either UTC offset.
  return new Date(startMs + 86_400_000 + 43_200_000).toISOString().slice(0, 10);
}

/** Per-org totals for one budget month, keyed by org id. Empty on any failure. */
async function orgTotalsFor(month: MonthKey): Promise<Map<string, Row>> {
  const probe = probeDateFor(month);
  if (!probe) return new Map();
  try {
    // PAGED estate read — see pagedEstateRollup for the F-1 truncation this
    // closes. One row per org, so the org_id key is unique across all pages.
    const rows = await pagedEstateRollup("ai_invocations_month_totals", probe);
    return new Map(rows.map((r) => [String(r.org_id), r]));
  } catch (e) {
    console.error("[ai-cost-snapshot] org totals failed", e);
    return new Map();
  }
}

/**
 * Live reservation totals for one budget month, keyed by org id. Empty on any
 * failure.
 *
 * A SEPARATE rollup rather than a join, because the two tables answer different
 * questions and one of them is time-sensitive: `live_pence` depends on `now()`
 * against each claim's TTL, so it cannot be materialised or cached the way a
 * month's committed total can.
 */
async function orgReservationsFor(month: MonthKey): Promise<Map<string, Row>> {
  const probe = probeDateFor(month);
  if (!probe) return new Map();
  try {
    // PAGED estate read — same F-1 truncation guard as orgTotalsFor. The
    // reservation rollup also groups by org_id, so the key is unique per page.
    const rows = await pagedEstateRollup("ai_reservations_month_totals", probe);
    return new Map(rows.map((r) => [String(r.org_id), r]));
  } catch (e) {
    console.error("[ai-cost-snapshot] reservation totals failed", e);
    return new Map();
  }
}

/** Build the estate-wide AI cost picture for a budget month (default: this one). */
export async function buildAiCostSnapshot(month?: MonthKey): Promise<AiCostSnapshot> {
  const monthKey = month ?? ukMonthKeyOf(new Date());
  const readiness = getAiGovernorReadiness();

  // This month, plus the trailing months that form each org's spike baseline.
  const current = await orgTotalsFor(monthKey);
  const reservations = await orgReservationsFor(monthKey);
  const history = await Promise.all(
    trailingMonths(monthKey, SPIKE_BASELINE_MONTHS).map((m) => orgTotalsFor(m)),
  );

  // THE UNION, not just the ledger's keys. An org with calls in flight and no
  // settled spend yet has no `ai_invocations` row — and it is precisely the org
  // an operator most wants to see, because it may already be at its ceiling.
  const orgIds = [...new Set([...current.keys(), ...reservations.keys()])];
  const names = await orgNames(orgIds);

  const byOrg: AiCostOrgRow[] = orgIds
    .map((orgId) => {
      const row = current.get(orgId) ?? {};
      const res = reservations.get(orgId) ?? {};
      const spentPence = num(row.total_cost_pence);
      const reservedPence = num(res.live_pence);
      const avg = trailingAverage(
        history.map((h) => num(h.get(orgId)?.total_cost_pence)),
      );
      // Headroom is committed AND claimed — the honest answer to "can this org
      // make another call", which is what the status pill is read as meaning.
      const committedAndClaimed = spentPence + reservedPence;
      return {
        orgId,
        orgName: names.get(orgId) ?? orgId,
        spentPence,
        reservedPence,
        liveReservations: num(res.live_count),
        overrunCount: num(res.overrun_count),
        expiredReservations: num(res.expired_count),
        invocations: num(row.invocations),
        failures: num(row.failures),
        status: evaluateBudget(committedAndClaimed, AI_MONTHLY_CEILING_PENCE),
        percentOfCeiling: budgetPercent(committedAndClaimed, AI_MONTHLY_CEILING_PENCE),
        trailingAveragePence: avg,
        spiking: detectSpike(spentPence, avg),
      };
    })
    .sort((a, b) => b.spentPence + b.reservedPence - (a.spentPence + a.reservedPence));

  const byFeature = await featureTotals(monthKey);

  return {
    month: monthKey,
    ceilingPence: AI_MONTHLY_CEILING_PENCE,
    readiness,
    totalPence: byOrg.reduce((a, o) => a + o.spentPence, 0),
    totalReservedPence: byOrg.reduce((a, o) => a + o.reservedPence, 0),
    totalInvocations: byOrg.reduce((a, o) => a + o.invocations, 0),
    totalFailures: byOrg.reduce((a, o) => a + o.failures, 0),
    totalOverruns: byOrg.reduce((a, o) => a + o.overrunCount, 0),
    byOrg,
    byFeature,
    blockedOrgs: byOrg.filter((o) => o.status === "blocked"),
    spikingOrgs: byOrg.filter((o) => o.spiking),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * How many Europe/London months the HQ trend view spans, ending on the current
 * month. Twelve: a full year makes a seasonal shape (a busy quarter, a quiet
 * summer) legible, and is short enough that every bar stays readable at 375px.
 */
export const AI_COST_TREND_MONTHS = 12;

/** A `YYYY-MM` key rendered as `Aug 2026`. LABEL ONLY — no bucketing here. */
function monthLabel(month: MonthKey): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim());
  if (!m) return month;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return month;
  // A fixed UTC instant on the 1st, formatted in UTC — the key already IS the
  // Europe/London month, so this only names it and must never shift it.
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Compose the trend from a window anchored on `asOfMonth` and a map of
 * per-month committed totals. PURE — no clock, no I/O — so the London-month
 * window and the zero-fill can be proven at their boundaries with frozen
 * fixtures rather than observed in production.
 *
 * The window is the `windowMonths` Europe/London months ENDING on `asOfMonth`,
 * built from `trailingMonths` (the London-pinned label arithmetic) rather than
 * from any `toISOString` month maths — the same helper the spike baseline uses.
 * Months the ledger is silent about are filled with an honest zero, never
 * dropped: a month with no spend is information, and a gap would misread as
 * "no data" rather than "£0".
 */
export function composeAiCostTrend(input: {
  asOfMonth: MonthKey;
  windowMonths?: number;
  monthTotals: ReadonlyMap<MonthKey, { totalPence: number; invocations: number }>;
  byFeature?: ReadonlyArray<AiCostFeatureRow>;
  generatedAt?: string;
}): AiCostTrend {
  const windowMonths =
    typeof input.windowMonths === "number" && input.windowMonths > 0
      ? Math.floor(input.windowMonths)
      : AI_COST_TREND_MONTHS;

  // trailingMonths gives the months BEFORE asOfMonth, oldest first; asOfMonth
  // itself is the window's newest month.
  const window = [...trailingMonths(input.asOfMonth, windowMonths - 1), input.asOfMonth];

  const months: AiCostTrendMonth[] = window.map((month, i) => {
    const cell = input.monthTotals.get(month);
    const totalPence = num(cell?.totalPence);
    const prevTotal = i > 0 ? num(input.monthTotals.get(window[i - 1]!)?.totalPence) : 0;
    return {
      month,
      label: monthLabel(month),
      totalPence,
      invocations: num(cell?.invocations),
      deltaPence: i > 0 ? totalPence - prevTotal : null,
      isCurrent: month === input.asOfMonth,
    };
  });

  let peakPence = 0;
  let peakMonth: MonthKey | null = null;
  let monthsWithSpend = 0;
  let totalPence = 0;
  for (const m of months) {
    totalPence += m.totalPence;
    if (m.totalPence > 0) monthsWithSpend += 1;
    if (m.totalPence > peakPence) {
      peakPence = m.totalPence;
      peakMonth = m.month;
    }
  }

  return {
    asOfMonth: input.asOfMonth,
    windowMonths,
    months,
    totalPence,
    peakPence,
    peakMonth,
    monthsWithSpend,
    hasAnySpend: totalPence > 0,
    byFeature: input.byFeature ?? [],
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/**
 * Build the estate-wide AI spend TREND — the last `AI_COST_TREND_MONTHS`
 * Europe/London budget months, month over month, plus per-feature contribution
 * over the same window.
 *
 * Reads exactly like the rest of this module: the SAME two invoker-rights SQL
 * rollups (`ai_invocations_month_totals`, `ai_invocations_month_by_feature`),
 * through the SAME service-role client, one call per window month. It writes
 * nothing — pure presentation over telemetry that already exists. While the
 * governor is dark every rollup is empty, so the series is twelve honest zeros
 * rather than a fabricated line.
 */
export async function buildAiCostTrend(month?: MonthKey): Promise<AiCostTrend> {
  const asOfMonth = month ?? ukMonthKeyOf(new Date());
  const window = [...trailingMonths(asOfMonth, AI_COST_TREND_MONTHS - 1), asOfMonth];

  // One rollup call per window month, in parallel. Each returns per-ORG rows for
  // that month; the estate total is their sum. Loud reads: orgTotalsFor and
  // featureTotals already log and degrade to empty on any failure.
  const [orgTotalsByMonth, featureRowsByMonth] = await Promise.all([
    Promise.all(window.map((m) => orgTotalsFor(m))),
    Promise.all(window.map((m) => featureTotals(m))),
  ]);

  const monthTotals = new Map<MonthKey, { totalPence: number; invocations: number }>();
  window.forEach((m, i) => {
    let totalPence = 0;
    let invocations = 0;
    for (const row of orgTotalsByMonth[i]!.values()) {
      totalPence += num(row.total_cost_pence);
      invocations += num(row.invocations);
    }
    monthTotals.set(m, { totalPence, invocations });
  });

  // Per-feature, summed across the whole window rather than a single month —
  // "where has the year's money gone", the trend counterpart of the page's
  // current-month by-feature table.
  const featureAgg = new Map<string, AiCostFeatureRow>();
  for (const rows of featureRowsByMonth) {
    for (const r of rows) {
      const cur =
        featureAgg.get(r.feature) ??
        { feature: r.feature, label: r.label, spentPence: 0, invocations: 0, failures: 0 };
      cur.spentPence += r.spentPence;
      cur.invocations += r.invocations;
      cur.failures += r.failures;
      featureAgg.set(r.feature, cur);
    }
  }
  const byFeature = [...featureAgg.values()].sort((a, b) => b.spentPence - a.spentPence);

  return composeAiCostTrend({
    asOfMonth,
    windowMonths: AI_COST_TREND_MONTHS,
    monthTotals,
    byFeature,
    generatedAt: new Date().toISOString(),
  });
}

/** Per-feature totals for a budget month, most expensive first. */
async function featureTotals(month: MonthKey): Promise<AiCostFeatureRow[]> {
  const probe = probeDateFor(month);
  if (!probe) return [];
  try {
    const { data, error } = await db(createAdminClient()).rpc("ai_invocations_month_by_feature", {
      p_month: probe,
      p_org_id: null,
    });
    if (error) {
      console.error("[ai-cost-snapshot] feature totals failed", error);
      return [];
    }
    const rows = Array.isArray(data) ? (data as Row[]) : [];
    return rows
      .map((r) => {
        const key = String(r.feature);
        return {
          feature: key,
          // An unregistered key means the ledger holds a feature this build no
          // longer knows — surfaced verbatim rather than hidden, because a
          // renamed feature silently vanishing from the cost view is how spend
          // goes unexplained.
          label: featureDefinition(key)?.label ?? `${key} (unregistered)`,
          spentPence: num(r.total_cost_pence),
          invocations: num(r.invocations),
          failures: num(r.failures),
        };
      })
      .sort((a, b) => b.spentPence - a.spentPence);
  } catch (e) {
    console.error("[ai-cost-snapshot] feature totals threw", e);
    return [];
  }
}

/** Org id → display name, for the ids that actually have spend. */
async function orgNames(ids: ReadonlyArray<string>): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    const { data } = await db(createAdminClient()).from("organizations").select("id, name").in("id", ids);
    return new Map((data ?? []).map((r) => [String(r.id), String(r.name ?? r.id)]));
  } catch (e) {
    console.error("[ai-cost-snapshot] org names failed", e);
    return new Map();
  }
}

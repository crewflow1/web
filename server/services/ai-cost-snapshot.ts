import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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
type Rpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(t: string): {
    select(cols: string): {
      in(col: string, vals: readonly string[]): PromiseLike<{ data: Row[] | null; error: unknown }>;
    };
  };
};
const db = (c: unknown) => c as unknown as Rpc;

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
    const { data, error } = await db(createAdminClient()).rpc("ai_invocations_month_totals", {
      p_org_id: null,
      p_month: probe,
    });
    if (error) {
      console.error("[ai-cost-snapshot] org totals failed", error);
      return new Map();
    }
    const rows = Array.isArray(data) ? (data as Row[]) : [];
    return new Map(rows.map((r) => [String(r.org_id), r]));
  } catch (e) {
    console.error("[ai-cost-snapshot] org totals threw", e);
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
    const { data, error } = await db(createAdminClient()).rpc("ai_reservations_month_totals", {
      p_org_id: null,
      p_month: probe,
    });
    if (error) {
      console.error("[ai-cost-snapshot] reservation totals failed", error);
      return new Map();
    }
    const rows = Array.isArray(data) ? (data as Row[]) : [];
    return new Map(rows.map((r) => [String(r.org_id), r]));
  } catch (e) {
    console.error("[ai-cost-snapshot] reservation totals threw", e);
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

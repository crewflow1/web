import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeMetrics } from "@/lib/hq/metrics";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import { getAiTaskCounts } from "@/server/services/hq-sales";
import {
  pipelineValue,
  tallyStatuses,
  type StatusCounts,
} from "@/lib/sales/model";
import {
  assembleExecutiveSections,
  type ExecSection,
  type ExecutiveInput,
} from "@/lib/hq/executive";

/**
 * CrewFlow HQ — Executive Command Centre aggregator (CEO Directive 004,
 * Phase 2). Service-role only.
 *
 * Gathers every figure the control centre shows in one parallel batch:
 *   - `buildHqSnapshot()` — revenue / MRR series, customers, trials, demos
 *   - `getAiTaskCounts()` — the autonomous task queue, by status
 *   - one bounded read of the companies table → status counts, pipeline /
 *     won value, researched + qualified counts (small columns only — the
 *     jsonb `enrichment` blob is checked with a cheap head COUNT instead)
 *   - four head COUNT queries over the timeline for the outreach channels
 *
 * The pure `assembleExecutiveSections` (lib/hq/executive.ts) turns the raw
 * numbers into the directive's grouped card set, so this layer stays a thin
 * data-gathering shim. Every query is bounded or COUNT(head) so it scales
 * to 100k companies without loading the world.
 *
 * The hq_sales_* tables aren't in the generated Supabase types, so the
 * query builder is reached through the same minimal `q<T>()` shim used by
 * hq-sales / hq-memory.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type DbError = { message: string } | null;

interface Q<T> extends PromiseLike<{
  data: T[] | null;
  count: number | null;
  error: DbError;
}> {
  select(
    columns: string,
    options?: { count?: "exact" | "planned" | "estimated"; head?: boolean },
  ): Q<T>;
  eq(column: string, value: unknown): Q<T>;
  gte(column: string, value: unknown): Q<T>;
  in(column: string, values: ReadonlyArray<unknown>): Q<T>;
  not(column: string, operator: string, value: unknown): Q<T>;
  limit(count: number): Q<T>;
}

function q<T>(admin: AdminClient, name: string): Q<T> {
  return admin.from(name as never) as unknown as Q<T>;
}

/** Run a prepared COUNT(head) query, degrading to 0 on error. */
async function runCount(query: Q<unknown>): Promise<number> {
  const { count, error } = await query;
  if (error) {
    console.error("[hq-executive] count query failed", error.message);
    return 0;
  }
  return count ?? 0;
}

type CompanyAggRow = {
  status: string;
  estimated_deal_value_gbp: number | null;
  ai_qualification_score: number | null;
  last_researched_at: string | null;
};

type CompanyAggregate = {
  counts: StatusCounts;
  total: number;
  pipelineValueGbp: number;
  wonValueGbp: number;
  researched: number;
  qualified: number;
  rejected: number;
};

/**
 * One bounded read of the small company columns → every company-derived
 * figure the dashboard needs. `enrichment` (jsonb) is deliberately NOT
 * selected here; "how many enriched" is a separate head COUNT so we never
 * pull heavy blobs across the wire.
 */
async function loadCompanyAggregate(
  admin: AdminClient,
): Promise<CompanyAggregate> {
  const { data, error } = await q<CompanyAggRow>(admin, "hq_sales_companies")
    .select(
      "status, estimated_deal_value_gbp, ai_qualification_score, last_researched_at",
    )
    .limit(100_000);
  if (error) {
    console.error("[hq-executive] company aggregate failed", error.message);
  }
  const rows = (data ?? []) as CompanyAggRow[];
  const counts = tallyStatuses(rows);
  let wonValueGbp = 0;
  let researched = 0;
  let qualified = 0;
  for (const r of rows) {
    if (r.status === "won") wonValueGbp += r.estimated_deal_value_gbp ?? 0;
    if (r.last_researched_at) researched += 1;
    if ((r.ai_qualification_score ?? -1) >= 60) qualified += 1;
  }
  return {
    counts,
    total: rows.length,
    pipelineValueGbp: pipelineValue(rows),
    wonValueGbp,
    researched,
    qualified,
    rejected: counts.disqualified,
  };
}

export type ExecutiveDashboard = {
  sections: ExecSection[];
  generatedAt: string;
};

/**
 * Gather every raw figure the executive view derives from, in one parallel
 * batch. Shared by `getExecutiveDashboard` (Phase 2) and the CEO board
 * (Phase 8) so both dashboards read the company / revenue / outreach numbers
 * from a single source of truth instead of duplicating the query plan.
 */
export async function gatherExecutiveInput(
  admin: AdminClient,
): Promise<ExecutiveInput> {
  const now = Date.now();
  const monthAgoIso = new Date(now - 30 * 86_400_000).toISOString();
  const todayStartIso = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

  const timeline = () =>
    q<unknown>(admin, "hq_sales_timeline_events").select("id", {
      count: "exact",
      head: true,
    });
  const companies = () =>
    q<unknown>(admin, "hq_sales_companies").select("id", {
      count: "exact",
      head: true,
    });

  const [
    snapshot,
    aiTasks,
    agg,
    coldCallsToday,
    emailsSent30d,
    linkedinMessages30d,
    instagramMessages30d,
    companiesEnriched,
  ] = await Promise.all([
    buildHqSnapshot(),
    getAiTaskCounts(),
    loadCompanyAggregate(admin),
    runCount(
      timeline()
        .in("event_type", ["call", "call_completed"])
        .gte("occurred_at", todayStartIso),
    ),
    runCount(
      timeline()
        .in("event_type", ["email", "email_sent"])
        .gte("occurred_at", monthAgoIso),
    ),
    runCount(
      timeline()
        .in("event_type", ["linkedin", "linkedin_sent"])
        .gte("occurred_at", monthAgoIso),
    ),
    runCount(
      timeline().eq("event_type", "instagram").gte("occurred_at", monthAgoIso),
    ),
    runCount(companies().not("enrichment", "is", null)),
  ]);

  const metrics = computeMetrics(snapshot);
  const mrr = snapshot.series.mrr;
  const rev = snapshot.series.revenue;
  const growth = snapshot.series.customerGrowth;
  const prevMrr = mrr.length >= 2 ? mrr[mrr.length - 2]?.mrr ?? 0 : 0;
  const lastRev = rev.length >= 1 ? rev[rev.length - 1]?.revenue ?? 0 : 0;
  const prevRev = rev.length >= 2 ? rev[rev.length - 2]?.revenue ?? 0 : 0;
  const newCustomersThisMonth =
    growth.length >= 1 ? growth[growth.length - 1]?.count ?? 0 : 0;

  return {
    mrrGbp: metrics.mrrGbp,
    mrrPrevGbp: prevMrr,
    revenueThisMonthGbp: lastRev,
    revenuePrevMonthGbp: prevRev,
    activeCustomers: metrics.activeCustomers,
    trials: metrics.activeOnboarding,
    newCustomersThisMonth,
    customerGrowthPct: metrics.growthPct,
    pipelineValueGbp: agg.pipelineValueGbp,
    wonValueGbp: agg.wonValueGbp,
    totalCompanies: agg.total,
    bookedDemos: snapshot.demos.demo_booked,
    activeDemos: snapshot.demos.pending_demo + snapshot.demos.legacy_new,
    statusCounts: agg.counts,
    coldCallsToday,
    emailsSent30d,
    linkedinMessages30d,
    instagramMessages30d,
    whatsappMessages30d: 0,
    aiTasks,
    companiesResearched: agg.researched,
    companiesQualified: agg.qualified,
    companiesRejected: agg.rejected,
    companiesEnriched,
  };
}

export async function getExecutiveDashboard(): Promise<ExecutiveDashboard> {
  const admin = createAdminClient();
  const input = await gatherExecutiveInput(admin);

  return {
    sections: assembleExecutiveSections(input),
    generatedAt: new Date().toISOString(),
  };
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMemory } from "@/server/services/hq-memory";
import { listMemoryTypes, listMemorySources } from "@/server/services/hq-memory";
import {
  aggregateSalesFacets,
  buildFunnel,
  closeRate,
  deriveDomain,
  EMPLOYEE_BANDS,
  eventLabel,
  isPromotableOutcome,
  likelihoodBandFromScore,
  pipelineValue,
  summariseActivity,
  tallyStatuses,
  tallyTaskStatuses,
  winRate,
  type AiProductivity,
  type SalesAiTask,
  type SalesChannel,
  type SalesChannelType,
  type SalesCompany,
  type SalesCompanyDetail,
  type SalesCompanyListItem,
  type SalesContact,
  type SalesDashboard,
  type SalesFacets,
  type SalesFeedItem,
  type SalesIntegration,
  type SalesLocation,
  type SalesRecommendation,
  type SalesResearchReport,
  type SalesSource,
  type SalesTaskItem,
  type SalesTaskType,
  type SalesTimelineEvent,
  type StatusCounts,
  type TaskStatusCounts,
} from "@/lib/sales/model";
import { COMM_EVENT_TYPES } from "@/lib/sales/comms";

/**
 * CrewFlow HQ — Sales AI Platform data access (CEO Directive 003).
 *
 * Service-role client only. The six hq_sales_* tables have RLS enabled
 * with ZERO policies, so every read/write here is invisible to the
 * customer/staff JWT client. Callers (HQ pages + actions) must already
 * have confirmed isSuperAdminEmail — NO customer surface ever reaches
 * this module.
 *
 * The tables aren't in the generated Supabase types yet, so the query
 * builder is reached through a single small typed shim (`table<T>()`),
 * mirroring hq-memory / hq-audit. Every mutating function emits a
 * timeline event (the company's own audit trail) and is additionally
 * paired by the caller with a recordAdminActivity row for the global HQ
 * audit log.
 *
 * FOUNDATION ONLY. Nothing here calls a model provider or runs research
 * autonomously. AI-authored artifacts simply carry `generated_by`,
 * `model`, and `ai_employee_id` so they are fully traceable.
 */

// ---------------------------------------------------------------------
// Minimal typed shim over the (still-untyped) Supabase query builder.
// ---------------------------------------------------------------------

type DbError = { message: string } | null;
type ListResult<T> = { data: T[] | null; count: number | null; error: DbError };
type SingleResult<T> = { data: T | null; error: DbError };

interface SalesQuery<T> extends PromiseLike<ListResult<T>> {
  select(
    columns: string,
    options?: { count?: "exact" | "planned" | "estimated"; head?: boolean },
  ): SalesQuery<T>;
  insert(payload: unknown): SalesQuery<T>;
  update(payload: unknown): SalesQuery<T>;
  delete(): SalesQuery<T>;
  eq(column: string, value: unknown): SalesQuery<T>;
  neq(column: string, value: unknown): SalesQuery<T>;
  not(column: string, operator: string, value: unknown): SalesQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): SalesQuery<T>;
  contains(column: string, value: unknown): SalesQuery<T>;
  or(filters: string): SalesQuery<T>;
  gte(column: string, value: unknown): SalesQuery<T>;
  lte(column: string, value: unknown): SalesQuery<T>;
  lt(column: string, value: unknown): SalesQuery<T>;
  textSearch(
    column: string,
    query: string,
    options?: { type?: "websearch" | "plain" | "phrase"; config?: string },
  ): SalesQuery<T>;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): SalesQuery<T>;
  range(from: number, to: number): SalesQuery<T>;
  limit(count: number): SalesQuery<T>;
  maybeSingle(): PromiseLike<SingleResult<T>>;
}

type AdminClient = ReturnType<typeof createAdminClient>;

function table<T>(admin: AdminClient, name: string): SalesQuery<T> {
  return admin.from(name as never) as unknown as SalesQuery<T>;
}

// ---------------------------------------------------------------------
// Column projections. `summary` (long) and `search_tsv` are excluded from
// list/feed queries so cards stay lightweight.
// ---------------------------------------------------------------------

const COMPANY_LIST_COLUMNS = [
  "id", "name", "website", "domain", "industry", "employee_count",
  "annual_turnover_gbp", "location", "region", "county", "country",
  "primary_email", "primary_phone", "linkedin_url", "instagram_url",
  "facebook_url", "companies_house_url", "companies_house_number",
  "website_technology", "crm_score", "ai_qualification_score",
  "estimated_deal_value_gbp", "status", "source", "assigned_to_email",
  "tags", "last_researched_at", "created_by_id", "created_by_email",
  "created_at", "updated_at",
].join(", ");

// Company Intelligence — reserved signals, loaded only on the detail page
// (kept out of list/search projections so cards stay lightweight at scale).
const COMPANY_INTELLIGENCE_COLUMNS = [
  "revenue_estimate_gbp", "growth_score", "construction_sector",
  "software_used", "estimated_software_spend_gbp", "fleet_size",
  "staff_size", "website_quality_score", "marketing_quality_score",
  "hiring_activity_score", "digital_maturity_score", "enrichment",
].join(", ");

const COMPANY_DETAIL_COLUMNS = `${COMPANY_LIST_COLUMNS}, summary, ${COMPANY_INTELLIGENCE_COLUMNS}`;

const CONTACT_COLUMNS =
  "id, company_id, full_name, title, seniority, email, phone, linkedin_url, is_primary, is_decision_maker, notes, created_by_email, created_at, updated_at";

const LOCATION_COLUMNS =
  "id, company_id, label, is_primary, is_headquarters, address_line1, address_line2, city, county, region, postcode, country, latitude, longitude, phone, notes, generated_by, model, ai_employee_id, created_by_email, metadata, created_at, updated_at";

const CHANNEL_COLUMNS =
  "id, company_id, contact_id, location_id, channel_type, value, label, is_primary, is_verified, status, generated_by, model, ai_employee_id, created_by_email, metadata, created_at, updated_at";

const TASK_COLUMNS =
  "id, company_id, contact_id, task_type, status, priority, priority_rank, retry_count, max_retries, assigned_ai_employee_id, scheduled_at, started_at, finished_at, error_message, payload, result, dedupe_key, source, created_by_email, created_at, updated_at";

const RESEARCH_COLUMNS =
  "id, company_id, summary, pain_points, likelihood_score, likelihood_band, estimated_software_spend_gbp, estimated_spend_note, best_angle, opening_line, recommended_follow_up, risk_assessment, risk_level, generated_by, model, ai_employee_id, authored_by_email, status, memory_id, created_at, updated_at";

const RECO_COLUMNS =
  "id, company_id, why_buy, key_features, likely_objections, recommended_pricing, recommended_plan, recommended_price_gbp, best_salesperson, best_time_to_call, follow_up_schedule, follow_up_steps, generated_by, model, ai_employee_id, authored_by_email, status, created_at, updated_at";

const TIMELINE_COLUMNS =
  "id, company_id, contact_id, event_type, direction, subject, body, outcome, occurred_at, actor_email, ai_employee_id, source, metadata, memory_id, created_at";

const FACET_COLUMNS =
  "status, industry, county, region, source, assigned_to_email, employee_count, estimated_deal_value_gbp";

const FACET_WINDOW = 5000; // bounded sample for facets + pipeline value
const ACTIVITY_WINDOW = 1000; // bounded sample for activity series

// ---------------------------------------------------------------------
// Lookups (extensible — "new lead sources are data, not code").
// ---------------------------------------------------------------------

export async function listSalesSources(
  activeOnly = false,
): Promise<SalesSource[]> {
  const admin = createAdminClient();
  let q = table<SalesSource>(admin, "hq_sales_sources").select(
    "slug, label, category, is_active, sort_order",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-sales] listSalesSources failed", error);
    return [];
  }
  return (data ?? []) as SalesSource[];
}

async function sourceLabelMap(): Promise<Record<string, string>> {
  const sources = await listSalesSources();
  return Object.fromEntries(sources.map((s) => [s.slug, s.label]));
}

/** Channel kinds (phone/email/linkedin/social/…) — extensible DATA. */
export async function listChannelTypes(
  activeOnly = true,
): Promise<SalesChannelType[]> {
  const admin = createAdminClient();
  let q = table<SalesChannelType>(admin, "hq_sales_channel_types").select(
    "slug, label, category, is_active, sort_order",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-sales] listChannelTypes failed", error);
    return [];
  }
  return (data ?? []) as SalesChannelType[];
}

/** Task kinds an AI employee can be assigned — extensible DATA. */
export async function listTaskTypes(
  activeOnly = true,
): Promise<SalesTaskType[]> {
  const admin = createAdminClient();
  let q = table<SalesTaskType>(admin, "hq_sales_task_types").select(
    "slug, label, category, is_active, sort_order",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-sales] listTaskTypes failed", error);
    return [];
  }
  return (data ?? []) as SalesTaskType[];
}

/** Future integration connectors (planned/connected/disabled) — DATA. */
export async function listIntegrations(
  activeOnly = false,
): Promise<SalesIntegration[]> {
  const admin = createAdminClient();
  let q = table<SalesIntegration>(admin, "hq_sales_integrations").select(
    "slug, label, category, status, is_active, sort_order",
  );
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("sort_order", { ascending: true });
  if (error) {
    console.error("[hq-sales] listIntegrations failed", error);
    return [];
  }
  return (data ?? []) as SalesIntegration[];
}

// ---------------------------------------------------------------------
// Search — keyword (FTS) + every structured filter, paginated. All
// filters hit btree / GIN indexes so search stays instant at scale.
// ---------------------------------------------------------------------

export type CompanySort = "recent" | "oldest" | "name" | "score" | "researched";

export type CompanySearchParams = {
  q?: string;
  status?: string;
  industry?: string;
  county?: string;
  region?: string;
  source?: string;
  assignedTo?: string;
  tag?: string;
  tech?: string;
  sizeBand?: string;
  minScore?: number;
  sort?: CompanySort;
  page?: number;
  pageSize?: number;
};

export type CompanySearchResult = {
  companies: SalesCompanyListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function searchCompanies(
  params: CompanySearchParams = {},
): Promise<CompanySearchResult> {
  const admin = createAdminClient();
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 20)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = table<SalesCompanyListItem>(admin, "hq_sales_companies").select(
    COMPANY_LIST_COLUMNS,
    { count: "exact" },
  );

  const term = params.q?.trim();
  if (term) {
    q = q.textSearch("search_tsv", term, { type: "websearch", config: "english" });
  }
  if (params.status) q = q.eq("status", params.status);
  if (params.industry) q = q.eq("industry", params.industry);
  if (params.county) q = q.eq("county", params.county);
  if (params.region) q = q.eq("region", params.region);
  if (params.source) q = q.eq("source", params.source);
  if (params.assignedTo) q = q.eq("assigned_to_email", params.assignedTo);
  if (params.tag) q = q.contains("tags", [params.tag]);
  if (params.tech) q = q.contains("website_technology", [params.tech]);
  if (typeof params.minScore === "number") {
    q = q.gte("ai_qualification_score", params.minScore);
  }
  if (params.sizeBand) {
    const band = EMPLOYEE_BANDS.find((b) => b.key === params.sizeBand);
    if (band) {
      q = q.gte("employee_count", band.min);
      if (band.max != null) q = q.lte("employee_count", band.max);
    }
  }

  switch (params.sort) {
    case "oldest":
      q = q.order("created_at", { ascending: true });
      break;
    case "name":
      q = q.order("name", { ascending: true });
      break;
    case "score":
      q = q.order("ai_qualification_score", { ascending: false, nullsFirst: false });
      break;
    case "researched":
      q = q.order("last_researched_at", { ascending: false, nullsFirst: false });
      break;
    case "recent":
    default:
      q = q.order("created_at", { ascending: false });
      break;
  }

  const { data, count, error } = await q.range(from, to);
  if (error) {
    console.error("[hq-sales] searchCompanies failed", error);
    return { companies: [], total: 0, page, pageSize, pageCount: 0 };
  }
  const total = count ?? 0;
  return {
    companies: (data ?? []) as SalesCompanyListItem[],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------------------------------------------------------------------
// Detail — company + contacts + research + recommendations + timeline.
// ---------------------------------------------------------------------

export async function getCompany(id: string): Promise<SalesCompany | null> {
  const admin = createAdminClient();
  const { data, error } = await table<SalesCompany>(admin, "hq_sales_companies")
    .select(COMPANY_DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[hq-sales] getCompany failed", error);
    return null;
  }
  return (data as SalesCompany | null) ?? null;
}

export async function loadCompanyDetail(
  id: string,
): Promise<SalesCompanyDetail | null> {
  const admin = createAdminClient();
  const company = await getCompany(id);
  if (!company) return null;

  const [contacts, locations, channels, research, recommendations, timeline, tasks] =
    await Promise.all([
      table<SalesContact>(admin, "hq_sales_contacts")
        .select(CONTACT_COLUMNS)
        .eq("company_id", id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      table<SalesLocation>(admin, "hq_sales_locations")
        .select(LOCATION_COLUMNS)
        .eq("company_id", id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      table<SalesChannel>(admin, "hq_sales_channels")
        .select(CHANNEL_COLUMNS)
        .eq("company_id", id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      table<SalesResearchReport>(admin, "hq_sales_research_reports")
        .select(RESEARCH_COLUMNS)
        .eq("company_id", id)
        .order("created_at", { ascending: false }),
      table<SalesRecommendation>(admin, "hq_sales_recommendations")
        .select(RECO_COLUMNS)
        .eq("company_id", id)
        .order("created_at", { ascending: false }),
      table<SalesTimelineEvent>(admin, "hq_sales_timeline_events")
        .select(TIMELINE_COLUMNS)
        .eq("company_id", id)
        .order("occurred_at", { ascending: false })
        .limit(200),
      table<SalesAiTask>(admin, "hq_sales_ai_tasks")
        .select(TASK_COLUMNS)
        .eq("company_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  return {
    company,
    contacts: (contacts.data ?? []) as SalesContact[],
    locations: (locations.data ?? []) as SalesLocation[],
    channels: (channels.data ?? []) as SalesChannel[],
    research: (research.data ?? []) as SalesResearchReport[],
    recommendations: (recommendations.data ?? []) as SalesRecommendation[],
    timeline: (timeline.data ?? []) as SalesTimelineEvent[],
    tasks: (tasks.data ?? []) as SalesAiTask[],
  };
}

// ---------------------------------------------------------------------
// Activity feed — recent timeline events across ALL companies, joined
// with company name. Powers the global feed + dashboard "recent".
// ---------------------------------------------------------------------

export async function listActivityFeed(
  limit = 40,
  search?: string,
): Promise<SalesFeedItem[]> {
  const admin = createAdminClient();
  let q = table<SalesTimelineEvent>(
    admin,
    "hq_sales_timeline_events",
  ).select(TIMELINE_COLUMNS);
  const term = search?.trim();
  if (term) {
    // Full-text over subject/body/outcome/event_type — "everything searchable".
    q = q.textSearch("search_tsv", term, { type: "websearch", config: "english" });
  }
  const { data, error } = await q
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[hq-sales] listActivityFeed failed", error);
    return [];
  }
  const events = (data ?? []) as SalesTimelineEvent[];
  if (events.length === 0) return [];

  const companyIds = [...new Set(events.map((e) => e.company_id))];
  const { data: companies } = await table<{ id: string; name: string }>(
    admin,
    "hq_sales_companies",
  )
    .select("id, name")
    .in("id", companyIds);
  const nameById = new Map(
    ((companies ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  );

  return events.map((e) => ({
    ...e,
    company_name: nameById.get(e.company_id) ?? null,
  }));
}

/**
 * Communication Centre window (Directive 004, Phase 5) — a bounded,
 * newest-first read of every messaging touch (email / phone / linkedin /
 * instagram / whatsapp / sms / facebook) across ALL companies, joined with
 * company names. The page buckets this per channel in-app (lib/sales/comms).
 * Optional full-text search keeps "everything searchable" honest. Mirrors
 * listActivityFeed's bounded-read + name-join shape; the
 * ai_employee_tasks-style scale story is identical.
 */
export async function listCommunicationWindow(
  limit = 200,
  search?: string,
): Promise<SalesFeedItem[]> {
  const admin = createAdminClient();
  let q = table<SalesTimelineEvent>(admin, "hq_sales_timeline_events")
    .select(TIMELINE_COLUMNS)
    .in("event_type", COMM_EVENT_TYPES);
  const term = search?.trim();
  if (term) {
    q = q.textSearch("search_tsv", term, { type: "websearch", config: "english" });
  }
  const { data, error } = await q
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[hq-sales] listCommunicationWindow failed", error);
    return [];
  }
  const events = (data ?? []) as SalesTimelineEvent[];
  if (events.length === 0) return [];

  const companyIds = [...new Set(events.map((e) => e.company_id))];
  const { data: companies } = await table<{ id: string; name: string }>(
    admin,
    "hq_sales_companies",
  )
    .select("id, name")
    .in("id", companyIds);
  const nameById = new Map(
    ((companies ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  );

  return events.map((e) => ({
    ...e,
    company_name: nameById.get(e.company_id) ?? null,
  }));
}

// ---------------------------------------------------------------------
// AI Task Queue — the global view. listAiTasks returns a bounded, queue-
// ordered window joined with company names; getAiTaskCounts gives exact
// status counts. No worker executes anything — this is the foundation.
// ---------------------------------------------------------------------

export type AiTaskFilter = {
  status?: string;
  taskType?: string;
  limit?: number;
};

export async function listAiTasks(
  filter: AiTaskFilter = {},
): Promise<SalesTaskItem[]> {
  const admin = createAdminClient();
  const limit = Math.min(500, Math.max(1, Math.floor(filter.limit ?? 100)));
  let q = table<SalesAiTask>(admin, "hq_sales_ai_tasks").select(TASK_COLUMNS);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.taskType) q = q.eq("task_type", filter.taskType);
  // Queue order: highest priority first, then oldest scheduled / created.
  const { data, error } = await q
    .order("priority_rank", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[hq-sales] listAiTasks failed", error);
    return [];
  }
  const tasks = (data ?? []) as SalesAiTask[];
  if (tasks.length === 0) return [];

  const companyIds = [
    ...new Set(
      tasks
        .map((t) => t.company_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
  let nameById = new Map<string, string>();
  if (companyIds.length > 0) {
    const { data: companies } = await table<{ id: string; name: string }>(
      admin,
      "hq_sales_companies",
    )
      .select("id, name")
      .in("id", companyIds);
    nameById = new Map(
      ((companies ?? []) as { id: string; name: string }[]).map((c) => [
        c.id,
        c.name,
      ]),
    );
  }

  return tasks.map((t) => ({
    ...t,
    company_name: t.company_id ? nameById.get(t.company_id) ?? null : null,
  }));
}

export async function getAiTaskCounts(): Promise<TaskStatusCounts> {
  const admin = createAdminClient();
  const { data, error } = await table<{ status: string }>(
    admin,
    "hq_sales_ai_tasks",
  )
    .select("status")
    .limit(100000);
  if (error) {
    console.error("[hq-sales] getAiTaskCounts failed", error);
    return tallyTaskStatuses([]);
  }
  return tallyTaskStatuses((data ?? []) as { status: string }[]);
}

// ---------------------------------------------------------------------
// Dashboard — exact status counts via indexed COUNT(head) queries;
// facets + pipeline value from a bounded company window; activity series
// from a bounded timeline window; AI productivity via COUNT queries.
// ---------------------------------------------------------------------

async function countTable(
  admin: AdminClient,
  name: string,
  build: (q: SalesQuery<{ id: string }>) => SalesQuery<{ id: string }>,
): Promise<number> {
  const base = table<{ id: string }>(admin, name).select("id", {
    count: "exact",
    head: true,
  });
  const { count, error } = await build(base);
  if (error) {
    console.error(`[hq-sales] count ${name} failed`, error);
    return 0;
  }
  return count ?? 0;
}

async function getStatusCounts(admin: AdminClient): Promise<StatusCounts> {
  // One windowed read of just the status column is cheap (single small
  // column, GIN/btree backed) and gives exact counts at foundation scale.
  const { data, error } = await table<{ status: string }>(
    admin,
    "hq_sales_companies",
  )
    .select("status")
    .limit(100000);
  if (error) {
    console.error("[hq-sales] getStatusCounts failed", error);
    return tallyStatuses([]);
  }
  return tallyStatuses((data ?? []) as { status: string }[]);
}

export async function getSalesDashboard(): Promise<SalesDashboard> {
  const admin = createAdminClient();
  const monthAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [
    counts,
    sourceLabels,
    facetRes,
    activityRes,
    recentCompaniesRes,
    aiResearch,
    aiReco,
    aiLogged,
    feed,
  ] = await Promise.all([
    getStatusCounts(admin),
    sourceLabelMap(),
    table<{
      status: string;
      industry: string | null;
      county: string | null;
      region: string | null;
      source: string;
      assigned_to_email: string | null;
      employee_count: number | null;
      estimated_deal_value_gbp: number | null;
    }>(admin, "hq_sales_companies")
      .select(FACET_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(FACET_WINDOW),
    table<{ occurred_at: string }>(admin, "hq_sales_timeline_events")
      .select("occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(ACTIVITY_WINDOW),
    table<SalesCompanyListItem>(admin, "hq_sales_companies")
      .select(COMPANY_LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(8),
    countTable(admin, "hq_sales_research_reports", (q) =>
      q.eq("generated_by", "ai").gte("created_at", monthAgoIso),
    ),
    countTable(admin, "hq_sales_recommendations", (q) =>
      q.eq("generated_by", "ai").gte("created_at", monthAgoIso),
    ),
    countTable(admin, "hq_sales_timeline_events", (q) =>
      q.not("ai_employee_id", "is", null).gte("occurred_at", monthAgoIso),
    ),
    listActivityFeed(12),
  ]);

  const facetRows = (facetRes.data ?? []) as Parameters<
    typeof aggregateSalesFacets
  >[0];
  const facets: SalesFacets = aggregateSalesFacets(facetRows, sourceLabels);
  const activity = summariseActivity(
    (activityRes.data ?? []) as { occurred_at: string }[],
  );

  const wonValueGbp = facetRows
    .filter((r) => r.status === "won")
    .reduce((sum, r) => sum + (r.estimated_deal_value_gbp ?? 0), 0);

  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  const aiProductivity: AiProductivity = {
    researchReports: aiResearch,
    recommendations: aiReco,
    loggedActions: aiLogged,
    total: aiResearch + aiReco + aiLogged,
  };

  return {
    total,
    counts,
    funnel: buildFunnel(counts),
    winRate: winRate(counts),
    closeRate: closeRate(counts),
    pipelineValueGbp: pipelineValue(facetRows),
    wonValueGbp,
    activity,
    aiProductivity,
    facets,
    recentCompanies: (recentCompaniesRes.data ?? []) as SalesCompanyListItem[],
    recentActivity: feed,
  };
}

// ---------------------------------------------------------------------
// Analytics — funnel + the directive's facet set over a larger window.
// ---------------------------------------------------------------------

export type SalesAnalytics = {
  total: number;
  counts: StatusCounts;
  funnel: ReturnType<typeof buildFunnel>;
  winRate: number;
  closeRate: number;
  pipelineValueGbp: number;
  facets: SalesFacets;
};

export async function getSalesAnalytics(): Promise<SalesAnalytics> {
  const admin = createAdminClient();
  const [counts, sourceLabels, facetRes] = await Promise.all([
    getStatusCounts(admin),
    sourceLabelMap(),
    table<{
      status: string;
      industry: string | null;
      county: string | null;
      region: string | null;
      source: string;
      assigned_to_email: string | null;
      employee_count: number | null;
      estimated_deal_value_gbp: number | null;
    }>(admin, "hq_sales_companies")
      .select(FACET_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(FACET_WINDOW),
  ]);

  const facetRows = (facetRes.data ?? []) as Parameters<
    typeof aggregateSalesFacets
  >[0];
  const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);

  return {
    total,
    counts,
    funnel: buildFunnel(counts),
    winRate: winRate(counts),
    closeRate: closeRate(counts),
    pipelineValueGbp: pipelineValue(facetRows),
    facets: aggregateSalesFacets(facetRows, sourceLabels),
  };
}

// ---------------------------------------------------------------------
// Writes — HQ operator only. Each emits a timeline event (the company's
// own audit trail); the caller additionally writes recordAdminActivity.
// ---------------------------------------------------------------------

type Actor = { id: string | null; email: string | null };

export type WriteResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

async function insertTimelineEvent(
  admin: AdminClient,
  row: {
    company_id: string;
    contact_id?: string | null;
    event_type: string;
    direction?: string;
    subject?: string | null;
    body?: string;
    outcome?: string | null;
    occurred_at?: string;
    actor_email?: string | null;
    ai_employee_id?: string | null;
    source?: string;
    metadata?: Record<string, unknown> | null;
    memory_id?: string | null;
  },
): Promise<string | null> {
  const { data, error } = await table<{ id: string }>(
    admin,
    "hq_sales_timeline_events",
  )
    .insert({
      company_id: row.company_id,
      contact_id: row.contact_id ?? null,
      event_type: row.event_type,
      direction: row.direction ?? "internal",
      subject: row.subject ?? null,
      body: row.body ?? "",
      outcome: row.outcome ?? null,
      occurred_at: row.occurred_at ?? new Date().toISOString(),
      actor_email: row.actor_email ?? null,
      ai_employee_id: row.ai_employee_id ?? null,
      source: row.source ?? "manual",
      metadata: row.metadata ?? null,
      memory_id: row.memory_id ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[hq-sales] insertTimelineEvent failed", error);
    return null;
  }
  return data?.id ?? null;
}

export type CompanyWriteInput = {
  name: string;
  summary: string;
  website: string | null;
  industry: string | null;
  employeeCount: number | null;
  annualTurnoverGbp: number | null;
  location: string | null;
  region: string | null;
  county: string | null;
  country: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  linkedinUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  companiesHouseUrl: string | null;
  companiesHouseNumber: string | null;
  websiteTechnology: string[];
  crmScore: number | null;
  aiQualificationScore: number | null;
  estimatedDealValueGbp: number | null;
  status: string;
  source: string;
  assignedToEmail: string | null;
  tags: string[];
  // Company Intelligence — reserved, nullable signals (Directive 003).
  revenueEstimateGbp: number | null;
  growthScore: number | null;
  constructionSector: string | null;
  softwareUsed: string[];
  estimatedSoftwareSpendGbp: number | null;
  fleetSize: number | null;
  staffSize: number | null;
  websiteQualityScore: number | null;
  marketingQualityScore: number | null;
  hiringActivityScore: number | null;
  digitalMaturityScore: number | null;
};

function companyPayload(input: CompanyWriteInput) {
  return {
    name: input.name,
    summary: input.summary,
    website: input.website,
    domain: deriveDomain(input.website),
    industry: input.industry,
    employee_count: input.employeeCount,
    annual_turnover_gbp: input.annualTurnoverGbp,
    location: input.location,
    region: input.region,
    county: input.county,
    country: input.country || "United Kingdom",
    primary_email: input.primaryEmail,
    primary_phone: input.primaryPhone,
    linkedin_url: input.linkedinUrl,
    instagram_url: input.instagramUrl,
    facebook_url: input.facebookUrl,
    companies_house_url: input.companiesHouseUrl,
    companies_house_number: input.companiesHouseNumber,
    website_technology: input.websiteTechnology,
    crm_score: input.crmScore,
    ai_qualification_score: input.aiQualificationScore,
    estimated_deal_value_gbp: input.estimatedDealValueGbp,
    status: input.status,
    source: input.source,
    assigned_to_email: input.assignedToEmail,
    tags: input.tags,
    revenue_estimate_gbp: input.revenueEstimateGbp,
    growth_score: input.growthScore,
    construction_sector: input.constructionSector,
    software_used: input.softwareUsed,
    estimated_software_spend_gbp: input.estimatedSoftwareSpendGbp,
    fleet_size: input.fleetSize,
    staff_size: input.staffSize,
    website_quality_score: input.websiteQualityScore,
    marketing_quality_score: input.marketingQualityScore,
    hiring_activity_score: input.hiringActivityScore,
    digital_maturity_score: input.digitalMaturityScore,
  };
}

export async function createCompany(
  input: CompanyWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data, error } = await table<{ id: string }>(admin, "hq_sales_companies")
    .insert({
      ...companyPayload(input),
      created_by_id: actor.id,
      created_by_email: actor.email,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-sales] createCompany failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  await insertTimelineEvent(admin, {
    company_id: data.id,
    event_type: "created",
    actor_email: actor.email,
    body: `Company added to the Sales AI database.`,
    source: input.source,
    metadata: { status: input.status, source: input.source },
  });
  return { ok: true, id: data.id };
}

export async function updateCompany(
  id: string,
  input: CompanyWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const current = await getCompany(id);
  if (!current) return { ok: false, error: "Company not found" };

  const { error } = await table<SalesCompany>(admin, "hq_sales_companies")
    .update(companyPayload(input))
    .eq("id", id);
  if (error) {
    console.error("[hq-sales] updateCompany failed", error);
    return { ok: false, error: error.message };
  }

  // A status change via the edit form still records a status_change event.
  if (current.status !== input.status) {
    await insertTimelineEvent(admin, {
      company_id: id,
      event_type: "status_change",
      actor_email: actor.email,
      body: `Status changed to ${input.status}.`,
      metadata: { from: current.status, to: input.status },
    });
  }
  return { ok: true, id };
}

export async function setCompanyStatus(
  id: string,
  status: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const current = await getCompany(id);
  if (!current) return { ok: false, error: "Company not found" };
  if (current.status === status) return { ok: true, id };

  const { error } = await table<SalesCompany>(admin, "hq_sales_companies")
    .update({ status })
    .eq("id", id);
  if (error) {
    console.error("[hq-sales] setCompanyStatus failed", error);
    return { ok: false, error: error.message };
  }
  await insertTimelineEvent(admin, {
    company_id: id,
    event_type: "status_change",
    actor_email: actor.email,
    body: `Status changed to ${status}.`,
    metadata: { from: current.status, to: status },
  });
  return { ok: true, id };
}

// --- Contacts --------------------------------------------------------

export type ContactWriteInput = {
  fullName: string;
  title: string | null;
  seniority: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  notes: string;
};

function contactPayload(companyId: string, input: ContactWriteInput) {
  return {
    company_id: companyId,
    full_name: input.fullName,
    title: input.title,
    seniority: input.seniority,
    email: input.email,
    phone: input.phone,
    linkedin_url: input.linkedinUrl,
    is_primary: input.isPrimary,
    is_decision_maker: input.isDecisionMaker,
    notes: input.notes,
  };
}

export async function addContact(
  companyId: string,
  input: ContactWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data, error } = await table<{ id: string }>(admin, "hq_sales_contacts")
    .insert({ ...contactPayload(companyId, input), created_by_email: actor.email })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-sales] addContact failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  await insertTimelineEvent(admin, {
    company_id: companyId,
    contact_id: data.id,
    event_type: "note",
    actor_email: actor.email,
    body: `Added contact ${input.fullName}${input.title ? ` (${input.title})` : ""}.`,
  });
  return { ok: true, id: data.id };
}

export async function updateContact(
  id: string,
  companyId: string,
  input: ContactWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { error } = await table<SalesContact>(admin, "hq_sales_contacts")
    .update(contactPayload(companyId, input))
    .eq("id", id);
  if (error) {
    console.error("[hq-sales] updateContact failed", error);
    return { ok: false, error: error.message };
  }
  void actor;
  return { ok: true, id };
}

export async function deleteContact(
  id: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { error } = await table<SalesContact>(admin, "hq_sales_contacts")
    .delete()
    .eq("id", id);
  if (error) {
    console.error("[hq-sales] deleteContact failed", error);
    return { ok: false, error: error.message };
  }
  void actor;
  return { ok: true, id };
}

// --- Research reports (permanent) -----------------------------------

export type ResearchWriteInput = {
  summary: string;
  painPoints: string[];
  likelihoodScore: number | null;
  estimatedSoftwareSpendGbp: number | null;
  estimatedSpendNote: string;
  bestAngle: string;
  openingLine: string;
  recommendedFollowUp: string;
  riskAssessment: string;
  riskLevel: string;
  generatedBy: string;
  model: string | null;
  aiEmployeeId: string | null;
};

export async function addResearchReport(
  companyId: string,
  input: ResearchWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await table<{ id: string }>(
    admin,
    "hq_sales_research_reports",
  )
    .insert({
      company_id: companyId,
      summary: input.summary,
      pain_points: input.painPoints,
      likelihood_score: input.likelihoodScore,
      likelihood_band: likelihoodBandFromScore(input.likelihoodScore),
      estimated_software_spend_gbp: input.estimatedSoftwareSpendGbp,
      estimated_spend_note: input.estimatedSpendNote,
      best_angle: input.bestAngle,
      opening_line: input.openingLine,
      recommended_follow_up: input.recommendedFollowUp,
      risk_assessment: input.riskAssessment,
      risk_level: input.riskLevel,
      generated_by: input.generatedBy,
      model: input.model,
      ai_employee_id: input.aiEmployeeId,
      authored_by_email: actor.email,
      status: "final",
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-sales] addResearchReport failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }

  // Stamp last_researched_at on the company.
  await table<SalesCompany>(admin, "hq_sales_companies")
    .update({ last_researched_at: nowIso })
    .eq("id", companyId);

  await insertTimelineEvent(admin, {
    company_id: companyId,
    event_type: "research",
    actor_email: input.generatedBy === "human" ? actor.email : null,
    ai_employee_id: input.aiEmployeeId,
    source: input.generatedBy === "ai" ? "ai_research" : "manual",
    body: `Research report completed.`,
    occurred_at: nowIso,
    metadata: { likelihood_band: likelihoodBandFromScore(input.likelihoodScore) },
  });
  return { ok: true, id: data.id };
}

// --- Recommendations -------------------------------------------------

export type RecommendationWriteInput = {
  whyBuy: string;
  keyFeatures: string[];
  likelyObjections: string[];
  recommendedPricing: string;
  recommendedPlan: string | null;
  recommendedPriceGbp: number | null;
  bestSalesperson: string | null;
  bestTimeToCall: string;
  followUpSchedule: string;
  followUpSteps: unknown | null;
  generatedBy: string;
  model: string | null;
  aiEmployeeId: string | null;
};

export async function addRecommendation(
  companyId: string,
  input: RecommendationWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();

  // Supersede any currently-active recommendation for this company.
  await table<SalesRecommendation>(admin, "hq_sales_recommendations")
    .update({ status: "superseded" })
    .eq("company_id", companyId)
    .eq("status", "active");

  const { data, error } = await table<{ id: string }>(
    admin,
    "hq_sales_recommendations",
  )
    .insert({
      company_id: companyId,
      why_buy: input.whyBuy,
      key_features: input.keyFeatures,
      likely_objections: input.likelyObjections,
      recommended_pricing: input.recommendedPricing,
      recommended_plan: input.recommendedPlan,
      recommended_price_gbp: input.recommendedPriceGbp,
      best_salesperson: input.bestSalesperson,
      best_time_to_call: input.bestTimeToCall,
      follow_up_schedule: input.followUpSchedule,
      follow_up_steps: input.followUpSteps,
      generated_by: input.generatedBy,
      model: input.model,
      ai_employee_id: input.aiEmployeeId,
      authored_by_email: actor.email,
      status: "active",
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("[hq-sales] addRecommendation failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  await insertTimelineEvent(admin, {
    company_id: companyId,
    event_type: "recommendation",
    actor_email: input.generatedBy === "human" ? actor.email : null,
    ai_employee_id: input.aiEmployeeId,
    body: `AI recommendation generated.`,
  });
  return { ok: true, id: data.id };
}

// --- Timeline interactions ------------------------------------------

export type TimelineWriteInput = {
  eventType: string;
  direction: string;
  subject: string | null;
  body: string;
  outcome: string | null;
  occurredAt: string | null;
  contactId: string | null;
};

export async function logInteraction(
  companyId: string,
  input: TimelineWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const id = await insertTimelineEvent(admin, {
    company_id: companyId,
    contact_id: input.contactId,
    event_type: input.eventType,
    direction: input.direction,
    subject: input.subject,
    body: input.body,
    outcome: input.outcome,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    actor_email: actor.email,
    source: "manual",
  });
  if (!id) return { ok: false, error: "Could not log interaction" };
  return { ok: true, id };
}

// --- Locations (multiple per company) -------------------------------

export type LocationWriteInput = {
  label: string | null;
  isPrimary: boolean;
  isHeadquarters: boolean;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  county: string | null;
  region: string | null;
  postcode: string | null;
  country: string;
  phone: string | null;
  notes: string;
  generatedBy: string;
  model: string | null;
  aiEmployeeId: string | null;
};

function locationPayload(companyId: string, input: LocationWriteInput) {
  const isAi = input.generatedBy === "ai";
  return {
    company_id: companyId,
    label: input.label,
    is_primary: input.isPrimary,
    is_headquarters: input.isHeadquarters,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    county: input.county,
    region: input.region,
    postcode: input.postcode,
    country: input.country || "United Kingdom",
    phone: input.phone,
    notes: input.notes,
    generated_by: input.generatedBy,
    model: isAi ? input.model : null,
    ai_employee_id: isAi ? input.aiEmployeeId : null,
  };
}

export async function addLocation(
  companyId: string,
  input: LocationWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data, error } = await table<{ id: string }>(admin, "hq_sales_locations")
    .insert({ ...locationPayload(companyId, input), created_by_email: actor.email })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-sales] addLocation failed", error);
    return { ok: false, error: error?.message ?? "Insert failed" };
  }
  const where = [input.label, input.city, input.postcode].filter(Boolean).join(", ");
  await insertTimelineEvent(admin, {
    company_id: companyId,
    event_type: "note",
    actor_email: input.generatedBy === "human" ? actor.email : null,
    ai_employee_id: input.generatedBy === "ai" ? input.aiEmployeeId : null,
    body: `Added location${where ? `: ${where}` : ""}.`,
  });
  return { ok: true, id: data.id };
}

// --- Channels (multiple phones / emails / LinkedIn / socials) -------

export type ChannelWriteInput = {
  channelType: string;
  value: string;
  label: string | null;
  contactId: string | null;
  locationId: string | null;
  isPrimary: boolean;
  isVerified: boolean;
  status: string;
  generatedBy: string;
  model: string | null;
  aiEmployeeId: string | null;
};

function channelPayload(companyId: string, input: ChannelWriteInput) {
  const isAi = input.generatedBy === "ai";
  return {
    company_id: companyId,
    contact_id: input.contactId,
    location_id: input.locationId,
    channel_type: input.channelType,
    value: input.value,
    label: input.label,
    is_primary: input.isPrimary,
    is_verified: input.isVerified,
    status: input.status,
    generated_by: input.generatedBy,
    model: isAi ? input.model : null,
    ai_employee_id: isAi ? input.aiEmployeeId : null,
  };
}

export async function addChannel(
  companyId: string,
  input: ChannelWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data, error } = await table<{ id: string }>(admin, "hq_sales_channels")
    .insert({ ...channelPayload(companyId, input), created_by_email: actor.email })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const msg = error?.message ?? "Insert failed";
    console.error("[hq-sales] addChannel failed", error);
    if (/duplicate key|unique/i.test(msg)) {
      return { ok: false, error: "That channel already exists for this company." };
    }
    return { ok: false, error: msg };
  }
  await insertTimelineEvent(admin, {
    company_id: companyId,
    contact_id: input.contactId,
    event_type: "note",
    actor_email: input.generatedBy === "human" ? actor.email : null,
    ai_employee_id: input.generatedBy === "ai" ? input.aiEmployeeId : null,
    body: `Added ${input.channelType}: ${input.value}.`,
  });
  return { ok: true, id: data.id };
}

export async function deleteChannel(
  id: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { error } = await table<SalesChannel>(admin, "hq_sales_channels")
    .delete()
    .eq("id", id);
  if (error) {
    console.error("[hq-sales] deleteChannel failed", error);
    return { ok: false, error: error.message };
  }
  void actor;
  return { ok: true, id };
}

// --- AI Task Queue (foundation — enqueue only, no execution) --------

export type AiTaskWriteInput = {
  companyId: string | null;
  contactId: string | null;
  taskType: string;
  priority: string;
  scheduledAt: string | null;
  maxRetries: number;
  assignedAiEmployeeId: string | null;
  payload: Record<string, unknown> | null;
  dedupeKey: string | null;
};

export async function enqueueAiTask(
  input: AiTaskWriteInput,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data, error } = await table<{ id: string }>(admin, "hq_sales_ai_tasks")
    .insert({
      company_id: input.companyId,
      contact_id: input.contactId,
      task_type: input.taskType,
      status: "pending",
      priority: input.priority,
      retry_count: 0,
      max_retries: input.maxRetries,
      assigned_ai_employee_id: input.assignedAiEmployeeId,
      scheduled_at: input.scheduledAt,
      payload: input.payload,
      dedupe_key: input.dedupeKey,
      source: "manual",
      created_by_email: actor.email,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    const msg = error?.message ?? "Insert failed";
    console.error("[hq-sales] enqueueAiTask failed", error);
    if (/duplicate key|unique/i.test(msg)) {
      return { ok: false, error: "A live task with that dedupe key already exists." };
    }
    return { ok: false, error: msg };
  }
  // A company-scoped task gets a timeline marker so the AI footprint is
  // visible on the company. Global tasks (no company) have no timeline.
  if (input.companyId) {
    await insertTimelineEvent(admin, {
      company_id: input.companyId,
      contact_id: input.contactId,
      event_type: "task_scheduled",
      actor_email: actor.email,
      ai_employee_id: input.assignedAiEmployeeId,
      body: `AI task scheduled: ${input.taskType}.`,
      metadata: { task_id: data.id, priority: input.priority },
    });
  }
  return { ok: true, id: data.id };
}

// ---------------------------------------------------------------------
// Shared Memory bridge (Directive 002 integration). Promote a research
// report into the company-wide Shared Memory Engine so its findings
// become reusable knowledge every AI employee can read. Opt-in + audited.
// ---------------------------------------------------------------------

async function pickMemoryType(): Promise<string | null> {
  const types = await listMemoryTypes(true);
  if (types.length === 0) return null;
  const preferred = ["sales", "research", "customer", "company"];
  for (const slug of preferred) {
    if (types.some((t) => t.slug === slug)) return slug;
  }
  return types[0]?.slug ?? null;
}

async function pickMemorySource(): Promise<string> {
  const sources = await listMemorySources(true);
  const preferred = ["crm", "manual"];
  for (const slug of preferred) {
    if (sources.some((s) => s.slug === slug)) return slug;
  }
  return sources[0]?.slug ?? "manual";
}

export async function promoteResearchToMemory(
  reportId: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data: report } = await table<SalesResearchReport>(
    admin,
    "hq_sales_research_reports",
  )
    .select(RESEARCH_COLUMNS)
    .eq("id", reportId)
    .maybeSingle();
  if (!report) return { ok: false, error: "Research report not found" };
  if (report.memory_id) return { ok: true, id: report.memory_id };

  const company = await getCompany(report.company_id);
  if (!company) return { ok: false, error: "Company not found" };

  const memoryType = await pickMemoryType();
  if (!memoryType) {
    return { ok: false, error: "No Shared Memory types configured" };
  }
  const source = await pickMemorySource();

  const bodyParts: string[] = [];
  if (report.summary) bodyParts.push(`## Summary\n${report.summary}`);
  if (report.pain_points.length) {
    bodyParts.push(`## Pain points\n${report.pain_points.map((p) => `- ${p}`).join("\n")}`);
  }
  if (report.best_angle) bodyParts.push(`## Best angle\n${report.best_angle}`);
  if (report.opening_line) bodyParts.push(`## Suggested opening line\n${report.opening_line}`);
  if (report.recommended_follow_up) {
    bodyParts.push(`## Recommended follow-up\n${report.recommended_follow_up}`);
  }
  if (report.risk_assessment) {
    bodyParts.push(`## Risk assessment (${report.risk_level})\n${report.risk_assessment}`);
  }

  const result = await createMemory(
    {
      title: `Sales research — ${company.name}`,
      summary: report.summary || `AI sales research for ${company.name}.`,
      body: bodyParts.join("\n\n"),
      memoryType,
      department: "sales",
      importance: "normal",
      visibility: "public_hq",
      source,
      status: "active",
      confidence: report.likelihood_score ?? 70,
      pinned: false,
      tags: [...new Set(["sales", "research", ...company.tags])],
      organisationName: company.name,
      relationships: [
        {
          entityType: "organisation",
          entityId: company.id,
          entityLabel: company.name,
          relation: "about",
        },
      ],
      employeeIds: [],
      grantDepartments: [],
    },
    actor,
  );

  if (!result.ok) return result;

  await table<SalesResearchReport>(admin, "hq_sales_research_reports")
    .update({ memory_id: result.id })
    .eq("id", reportId);

  await insertTimelineEvent(admin, {
    company_id: company.id,
    event_type: "system",
    actor_email: actor.email,
    body: `Research promoted to Shared Memory.`,
    memory_id: result.id,
  });

  return { ok: true, id: result.id };
}

/**
 * Promote a winning OUTCOME (a handled objection, a completed cold call, a
 * completed demo) into the Shared Memory Engine, so every AI employee can
 * learn from a real result. Directive 003: "Every successful objection /
 * cold call / demo / close should become reusable knowledge." Opt-in,
 * idempotent (re-promoting returns the existing memory), and audited.
 */
export async function promoteOutcomeToMemory(
  eventId: string,
  actor: Actor,
): Promise<WriteResult> {
  const admin = createAdminClient();
  const { data: event } = await table<SalesTimelineEvent>(
    admin,
    "hq_sales_timeline_events",
  )
    .select(TIMELINE_COLUMNS)
    .eq("id", eventId)
    .maybeSingle();
  if (!event) return { ok: false, error: "Timeline event not found" };
  if (event.memory_id) return { ok: true, id: event.memory_id };
  if (!isPromotableOutcome(event.event_type)) {
    return { ok: false, error: "This event cannot be promoted to memory" };
  }

  const company = await getCompany(event.company_id);
  if (!company) return { ok: false, error: "Company not found" };

  const memoryType = await pickMemoryType();
  if (!memoryType) {
    return { ok: false, error: "No Shared Memory types configured" };
  }
  const source = await pickMemorySource();

  const label = eventLabel(event.event_type);
  const bodyParts: string[] = [];
  if (event.subject) bodyParts.push(`## ${event.subject}`);
  if (event.body) bodyParts.push(event.body);
  if (event.outcome) bodyParts.push(`**Outcome:** ${event.outcome}`);

  const result = await createMemory(
    {
      title: `${label} — ${company.name}`,
      summary: event.subject || `${label} outcome for ${company.name}.`,
      body: bodyParts.join("\n\n") || `${label} for ${company.name}.`,
      memoryType,
      department: "sales",
      importance: "normal",
      visibility: "public_hq",
      source,
      status: "active",
      confidence: 75,
      pinned: false,
      tags: [...new Set(["sales", "outcome", event.event_type, ...company.tags])],
      organisationName: company.name,
      relationships: [
        {
          entityType: "organisation",
          entityId: company.id,
          entityLabel: company.name,
          relation: "about",
        },
      ],
      employeeIds: [],
      grantDepartments: [],
    },
    actor,
  );

  if (!result.ok) return result;

  await table<SalesTimelineEvent>(admin, "hq_sales_timeline_events")
    .update({ memory_id: result.id })
    .eq("id", eventId);

  await insertTimelineEvent(admin, {
    company_id: company.id,
    event_type: "system",
    actor_email: actor.email,
    body: `${label} promoted to Shared Memory.`,
    memory_id: result.id,
  });

  return { ok: true, id: result.id };
}

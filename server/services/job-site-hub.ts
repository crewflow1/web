import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import {
  summariseJobDiary,
  summariseJobSnags,
  type JobDiaryRow,
  type JobDiarySummary,
  type JobSnagRow,
  type JobSnagSummary,
} from "@/lib/site-ops/job-panels";
import {
  composeSiteTimeline,
  type AttachmentEventRow,
  type DiaryEventRow,
  type InspectionEventRow,
  type JobDocumentEventRow,
  type PermitEventRow,
  type RamsEventRow,
  type SiteTimelineEvent,
  type SnagEventRow,
  type ToolboxEventRow,
} from "@/lib/site-ops/timeline";

/**
 * Job Site Hub — the read layer behind the job page's site-operations panels.
 *
 * This module FETCHES; it does not decide. Every merge / ordering / labelling
 * rule lives in the pure libs (lib/site-ops/*), so the only thing that can go
 * wrong here is a read — and a read going wrong degrades to an empty panel,
 * never to a broken job page.
 *
 * SCOPING — three independent belts, deliberately:
 *   1. RLS: every read runs on the caller's client (the user JWT in the app).
 *   2. `org_id` PINNED explicitly. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so an RLS-only read BLENDS orgs for a dual-org
 *      member. That is a real P0 class we have already shipped fixes for twice.
 *   3. `job_id` pinned (or, for the polymorphic/indirect tables, an id set
 *      derived from job-pinned rows).
 *
 * PAGING: reads go through `fetchAllRows`, whose contract requires a UNIQUE
 * total order — a non-unique sort key (a date, a status, an FK) can drop or
 * duplicate rows at a page boundary. Every read below therefore orders by the
 * primary key `id`, which is unique by construction. Chronology is the pure
 * libs' job, not the query's.
 *
 * FAN-OUT: two waves, never N+1. Wave 1 reads the job-pinned tables in
 * parallel; wave 2 resolves the two INDIRECT sources with one read each.
 *
 * TESTABILITY: the `gather*` functions take the Supabase client as an argument
 * rather than creating it, so the integration suite can drive the EXACT same
 * queries with a real user JWT against real Postgres.
 */

type Row = Record<string, unknown>;

/**
 * Minimal self-returning view of the PostgREST builder — enough for the read
 * chains below without fighting the generated `Database` types (none of these
 * tables are in lib/supabase/types.ts yet). Mirrors briefing.ts.
 */
export type SiteHubClient = {
  from: (t: string) => SiteHubBuilder;
};
type SiteHubBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => SiteHubBuilder;
  eq: (k: string, v: unknown) => SiteHubBuilder;
  in: (k: string, v: readonly unknown[]) => SiteHubBuilder;
  order: (k: string, o: { ascending: boolean }) => SiteHubBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

/** Hard ceiling on the rendered feed — a long-running site holds thousands. */
export const SITE_TIMELINE_DEFAULT_LIMIT = 40;
/** How many diary entries the job panel shows before "view all". */
export const JOB_DIARY_PANEL_LIMIT = 4;
/** How many open snags the job panel lists before "view all". */
export const JOB_SNAGS_PANEL_LIMIT = 5;

/**
 * Page a job-pinned read to completion. Ordered by `id` (unique) so no row can
 * shift across a page edge; a read error degrades to whatever was gathered.
 */
async function pagedByJob<T>(
  db: SiteHubClient,
  table: string,
  cols: string,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<T[]> {
  const { data } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from(table)
        .select(cols)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return data as unknown as T[];
}

/** Page a read pinned by org + an explicit id set (the indirect sources). */
async function pagedByIds<T>(
  db: SiteHubClient,
  table: string,
  cols: string,
  orgId: string,
  column: string,
  ids: readonly string[],
  extra?: { column: string; values: readonly string[] },
  pageSize?: number,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const { data } = await fetchAllRows<Row>((from, to) => {
    const base = db.from(table).select(cols).eq("org_id", orgId).in(column, ids);
    const scoped = extra ? base.in(extra.column, extra.values) : base;
    return scoped.order("id", { ascending: true }).range(from, to);
  }, pageSize);
  return data as unknown as T[];
}

const DIARY_COLS = "id, entry_date, weather, labour_count, work_summary, delays, created_at";
const SNAG_COLS = "id, title, status, priority, location, due_date, created_at";

// ── Diary panel ──────────────────────────────────────────────────────────────

/**
 * Every diary entry logged against this job, org-pinned and fully paged.
 *
 * `pageSize` exists so the integration suite can force real page boundaries on
 * a small fixture and prove the unique-order contract; production uses the
 * default.
 */
export async function gatherJobDiary(
  db: SiteHubClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<JobDiaryRow[]> {
  return pagedByJob<JobDiaryRow>(db, "site_diary_entries", DIARY_COLS, orgId, jobId, pageSize);
}

export async function loadJobDiaryPanel(
  orgId: string,
  jobId: string,
  limit: number = JOB_DIARY_PANEL_LIMIT,
): Promise<JobDiarySummary> {
  try {
    const supabase = await createClient();
    const rows = await gatherJobDiary(supabase as unknown as SiteHubClient, orgId, jobId);
    return summariseJobDiary(rows, limit);
  } catch (err) {
    console.error("[job-site-hub] diary panel failed", err);
    return { total: 0, recent: [], lastEntryDate: null, withDelays: 0 };
  }
}

// ── Snags panel ──────────────────────────────────────────────────────────────

/** Every snag raised against this job, org-pinned and fully paged. */
export async function gatherJobSnags(
  db: SiteHubClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<JobSnagRow[]> {
  return pagedByJob<JobSnagRow>(db, "snags", SNAG_COLS, orgId, jobId, pageSize);
}

export async function loadJobSnagsPanel(
  orgId: string,
  jobId: string,
  todayIso: string,
): Promise<JobSnagSummary> {
  try {
    const supabase = await createClient();
    const rows = await gatherJobSnags(supabase as unknown as SiteHubClient, orgId, jobId);
    return summariseJobSnags(rows, todayIso);
  } catch (err) {
    console.error("[job-site-hub] snags panel failed", err);
    return { total: 0, open: 0, overdue: 0, byPriority: [], openSnags: [] };
  }
}

// ── Site timeline ────────────────────────────────────────────────────────────

export type JobSiteSources = {
  diary: DiaryEventRow[];
  snags: SnagEventRow[];
  toolbox: ToolboxEventRow[];
  rams: RamsEventRow[];
  permits: PermitEventRow[];
  inspections: InspectionEventRow[];
  documents: JobDocumentEventRow[];
  attachments: AttachmentEventRow[];
  assetNames: Map<string, string>;
  attachmentContext: Map<string, string>;
};

/**
 * Fetch every row the timeline may contain, for ONE job in ONE org.
 *
 * Two waves. Wave 1 is the seven tables carrying `job_id`. Wave 2 resolves the
 * two indirect sources: `asset_inspections` has NO `job_id` (plant reaches a
 * job only through `asset_assignments`), and `tenant_attachments` is polymorphic
 * (`target_table` + `target_id`) — both are read with a single `.in(...)` over
 * ids we already hold, so the fan-out stays constant regardless of site size.
 */
export async function gatherJobSiteSources(
  db: SiteHubClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<JobSiteSources> {
  const [diary, snags, toolbox, rams, permits, documents, assignments] = await Promise.all([
    pagedByJob<DiaryEventRow>(
      db,
      "site_diary_entries",
      "id, entry_date, work_summary, weather, labour_count",
      orgId,
      jobId,
      pageSize,
    ),
    pagedByJob<SnagEventRow>(
      db,
      "snags",
      "id, title, status, priority, location, created_at, resolved_at",
      orgId,
      jobId,
      pageSize,
    ),
    pagedByJob<ToolboxEventRow>(
      db,
      "toolbox_talks",
      "id, topic, talk_date, status, reference, attendee_count",
      orgId,
      jobId,
      pageSize,
    ),
    pagedByJob<RamsEventRow>(
      db,
      "risk_assessments",
      "id, title, reference, status, activity, created_at, issued_at",
      orgId,
      jobId,
      pageSize,
    ),
    pagedByJob<PermitEventRow>(
      db,
      "permits_to_work",
      "id, title, reference, permit_type, status, created_at, issued_at, valid_from, valid_until",
      orgId,
      jobId,
      pageSize,
    ),
    // Private documents are excluded by job_documents' OWN RLS policy for a
    // non-admin viewer, so this needs no extra visibility filter: an admin sees
    // both areas, a staff member sees only 'staff'.
    pagedByJob<JobDocumentEventRow>(
      db,
      "job_documents",
      "id, title, doc_type, status, visibility, created_at",
      orgId,
      jobId,
      pageSize,
    ),
    pagedByJob<{ id: string; asset_id: string }>(
      db,
      "asset_assignments",
      "id, asset_id",
      orgId,
      jobId,
      pageSize,
    ),
  ]);

  const assetIds = [...new Set(assignments.map((a) => a.asset_id).filter(Boolean))];
  const attachmentTargets = [
    jobId,
    ...diary.map((d) => d.id),
    ...snags.map((s) => s.id),
    ...toolbox.map((t) => t.id),
  ];

  const [inspections, assets, attachments] = await Promise.all([
    pagedByIds<InspectionEventRow>(
      db,
      "asset_inspections",
      "id, asset_id, title, kind, status, outcome, inspected_at, created_at",
      orgId,
      "asset_id",
      assetIds,
      undefined,
      pageSize,
    ),
    pagedByIds<{ id: string; name: string }>(
      db,
      "assets",
      "id, name",
      orgId,
      "id",
      assetIds,
      undefined,
      pageSize,
    ),
    pagedByIds<AttachmentEventRow>(
      db,
      "tenant_attachments",
      "id, filename, mime_type, target_table, target_id, created_at",
      orgId,
      "target_id",
      attachmentTargets,
      { column: "target_table", values: ["jobs", "site_diary_entries", "snags", "toolbox_talks"] },
      pageSize,
    ),
  ]);

  // Human context for an uploaded file ("Diary 18 Jul 2026") — built from rows
  // already in hand, so it costs no extra query.
  const attachmentContext = new Map<string, string>();
  for (const d of diary) attachmentContext.set(d.id, `Diary ${formatDiaryDate(d.entry_date)}`);
  for (const s of snags) attachmentContext.set(s.id, `Snag: ${s.title}`);
  for (const t of toolbox) attachmentContext.set(t.id, `Toolbox talk: ${t.topic}`);

  return {
    diary,
    snags,
    toolbox,
    rams,
    permits,
    inspections,
    documents,
    attachments,
    assetNames: new Map(assets.map((a) => [a.id, a.name])),
    attachmentContext,
  };
}

export interface JobSiteTimeline {
  events: SiteTimelineEvent[];
  /** Total composed events before the display limit — drives "showing N of M". */
  total: number;
}

/**
 * Build the chronological site feed for one job.
 *
 * Best-effort by contract: any failure returns an empty feed. This panel renders
 * alongside eight others; a timeline hiccup must cost the timeline, not the page.
 */
export async function loadJobSiteTimeline(
  orgId: string,
  jobId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<JobSiteTimeline> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SITE_TIMELINE_DEFAULT_LIMIT;
  try {
    const supabase = await createClient();
    const sources = await gatherJobSiteSources(supabase as unknown as SiteHubClient, orgId, jobId);
    const all = composeSiteTimeline({ now, jobId, ...sources });
    return { events: all.slice(0, limit), total: all.length };
  } catch (err) {
    console.error("[job-site-hub] timeline failed", err);
    return { events: [], total: 0 };
  }
}

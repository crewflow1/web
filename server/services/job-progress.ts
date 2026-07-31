import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import {
  buildProgressCurve,
  buildProgressSeries,
  summariseProgress,
  REPORTED_PROGRESS_STATUSES,
  type ProgressCurve,
  type ProgressObservationRow,
  type ProgressSummary,
  type SiteReportProgressRow,
} from "@/lib/job-progress/series";

/**
 * Job progress — the read layer behind the progress panel.
 *
 * FETCHES; does not decide. Every merge, precedence, threshold and coordinate
 * rule lives in lib/job-progress/series.ts, so the only thing that can go wrong
 * here is a read. Same split (and the same three scoping belts) as
 * server/services/job-site-hub.ts:
 *
 *   1. RLS — reads run on the caller's client (their JWT) in the app.
 *   2. `org_id` PINNED EXPLICITLY. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so an RLS-only read BLENDS orgs for a dual-org
 *      member. That is a shipped-twice P0 class, not a hypothetical.
 *   3. `job_id` pinned.
 *
 * LOUD READS. Neither gather function swallows a failure: each returns the rows
 * it got AND the error, so the caller renders an explicit error state instead of
 * an empty curve. A blank chart that means "the query was rejected" is
 * indistinguishable from one that means "this job has never been assessed" —
 * exactly the silent-empty class lib/supabase/read-failure.ts exists to end.
 *
 * PAGING via `fetchAllRows`, whose contract needs a UNIQUE total order; both
 * reads order by `id` (unique by construction). Chronology is the pure lib's
 * job, not the query's.
 */

type Row = Record<string, unknown>;

/**
 * Minimal self-returning view of the PostgREST builder — enough for these read
 * chains without fighting the generated `Database` types (neither table is in
 * lib/supabase/types.ts). Mirrors job-site-hub.ts.
 */
export type ProgressClient = {
  from: (t: string) => ProgressBuilder;
};
type ProgressBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => ProgressBuilder;
  eq: (k: string, v: unknown) => ProgressBuilder;
  in: (k: string, v: readonly unknown[]) => ProgressBuilder;
  order: (k: string, o: { ascending: boolean }) => ProgressBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};

const OBSERVATION_COLS = "id, job_id, observed_on, percent, note, recorded_by";
/**
 * `content` is the whole jsonb blob — PostgREST cannot project a single key out
 * of it, so the report's other commentary fields ride along. They stay INSIDE
 * the tenant boundary: only `progress_percent` is read (readReportPercent), and
 * the customer-facing DTO cannot represent any of it.
 */
const REPORT_COLS = "id, job_id, status, period_end, report_number, content";

export interface ProgressRead<T> {
  rows: T[];
  /** Non-null when the read failed; the caller MUST surface it. */
  error: unknown;
}

/** Every progress observation on this job, org-pinned and fully paged. */
export async function gatherProgressObservations(
  db: ProgressClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<ProgressRead<ProgressObservationRow>> {
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("job_progress_observations")
        .select(OBSERVATION_COLS)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return { rows: data as unknown as ProgressObservationRow[], error };
}

/**
 * The site reports on this job whose progress figure enters the series.
 *
 * The status filter is applied IN THE QUERY as well as in the pure lib. Not
 * belt-and-braces duplication: it keeps draft reports — whose `content` is the
 * author's live working copy — from crossing the wire at all.
 */
export async function gatherProgressReports(
  db: ProgressClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<ProgressRead<SiteReportProgressRow>> {
  const { data, error } = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("site_reports")
        .select(REPORT_COLS)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .in("status", REPORTED_PROGRESS_STATUSES)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  return { rows: data as unknown as SiteReportProgressRow[], error };
}

export interface JobProgressView {
  summary: ProgressSummary;
  curve: ProgressCurve;
  /** True when EITHER read failed — render the error state, never an empty curve. */
  failed: boolean;
}

/** Curve size for the job panel. Small enough for a 375px phone, in viewBox units. */
export const PROGRESS_CURVE_WIDTH = 320;
export const PROGRESS_CURVE_HEIGHT = 120;

/**
 * Load one job's progress: both sources, merged, summarised and laid out.
 *
 * `now` is passed in so the trend and "days since" are the page's day, and are
 * reproducible under test.
 */
export async function loadJobProgress(
  orgId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<JobProgressView> {
  const supabase = (await createClient()) as unknown as ProgressClient;
  const [observations, reports] = await Promise.all([
    gatherProgressObservations(supabase, orgId, jobId),
    gatherProgressReports(supabase, orgId, jobId),
  ]);

  const points = buildProgressSeries({
    observations: observations.rows,
    reports: reports.rows,
  });

  return {
    summary: summariseProgress(points, now),
    curve: buildProgressCurve(points, {
      width: PROGRESS_CURVE_WIDTH,
      height: PROGRESS_CURVE_HEIGHT,
    }),
    failed: Boolean(observations.error) || Boolean(reports.error),
  };
}

// ── Portal (batched) ─────────────────────────────────────────────────────────

/**
 * Progress for MANY jobs in two reads, for the customer portal's job list.
 *
 * Batched deliberately: a per-job call would be an N+1 on a page rendering
 * every job a customer has. The caller supplies the job ids it has ALREADY
 * scoped to one customer + one org, and both reads are pinned on `org_id` plus
 * that id set — so this can only ever return rows for jobs the caller resolved.
 *
 * Returns internal summaries. Narrowing to the customer-safe shape is
 * lib/job-progress/portal.ts's job and MUST happen before rendering.
 */
export async function loadProgressForJobs(
  db: ProgressClient,
  orgId: string,
  jobIds: readonly string[],
  now: Date = new Date(),
): Promise<{ byJob: Map<string, ProgressSummary>; failed: boolean }> {
  const byJob = new Map<string, ProgressSummary>();
  if (jobIds.length === 0) return { byJob, failed: false };

  const [observations, reports] = await Promise.all([
    fetchAllRows<Row>((from, to) =>
      db
        .from("job_progress_observations")
        .select(OBSERVATION_COLS)
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<Row>((from, to) =>
      db
        .from("site_reports")
        .select(REPORT_COLS)
        .eq("org_id", orgId)
        .in("job_id", jobIds)
        .in("status", REPORTED_PROGRESS_STATUSES)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const obsByJob = new Map<string, ProgressObservationRow[]>();
  for (const row of (observations.data ?? []) as unknown as Array<
    ProgressObservationRow & { job_id: string }
  >) {
    const list = obsByJob.get(row.job_id) ?? [];
    list.push(row);
    obsByJob.set(row.job_id, list);
  }

  const repByJob = new Map<string, SiteReportProgressRow[]>();
  for (const row of (reports.data ?? []) as unknown as Array<
    SiteReportProgressRow & { job_id: string | null }
  >) {
    if (!row.job_id) continue;
    const list = repByJob.get(row.job_id) ?? [];
    list.push(row);
    repByJob.set(row.job_id, list);
  }

  for (const jobId of jobIds) {
    const points = buildProgressSeries({
      observations: obsByJob.get(jobId) ?? [],
      reports: repByJob.get(jobId) ?? [],
    });
    byJob.set(jobId, summariseProgress(points, now));
  }

  return {
    byJob,
    failed: Boolean(observations.error) || Boolean(reports.error),
  };
}

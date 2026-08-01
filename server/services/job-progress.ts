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
import {
  buildPlannedCurve,
  buildPlannedProgress,
  plannedDomain,
  unionDomain,
  type PlannedCurve,
  type ProgrammeBaselineRow,
  type ProgrammeMilestoneRow,
} from "@/lib/job-programme/planned";

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
  is: (k: string, v: unknown) => ProgressBuilder;
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
/** Current programme baseline (20261085). Internal read — note rides along for
 *  the staff panel path only; the portal path never selects it (see below). */
const BASELINE_COLS = "id, job_id, revision, planned_start, planned_end";
const MILESTONE_COLS =
  "id, baseline_id, title, planned_start, planned_end, weight, customer_visible, sort";
/**
 * The PORTAL milestone read — deliberately narrower than MILESTONE_COLS. The
 * portal page runs on the service-role client for an unauthenticated token, so
 * the discipline is the jobs-page one: never SELECT what must not reach a
 * customer, don't just avoid rendering it. `weight` (the org's commercial model
 * of the job's effort) never crosses the wire on this path at all;
 * lib/job-programme/portal.ts then structurally drops everything but title +
 * planned_end.
 */
const PORTAL_MILESTONE_COLS =
  "id, baseline_id, title, planned_end, customer_visible, sort";

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

/**
 * The current programme baseline and its milestones, in one BEST-EFFORT gather.
 *
 * Best-effort is a deliberate, narrower contract than the two loud gathers
 * above, and the difference is what each read is FOR. A failed observation
 * read makes the panel's whole claim wrong ("no readings yet" vs "the query
 * was rejected" must not look identical), so it is surfaced loudly. The
 * programme is an OPTIONAL second line on that same panel: when this read
 * fails, `planned` is null and the panel renders exactly what it rendered
 * before 20261085 existed — actual progress, honestly labelled as having no
 * planned line. Absent table, absent baseline and failed read all degrade to
 * byte-identical today's-behaviour output. (The programme PANEL, which makes
 * claims about the programme itself, does its own loud read —
 * app/(app)/jobs/[id]/_job-programme.tsx.)
 */
export async function gatherProgrammeBaseline(
  db: ProgressClient,
  orgId: string,
  jobId: string,
  pageSize?: number,
): Promise<{
  baseline: ProgrammeBaselineRow | null;
  milestones: ProgrammeMilestoneRow[];
}> {
  const baselines = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("job_programme_baselines")
        .select(BASELINE_COLS)
        .eq("org_id", orgId)
        .eq("job_id", jobId)
        .is("superseded_at", null)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  if (baselines.error) return { baseline: null, milestones: [] };
  // The one-current partial unique index makes >1 row unrepresentable; a lone
  // defensive [0] is not a `.single()` (nothing throws on 0).
  const baseline =
    ((baselines.data ?? [])[0] as unknown as ProgrammeBaselineRow | undefined) ?? null;
  if (!baseline) return { baseline: null, milestones: [] };

  const milestones = await fetchAllRows<Row>(
    (from, to) =>
      db
        .from("job_milestones")
        .select(MILESTONE_COLS)
        .eq("org_id", orgId)
        .eq("baseline_id", baseline.id)
        .order("id", { ascending: true })
        .range(from, to),
    pageSize,
  );
  if (milestones.error) return { baseline: null, milestones: [] };
  return {
    baseline,
    milestones: milestones.data as unknown as ProgrammeMilestoneRow[],
  };
}

export interface JobProgressView {
  summary: ProgressSummary;
  curve: ProgressCurve;
  /**
   * The planned line, in the SAME viewBox and x-domain as `curve` — or null
   * whenever there is no honest one (no current baseline, unweighted or
   * partially weighted milestones, Σ ≠ 100, or the programme read failed).
   * Null means "draw nothing and say nothing", never an error state.
   */
  planned: PlannedCurve | null;
  /** Baseline revision behind `planned`, for the panel's provenance line. */
  plannedRevision: number | null;
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
  const [observations, reports, programme] = await Promise.all([
    gatherProgressObservations(supabase, orgId, jobId),
    gatherProgressReports(supabase, orgId, jobId),
    gatherProgrammeBaseline(supabase, orgId, jobId),
  ]);

  const points = buildProgressSeries({
    observations: observations.rows,
    reports: reports.rows,
  });

  // The planned line, ONLY when the pure lib says one honestly exists. When it
  // does, both lines are laid out against the UNION of their day spans so a
  // date sits at one x position on the shared chart; when it does not, the
  // curve call below is byte-identical to what shipped with 20261078.
  const plannedPoints = buildPlannedProgress(programme.baseline, programme.milestones);
  const size = { width: PROGRESS_CURVE_WIDTH, height: PROGRESS_CURVE_HEIGHT };

  if (plannedPoints === null) {
    return {
      summary: summariseProgress(points, now),
      curve: buildProgressCurve(points, size),
      planned: null,
      plannedRevision: null,
      failed: Boolean(observations.error) || Boolean(reports.error),
    };
  }

  const actualDomain =
    points.length > 0
      ? { from: points[0]!.day, to: points[points.length - 1]!.day }
      : null;
  const domain = unionDomain(actualDomain, plannedDomain(plannedPoints));

  return {
    summary: summariseProgress(points, now),
    curve: buildProgressCurve(points, { ...size, domain: domain ?? undefined }),
    planned: buildPlannedCurve(plannedPoints, { ...size, domain: domain ?? undefined }),
    plannedRevision: programme.baseline?.revision ?? null,
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

/**
 * Customer-visible programme milestones for MANY jobs in two reads, for the
 * customer portal's job list — the loadProgressForJobs shape exactly.
 *
 * Scoping: the caller supplies job ids it has ALREADY scoped to one customer +
 * one org; both reads are pinned on `org_id` plus derived id sets, and the
 * baseline read takes only CURRENT revisions (superseded_at IS NULL) — a
 * superseded plan is the org's history, not the customer's schedule.
 *
 * The milestone read uses PORTAL_MILESTONE_COLS (no weight — see the constant)
 * and filters `customer_visible` IN THE QUERY as well as in the pure lib, so a
 * staff-only milestone title never crosses the wire to a page served on an
 * unauthenticated token. Returns internal rows; narrowing to the customer-safe
 * `PortalMilestone` shape is lib/job-programme/portal.ts's job and MUST happen
 * before rendering.
 *
 * Best-effort like every other portal add-on: a failed read yields an empty
 * map (the portal shows no plan, never an error page for an optional section).
 */
export async function loadProgrammeMilestonesForJobs(
  db: ProgressClient,
  orgId: string,
  jobIds: readonly string[],
): Promise<{ byJob: Map<string, ProgrammeMilestoneRow[]>; failed: boolean }> {
  const byJob = new Map<string, ProgrammeMilestoneRow[]>();
  if (jobIds.length === 0) return { byJob, failed: false };

  const baselines = await fetchAllRows<Row>((from, to) =>
    db
      .from("job_programme_baselines")
      .select("id, job_id")
      .eq("org_id", orgId)
      .in("job_id", jobIds)
      .is("superseded_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (baselines.error) return { byJob, failed: true };
  const baselineRows = (baselines.data ?? []) as unknown as Array<{
    id: string;
    job_id: string;
  }>;
  if (baselineRows.length === 0) return { byJob, failed: false };
  const jobByBaseline = new Map(baselineRows.map((b) => [b.id, b.job_id]));

  const milestones = await fetchAllRows<Row>((from, to) =>
    db
      .from("job_milestones")
      .select(PORTAL_MILESTONE_COLS)
      .eq("org_id", orgId)
      .in("baseline_id", [...jobByBaseline.keys()])
      .eq("customer_visible", true)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (milestones.error) return { byJob, failed: true };

  for (const row of (milestones.data ?? []) as unknown as Array<
    ProgrammeMilestoneRow & { baseline_id: string }
  >) {
    const jobId = jobByBaseline.get(row.baseline_id);
    if (!jobId) continue;
    const list = byJob.get(jobId) ?? [];
    list.push(row);
    byJob.set(jobId, list);
  }
  return { byJob, failed: false };
}

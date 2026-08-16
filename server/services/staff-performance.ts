import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { hoursInWindow, overlapMs, type TimeEntry } from "@/lib/time/compute";
import { round2 } from "@/lib/money";
import {
  computeStaffPerformance,
  type PerformanceJobRow,
  type PerformanceNcrRow,
  type StaffPerformance,
} from "@/lib/staff/performance";

/**
 * Staff performance — the READ layer (server/services/staff-performance.ts).
 *
 * FETCHES the ledgers a person is attached to, then hands them to the PURE
 * aggregator (lib/staff/performance.ts). It never writes and holds no business
 * rule of its own — the arithmetic lives in the pure module and the trailing
 * hours reuse lib/time/compute (the SAME window-clipping, break-apportioning
 * maths as payroll and the timesheet), so no figure here is a second answer to a
 * question another surface already answers.
 *
 * SCOPING: every read pins `org_id` on top of RLS — current_org_ids() returns
 * every org the viewer belongs to, so an RLS-only read would blend a dual-org
 * member's tenants (the #456 class). Each read is paged (fetchAllRows) with the
 * unique `id` tiebreak and is LOUD: a read error throws readFailure so the staff
 * page shows its error boundary rather than a misleading zeroed scorecard.
 */

type Row = Record<string, unknown>;

type PerfBuilder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => PerfBuilder;
  eq: (k: string, v: unknown) => PerfBuilder;
  gte: (k: string, v: unknown) => PerfBuilder;
  order: (k: string, o: { ascending: boolean }) => PerfBuilder;
  range: (f: number, t: number) => PromiseLike<PageResult<Row>>;
};
type PerfClient = { from: (t: string) => PerfBuilder };

/**
 * Trailing window (days) for the utilisation lens. A quarter smooths the noise
 * of a single quiet or busy week while staying recent enough to be current.
 */
export const PERFORMANCE_UTILISATION_DAYS = 90;

async function pagedRows(
  db: PerfClient,
  table: string,
  cols: string,
  orgId: string,
  build: (b: PerfBuilder) => PerfBuilder,
  context: string,
): Promise<Row[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    build(db.from(table).select(cols).eq("org_id", orgId))
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure(context, error as SupabaseReadError);
  return data;
}

/**
 * Build one member's performance scorecard for one org.
 *
 * `now` is injected (never a clock read inside the pure core) so open time
 * entries count up to a reproducible instant and the result is testable.
 */
export async function getStaffPerformance(
  orgId: string,
  userId: string,
  now: Date = new Date(),
): Promise<StaffPerformance> {
  const supabase = await createClient();
  const db = supabase as unknown as PerfClient;

  const windowFrom = new Date(now.getTime() - PERFORMANCE_UTILISATION_DAYS * 86_400_000);
  const windowFromIso = windowFrom.toISOString();

  const [jobRows, ncrRows, timeRows, rotaRows] = await Promise.all([
    // Jobs this person is the named assignee for. Not windowed: "jobs completed
    // on time" is a career-to-date signal on a per-person page, and the set is
    // small (one assignee's jobs), so a full read is cheap and complete.
    pagedRows(
      db,
      "jobs",
      "id, status, scheduled_date, scheduled_end_date, practical_completion_date, assigned_to",
      orgId,
      (b) => b.eq("assigned_to", userId),
      "staff performance: jobs",
    ),
    // NCRs where this person is the responsible party.
    pagedRows(
      db,
      "non_conformance_reports",
      "id, status, responsible_user_id",
      orgId,
      (b) => b.eq("responsible_user_id", userId),
      "staff performance: ncrs",
    ),
    // Clock-ins in the trailing window (bounded on the indexed started_at).
    pagedRows(
      db,
      "time_entries",
      "id, user_id, job_id, started_at, ended_at, breaks",
      orgId,
      (b) => b.eq("user_id", userId).gte("started_at", windowFromIso),
      "staff performance: time entries",
    ),
    // Rostered shifts in the trailing window — the coverage denominator.
    pagedRows(
      db,
      "rota_entries",
      "id, user_id, starts_at, ends_at",
      orgId,
      (b) => b.eq("user_id", userId).gte("starts_at", windowFromIso),
      "staff performance: rota",
    ),
  ]);

  const jobs: PerformanceJobRow[] = jobRows.map((j) => ({
    id: String(j.id),
    status: (j.status as string | null) ?? null,
    scheduled_date: (j.scheduled_date as string | null) ?? null,
    scheduled_end_date: (j.scheduled_end_date as string | null) ?? null,
    practical_completion_date: (j.practical_completion_date as string | null) ?? null,
  }));
  const ncrs: PerformanceNcrRow[] = ncrRows.map((n) => ({
    status: (n.status as string | null) ?? null,
  }));

  // Recorded hours: THE shared arithmetic, unchanged (breaks apportioned, open
  // entries clipped to `now`).
  const timeEntries: TimeEntry[] = timeRows.map((t) => ({
    id: String(t.id),
    user_id: String(t.user_id),
    job_id: (t.job_id as string | null) ?? null,
    started_at: String(t.started_at),
    ended_at: (t.ended_at as string | null) ?? null,
    breaks: (t.breaks as TimeEntry["breaks"]) ?? [],
  }));
  const recordedHours = hoursInWindow(timeEntries, windowFrom, now, now);

  // Rostered hours: rota intervals clipped to the window via the same overlap
  // helper (ends_at is NOT NULL by CHECK, so nothing counts "up to now").
  let rosteredMs = 0;
  for (const r of rotaRows) {
    rosteredMs += overlapMs(
      { started_at: String(r.starts_at), ended_at: (r.ends_at as string | null) ?? null },
      windowFrom,
      now,
      now,
    );
  }

  return computeStaffPerformance({
    jobs,
    ncrs,
    recordedHours,
    rosteredHours: round2(rosteredMs / 3_600_000),
    windowDays: PERFORMANCE_UTILISATION_DAYS,
  });
}

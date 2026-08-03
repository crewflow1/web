import type { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Window-scoped calendar reads (F-1).
 *
 * The bug this fixes: /jobs/calendar loaded ALL of an org's jobs with a blind
 * `.limit(1000)`, unordered and with no date filter, then expanded recurring
 * parents and filtered to the visible window IN MEMORY. The moment an org
 * crossed 1000 jobs the PostgREST cap silently dropped rows — so jobs
 * scheduled inside the rendered week/month could vanish from the grid with no
 * error, and (because the fetch was unordered) which ones vanished was
 * arbitrary.
 *
 * The fix splits the read by nature instead of blindly capping:
 *
 *   1. NON-RECURRING jobs (`recurring IS NULL`) only render on their own
 *      scheduled_date, so they are scoped to `[range.from, range.to]` — the
 *      exact window the grid draws. Paged under the cap in case a single
 *      42-day month grid itself holds >1000 one-off jobs.
 *
 *   2. RECURRING jobs (`recurring IS NOT NULL`) must be expanded across the
 *      window regardless of their anchor date (a weekly parent anchored months
 *      ago still has occurrences this week), so they cannot be date-bounded.
 *      They are read UNBOUNDED via fetchAllRows — a far smaller set than the
 *      whole jobs table — and expanded downstream. A row with a non-null but
 *      malformed `recurring` payload lands here too and is treated as a single
 *      job by the expander's isValidRecurringPayload check, so no job is lost.
 *
 * Both reads carry a deterministic `scheduled_date, id` total order so paging
 * can never skip or duplicate a row at a page boundary. The merged set feeds
 * the existing (unchanged) recurring-expansion + in-memory window filter in
 * both the month view and the week client.
 */

/** The server Supabase client this reader is given (tests pass a mock cast to it). */
export type CalendarSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Row shape the calendar consumes. Mirrors the select below and the `DbJob`
 * shape the week client (`_calendar.tsx`) expects, so the merged result is
 * assignable without a cast.
 */
export type CalendarDbJob = {
  id: string;
  status: string;
  scheduled_date: string | null;
  notes: string | null;
  assigned_to: string | null;
  customer_id: string | null;
  recurring: unknown;
  customer: { id: string; name: string } | null;
  assigned: { id: string; full_name: string | null; email: string } | null;
};

/**
 * FK-hinted embed on `users` (jobs has a single assigned_to FK today, but the
 * hint is mandatory by house rule and future-proofs against a second FK).
 */
const CALENDAR_JOB_SELECT = `
  id, status, scheduled_date, notes, assigned_to, customer_id, recurring,
  customer:customers ( id, name ),
  assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
`;

export type FetchCalendarJobsArgs = {
  supabase: CalendarSupabaseClient;
  orgId: string;
  range: { from: string; to: string };
  /** Optional status filter (""/undefined = all). */
  statusFilter?: string;
  /** Optional assignee filter (""/undefined = all). */
  staffFilter?: string;
};

/**
 * Read every job the calendar grid must render for `range`, truncation-safe.
 * Returns the raw merged rows (non-recurring windowed + recurring unbounded);
 * downstream code does the recurring expansion + final in-memory window clip.
 */
export async function fetchCalendarJobs({
  supabase,
  orgId,
  range,
  statusFilter,
  staffFilter,
}: FetchCalendarJobsArgs): Promise<{ rows: CalendarDbJob[]; error: unknown }> {
  // Shared org + optional filter scope. ACTIVE-org pin — RLS admits every org
  // the viewer belongs to, so the grid must pin the active org itself.
  const scoped = () => {
    let q = supabase
      .from("jobs")
      .select(CALENDAR_JOB_SELECT)
      .eq("org_id", orgId);
    if (statusFilter) q = q.eq("status", statusFilter);
    if (staffFilter) q = q.eq("assigned_to", staffFilter);
    return q;
  };

  const nonRecurring = await fetchAllRows<CalendarDbJob>((from, to) =>
    scoped()
      .is("recurring", null)
      .gte("scheduled_date", range.from)
      .lte("scheduled_date", range.to)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (nonRecurring.error) return { rows: [], error: nonRecurring.error };

  const recurring = await fetchAllRows<CalendarDbJob>((from, to) =>
    scoped()
      .not("recurring", "is", null)
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (recurring.error) return { rows: [], error: recurring.error };

  return { rows: [...nonRecurring.data, ...recurring.data], error: null };
}

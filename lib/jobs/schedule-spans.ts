import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Window-scoped reader for the gantt + resource-lane views (F-1 safe).
 *
 * A dedicated reader (not lib/schedule/calendar-data.ts) because:
 *   - the gantt needs `scheduled_end_date` (the span), which the calendar reader
 *     does not select; and
 *   - lib/schedule/* is shared with another engineer, so this feature keeps its
 *     own read path rather than widening theirs.
 *
 * A job intersects the rendered window when its span [scheduled_date,
 * scheduled_end_date ?? scheduled_date] overlaps [from, to]. Because the end may
 * exceed `to` and the start may precede `from`, the SQL bound is deliberately
 * loose — `scheduled_date <= to` AND `scheduled_end_date >= from OR
 * scheduled_end_date IS NULL AND scheduled_date >= from` — and the precise
 * clip is done in the pure layout (lib/jobs/span.ts). Reads are paged under the
 * PostgREST cap on a deterministic (scheduled_date, id) order and ACTIVE-org
 * pinned; RLS admits every org the viewer belongs to, so the pin is essential.
 *
 * Recurring jobs are intentionally NOT expanded here: a gantt bar is a single
 * physical booking window, and recurrence is a week/month-grid concept. A
 * recurring parent still shows as its own single span.
 */

export type SpanSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type JobSpanRow = {
  id: string;
  status: string;
  scheduled_date: string | null;
  scheduled_end_date: string | null;
  assigned_to: string | null;
  customer_id: string | null;
  customer: { id: string; name: string } | null;
  assigned: { id: string; full_name: string | null; email: string } | null;
};

const SPAN_SELECT = `
  id, status, scheduled_date, scheduled_end_date, assigned_to, customer_id,
  customer:customers ( id, name ),
  assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
`;

export async function fetchJobSpansForWindow({
  supabase,
  orgId,
  range,
  statusFilter,
  staffFilter,
}: {
  supabase: SpanSupabaseClient;
  orgId: string;
  range: { from: string; to: string };
  statusFilter?: string;
  staffFilter?: string;
}): Promise<{ rows: JobSpanRow[]; error: unknown }> {
  const scoped = () => {
    let q = supabase
      .from("jobs")
      .select(SPAN_SELECT)
      .eq("org_id", orgId)
      // A job that starts after the window's end cannot intersect it.
      .lte("scheduled_date", range.to)
      // Either the explicit end is on/after the window start, OR there is no
      // end and the (single-day) start is on/after the window start.
      .or(
        `scheduled_end_date.gte.${range.from},and(scheduled_end_date.is.null,scheduled_date.gte.${range.from})`,
      );
    if (statusFilter) q = q.eq("status", statusFilter);
    if (staffFilter) q = q.eq("assigned_to", staffFilter);
    return q;
  };

  const { data, error } = await fetchAllRows<JobSpanRow>((from, to) =>
    scoped()
      .order("scheduled_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) return { rows: [], error };
  return { rows: data ?? [], error: null };
}

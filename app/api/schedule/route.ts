import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  expandRecurring,
  isValidRecurringPayload,
} from "@/lib/schedule/recurring";
import { fetchCalendarJobs } from "@/lib/schedule/calendar-data";
import type { CalendarJob } from "@/lib/schedule/types";

/**
 * GET /api/schedule
 *
 * Returns the calendar payload for the visible date range.
 *
 *   ?from=YYYY-MM-DD   inclusive
 *   ?to=YYYY-MM-DD     inclusive
 *   ?status=new|in-progress|completed|blocked   optional filter
 *   ?staff=<user_id>                            optional filter
 *
 * Expands jobs.recurring patterns into virtual occurrences that fall
 * inside the window. Virtual occurrences are tagged so the UI knows
 * they can't be drag-edited directly.
 *
 * RLS-scoped via user JWT — members of the org only.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return NextResponse.json(
      { error: "from/to must be YYYY-MM-DD and from <= to" },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const statusFilter = url.searchParams.get("status") ?? undefined;
  const staffFilter = url.searchParams.get("staff") ?? undefined;

  // WINDOW-SCOPED (F-1): the old read pulled ALL org jobs with a blind
  // `.limit(1000)` — no order, no date window — then expanded recurring +
  // window-filtered in memory. Because a recurring parent anchored OUTSIDE
  // [from, to] still yields in-window occurrences, the read cannot be
  // date-bounded, so once an org crossed 1000 jobs PostgREST silently clamped
  // the response and dropped in-window jobs from the calendar with no error.
  // fetchCalendarJobs (the same reader the /jobs/calendar server render uses)
  // splits the read: non-recurring jobs scoped to [from, to] + recurring
  // parents read unbounded, both paged under the cap on a deterministic
  // scheduled_date+id order. The recurring-expansion + in-memory window filter
  // below is byte-for-byte the pre-existing logic, unchanged.
  const { rows, error } = await fetchCalendarJobs({
    supabase,
    orgId: ctx.org.id,
    range: { from, to },
    statusFilter,
    staffFilter,
  });
  if (error) {
    console.error("[schedule] list failed", error);
    return NextResponse.json({ error: "Failed to load schedule" }, { status: 500 });
  }

  const out: CalendarJob[] = [];
  for (const j of rows) {
    const assignedName = j.assigned?.full_name ?? j.assigned?.email ?? null;
    const customerName = j.customer?.name ?? null;

    const isRecurringParent =
      j.recurring &&
      typeof j.recurring === "object" &&
      isValidRecurringPayload(j.recurring);

    if (isRecurringParent && j.scheduled_date) {
      // Emit virtual occurrences within [from, to].
      const occurrences = expandRecurring(
        j.scheduled_date,
        j.recurring as Parameters<typeof expandRecurring>[1],
        from,
        to,
      );
      for (const date of occurrences) {
        const isParentDate = date === j.scheduled_date;
        out.push({
          id: isParentDate ? j.id : `${j.id}:${date}`,
          parent_id: j.id,
          date,
          status: j.status,
          notes: j.notes ?? null,
          assigned_to: j.assigned_to,
          assigned_name: assignedName,
          customer_id: j.customer_id,
          customer_name: customerName,
          is_recurring_occurrence: !isParentDate,
        });
      }
    } else if (j.scheduled_date && j.scheduled_date >= from && j.scheduled_date <= to) {
      out.push({
        id: j.id,
        parent_id: j.id,
        date: j.scheduled_date,
        status: j.status,
        notes: j.notes ?? null,
        assigned_to: j.assigned_to,
        assigned_name: assignedName,
        customer_id: j.customer_id,
        customer_name: customerName,
        is_recurring_occurrence: false,
      });
    }
  }

  return NextResponse.json({ data: out });
}

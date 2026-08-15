import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../_form-helpers";
import { CalendarClient } from "./_calendar";
import { MonthView } from "./_month-view";
import { GanttView } from "./_gantt-view";
import { fetchCalendarJobs } from "@/lib/schedule/calendar-data";
import { fetchJobSpansForWindow } from "@/lib/jobs/schedule-spans";
import {
  expandRecurring,
  isValidRecurringPayload,
} from "@/lib/schedule/recurring";
import type { CalendarJob } from "@/lib/schedule/types";

/**
 * /jobs/calendar — week-view + month-view scheduling surface.
 *
 *   ?view=week (default) → drag-drop week grid (existing client UI)
 *   ?view=month          → read-only month grid; click a day → week
 *   ?d=YYYY-MM-DD        → anchor date inside the visible window
 *   ?status=, ?staff=    → filters applied to both views
 *
 * Single page that fetches the relevant date window based on view,
 * then dispatches to the correct presentation component. The month
 * view shares the same recurring-expansion + filter logic.
 */

type SP = Promise<{
  d?: string;
  status?: string;
  staff?: string;
  view?: string;
}>;

function isoFromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function startOfWeekIso(anchorIso: string): string {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  const dow = anchor.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - daysFromMonday);
  return isoFromUtc(start);
}

/**
 * Month-grid range = first Monday of the 6-row grid → last Sunday.
 * (i.e. pads back into the previous month and forward into the next so
 * the grid is always full.)
 */
function monthGridRange(anchorIso: string): { from: string; to: string } {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const startWeekday = (first.getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -startWeekday);
  const gridEnd = addDays(gridStart, 41); // 6 rows × 7 cols - 1
  return { from: isoFromUtc(gridStart), to: isoFromUtc(gridEnd) };
}

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  const anchorIso =
    sp.d && /^\d{4}-\d{2}-\d{2}$/.test(sp.d)
      ? sp.d
      : new Date().toISOString().slice(0, 10);
  const view =
    sp.view === "month"
      ? "month"
      : sp.view === "gantt"
        ? "gantt"
        : sp.view === "resource"
          ? "resource"
          : "week";

  // Gantt + resource views span four weeks from the anchor's week start, wide
  // enough to see multi-day jobs and resource load without scrolling per week.
  const timelineRange = (() => {
    const weekStart = startOfWeekIso(anchorIso);
    return {
      from: weekStart,
      to: isoFromUtc(addDays(new Date(`${weekStart}T00:00:00Z`), 27)),
    };
  })();

  const range =
    view === "month"
      ? monthGridRange(anchorIso)
      : view === "gantt" || view === "resource"
        ? timelineRange
        : (() => {
            const weekStart = startOfWeekIso(anchorIso);
            return { from: weekStart, to: isoFromUtc(addDays(new Date(`${weekStart}T00:00:00Z`), 6)) };
          })();

  const staff = await listStaffForOrg(ctx.org.id);
  const supabase = await createClient();

  // Build a switch-view header that preserves the active filters + anchor.
  function tlLinkQs(target: "week" | "month" | "gantt" | "resource"): string {
    const params = new URLSearchParams({ d: anchorIso, view: target });
    if (sp.status) params.set("status", sp.status);
    if (sp.staff) params.set("staff", sp.staff);
    return params.toString();
  }

  // ── Gantt / resource-swimlane views (multi-day spans, read-only) ──
  if (view === "gantt" || view === "resource") {
    const { rows: spanRows, error: spanError } = await fetchJobSpansForWindow({
      supabase,
      orgId: ctx.org.id,
      range,
      statusFilter: sp.status,
      staffFilter: sp.staff,
    });
    if (spanError) throw readFailure("jobs calendar: spans", spanError);
    return (
      <div className="space-y-4">
        <ViewToggle
          weekHref={`/jobs/calendar?${tlLinkQs("week")}`}
          monthHref={`/jobs/calendar?${tlLinkQs("month")}`}
          ganttHref={`/jobs/calendar?${tlLinkQs("gantt")}`}
          resourceHref={`/jobs/calendar?${tlLinkQs("resource")}`}
          active={view}
          orgName={ctx.org.name}
        />
        <header>
          <h1 className="text-2xl font-bold text-slate-900">
            {view === "resource" ? "Resource lanes" : "Gantt"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {ctx.org.name} · {range.from} → {range.to}
          </p>
        </header>
        <GanttView
          rows={spanRows}
          staff={staff.map((s) => ({ id: s.id, name: s.full_name ?? s.email }))}
          range={range}
          mode={view}
        />
      </div>
    );
  }
  // WINDOW-SCOPED (F-1): the old read pulled ALL org jobs with a blind
  // 1000-row cap, so once an org crossed 1000 jobs the PostgREST cap silently
  // dropped some from the grid. fetchCalendarJobs scopes non-recurring jobs to
  // the rendered [from, to] window and reads recurring parents unbounded (they
  // must be expanded across the window), both paged under the cap on a
  // deterministic scheduled_date+id order. The recurring-expansion + in-memory
  // window filter below is unchanged.
  const { rows, error } = await fetchCalendarJobs({
    supabase,
    orgId: ctx.org.id,
    range,
    statusFilter: sp.status,
    staffFilter: sp.staff,
  });
  if (error) throw readFailure("jobs calendar: jobs", error);

  if (view === "month") {
    // Expand recurring + flatten into CalendarJob[] for the month grid.
    const occurrences: CalendarJob[] = [];
    for (const j of rows) {
      const assignedName = j.assigned?.full_name ?? j.assigned?.email ?? null;
      const customerName = j.customer?.name ?? null;
      if (isValidRecurringPayload(j.recurring) && j.scheduled_date) {
        const dates = expandRecurring(j.scheduled_date, j.recurring, range.from, range.to);
        for (const date of dates) {
          const isParentDate = date === j.scheduled_date;
          occurrences.push({
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
      } else if (
        j.scheduled_date &&
        j.scheduled_date >= range.from &&
        j.scheduled_date <= range.to
      ) {
        occurrences.push({
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

    return (
      <div className="space-y-4">
        <ViewToggle
          weekHref={`/jobs/calendar?${tlLinkQs("week")}`}
          monthHref={`/jobs/calendar?${tlLinkQs("month")}`}
          ganttHref={`/jobs/calendar?${tlLinkQs("gantt")}`}
          resourceHref={`/jobs/calendar?${tlLinkQs("resource")}`}
          active="month"
          orgName={ctx.org.name}
        />
        <MonthView
          anchorIso={anchorIso}
          jobsInRange={occurrences}
          filterStatus={sp.status ?? ""}
          filterStaff={sp.staff ?? ""}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ViewToggle
        weekHref={`/jobs/calendar?${tlLinkQs("week")}`}
        monthHref={`/jobs/calendar?${tlLinkQs("month")}`}
        ganttHref={`/jobs/calendar?${tlLinkQs("gantt")}`}
        resourceHref={`/jobs/calendar?${tlLinkQs("resource")}`}
        active="week"
        orgName={ctx.org.name}
      />
      <CalendarClient
        orgName={ctx.org.name}
        staff={staff.map((s) => ({
          id: s.id,
          name: s.full_name ?? s.email,
        }))}
        initialJobs={rows}
        weekStart={range.from}
        weekEnd={range.to}
        statusFilter={sp.status ?? ""}
        staffFilter={sp.staff ?? ""}
      />
    </div>
  );
}

function ViewToggle({
  weekHref,
  monthHref,
  ganttHref,
  resourceHref,
  active,
}: {
  weekHref: string;
  monthHref: string;
  ganttHref: string;
  resourceHref: string;
  active: "week" | "month" | "gantt" | "resource";
  orgName: string;
}) {
  const tabs: { href: string; key: typeof active; label: string }[] = [
    { href: weekHref, key: "week", label: "Week" },
    { href: monthHref, key: "month", label: "Month" },
    { href: ganttHref, key: "gantt", label: "Gantt" },
    { href: resourceHref, key: "resource", label: "Resource" },
  ];
  return (
    <div className="flex justify-end">
      <nav className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white text-xs">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active === t.key ? "page" : undefined}
            className={
              active === t.key
                ? "bg-slate-900 px-3 py-1.5 font-medium text-white"
                : "px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

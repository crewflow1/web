import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../_form-helpers";
import { CalendarClient } from "./_calendar";
import { MonthView } from "./_month-view";
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
  const view = sp.view === "month" ? "month" : "week";

  const range =
    view === "month"
      ? monthGridRange(anchorIso)
      : (() => {
          const weekStart = startOfWeekIso(anchorIso);
          return { from: weekStart, to: isoFromUtc(addDays(new Date(`${weekStart}T00:00:00Z`), 6)) };
        })();

  const staff = await listStaffForOrg(ctx.org.id);
  const supabase = await createClient();
  let q = supabase
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, notes, assigned_to, customer_id, recurring,
        customer:customers ( id, name ),
        assigned:users!jobs_assigned_to_fkey ( id, full_name, email )
      `,
    )
    // ACTIVE-org pin — the staff filter above already comes from
    // listStaffForOrg(ctx.org.id) (#456); the calendar grid itself did not.
    .eq("org_id", ctx.org.id)
    .limit(1000);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.staff) q = q.eq("assigned_to", sp.staff);
  const { data: rawJobs, error } = await q;
  if (error) throw readFailure("jobs calendar: jobs", error);
  const rows = rawJobs ?? [];

  // Build a switch-view header that preserves the active filters + anchor.
  function viewLinkQs(target: "week" | "month"): string {
    const params = new URLSearchParams({ d: anchorIso, view: target });
    if (sp.status) params.set("status", sp.status);
    if (sp.staff) params.set("staff", sp.staff);
    return params.toString();
  }

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
          weekHref={`/jobs/calendar?${viewLinkQs("week")}`}
          monthHref={`/jobs/calendar?${viewLinkQs("month")}`}
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
        weekHref={`/jobs/calendar?${viewLinkQs("week")}`}
        monthHref={`/jobs/calendar?${viewLinkQs("month")}`}
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
  active,
}: {
  weekHref: string;
  monthHref: string;
  active: "week" | "month";
  orgName: string;
}) {
  return (
    <div className="flex justify-end">
      <nav className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white text-xs">
        <Link
          href={weekHref}
          aria-current={active === "week" ? "page" : undefined}
          className={
            active === "week"
              ? "bg-slate-900 px-3 py-1.5 font-medium text-white"
              : "px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          }
        >
          Week
        </Link>
        <Link
          href={monthHref}
          aria-current={active === "month" ? "page" : undefined}
          className={
            active === "month"
              ? "bg-slate-900 px-3 py-1.5 font-medium text-white"
              : "px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          }
        >
          Month
        </Link>
      </nav>
    </div>
  );
}

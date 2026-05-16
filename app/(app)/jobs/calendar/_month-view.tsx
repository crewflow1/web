import Link from "next/link";
import type { CalendarJob } from "@/lib/schedule/types";

/**
 * Read-only month grid.
 *
 * Drag-drop is intentionally disabled here — a 7×5 grid of small cells
 * isn't a good interaction target on mobile, and supporting it on
 * desktop only would split the UX in half. Click a day cell to jump
 * to that day's week view (where drag is enabled).
 *
 * Recurring occurrences render as small badges alongside real jobs.
 */

const STATUS_DOT: Record<string, string> = {
  new: "bg-blue-500",
  "in-progress": "bg-amber-500",
  completed: "bg-green-500",
  blocked: "bg-red-500",
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isoFromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** First-of-month, anchored in UTC to match scheduled_date semantics. */
function monthStart(anchorIso: string): Date {
  const d = new Date(`${anchorIso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function MonthView({
  anchorIso,
  jobsInRange,
  filterStatus,
  filterStaff,
}: {
  /** Any date in the month to render. */
  anchorIso: string;
  /** All occurrences (real + virtual) whose date falls inside the month grid. */
  jobsInRange: CalendarJob[];
  filterStatus: string;
  filterStaff: string;
}) {
  const first = monthStart(anchorIso);

  // Pad backwards to Monday of the first row.
  const startWeekday = (first.getUTCDay() + 6) % 7; // 0 if Mon, 6 if Sun
  const gridStart = addDays(first, -startWeekday);

  // Always render 6 rows (42 cells) — covers any month layout, keeps
  // the grid height consistent for the eye to scan.
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

  // Bucket jobs by date for quick lookup.
  const byDay = new Map<string, CalendarJob[]>();
  for (const j of jobsInRange) {
    const arr = byDay.get(j.date) ?? [];
    arr.push(j);
    byDay.set(j.date, arr);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const monthIndex = first.getUTCMonth();

  // Previous / next month anchors.
  const prevAnchor = addDays(first, -1); // a day in the previous month
  const nextAnchor = addDays(first, 32); // safely lands inside next month

  function viewQs(d: string): string {
    const sp = new URLSearchParams({ d, view: "month" });
    if (filterStatus) sp.set("status", filterStatus);
    if (filterStaff) sp.set("staff", filterStaff);
    return sp.toString();
  }
  function weekQs(d: string): string {
    const sp = new URLSearchParams({ d, view: "week" });
    if (filterStatus) sp.set("status", filterStatus);
    if (filterStaff) sp.set("staff", filterStaff);
    return sp.toString();
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {monthLabel(first)}
          </h2>
          <p className="text-xs text-slate-500">
            Click a day to open its week view (drag-drop enabled there).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/jobs/calendar?${viewQs(isoFromUtc(prevAnchor))}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Previous
          </Link>
          <Link
            href={`/jobs/calendar?${viewQs(todayIso)}`}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
          >
            Today
          </Link>
          <Link
            href={`/jobs/calendar?${viewQs(isoFromUtc(nextAnchor))}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Next →
          </Link>
        </div>
      </header>

      {/* Weekday header row, hidden on mobile to save space */}
      <ol className="hidden grid-cols-7 gap-1 text-center text-[11px] font-medium uppercase tracking-wide text-slate-500 md:grid">
        {WEEKDAY_LABELS.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ol>

      {/* The grid — 1 column on mobile, 7 on md+. */}
      <ol className="grid grid-cols-1 gap-1 md:grid-cols-7">
        {cells.map((cell) => {
          const cellIso = isoFromUtc(cell);
          const dayNumber = cell.getUTCDate();
          const inMonth = cell.getUTCMonth() === monthIndex;
          const isToday = cellIso === todayIso;
          const dayJobs = byDay.get(cellIso) ?? [];
          const visible = dayJobs.slice(0, 3);
          const overflow = dayJobs.length - visible.length;

          return (
            <li key={cellIso}>
              <Link
                href={`/jobs/calendar?${weekQs(cellIso)}`}
                aria-label={`Week of ${cellIso}, ${dayJobs.length} jobs`}
                className={`block min-h-[80px] rounded-md border p-2 text-left transition hover:border-slate-400 hover:bg-slate-50 ${
                  isToday
                    ? "border-slate-900 bg-white"
                    : inMonth
                      ? "border-slate-200 bg-white"
                      : "border-slate-100 bg-slate-50/60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-medium ${
                      isToday
                        ? "text-slate-900"
                        : inMonth
                          ? "text-slate-700"
                          : "text-slate-400"
                    }`}
                  >
                    {/* Show "Mon 5" on mobile (no weekday header), just "5" on desktop. */}
                    <span className="md:hidden">
                      {WEEKDAY_LABELS[(cell.getUTCDay() + 6) % 7]} {dayNumber}
                    </span>
                    <span className="hidden md:inline">{dayNumber}</span>
                  </span>
                  {isToday ? (
                    <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      today
                    </span>
                  ) : null}
                </div>

                {dayJobs.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {visible.map((j) => (
                      <li
                        key={j.id}
                        className="flex items-center gap-1 truncate text-[11px] text-slate-700"
                      >
                        <span
                          aria-hidden
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[j.status] ?? "bg-slate-400"}`}
                        />
                        <span className="truncate">
                          {j.is_recurring_occurrence ? "↻ " : ""}
                          {j.customer_name ?? "—"}
                        </span>
                      </li>
                    ))}
                    {overflow > 0 ? (
                      <li className="text-[11px] font-medium text-slate-500">
                        +{overflow} more
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

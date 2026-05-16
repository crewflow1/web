"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { expandRecurring, isValidRecurringPayload } from "@/lib/schedule/recurring";
import type { CalendarJob, CalendarStaff } from "@/lib/schedule/types";

/**
 * Week-view calendar with drag-and-drop reschedule + assignee change.
 *
 * Layout:
 *   - 7 day columns on >=md
 *   - 1-column vertical list on <md (mobile-first; columns become
 *     stacked "Mon — 2 jobs / Tue — 1 job" sections)
 *   - Jobs render as draggable cards. Drop targets are the day columns;
 *     dropping a card on a different day issues a PUT.
 *   - Assignee changes via the per-card select (post-drop fine-grain).
 *
 * @dnd-kit handles pointer + touch via the two sensors configured
 * below. Activation distance is 5px so a tap on the card still
 * navigates to the job detail (rather than treating every tap as the
 * start of a drag).
 */

type DbJob = {
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

const STATUS_STYLES: Record<string, string> = {
  new: "border-blue-300 bg-blue-50 text-blue-900",
  "in-progress": "border-amber-300 bg-amber-50 text-amber-900",
  completed: "border-green-300 bg-green-50 text-green-900",
  blocked: "border-red-300 bg-red-50 text-red-900",
};

const STATUSES = ["new", "in-progress", "completed", "blocked"] as const;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function expandToOccurrences(
  jobs: DbJob[],
  rangeFrom: string,
  rangeTo: string,
): CalendarJob[] {
  const out: CalendarJob[] = [];
  for (const j of jobs) {
    const assignedName = j.assigned?.full_name ?? j.assigned?.email ?? null;
    const customerName = j.customer?.name ?? null;

    if (isValidRecurringPayload(j.recurring) && j.scheduled_date) {
      const dates = expandRecurring(j.scheduled_date, j.recurring, rangeFrom, rangeTo);
      for (const date of dates) {
        const isParentDate = date === j.scheduled_date;
        out.push({
          id: isParentDate ? j.id : `${j.id}:${date}`,
          parent_id: j.id,
          date,
          status: j.status,
          notes: j.notes,
          assigned_to: j.assigned_to,
          assigned_name: assignedName,
          customer_id: j.customer_id,
          customer_name: customerName,
          is_recurring_occurrence: !isParentDate,
        });
      }
    } else if (
      j.scheduled_date &&
      j.scheduled_date >= rangeFrom &&
      j.scheduled_date <= rangeTo
    ) {
      out.push({
        id: j.id,
        parent_id: j.id,
        date: j.scheduled_date,
        status: j.status,
        notes: j.notes,
        assigned_to: j.assigned_to,
        assigned_name: assignedName,
        customer_id: j.customer_id,
        customer_name: customerName,
        is_recurring_occurrence: false,
      });
    }
  }
  return out;
}

export function CalendarClient({
  orgName,
  staff,
  initialJobs,
  weekStart,
  weekEnd,
  statusFilter,
  staffFilter,
}: {
  orgName: string;
  staff: CalendarStaff[];
  initialJobs: DbJob[];
  weekStart: string;
  weekEnd: string;
  statusFilter: string;
  staffFilter: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [jobs, setJobs] = useState<DbJob[]>(initialJobs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // @dnd-kit sensors: PointerSensor for mouse, TouchSensor for fingers.
  // 5px activation distance lets a tap stay a tap.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  // 7 day cells starting Mon
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i)),
    [weekStart],
  );

  // Build the list of cards from the current jobs state (so optimistic
  // updates after PUT show up immediately).
  const occurrences = useMemo(
    () => expandToOccurrences(jobs, weekStart, weekEnd),
    [jobs, weekStart, weekEnd],
  );
  const byDay = useMemo(() => {
    const map: Record<string, CalendarJob[]> = {};
    for (const d of days) map[d] = [];
    for (const occ of occurrences) {
      if (map[occ.date]) map[occ.date]!.push(occ);
    }
    return map;
  }, [occurrences, days]);

  function isoToHuman(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
  }

  async function persistMove(jobId: string, newDate: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedule/${jobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_date: newDate }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Move failed (${res.status})`);
        return false;
      }
      return true;
    } catch {
      setError("Network error rescheduling.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function persistAssignee(jobId: string, assignee: string | null): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedule/${jobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_to: assignee }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Assignee change failed (${res.status})`);
        return false;
      }
      return true;
    } catch {
      setError("Network error reassigning.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function applyOptimisticMove(jobId: string, newDate: string) {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, scheduled_date: newDate } : j)),
    );
  }
  function applyOptimisticAssignee(jobId: string, assignee: string | null) {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              assigned_to: assignee,
              assigned:
                assignee === null
                  ? null
                  : {
                      id: assignee,
                      full_name:
                        staff.find((s) => s.id === assignee)?.name ?? null,
                      email: "",
                    },
            }
          : j,
      ),
    );
  }

  async function onDragEnd(e: DragEndEvent) {
    const draggedId = String(e.active.id);
    const dropDate = e.over ? String(e.over.id) : null;
    if (!dropDate) return;

    // Recurring occurrences can't be moved directly — surface that.
    if (draggedId.includes(":")) {
      setError(
        "This is a recurring occurrence — edit the parent at /jobs/[id] to change its pattern.",
      );
      return;
    }

    const job = jobs.find((j) => j.id === draggedId);
    if (!job) return;
    if (job.scheduled_date === dropDate) return;

    // Optimistic update, then PUT, revert on failure.
    const prevDate = job.scheduled_date;
    applyOptimisticMove(draggedId, dropDate);
    const ok = await persistMove(draggedId, dropDate);
    if (!ok) applyOptimisticMove(draggedId, prevDate ?? "");
    else startTransition(() => router.refresh());
  }

  async function onAssigneeChange(parentId: string, value: string) {
    if (parentId.includes(":")) {
      setError("Recurring occurrences aren't directly editable.");
      return;
    }
    const prev =
      jobs.find((j) => j.id === parentId)?.assigned_to ?? null;
    const next = value === "" ? null : value;
    applyOptimisticAssignee(parentId, next);
    const ok = await persistAssignee(parentId, next);
    if (!ok) applyOptimisticAssignee(parentId, prev);
    else startTransition(() => router.refresh());
  }

  const prevWeek = addDaysIso(weekStart, -7);
  const nextWeek = addDaysIso(weekStart, 7);
  const todayIso = new Date().toISOString().slice(0, 10);

  const totalCount = occurrences.length;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Calendar</h1>
          <p className="mt-1 text-sm text-slate-600">
            {orgName} · week of {isoToHuman(weekStart)} – {isoToHuman(weekEnd)}{" "}
            · {totalCount} {totalCount === 1 ? "job" : "jobs"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/jobs/calendar?d=${prevWeek}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Previous
          </Link>
          <Link
            href={`/jobs/calendar?d=${todayIso}`}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800"
          >
            Today
          </Link>
          <Link
            href={`/jobs/calendar?d=${nextWeek}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Next →
          </Link>
        </div>
      </header>

      {/* Filters */}
      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <input type="hidden" name="d" value={weekStart} />
        <div>
          <label className="block text-xs font-medium text-slate-700">Status</label>
          <select
            name="status"
            defaultValue={statusFilter}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-700">Staff</label>
          <select
            name="staff"
            defaultValue={staffFilter}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">All</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href={`/jobs/calendar?d=${weekStart}`}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Clear
        </Link>
      </form>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}
      {busy ? (
        <div className="text-xs text-slate-500">Saving…</div>
      ) : null}

      {/* Week grid: 7 columns on md+, stacked on mobile */}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-7">
          {days.map((d, i) => (
            <DayColumn
              key={d}
              date={d}
              label={`${WEEKDAY_LABELS[i]} ${isoToHuman(d)}`}
              isToday={d === todayIso}
              jobs={byDay[d] ?? []}
              staff={staff}
              onAssigneeChange={onAssigneeChange}
            />
          ))}
        </ol>
      </DndContext>

      <details className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500 shadow-sm">
        <summary className="cursor-pointer text-slate-700">
          How drag &amp; drop works
        </summary>
        <p className="mt-2">
          Hold a card and drag it to another day to reschedule. Works on
          mouse and touch (long-press on mobile to start drag). Tap a card
          to open its full detail page. Recurring occurrences are marked
          with a ↻ and need to be edited from the parent job page.
        </p>
        <p className="mt-2">
          Only admins/owners can reschedule jobs (existing RLS policy).
          Field staff see the calendar read-only.
        </p>
      </details>
    </div>
  );
}

function DayColumn({
  date,
  label,
  isToday,
  jobs,
  staff,
  onAssigneeChange,
}: {
  date: string;
  label: string;
  isToday: boolean;
  jobs: CalendarJob[];
  staff: CalendarStaff[];
  onAssigneeChange: (parentId: string, value: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: date });
  return (
    <li
      ref={setNodeRef}
      className={`flex min-h-[120px] flex-col rounded-xl border ${
        isOver
          ? "border-slate-900 bg-slate-100"
          : "border-slate-200 bg-slate-50/60"
      }`}
    >
      <header
        className={`flex items-center justify-between border-b border-slate-200 px-3 py-2 text-xs font-medium ${
          isToday ? "text-slate-900" : "text-slate-600"
        }`}
      >
        <span>{label}</span>
        {isToday ? (
          <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white">
            today
          </span>
        ) : null}
      </header>
      <ul className="flex-1 space-y-2 p-2">
        {jobs.length === 0 ? (
          <li className="rounded-md border border-dashed border-slate-200 bg-white py-4 text-center text-[11px] text-slate-400">
            Drop a job here
          </li>
        ) : (
          jobs.map((j) => (
            <DraggableCard
              key={j.id}
              job={j}
              staff={staff}
              onAssigneeChange={onAssigneeChange}
            />
          ))
        )}
      </ul>
    </li>
  );
}

function DraggableCard({
  job,
  staff,
  onAssigneeChange,
}: {
  job: CalendarJob;
  staff: CalendarStaff[];
  onAssigneeChange: (parentId: string, value: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: job.id, disabled: job.is_recurring_occurrence });

  const transformStyle = transform
    ? `translate(${transform.x}px, ${transform.y}px)`
    : undefined;

  const statusClass =
    STATUS_STYLES[job.status as keyof typeof STATUS_STYLES] ??
    "border-slate-300 bg-white text-slate-900";

  return (
    <li
      ref={setNodeRef}
      style={{ transform: transformStyle }}
      className={`group rounded-md border p-2 text-xs shadow-sm ${statusClass} ${
        isDragging ? "opacity-50" : ""
      } ${job.is_recurring_occurrence ? "border-dashed" : ""}`}
    >
      <div
        {...attributes}
        {...listeners}
        // Drag handle: the whole card top. Tap-through-to-detail is the
        // anchor below.
        className="cursor-grab touch-none select-none"
      >
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-medium">
            {job.customer_name ?? "—"}
          </span>
          {job.is_recurring_occurrence ? (
            <span title="Recurring occurrence" aria-hidden>
              ↻
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] opacity-80">{job.status}</div>
      </div>

      {/* Inline assignee change (parent jobs only) */}
      {job.is_recurring_occurrence ? (
        <div className="mt-2 truncate text-[11px] text-slate-500">
          {job.assigned_name ?? "Unassigned"}
        </div>
      ) : (
        <select
          aria-label="Assignee"
          value={job.assigned_to ?? ""}
          onChange={(e) => onAssigneeChange(job.parent_id, e.target.value)}
          className="mt-2 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-700"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">— unassigned —</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <Link
          href={`/jobs/${job.parent_id}`}
          className="text-slate-600 underline decoration-dotted hover:text-slate-900"
        >
          Open →
        </Link>
      </div>
    </li>
  );
}

/**
 * "My tasks" — pure selection + ordering for the /me task list.
 *
 * The tasks are assigned job-checklist items (job_checklists.assigned_to /
 * due_on, migration 20261182000000). The DB read on /me is ACTIVE-org pinned and
 * already filters to the viewer + open items; this module is the pure,
 * unit-testable core that (a) re-asserts "mine and open" as defence in depth and
 * (b) orders them the way a worker wants: soonest deadline first, undated last.
 *
 * Server/client-safe — no imports.
 */

export type MyTaskRow = {
  id: string;
  label: string;
  job_id: string;
  is_done: boolean;
  assigned_to: string | null;
  due_on: string | null;
  customer_name: string | null;
};

/**
 * Order tasks the way the worker reads them: an item WITH a due date always
 * sorts before one without (a deadline is more urgent than an open-ended task);
 * among dated items, soonest first; ties broken by label then id so the order is
 * total and stable.
 */
export function sortMyTasks<T extends { due_on: string | null; label: string; id: string }>(
  tasks: readonly T[],
): T[] {
  return [...tasks].sort((a, b) => {
    if (a.due_on && b.due_on) {
      if (a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
    } else if (a.due_on) {
      return -1;
    } else if (b.due_on) {
      return 1;
    }
    if (a.label !== b.label) return a.label < b.label ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Select the viewer's OPEN tasks from a set of rows and order them. Filters to
 * `assigned_to === userId` and `is_done === false` — so even if a caller passes
 * a broader set (or a future read widens), a completed item or someone else's
 * task can never appear in "my tasks".
 */
export function selectMyOpenTasks(
  rows: readonly MyTaskRow[],
  userId: string,
): MyTaskRow[] {
  return sortMyTasks(
    rows.filter((r) => r.assigned_to === userId && r.is_done === false),
  );
}

/** True when a due date is strictly before today (YYYY-MM-DD compared). */
export function isTaskOverdue(dueOn: string | null, todayIso: string): boolean {
  return dueOn != null && dueOn < todayIso;
}

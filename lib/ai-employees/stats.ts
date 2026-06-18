/**
 * CrewFlow HQ — AI Employee workforce telemetry (CEO Directive 004, Phase 3).
 *
 * Pure, server/client-safe derivations over the task + memory history that
 * already lives in `ai_employee_tasks` / `ai_employee_memory`. NO Supabase /
 * server-only imports — the service layer, the boardroom pages, and the unit
 * tests all share this one vocabulary, exactly like `lib/hq/executive.ts`.
 *
 * Maps the directive's per-employee fields to real data:
 *   • Tasks today         — tasks created since the UTC day boundary
 *   • Success rate        — completed / (completed + failed)
 *   • Avg completion time — mean wall-clock across completed-with-timestamps
 *   • Last completed task — newest task in a terminal "completed" state
 *   • Knowledge version   — 1 + memory entries (each entry is a revision)
 *   • Memory usage        — stored character footprint + entry count
 *
 * ARCHITECTURE ONLY. Nothing here executes a task or calls a model provider;
 * it reads shaped history rows and derives operational stats.
 */

// Minimal row shapes (a subset of the DB columns) so callers can pass either
// full AiEmployeeTask / AiEmployeeMemoryEntry rows or lean bounded reads.
export type TaskStatRow = {
  status: string;
  title?: string | null;
  created_at: string;
  completed_at: string | null;
};

export type MemoryStatRow = {
  content: string;
};

export type EmployeeStats = {
  tasksToday: number;
  tasksTotal: number;
  completed: number;
  failed: number;
  inProgress: number;
  /** completed / (completed + failed); null when nothing has finished. */
  successRatePct: number | null;
  /** Mean wall-clock ms across completed tasks carrying both timestamps. */
  avgCompletionMs: number | null;
  avgCompletionLabel: string;
  lastCompletedTitle: string | null;
  /** Completion stamp (falls back to created_at for legacy rows). */
  lastCompletedAt: string | null;
  /** 1 + memory entries — each entry is a knowledge revision. */
  knowledgeVersion: number;
  memoryEntries: number;
  memoryChars: number;
  memoryUsageLabel: string;
};

/** UTC start-of-day ISO, matching the Command Centre's "today" convention. */
export function startOfUtcDayIso(nowIso?: string): string {
  const base = nowIso ? new Date(nowIso) : new Date();
  return `${base.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** "—" | "30s" | "2m" | "1h 30m" | "1d 1h" — compact, human-readable. */
export function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hrs < 24) return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs ? `${days}d ${remHrs}h` : `${days}d`;
}

/** Stored-size label. Characters ≈ bytes for the ASCII-dominant content. */
export function memoryUsageLabel(chars: number): string {
  if (chars <= 0) return "0 B";
  if (chars < 1000) return `${chars} B`;
  const kb = chars / 1000;
  if (kb < 1000) return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

export function computeEmployeeStats(
  tasks: ReadonlyArray<TaskStatRow>,
  memory: ReadonlyArray<MemoryStatRow>,
  opts: { nowIso?: string } = {},
): EmployeeStats {
  const todayStart = startOfUtcDayIso(opts.nowIso);
  let tasksToday = 0;
  let completed = 0;
  let failed = 0;
  let inProgress = 0;
  let durSum = 0;
  let durCount = 0;
  let lastStamp = "";
  let lastCompletedTitle: string | null = null;
  let lastCompletedAt: string | null = null;

  for (const t of tasks) {
    if (t.created_at >= todayStart) tasksToday += 1;

    if (t.status === "completed") {
      completed += 1;
      const stamp = t.completed_at ?? t.created_at;
      if (stamp > lastStamp) {
        lastStamp = stamp;
        lastCompletedTitle = t.title ?? null;
        lastCompletedAt = stamp;
      }
      if (t.completed_at) {
        const ms =
          new Date(t.completed_at).getTime() - new Date(t.created_at).getTime();
        if (Number.isFinite(ms) && ms >= 0) {
          durSum += ms;
          durCount += 1;
        }
      }
    } else if (t.status === "failed") {
      failed += 1;
    } else if (t.status === "in_progress") {
      inProgress += 1;
    }
  }

  const passFail = completed + failed;
  const successRatePct =
    passFail === 0 ? null : Math.round((completed / passFail) * 100);
  const avgCompletionMs = durCount === 0 ? null : Math.round(durSum / durCount);

  const memoryEntries = memory.length;
  let memoryChars = 0;
  for (const m of memory) memoryChars += m.content.length;

  return {
    tasksToday,
    tasksTotal: tasks.length,
    completed,
    failed,
    inProgress,
    successRatePct,
    avgCompletionMs,
    avgCompletionLabel: formatDuration(avgCompletionMs),
    lastCompletedTitle,
    lastCompletedAt,
    knowledgeVersion: 1 + memoryEntries,
    memoryEntries,
    memoryChars,
    memoryUsageLabel: memoryUsageLabel(memoryChars),
  };
}

export function emptyEmployeeStats(): EmployeeStats {
  return computeEmployeeStats([], []);
}

// ---------------------------------------------------------------------
// Workforce roll-up — the headline KPIs across the whole roster.
// ---------------------------------------------------------------------

export type WorkforceSummary = {
  totalEmployees: number;
  activeWorkers: number;
  waitingApproval: number;
  blockedOrError: number;
  tasksToday: number;
  tasksInProgress: number;
  completedTotal: number;
  failedTotal: number;
  successRatePct: number | null;
  avgCompletionMs: number | null;
  avgCompletionLabel: string;
  totalMemoryEntries: number;
  totalMemoryChars: number;
  memoryUsageLabel: string;
};

/**
 * Combine per-employee stats with the roster's live statuses. Status
 * counts come from the employee rows (source of truth for "active now");
 * task / memory totals come from the derived stats. The overall average
 * completion weights each employee's mean by its completed count.
 */
export function aggregateWorkforce(
  employees: ReadonlyArray<{ status: string }>,
  stats: ReadonlyArray<EmployeeStats>,
): WorkforceSummary {
  let activeWorkers = 0;
  let waitingApproval = 0;
  let blockedOrError = 0;
  for (const e of employees) {
    if (e.status === "working") activeWorkers += 1;
    else if (e.status === "waiting_approval") waitingApproval += 1;
    else if (e.status === "blocked" || e.status === "error") blockedOrError += 1;
  }

  let tasksToday = 0;
  let tasksInProgress = 0;
  let completedTotal = 0;
  let failedTotal = 0;
  let durSum = 0;
  let durCount = 0;
  let totalMemoryEntries = 0;
  let totalMemoryChars = 0;
  for (const s of stats) {
    tasksToday += s.tasksToday;
    tasksInProgress += s.inProgress;
    completedTotal += s.completed;
    failedTotal += s.failed;
    totalMemoryEntries += s.memoryEntries;
    totalMemoryChars += s.memoryChars;
    if (s.avgCompletionMs != null && s.completed > 0) {
      durSum += s.avgCompletionMs * s.completed;
      durCount += s.completed;
    }
  }

  const passFail = completedTotal + failedTotal;
  const successRatePct =
    passFail === 0 ? null : Math.round((completedTotal / passFail) * 100);
  const avgCompletionMs = durCount === 0 ? null : Math.round(durSum / durCount);

  return {
    totalEmployees: employees.length,
    activeWorkers,
    waitingApproval,
    blockedOrError,
    tasksToday,
    tasksInProgress,
    completedTotal,
    failedTotal,
    successRatePct,
    avgCompletionMs,
    avgCompletionLabel: formatDuration(avgCompletionMs),
    totalMemoryEntries,
    totalMemoryChars,
    memoryUsageLabel: memoryUsageLabel(totalMemoryChars),
  };
}

/** "—" when a rate is unmeasurable yet (no finished work), else "NN%". */
export function formatRate(pct: number | null): string {
  return pct == null ? "—" : `${pct}%`;
}

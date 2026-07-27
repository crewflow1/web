import {
  isTerminalStatus,
  SNAG_PRIORITIES,
  SNAG_PRIORITY_LABELS,
  SNAG_STATUS_LABELS,
  type SnagPriority,
  type SnagStatus,
} from "@/lib/snags/schema";

/**
 * Job Site Hub — the small pure roll-ups behind the job-page panels.
 *
 * These summarise rows the caller already fetched (job-pinned + org-pinned).
 * They restate NO lifecycle rules: "open" is defined by
 * lib/snags/schema.ts's `isTerminalStatus` (verified / wont_fix are terminal),
 * exactly as lib/blueprints/pins.ts and the snag list already treat it. If the
 * lifecycle ever changes, it changes in one place and these follow.
 */

export type JobSnagRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  location: string | null;
  due_date: string | null;
  created_at: string;
};

export type JobSnagSummary = {
  total: number;
  open: number;
  /** Open snags past their due date, by the caller's calendar day (YYYY-MM-DD). */
  overdue: number;
  /** Open-snag counts per priority, high → low. */
  byPriority: Array<{ priority: SnagPriority; label: string; count: number }>;
  /** Open snags, most urgent first, then oldest first. */
  openSnags: JobSnagRow[];
};

const PRIORITY_RANK: Record<SnagPriority, number> = { high: 0, medium: 1, low: 2 };

function asPriority(value: string): SnagPriority {
  return (SNAG_PRIORITIES as readonly string[]).includes(value) ? (value as SnagPriority) : "medium";
}

/** True while the snag still needs someone — i.e. it has not reached a terminal status. */
export function isOpenSnag(status: string): boolean {
  return !isTerminalStatus(status as SnagStatus);
}

/** Human status word for a snag. Never a colour on its own (WCAG 1.4.1). */
export function snagStatusLabel(status: string): string {
  return (SNAG_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

/** Human priority word for a snag. */
export function snagPriorityLabel(priority: string): string {
  return (SNAG_PRIORITY_LABELS as Record<string, string>)[priority] ?? priority;
}

/**
 * Roll a job's snags up into the numbers a site manager needs at a glance.
 *
 * `todayIso` is passed in (never read from a clock here) so the overdue count is
 * reproducible in a test and consistent with whatever day the page rendered for.
 */
export function summariseJobSnags(
  rows: readonly JobSnagRow[],
  todayIso: string,
): JobSnagSummary {
  const openSnags = rows
    .filter((r) => isOpenSnag(r.status))
    .slice()
    .sort((a, b) => {
      const pa = PRIORITY_RANK[asPriority(a.priority)];
      const pb = PRIORITY_RANK[asPriority(b.priority)];
      if (pa !== pb) return pa - pb;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      // Unique tiebreak so the order is total and permutation-independent.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const counts: Record<SnagPriority, number> = { high: 0, medium: 0, low: 0 };
  for (const s of openSnags) counts[asPriority(s.priority)] += 1;

  return {
    total: rows.length,
    open: openSnags.length,
    overdue: openSnags.filter((s) => !!s.due_date && !!todayIso && s.due_date < todayIso).length,
    byPriority: (["high", "medium", "low"] as const).map((p) => ({
      priority: p,
      label: SNAG_PRIORITY_LABELS[p],
      count: counts[p],
    })),
    openSnags,
  };
}

export type JobDiaryRow = {
  id: string;
  entry_date: string;
  weather: string | null;
  labour_count: number | null;
  work_summary: string | null;
  delays: string | null;
  created_at: string;
};

export type JobDiarySummary = {
  total: number;
  /** Most recent first; a unique tiebreak keeps same-day entries deterministic. */
  recent: JobDiaryRow[];
  /** The latest entry's date, or null when the job has no diary yet. */
  lastEntryDate: string | null;
  /** Entries recording a delay — the disputes/EOT evidence trail. */
  withDelays: number;
};

/**
 * Order a job's diary newest-first and take the head.
 *
 * Sort key is (entry_date, created_at, id): the logged DAY leads, the write
 * order breaks a same-day tie, and the primary key makes the order total so the
 * panel never reshuffles between renders.
 */
export function summariseJobDiary(
  rows: readonly JobDiaryRow[],
  limit: number,
): JobDiarySummary {
  const ordered = rows.slice().sort((a, b) => {
    if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return {
    total: ordered.length,
    recent: limit >= 0 ? ordered.slice(0, limit) : ordered,
    lastEntryDate: ordered[0]?.entry_date ?? null,
    withDelays: ordered.filter((r) => !!r.delays && r.delays.trim() !== "").length,
  };
}

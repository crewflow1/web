/**
 * CrewFlow — Notifications pure compute (sort + group + filter).
 *
 * No I/O. Imported by both the customer page and the HQ page.
 */

import {
  NOTIFICATION_PRIORITY_RANK,
  type NotificationCategory,
  type NotificationPriority,
  type NotificationRow,
} from "./types";

/**
 * Default "what should I look at first" ordering.
 *   1. Unread + un-dismissed first
 *   2. Higher priority first (urgent → low)
 *   3. Newest first
 */
export function prioritySort<T extends NotificationRow>(
  rows: ReadonlyArray<T>,
): T[] {
  const out = rows.slice();
  out.sort((a, b) => {
    const aActive = a.read_at === null && a.dismissed_at === null ? 0 : 1;
    const bActive = b.read_at === null && b.dismissed_at === null ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const pa = NOTIFICATION_PRIORITY_RANK[a.priority as NotificationPriority] ?? 9;
    const pb = NOTIFICATION_PRIORITY_RANK[b.priority as NotificationPriority] ?? 9;
    if (pa !== pb) return pa - pb;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return out;
}

export type NotificationFilters = {
  q?: string | null;
  category?: NotificationCategory | "all" | null;
  priority?: NotificationPriority | "all" | null;
  /** "unread" hides read OR dismissed. "all" shows everything. */
  state?: "unread" | "all" | "dismissed" | null;
  /** HQ-only filter. */
  org_id?: string | null;
};

export function filterNotifications<T extends NotificationRow>(
  rows: ReadonlyArray<T>,
  f: NotificationFilters,
): T[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return rows.filter((n) => {
    if (q) {
      const blob = `${n.title} ${n.body ?? ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    if (f.category && f.category !== "all" && n.category !== f.category) {
      return false;
    }
    if (f.priority && f.priority !== "all" && n.priority !== f.priority) {
      return false;
    }
    if (f.org_id && n.org_id !== f.org_id) return false;
    if (f.state === "unread") {
      if (n.read_at !== null || n.dismissed_at !== null) return false;
    } else if (f.state === "dismissed") {
      if (n.dismissed_at === null) return false;
    }
    return true;
  });
}

/**
 * Group by "today / yesterday / this week / older" buckets for the
 * UI list. Pure: caller passes `now` for deterministic tests.
 */
export type NotificationGroup<T> = {
  label: "Today" | "Yesterday" | "Earlier this week" | "Older";
  rows: T[];
};

export function groupByDate<T extends NotificationRow>(
  rows: ReadonlyArray<T>,
  now: Date = new Date(),
): NotificationGroup<T>[] {
  const buckets: Record<NotificationGroup<T>["label"], T[]> = {
    Today: [],
    Yesterday: [],
    "Earlier this week": [],
    Older: [],
  };
  const today = startOfDayUtc(now);
  const yesterday = today - 86_400_000;
  const weekAgo = today - 7 * 86_400_000;
  for (const r of rows) {
    const t = startOfDayUtc(new Date(r.created_at));
    if (t >= today) buckets.Today.push(r);
    else if (t >= yesterday) buckets.Yesterday.push(r);
    else if (t >= weekAgo) buckets["Earlier this week"].push(r);
    else buckets.Older.push(r);
  }
  // Return in fixed order, dropping empty buckets.
  return (["Today", "Yesterday", "Earlier this week", "Older"] as const)
    .map((label) => ({ label, rows: buckets[label] }))
    .filter((g) => g.rows.length > 0);
}

function startOfDayUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Badge text helper — same shape as HQ-7's badgeText. 0 → null
 * (UI hides the badge).
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}

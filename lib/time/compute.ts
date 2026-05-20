/**
 * Time-tracking helpers — pure, server/client-safe.
 *
 * Source-of-truth invariant: `time_entries` is the spine. Hours = (ended_at
 * − started_at) − sum(breaks). Open entries (ended_at = null) count up to
 * "now" for live UI displays but are excluded from finalised payroll.
 */

export type Break = {
  started_at: string; // ISO
  ended_at: string | null; // ISO; null = currently on break
};

export type TimeEntry = {
  id: string;
  user_id: string;
  job_id: string | null;
  started_at: string;
  ended_at: string | null;
  breaks: Break[] | null;
  payroll_line_id?: string | null;
};

/**
 * Hours worked on a single entry. Open entries count up to `now`.
 * Returns 0 if started_at is in the future or breaks make the math negative.
 */
export function entryHours(entry: TimeEntry, now: Date = new Date()): number {
  const start = new Date(entry.started_at).getTime();
  const end = entry.ended_at ? new Date(entry.ended_at).getTime() : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  const grossMs = end - start;
  const breakMs = totalBreakMs(entry.breaks ?? [], now);
  const netMs = Math.max(0, grossMs - breakMs);
  return Math.round((netMs / 3_600_000) * 100) / 100;
}

/** Total break duration in ms; open breaks count up to `now`. */
export function totalBreakMs(breaks: Break[], now: Date = new Date()): number {
  let total = 0;
  for (const b of breaks) {
    const s = new Date(b.started_at).getTime();
    const e = b.ended_at ? new Date(b.ended_at).getTime() : now.getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    total += e - s;
  }
  return total;
}

/** Is the entry currently being worked? */
export function isOpen(entry: TimeEntry): boolean {
  return entry.ended_at === null;
}

/** Is the user on a break right now (open entry, last break is open)? */
export function isOnBreak(entry: TimeEntry): boolean {
  if (!isOpen(entry)) return false;
  const last = (entry.breaks ?? [])[entry.breaks?.length ? entry.breaks.length - 1 : -1];
  return !!last && last.ended_at === null;
}

/**
 * Detect overlap between an entry and a window. Used to:
 *  - sum hours into a payroll period
 *  - block double clock-in
 *
 * Returns the overlapping ms (0 = no overlap).
 */
export function overlapMs(
  entry: { started_at: string; ended_at: string | null },
  windowStart: Date,
  windowEnd: Date,
  now: Date = new Date(),
): number {
  const s = new Date(entry.started_at).getTime();
  const e = entry.ended_at ? new Date(entry.ended_at).getTime() : now.getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  const ws = windowStart.getTime();
  const we = windowEnd.getTime();
  const lo = Math.max(s, ws);
  const hi = Math.min(e, we);
  return Math.max(0, hi - lo);
}

/**
 * Sum hours across many entries inside a [from, to) window.
 * Breaks are deducted proportionally to the in-window fraction.
 */
export function hoursInWindow(
  entries: TimeEntry[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): number {
  let totalMs = 0;
  for (const e of entries) {
    const overlap = overlapMs(e, from, to, now);
    if (overlap === 0) continue;
    const entryStart = new Date(e.started_at).getTime();
    const entryEnd = e.ended_at ? new Date(e.ended_at).getTime() : now.getTime();
    const fullSpan = Math.max(1, entryEnd - entryStart);
    const breaks = totalBreakMs(e.breaks ?? [], now);
    const breakInWindow = breaks * (overlap / fullSpan);
    totalMs += Math.max(0, overlap - breakInWindow);
  }
  return Math.round((totalMs / 3_600_000) * 100) / 100;
}

/** Per-user hours rollup over a [from, to) window. */
export function hoursByUser(
  entries: TimeEntry[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): Map<string, number> {
  const byUser = new Map<string, TimeEntry[]>();
  for (const e of entries) {
    const arr = byUser.get(e.user_id) ?? [];
    arr.push(e);
    byUser.set(e.user_id, arr);
  }
  const out = new Map<string, number>();
  for (const [uid, list] of byUser) {
    out.set(uid, hoursInWindow(list, from, to, now));
  }
  return out;
}

/** Per-job hours rollup — feeds labour cost in profitability. */
export function hoursByJob(
  entries: TimeEntry[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (!e.job_id) continue;
    const overlap = overlapMs(e, from, to, now);
    if (overlap === 0) continue;
    const entryStart = new Date(e.started_at).getTime();
    const entryEnd = e.ended_at ? new Date(e.ended_at).getTime() : now.getTime();
    const fullSpan = Math.max(1, entryEnd - entryStart);
    const breaks = totalBreakMs(e.breaks ?? [], now);
    const breakInWindow = breaks * (overlap / fullSpan);
    const netHours = Math.max(0, overlap - breakInWindow) / 3_600_000;
    out.set(e.job_id, (out.get(e.job_id) ?? 0) + netHours);
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 100) / 100);
  return out;
}

/**
 * Start of the ISO week (Monday) containing `now`, in UTC.
 * UK construction payroll is overwhelmingly Mon–Sun weekly.
 */
export function startOfWeekIso(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
  const day = d.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** First-of-month ISO date for `now`. */
export function startOfMonthIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD ISO date string. */
export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Does a leave-request window cover the day of `instant`?
 * Used to gate clock-in.
 */
export function isWithinLeave(
  instant: Date,
  leave: { starts_at: string; ends_at: string; status: string },
): boolean {
  if (leave.status !== "approved") return false;
  const t = instant.getTime();
  return t >= new Date(leave.starts_at).getTime() && t <= new Date(leave.ends_at).getTime();
}

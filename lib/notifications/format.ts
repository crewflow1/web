/**
 * Pure helpers for the notifications UI — grouping + badge text.
 * Extracted so they're testable without the React component overhead.
 *
 * The relative-time string used to live here too. It now lives in
 * `lib/time/relative.ts` with the six other copies it had drifted from; this
 * module's ladder is preserved there as `RELATIVE_TIME_PRESETS.notification`.
 */

export type NotificationLike = {
  id: string;
  read_at: string | null;
};

export function unreadCount(notifications: NotificationLike[]): number {
  let c = 0;
  for (const n of notifications) if (!n.read_at) c++;
  return c;
}

export function badgeText(count: number): string {
  if (count === 0) return "";
  if (count > 9) return "9+";
  return String(count);
}

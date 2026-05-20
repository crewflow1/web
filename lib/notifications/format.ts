/**
 * Pure helpers for the notifications UI — relative-time string + grouping.
 * Extracted so they're testable without the React component overhead.
 */

export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = now.getTime() - t;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

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

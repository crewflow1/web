/**
 * Pure helpers for the notifications UI — relative-time string + grouping.
 * Extracted so they're testable without the React component overhead.
 */

import { relativeTime as relativeTimeCore } from "@/lib/time/relative";

export function relativeTime(iso: string, now: Date = new Date()): string {
  return relativeTimeCore(iso, { now, precision: "second", overflow: "extend" });
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

/**
 * CrewFlow — Notification email recipient routing (pure).
 *
 * The DECISION half of the notification→email bridge: given a
 * notification's audience, its (optional) opt-in email directive, and the
 * org's email address (already fetched by the caller), decide WHO — if
 * anyone — the email should go to. No I/O, no Supabase, no `server-only`:
 * fully unit-testable in isolation, exactly like the event helpers.
 *
 * The IO half lives in server/services/notifications-service.ts, which
 * fetches `organizations.email`, calls this decider, and hands the result
 * to `queueNotificationEmail`. Keeping the rule here means the "which
 * notifications email, and to whom" policy has ONE authoritative home.
 */

import type {
  NotificationAudience,
  NotificationEmailDirective,
} from "./types";

export type ResolvedEmailRecipient = {
  to: string;
  replyTo: string | null;
};

/**
 * Resolve the email recipient for a single notification.
 *
 * Rules (deny-by-default — never email unless a recipient is positively
 * resolved):
 *   1. No directive              → null (in-app only; historical default).
 *   2. directive.to (non-blank)  → that address, verbatim (explicit wins).
 *   3. customer / both audience  → the org email, when present + non-blank.
 *   4. otherwise (hq audience, or no org email) → null. For HQ-audience
 *      notifications the bridge resolves recipients SEPARATELY through
 *      parseHqRecipients (the configured /admin/settings list) — this
 *      single-recipient resolver never guesses an HQ address.
 *
 * Whitespace-only addresses are treated as absent so a stray " " in
 * `organizations.email` can never become a `to_email`.
 */
export function resolveEmailRecipient(args: {
  directive?: NotificationEmailDirective | null;
  audience: NotificationAudience;
  orgEmail?: string | null;
}): ResolvedEmailRecipient | null {
  const { directive, audience, orgEmail } = args;
  if (!directive) return null;

  const replyTo = normalise(directive.replyTo);

  const explicit = normalise(directive.to);
  if (explicit) return { to: explicit, replyTo };

  if (audience === "customer" || audience === "both") {
    const orgTo = normalise(orgEmail);
    if (orgTo) return { to: orgTo, replyTo };
  }

  return null;
}

function normalise(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// =====================================================================
// HQ-audience routing (settings-truth remediation, 2026-10-19)
// =====================================================================
//
// HQ-audience notifications historically had NO wired email recipient —
// rule 4 above skipped them. The /admin/settings "HQ email recipients" +
// quiet-hours controls existed but were read by nothing. These two pure
// helpers are their real consumers: the bridge in notifications-service
// resolves hq-audience directives through resolveHqEmailRecipients and
// defers deliveries through resolveHqQuietHours.

/** Conservative shape check — the queue's sender does the real validation. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Hard cap so a pathological settings value can never fan out unbounded. */
export const MAX_HQ_RECIPIENTS = 10;

/**
 * Parse the comma-separated `notifications.hq_email_recipients` setting
 * into a deduplicated list of plausible addresses (order preserved,
 * capped at MAX_HQ_RECIPIENTS). Empty / junk input → [] — HQ email
 * stays dark until an operator configures recipients.
 */
export function parseHqRecipients(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const addr = part.trim();
    if (!addr || !EMAIL_SHAPE.test(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
    if (out.length >= MAX_HQ_RECIPIENTS) break;
  }
  return out;
}

export type HqQuietHoursDecision =
  | { send: "now" }
  | { send: "deferred"; scheduledFor: Date };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes-since-midnight of `now` in `timezone`; null when the tz is invalid. */
function minutesOfDayIn(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch {
    return null; // invalid IANA name → treat as "no quiet hours" (fail open to sending)
  }
}

/**
 * Decide whether an HQ email queued at `now` sends immediately or is
 * deferred to the end of the quiet-hours window.
 *
 * Semantics (all pure, DST-approximate on the deferral instant — the
 * target is computed as a minute offset from `now`, which can be off by
 * an hour across a DST transition; acceptable for an internal deferral):
 *   - start === end, or any malformed input → quiet hours disabled.
 *   - The window may wrap midnight (22:00 → 07:00).
 *   - urgent === true AND urgentBypass === true → send now regardless.
 *   - Inside the window otherwise → deferred until the window's end.
 */
export function resolveHqQuietHours(args: {
  now: Date;
  timezone: string;
  quietStart: string;
  quietEnd: string;
  urgent: boolean;
  urgentBypass: boolean;
}): HqQuietHoursDecision {
  const { now, timezone, quietStart, quietEnd, urgent, urgentBypass } = args;
  if (!HHMM.test(quietStart) || !HHMM.test(quietEnd)) return { send: "now" };
  if (quietStart === quietEnd) return { send: "now" };

  const nowMin = minutesOfDayIn(now, timezone);
  if (nowMin === null) return { send: "now" };

  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h as number) * 60 + (m as number);
  };
  const start = toMin(quietStart);
  const end = toMin(quietEnd);

  const inWindow =
    start < end
      ? nowMin >= start && nowMin < end
      : nowMin >= start || nowMin < end; // wraps midnight

  if (!inWindow) return { send: "now" };
  if (urgent && urgentBypass) return { send: "now" };

  // Minutes until the window ends (1..1439), as an offset from `now`.
  const minutesUntilEnd = (end - nowMin + 1440) % 1440 || 1440;
  return {
    send: "deferred",
    scheduledFor: new Date(now.getTime() + minutesUntilEnd * 60_000),
  };
}

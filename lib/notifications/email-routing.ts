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
 *   4. otherwise (hq audience, or no org email) → null (skip — there is no
 *      wired recipient, so we do not guess).
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

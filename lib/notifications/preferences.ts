/**
 * CrewFlow — Notification preference policy (pure).
 *
 * The DECISION half of per-user notification preferences: given a
 * notification's category + priority and the user's stored preference row (or
 * none), decide which channels fire and — for email — whether it goes out
 * immediately or waits for the batched digest. No I/O, no Supabase, no
 * `server-only`: fully unit-testable in isolation, exactly like
 * `email-routing.ts` and the event helpers.
 *
 * The IO half lives in server/services/notification-preferences-service.ts,
 * which reads/writes the rows, and the honoring is wired at two points:
 *   * server/services/notifications-service.ts (the immediate email bridge)
 *     consults `resolveNotificationDelivery` before queueing a per-user email.
 *   * the notifications-digest cron batches everything this function routes to
 *     "digest".
 *
 * DEFAULT-ON, FAIL-OPEN. The absence of a preference row means today's
 * behaviour: in-app on, email immediate. A user only ever opts DOWN from the
 * default, never has to opt in to keep working notifications.
 *
 * CRITICAL ALWAYS SENDS. Money-critical and security categories can NEVER be
 * suppressed or deferred by a preference — a declined card or a security alert
 * always delivers in-app AND by email immediately. This is the hard rule from
 * the standards: "no silent suppression of critical alerts". It is enforced
 * HERE so every caller inherits it, not sprinkled across senders.
 */

import type { NotificationCategory, NotificationPriority } from "./types";

/** Email delivery cadence a user can pick per category. */
export const NOTIFICATION_CADENCES = ["immediate", "daily", "weekly"] as const;
export type NotificationCadence = (typeof NOTIFICATION_CADENCES)[number];

export const NOTIFICATION_CADENCE_LABEL: Record<NotificationCadence, string> = {
  immediate: "As it happens",
  daily: "Daily digest",
  weekly: "Weekly digest",
};

/**
 * The per-(org, user, category) preference row shape (mirror of the table minus
 * DB-managed columns). Server/client-safe.
 */
export type NotificationPreference = {
  org_id: string;
  user_id: string;
  category: string;
  in_app_enabled: boolean;
  email_enabled: boolean;
  email_cadence: NotificationCadence;
  /**
   * Web Push toggle. Default TRUE (opt-down, like email): a push only ever fires
   * for a user who has actually subscribed a device, so the subscription is the
   * real opt-in and this just lets them mute a category.
   */
  push_enabled: boolean;
  /**
   * SMS toggle. Default FALSE (opt-in): SMS is intrusive/costly and its transport
   * is Twilio-gated (dark). The toggle + sender seam exist so activation is a
   * config flip, not a schema change.
   */
  sms_enabled: boolean;
};

/**
 * CRITICAL CATEGORIES — never suppressed, never deferred, whatever the user's
 * preference says. These carry money-critical or security-critical signal the
 * user must see immediately (declined card, payment failure, security event).
 *
 * `alert` (HQ urgent alert rail) and the money categories qualify. Note that
 * ANY notification with priority 'urgent' is ALSO treated as critical below,
 * regardless of category — so a one-off urgent notification in an otherwise
 * mutable category still forces through.
 */
export const CRITICAL_CATEGORIES: ReadonlySet<NotificationCategory> = new Set<
  NotificationCategory
>(["stripe", "billing", "alert"]);

/** True when this (category, priority) must always deliver immediately. */
export function isCriticalNotification(
  category: NotificationCategory | string,
  priority: NotificationPriority | string,
): boolean {
  return (
    priority === "urgent" ||
    CRITICAL_CATEGORIES.has(category as NotificationCategory)
  );
}

/** How email should be delivered for a given notification, post-policy. */
export type EmailDelivery = "immediate" | "digest" | "off";

export type NotificationDelivery = {
  /** Whether the in-app notification row should be shown / counted. */
  inApp: boolean;
  /** Immediate email now, defer to the batched digest, or suppress entirely. */
  email: EmailDelivery;
};

/** The fail-open default when a user has expressed no preference. */
export const DEFAULT_DELIVERY: NotificationDelivery = {
  inApp: true,
  email: "immediate",
};

/**
 * Resolve how a single notification should be delivered to ONE user.
 *
 * Rules, in order:
 *   1. CRITICAL (money/security category, or priority urgent) → force
 *      { inApp: true, email: 'immediate' }. Never suppressed, never deferred —
 *      even an explicit opt-out row is overridden. This is the safety floor.
 *   2. No preference row → DEFAULT_DELIVERY (in-app on, email immediate). Today's
 *      behaviour; a user who never touched settings loses nothing.
 *   3. Otherwise honor the row: `in_app_enabled` gates in-app; `email_enabled`
 *      + `email_cadence` gate email (disabled → 'off'; immediate → 'immediate';
 *      daily/weekly → 'digest').
 */
export function resolveNotificationDelivery(args: {
  category: NotificationCategory | string;
  priority: NotificationPriority | string;
  preference?: NotificationPreference | null;
}): NotificationDelivery {
  const { category, priority, preference } = args;

  // (1) Critical safety floor — overrides everything, including an opt-out.
  if (isCriticalNotification(category, priority)) {
    return { inApp: true, email: "immediate" };
  }

  // (2) No stored preference → today's default behaviour.
  if (!preference) return { ...DEFAULT_DELIVERY };

  // (3) Honor the user's choice.
  const inApp = preference.in_app_enabled;
  let email: EmailDelivery;
  if (!preference.email_enabled) {
    email = "off";
  } else if (preference.email_cadence === "immediate") {
    email = "immediate";
  } else {
    // daily | weekly → the digest cron owns delivery.
    email = "digest";
  }
  return { inApp, email };
}

/**
 * Resolve whether a Web Push should fire for ONE user, per category/priority.
 *
 * Deliberately SEPARATE from `resolveNotificationDelivery` (which owns the
 * in-app + email decision and whose shape a lot of the email/digest code and
 * tests pin) so adding the push channel doesn't perturb that contract. Same
 * critical floor, same fail-open default:
 *   1. CRITICAL (money/security category or urgent priority) → true, always,
 *      overriding an explicit opt-out (the safety floor).
 *   2. No preference row → true (default-on; a push still only fires if the user
 *      has a subscription, so this never spams a user who never opted in).
 *   3. Otherwise honor `push_enabled`.
 *
 * NB this is the ELIGIBILITY decision only; the sender additionally requires
 * VAPID to be configured (else DARK) and at least one subscription to exist.
 */
export function resolvePushDelivery(args: {
  category: NotificationCategory | string;
  priority: NotificationPriority | string;
  preference?: NotificationPreference | null;
}): boolean {
  const { category, priority, preference } = args;
  if (isCriticalNotification(category, priority)) return true;
  if (!preference) return true;
  return preference.push_enabled;
}

/**
 * Resolve whether an SMS should fire for ONE user, per category/priority.
 *
 * Mirrors `resolvePushDelivery` but DEFAULT-OFF (opt-in): SMS is intrusive and
 * costly, so a user with no preference gets none. The critical floor still
 * overrides — a declined-card / security alert is eligible for SMS even from a
 * user who never opted a category in — but the SMS transport itself is dark
 * (Twilio-gated), so this decision is inert until that seam is wired + keyed.
 */
export function resolveSmsDelivery(args: {
  category: NotificationCategory | string;
  priority: NotificationPriority | string;
  preference?: NotificationPreference | null;
}): boolean {
  const { category, priority, preference } = args;
  if (isCriticalNotification(category, priority)) return true;
  if (!preference) return false;
  return preference.sms_enabled;
}

/**
 * Index a flat list of preference rows by category for O(1) per-notification
 * lookup. The senders read one user's rows, then resolve each notification
 * against the map.
 */
export function indexPreferencesByCategory(
  rows: ReadonlyArray<NotificationPreference>,
): Map<string, NotificationPreference> {
  const map = new Map<string, NotificationPreference>();
  for (const r of rows) map.set(r.category, r);
  return map;
}

// =====================================================================
// Digest composition (pure)
// =====================================================================

/** The minimal notification shape the digest formatter needs. */
export type DigestNotification = {
  id: string;
  category: NotificationCategory | string;
  title: string;
  body: string | null;
  priority: NotificationPriority | string;
  action_url: string | null;
  created_at: string;
};

export type DigestEmail = {
  subject: string;
  body_text: string;
  body_html: string;
};

const CATEGORY_HEADING: Record<string, string> = {
  support: "Support",
  billing: "Billing",
  stripe: "Payments",
  onboarding: "Onboarding",
  migration: "Migration",
  demo: "Demos",
  signup: "New customers",
  health: "Health",
  alert: "Alerts",
  system: "System",
  other: "Other",
};

function categoryHeading(category: string): string {
  return CATEGORY_HEADING[category] ?? "Updates";
}

const BASE_URL = "https://crewflow.uk";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Group notifications by category, preserving each notification's relative order
 * within a category and ordering categories by first appearance. Pure.
 */
export function groupDigestByCategory(
  notifications: ReadonlyArray<DigestNotification>,
): Array<{ category: string; items: DigestNotification[] }> {
  const order: string[] = [];
  const buckets = new Map<string, DigestNotification[]>();
  for (const n of notifications) {
    const key = String(n.category);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(n);
  }
  return order.map((category) => ({
    category,
    items: buckets.get(category)!,
  }));
}

/**
 * Compose ONE digest email from a batch of notifications. Deterministic and
 * pure — no clock, no I/O; the caller supplies the batch and cadence label. The
 * body groups notifications under category headings and links each back into the
 * app. Returns null when there is nothing to send (empty batch), so the caller
 * never queues an empty email.
 */
export function buildDigestEmail(input: {
  cadence: "daily" | "weekly";
  notifications: ReadonlyArray<DigestNotification>;
  recipientName?: string | null;
}): DigestEmail | null {
  const { cadence, notifications, recipientName } = input;
  if (notifications.length === 0) return null;

  const count = notifications.length;
  const cadenceWord = cadence === "daily" ? "daily" : "weekly";
  const subject =
    count === 1
      ? `Your CrewFlow ${cadenceWord} digest — 1 notification`
      : `Your CrewFlow ${cadenceWord} digest — ${count} notifications`;

  const groups = groupDigestByCategory(notifications);
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";

  // ---- plain text ----
  const textParts: string[] = [];
  textParts.push(greeting);
  textParts.push(
    `Here's your ${cadenceWord} summary — ${count} ${count === 1 ? "notification" : "notifications"} since your last digest.`,
  );
  for (const g of groups) {
    textParts.push(`\n${categoryHeading(g.category)}`);
    for (const n of g.items) {
      const line = n.body ? `${n.title} — ${n.body}` : n.title;
      textParts.push(`  • ${line}`);
      if (n.action_url) textParts.push(`    ${BASE_URL}${n.action_url}`);
    }
  }
  textParts.push(
    `\n\n— CrewFlow\nSee everything: ${BASE_URL}/notifications\nChange how often you're emailed: ${BASE_URL}/settings`,
  );
  const body_text = textParts.join("\n");

  // ---- html ----
  const htmlSections = groups
    .map((g) => {
      const items = g.items
        .map((n) => {
          const titleHtml = n.action_url
            ? `<a href="${BASE_URL}${escapeHtml(n.action_url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${escapeHtml(n.title)}</a>`
            : `<span style="font-weight:600">${escapeHtml(n.title)}</span>`;
          const bodyHtml = n.body
            ? `<div style="color:#475569;margin-top:2px">${escapeHtml(n.body)}</div>`
            : "";
          return `<li style="margin:0 0 10px 0;list-style:none">${titleHtml}${bodyHtml}</li>`;
        })
        .join("");
      return `<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:20px 0 8px 0">${escapeHtml(categoryHeading(g.category))}</h3><ul style="margin:0;padding:0">${items}</ul>`;
    })
    .join("");

  const body_html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55;max-width:600px">
<p style="margin:0 0 4px 0">${escapeHtml(greeting)}</p>
<p style="margin:0 0 4px 0;color:#475569">Here's your ${cadenceWord} summary — ${count} ${count === 1 ? "notification" : "notifications"} since your last digest.</p>
${htmlSections}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px 0">
<p style="font-size:12px;color:#94a3b8;margin:0">
<a href="${BASE_URL}/notifications" style="color:#64748b">See everything</a> ·
<a href="${BASE_URL}/settings" style="color:#64748b">Change how often you're emailed</a>
</p>
</div>`;

  return { subject, body_text, body_html };
}

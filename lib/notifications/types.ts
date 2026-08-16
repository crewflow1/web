/**
 * CrewFlow — Notifications OS shared types (HQ-8).
 *
 * Server/client-safe. No Supabase imports. The DB service layer
 * (server/services/notifications-service.ts) converts to/from these.
 */

export const NOTIFICATION_AUDIENCES = ["customer", "hq", "both"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_PRIORITIES = [
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_CATEGORIES = [
  "support",
  "billing",
  "stripe",
  "onboarding",
  "migration",
  "demo",
  "signup",
  "health",
  "alert",
  "system",
  "other",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_PRIORITY_LABEL: Record<NotificationPriority, string> =
  {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
  };

export const NOTIFICATION_PRIORITY_PILL: Record<NotificationPriority, string> =
  {
    low: "bg-slate-100 text-slate-700 border-slate-200",
    medium: "bg-blue-100 text-blue-900 border-blue-200",
    high: "bg-amber-100 text-amber-900 border-amber-200",
    urgent: "bg-red-100 text-red-800 border-red-200",
  };

export const NOTIFICATION_PRIORITY_RANK: Record<NotificationPriority, number> =
  {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationCategory, string> =
  {
    support: "Support",
    billing: "Billing",
    stripe: "Payment",
    onboarding: "Onboarding",
    migration: "Migration",
    demo: "Demo",
    signup: "New customer",
    health: "Health",
    alert: "Alert",
    system: "System",
    other: "Other",
  };

/**
 * L1 — derive a sensible display category from a notification's `type`
 * when the stored category is the catch-all default ("other").
 *
 * Background: in-app invoice/payment notifications are written by the
 * `_tg_activity_log_notify` DB trigger, which fans `activity_log` rows
 * (type = e.g. "invoice.paid", "payment.recorded") into `notifications`
 * but never sets `category` — so the column default 'other' sticks and
 * the feed showed every invoice/payment event under "Other".
 *
 * We can't widen the DB `category` CHECK constraint without a migration
 * (and migrations aren't applied by CI / previews are DB-less), so we map
 * onto the existing categories at READ time instead of writing new values:
 *   - money-received events  → "stripe"  (renders as "Payment")
 *   - invoice-lifecycle events → "billing" (renders as "Billing")
 * An explicitly-categorised notification (anything other than "other")
 * always wins — this only fills the gap left by the trigger. Because the
 * trigger writes audience='customer', this only affects the customer feed;
 * real Stripe/billing rows are stored with their own category, untouched.
 */
export function notificationCategoryForType(
  type: string,
  stored: NotificationCategory,
): NotificationCategory {
  if (stored !== "other") return stored;
  if (
    type === "payment.recorded" ||
    type === "invoice.paid" ||
    type === "invoice.payment_failed" ||
    type === "invoice.payment_action_required" ||
    type.startsWith("bank.")
  ) {
    return "stripe"; // label: "Payment"
  }
  if (type.startsWith("invoice.")) {
    return "billing"; // label: "Billing"
  }
  return stored;
}

/**
 * A stored Web Push subscription (mirror of public.push_subscriptions minus
 * DB-managed columns). Server/client-safe.
 */
export type PushSubscriptionRecord = {
  org_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string | null;
};

/**
 * The JSON payload delivered to the service worker's `push` handler. Kept small
 * and free of any private body the user hasn't already been shown in-app — the
 * title/body mirror the notification row, and `url` deep-links back into the app.
 */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  category: NotificationCategory;
};

const PUSH_FALLBACK_URL = "/notifications";

/**
 * Build the service-worker push payload from a notification row. Pure — no I/O.
 * `action_url` is used as the deep link when present (relative in-app path),
 * otherwise the notifications centre. `tag` coalesces repeat pushes for the same
 * source so a burst doesn't stack duplicate OS notifications.
 */
export function buildPushPayload(n: {
  id: string;
  title: string;
  body?: string | null;
  action_url?: string | null;
  category: NotificationCategory;
  source_module?: string | null;
  source_id?: string | null;
}): PushPayload {
  const rawUrl = typeof n.action_url === "string" ? n.action_url.trim() : "";
  // Only accept a same-origin RELATIVE path as the deep link — never an absolute
  // URL from stored data, so a poisoned action_url can't redirect the click off
  // to another origin when the SW opens it.
  const url = rawUrl.startsWith("/") && !rawUrl.startsWith("//")
    ? rawUrl
    : PUSH_FALLBACK_URL;
  const tag =
    n.source_module && n.source_id
      ? `${n.source_module}:${n.source_id}`
      : `notification:${n.id}`;
  return {
    title: n.title || "CrewFlow",
    body: (n.body ?? "").toString(),
    url,
    tag,
    category: n.category,
  };
}

export type NotificationRow = {
  id: string;
  org_id: string;
  user_id: string | null;
  audience: NotificationAudience;
  type: string;
  category: NotificationCategory;
  title: string;
  body: string | null;
  priority: NotificationPriority;
  source_module: string | null;
  source_id: string | null;
  action_url: string | null;
  read_at: string | null;
  dismissed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/**
 * Opt-in email delivery directive attached to a notification we're about
 * to create. PRESENCE of this field means "also deliver this notification
 * by email"; its ABSENCE means in-app only — the historical default. No
 * email is ever queued for a notification that does not carry this field,
 * so wiring it in is deliberate and per-notification (never a firehose).
 *
 * Recipient resolution (see `resolveEmailRecipient` in email-routing.ts):
 *   - `to` set        → that exact address, verbatim.
 *   - `to` omitted     → resolved from the audience (customer/both → the
 *                         org's `organizations.email`). HQ-audience email
 *                         has no wired recipient yet, so an hq-only
 *                         notification without an explicit `to` is skipped.
 */
export type NotificationEmailDirective = {
  /** Explicit recipient override. When omitted, resolved from audience. */
  to?: string | null;
  /** Reply-to for the dispatched email. Defaults to the system address. */
  replyTo?: string | null;
};

/**
 * Shape of a notification we're about to create. Mirror of the row
 * shape minus DB-managed columns. `user_id = null` = org-wide.
 *
 * `email` is NOT persisted on the notification row — it is a transient
 * delivery instruction consumed by `emitNotifications` to also queue an
 * email through the existing notification_email_queue → drain → Resend
 * pipeline. Callers that don't set it get today's in-app-only behaviour.
 */
export type NotificationCreate = {
  org_id: string;
  user_id: string | null;
  audience: NotificationAudience;
  type: string;
  category: NotificationCategory;
  title: string;
  body?: string | null;
  priority: NotificationPriority;
  source_module?: string | null;
  source_id?: string | null;
  action_url?: string | null;
  metadata?: Record<string, unknown>;
  email?: NotificationEmailDirective;
};

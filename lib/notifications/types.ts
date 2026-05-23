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
 * Shape of a notification we're about to create. Mirror of the row
 * shape minus DB-managed columns. `user_id = null` = org-wide.
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
};

/**
 * CrewFlow HQ — settings module.
 *
 * Pure, no Supabase imports, no `server-only`. Importable from
 * client components so the page + the server can share the same
 * schemas + defaults.
 *
 * Storage shape (in the singleton row's `data` JSONB):
 *   {
 *     general: GeneralSettings,
 *     notifications: NotificationSettings,
 *     alerts: AlertSettings,
 *     billing: BillingSettings,
 *     support: SupportSettings,
 *     integrations: IntegrationsSettings,
 *     feature_flags: FeatureFlagSettings
 *   }
 *
 * THE TRUTHFULNESS RULE (settings-truth remediation, 2026-10-19):
 * every field in these schemas has a REAL consumer outside the settings
 * surface, and its form hint names that consumer. The 2026-10-19 audit
 * found 7 working forms persisting 17 fields that NOTHING read, under
 * descriptions promising effects ("surface on customer-facing pages",
 * "tune the alert engine") — a phantom control panel. Each field was
 * reconciled against reality: the ones with a genuine, small wiring step
 * were wired (HQ alert emails + quiet hours, invoice due-date prefill,
 * support reply signature); the rest were RETIRED — form field, schema
 * entry and defaults removed. Do not add a field here without its
 * consumer landing in the same change.
 *
 * Retired keys (platform_name, support_email, ops_slack_url,
 * daily_digest_enabled, cooldown_hours, default_snooze_hours,
 * default_setup_fee_gbp, default_invoice_footer, the whole `branding`
 * section, auto_close_days, escalation_email, *_connected toggles) may
 * still exist in stored JSONB — mergeSettings simply ignores unknown
 * keys, and the raw-first upsert in server/services/hq-settings.ts
 * preserves them byte-for-byte (the #865 blob-preservation invariant).
 * NEVER migrate or delete the stored data.
 *
 * Adding a new section:
 *   1. Add it to SECTION_IDS + Section types below.
 *   2. Define its schema + defaults.
 *   3. Register in SECTION_SCHEMAS / SECTION_DEFAULTS / SECTION_LABEL.
 *   4. Add a save action in app/admin/settings/actions.ts.
 *   5. Render a form section in the page.
 *   6. Land the field's real consumer in the same change (see above).
 *
 * No migration required — JSONB absorbs new keys.
 */

import { z } from "zod";

// =====================================================================
// Section identifiers — exhaustive
// =====================================================================

export const SECTION_IDS = [
  "general",
  "notifications",
  "alerts",
  "billing",
  "support",
  "integrations",
  "feature_flags",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_LABEL: Record<SectionId, string> = {
  general: "General",
  notifications: "HQ email & quiet hours",
  alerts: "Alert preferences",
  billing: "Billing defaults",
  support: "Support",
  integrations: "Integrations",
  feature_flags: "Feature flags",
};

export const SECTION_BLURB: Record<SectionId, string> = {
  general:
    "HQ-wide defaults. The timezone governs the quiet-hours window in the HQ email section below.",
  notifications:
    "Where HQ notification emails go. Today the only HQ email is the critical-alert fire from the nightly alerts poll; quiet hours defer non-urgent HQ email until the window ends.",
  alerts:
    "Extra email copy for the deterministic alert engine — an optional additional recipient on every critical alert fire.",
  billing:
    "Pre-fills applied when an operator records a new invoice on /admin/billing. Existing invoices are untouched.",
  support:
    "Pre-filled signature for the reply box on /admin/support tickets. Visible and editable before every send.",
  integrations:
    "Read-only reflection of what THIS deploy can actually send (build + env facts — connection edits live in Vercel), plus free-form operator notes.",
  feature_flags:
    "Read-only truth panel. Production feature flags live in Vercel env (NEXT_PUBLIC_FEATURE_* / FEATURE_*) — a toggle here could not reach them, so none is offered.",
};

// =====================================================================
// Section schemas
// =====================================================================

// Consumer: the quiet-hours evaluation in the notification→email bridge
// (lib/notifications/email-routing.ts) interprets quiet_hours_* in THIS
// timezone.
export const generalSchema = z.object({
  timezone: z.string().trim().min(1).max(60).default("Europe/London"),
});

// Consumers: resolveHqEmailRecipients + resolveHqQuietHours in
// lib/notifications/email-routing.ts, called from the notification→email
// bridge (server/services/notifications-service.ts) for hq-audience
// notifications that carry an email directive.
export const notificationSchema = z.object({
  hq_email_recipients: z
    .string()
    .trim()
    .max(2000)
    // Comma-separated list of operator emails. Empty string = nobody —
    // HQ email stays dark until an operator sets recipients.
    .default(""),
  quiet_hours_start: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM")
    .default("22:00"),
  quiet_hours_end: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM")
    .default("07:00"),
  send_during_quiet_hours_for_urgent: z.boolean().default(true),
});

// Consumer: the notification→email bridge adds this address as an extra
// recipient on urgent alert-category HQ emails (the critical alert fires
// emitted by server/services/hq-alerts-scheduler.ts).
export const alertSchema = z.object({
  critical_cc_email: z
    .string()
    .trim()
    .email()
    .or(z.literal(""))
    .default(""),
});

// Consumer: app/admin/billing/page.tsx pre-fills the "Record invoice"
// due-date input with today + N days.
export const billingSchema = z.object({
  default_invoice_due_days: z.coerce
    .number()
    .int()
    .min(0)
    .max(180)
    .default(30),
});

// Consumer: app/admin/support/[id]/page.tsx passes this to the reply
// form as the textarea's initial content (operator sees + can edit it).
export const supportSchema = z.object({
  default_reply_signature: z
    .string()
    .trim()
    .max(2000)
    .default("— The CrewFlow team"),
});

// The three *_connected toggles that used to live here were a FALSE status
// panel: hand-flipped booleans persisted to JSONB and read by nothing, under
// a blurb claiming they reflected env vars. The page now renders the REAL
// provider readiness (lib/comms/readiness.ts + env presence), read-only.
// Only the free-form operator notepad remains writable.
export const integrationsSchema = z.object({
  notes: z.string().trim().max(2000).default(""),
});

// The three JSONB toggles that used to live here (enable_ai_coo,
// enable_whatsapp_outbound, enable_self_service_billing) were a FALSE control
// panel: persisted, rendered as switches, and read by NOTHING — the real
// gates are Vercel env flags. Removed by the live-activation programme;
// `.passthrough()`-free parse simply ignores any historic stored values.
export const featureFlagsSchema = z.object({});

// =====================================================================
// Combined schema + defaults
// =====================================================================

export const settingsSchema = z.object({
  general: generalSchema,
  notifications: notificationSchema,
  alerts: alertSchema,
  billing: billingSchema,
  support: supportSchema,
  integrations: integrationsSchema,
  feature_flags: featureFlagsSchema,
});

export type GeneralSettings = z.infer<typeof generalSchema>;
export type NotificationSettings = z.infer<typeof notificationSchema>;
export type AlertSettings = z.infer<typeof alertSchema>;
export type BillingSettings = z.infer<typeof billingSchema>;
export type SupportSettings = z.infer<typeof supportSchema>;
export type IntegrationsSettings = z.infer<typeof integrationsSchema>;
export type FeatureFlagSettings = z.infer<typeof featureFlagsSchema>;

export type HqSettings = z.infer<typeof settingsSchema>;

export const SECTION_SCHEMAS = {
  general: generalSchema,
  notifications: notificationSchema,
  alerts: alertSchema,
  billing: billingSchema,
  support: supportSchema,
  integrations: integrationsSchema,
  feature_flags: featureFlagsSchema,
} as const;

/**
 * Default settings — every section's `.default()` chained through
 * zod. Used as the seed when the singleton row has an empty `data`
 * blob, and as the rendering fallback on first paint.
 */
export const DEFAULT_SETTINGS: HqSettings = settingsSchema.parse({
  general: {},
  notifications: {},
  alerts: {},
  billing: {},
  support: {},
  integrations: {},
  feature_flags: {},
});

/**
 * Merge a partial DB blob into the defaults so partial / missing
 * keys are tolerated. Always returns a fully-populated HqSettings.
 *
 * Unknown top-level sections AND unknown keys inside a known section
 * (e.g. the retired fields listed in the header) are ignored, never
 * an error — zod's non-strict object parse strips them. The stored
 * blob itself is never rewritten here (reads are non-destructive).
 */
export function mergeSettings(
  raw: unknown,
): HqSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const draft = raw as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const section of SECTION_IDS) {
    const schema = SECTION_SCHEMAS[section];
    const parsed = schema.safeParse({
      ...(DEFAULT_SETTINGS[section] as Record<string, unknown>),
      ...((draft[section] as Record<string, unknown>) ?? {}),
    });
    merged[section] = parsed.success
      ? parsed.data
      : DEFAULT_SETTINGS[section];
  }
  return merged as HqSettings;
}

/**
 * Diff helper — returns the keys that changed between two settings
 * sections. Drives the audit-log metadata payload.
 */
export function diffSection<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { keys: string[]; before: Partial<T>; after: Partial<T> } {
  const keys: string[] = [];
  const beforeDiff: Partial<T> = {};
  const afterDiff: Partial<T> = {};
  const allKeys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const k of allKeys) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) {
      keys.push(k);
      (beforeDiff as Record<string, unknown>)[k] = before?.[k];
      (afterDiff as Record<string, unknown>)[k] = after?.[k];
    }
  }
  return { keys, before: beforeDiff, after: afterDiff };
}

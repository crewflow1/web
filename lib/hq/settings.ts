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
 *     branding: BrandingSettings,
 *     support: SupportSettings,
 *     integrations: IntegrationsSettings,
 *     feature_flags: FeatureFlagSettings
 *   }
 *
 * Adding a new section:
 *   1. Add it to SECTION_IDS + Section types below.
 *   2. Define its schema + defaults.
 *   3. Register in SECTION_SCHEMAS / SECTION_DEFAULTS / SECTION_LABEL.
 *   4. Add a save action in app/admin/settings/actions.ts.
 *   5. Render a form section in the page.
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
  "branding",
  "support",
  "integrations",
  "feature_flags",
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const SECTION_LABEL: Record<SectionId, string> = {
  general: "General",
  notifications: "Notification preferences",
  alerts: "Alert preferences",
  billing: "Billing defaults",
  branding: "Branding",
  support: "Support",
  integrations: "Integrations",
  feature_flags: "Feature flags",
};

export const SECTION_BLURB: Record<SectionId, string> = {
  general:
    "Platform-level identity. The values you put here surface on customer-facing pages and HQ headers.",
  notifications:
    "Which events fire an HQ email + when the team is quiet. Customer-side prefs live in their own settings page.",
  alerts:
    "Tune the deterministic alert engine — cooldown between re-fires, snooze defaults, who gets a copy of urgent fires.",
  billing:
    "Defaults applied when an operator creates a new invoice without overrides. Existing invoices are untouched.",
  branding:
    "Customer-facing branding on PDFs, public quote pages, and operator-managed emails.",
  support:
    "Default support behaviour — signature, auto-close timer, escalation contact.",
  integrations:
    "Which third-party providers are wired in. Read-only reflection of env vars — connection edits live in Vercel.",
  feature_flags:
    "Read-only truth panel. Production feature flags live in Vercel env (NEXT_PUBLIC_FEATURE_* / FEATURE_*) — a toggle here could not reach them, so none is offered.",
};

// =====================================================================
// Section schemas
// =====================================================================

export const generalSchema = z.object({
  platform_name: z.string().trim().min(1).max(120).default("CrewFlow"),
  support_email: z
    .string()
    .trim()
    .email()
    .default("support@crewflow.uk"),
  ops_slack_url: z
    .string()
    .trim()
    .url()
    .or(z.literal(""))
    .default(""),
  timezone: z.string().trim().min(1).max(60).default("Europe/London"),
});

export const notificationSchema = z.object({
  hq_email_recipients: z
    .string()
    .trim()
    .max(2000)
    // Comma-separated list of operator emails. Empty string = nobody.
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
  daily_digest_enabled: z.boolean().default(false),
});

export const alertSchema = z.object({
  cooldown_hours: z.coerce.number().int().min(0).max(168).default(24),
  default_snooze_hours: z.coerce.number().int().min(1).max(168).default(24),
  critical_cc_email: z
    .string()
    .trim()
    .email()
    .or(z.literal(""))
    .default(""),
});

export const billingSchema = z.object({
  default_invoice_due_days: z.coerce
    .number()
    .int()
    .min(0)
    .max(180)
    .default(30),
  default_setup_fee_gbp: z.coerce
    .number()
    .min(0)
    .max(100000)
    .default(1000),
  default_invoice_footer: z
    .string()
    .trim()
    .max(2000)
    .default("Thank you for your business."),
});

export const brandingSchema = z.object({
  logo_url: z
    .string()
    .trim()
    .url()
    .or(z.literal(""))
    .default(""),
  primary_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Hex like #1a2b3c")
    .default("#0f172a"),
  pdf_footer: z
    .string()
    .trim()
    .max(500)
    .default(""),
});

export const supportSchema = z.object({
  default_reply_signature: z
    .string()
    .trim()
    .max(2000)
    .default("— The CrewFlow team"),
  auto_close_days: z.coerce.number().int().min(0).max(180).default(14),
  escalation_email: z
    .string()
    .trim()
    .email()
    .or(z.literal(""))
    .default(""),
});

export const integrationsSchema = z.object({
  stripe_connected: z.boolean().default(false),
  resend_connected: z.boolean().default(false),
  whatsapp_connected: z.boolean().default(false),
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
  branding: brandingSchema,
  support: supportSchema,
  integrations: integrationsSchema,
  feature_flags: featureFlagsSchema,
});

export type GeneralSettings = z.infer<typeof generalSchema>;
export type NotificationSettings = z.infer<typeof notificationSchema>;
export type AlertSettings = z.infer<typeof alertSchema>;
export type BillingSettings = z.infer<typeof billingSchema>;
export type BrandingSettings = z.infer<typeof brandingSchema>;
export type SupportSettings = z.infer<typeof supportSchema>;
export type IntegrationsSettings = z.infer<typeof integrationsSchema>;
export type FeatureFlagSettings = z.infer<typeof featureFlagsSchema>;

export type HqSettings = z.infer<typeof settingsSchema>;

export const SECTION_SCHEMAS = {
  general: generalSchema,
  notifications: notificationSchema,
  alerts: alertSchema,
  billing: billingSchema,
  branding: brandingSchema,
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
  branding: {},
  support: {},
  integrations: {},
  feature_flags: {},
});

/**
 * Merge a partial DB blob into the defaults so partial / missing
 * keys are tolerated. Always returns a fully-populated HqSettings.
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

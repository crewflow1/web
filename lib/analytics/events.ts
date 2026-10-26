/**
 * CrewFlow product-analytics event taxonomy + privacy-safe capture.
 *
 * The ONE place event names and their allowed properties are defined. Every
 * product-analytics `capture` must go through {@link trackEvent} so that:
 *
 *   1. event names are a closed, typed set (no ad-hoc strings drifting in);
 *   2. properties are B2B / ORGANISATION-first and PRIVACY-SANITISED before
 *      they can leave the browser — no customer PII, no free text, no money
 *      amounts, no secrets (see {@link sanitizeEventProperties});
 *   3. nothing is ever sent unless the consent-gated loader
 *      (`lib/analytics/load.ts`) has registered a sink — so this inherits the
 *      "no analytics before consent" guarantee for free and NEVER throws.
 *
 * This module imports no provider SDK; `load.ts` injects the capture sink after
 * PostHog initialises, so `posthog-js` stays out of the path (and the bundle)
 * for users who have not opted in. Pure + testable: tests inject a fake sink.
 *
 * Modelling note: CrewFlow is B2B. Analytics are modelled at the ORGANISATION
 * level (pseudonymous `org_id`), not consumer-style individual vanity metrics.
 */

// ---------------------------------------------------------------------------
// Event taxonomy — every event answers a real product question.
// ---------------------------------------------------------------------------

export const ANALYTICS_EVENTS = {
  // Acquisition
  SIGNUP_STARTED: "signup_started",
  SIGNUP_COMPLETED: "signup_completed",
  ORGANISATION_CREATED: "organisation_created",
  // Activation (first-value milestones)
  ONBOARDING_STARTED: "onboarding_started",
  ONBOARDING_COMPLETED: "onboarding_completed",
  FIRST_CUSTOMER_CREATED: "first_customer_created",
  FIRST_JOB_CREATED: "first_job_created",
  FIRST_QUOTE_CREATED: "first_quote_created",
  FIRST_INVOICE_CREATED: "first_invoice_created",
  FIRST_STAFF_ADDED: "first_staff_added",
  // Engagement
  CUSTOMER_CREATED: "customer_created",
  LEAD_CREATED: "lead_created",
  JOB_CREATED: "job_created",
  JOB_UPDATED: "job_updated",
  QUOTE_CREATED: "quote_created",
  QUOTE_SENT: "quote_sent",
  QUOTE_ACCEPTED: "quote_accepted",
  INVOICE_CREATED: "invoice_created",
  INVOICE_SENT: "invoice_sent",
  PAYMENT_RECORDED: "payment_recorded",
  STAFF_ADDED: "staff_added",
  TIMESHEET_SUBMITTED: "timesheet_submitted",
  CUSTOMER_PORTAL_OPENED: "customer_portal_opened",
  // AI (capability inside the system — see Design Constitution §6)
  AI_INSIGHT_VIEWED: "ai_insight_viewed",
  AI_DRAFT_CREATED: "ai_draft_created",
  AI_DRAFT_APPROVED: "ai_draft_approved",
  AI_DRAFT_REJECTED: "ai_draft_rejected",
  AI_ACTION_APPLIED: "ai_action_applied",
  AI_GOVERNOR_REJECTED: "ai_governor_rejected",
  // Approval (human-in-the-loop gate)
  APPROVAL_REQUESTED: "approval_requested",
  APPROVAL_COMPLETED: "approval_completed",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

const EVENT_NAME_SET: ReadonlySet<string> = new Set(Object.values(ANALYTICS_EVENTS));

export function isAnalyticsEvent(name: string): name is AnalyticsEventName {
  return EVENT_NAME_SET.has(name);
}

// ---------------------------------------------------------------------------
// Privacy allowlist / denylist.
// ---------------------------------------------------------------------------

/**
 * Property values may only be primitives (string / number / boolean). Objects,
 * arrays and functions are dropped — they are the usual carriers of accidental
 * PII (a whole customer row, a notes blob). Prefer booleans, counts, buckets,
 * stages, role types and the pseudonymous `org_id`.
 */
export type SafePropertyValue = string | number | boolean;
export type SafeEventProperties = Record<string, SafePropertyValue>;

/**
 * Substrings that mark a property KEY as prohibited, matched case-insensitively.
 * Deliberately broad — a key containing any of these is dropped entirely rather
 * than risk shipping customer names, contact details, free text, money text or
 * secrets to a third party. Never send: customer/contact identity, addresses,
 * free text (notes/description/content/message/subject/body), raw money values,
 * tokens/secrets/passwords/keys, raw emails/phones.
 */
export const PROHIBITED_KEY_SUBSTRINGS: readonly string[] = [
  "name",
  "email",
  "phone",
  "mobile",
  "address",
  "postcode",
  "note",
  "description",
  "content",
  "message",
  "subject",
  "body",
  "text",
  "amount",
  "total",
  "price",
  "value",
  "balance",
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "key",
  "auth",
  "ssn",
  "dob",
  "iban",
  "sortcode",
  "account_number",
];

/** True when a property key must never be sent. */
export function isProhibitedKey(key: string): boolean {
  const k = key.toLowerCase();
  return PROHIBITED_KEY_SUBSTRINGS.some((bad) => k.includes(bad));
}

/** Cap stored string length — a long string is a free-text smell. */
const MAX_STRING_LENGTH = 64;

/**
 * Strip a properties object down to what is safe to send: drop prohibited keys,
 * drop non-primitive values, drop over-long strings. Returns a new object; never
 * throws. (Prefer BUCKETS over raw numbers for anything sensitive upstream — this
 * is the last line of defence, not an excuse to pass raw data.)
 */
export function sanitizeEventProperties(
  props: Record<string, unknown> | undefined,
): SafeEventProperties {
  const out: SafeEventProperties = {};
  if (!props || typeof props !== "object") return out;
  for (const [key, value] of Object.entries(props)) {
    if (isProhibitedKey(key)) continue;
    if (typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "string") {
      if (value.length === 0 || value.length > MAX_STRING_LENGTH) continue;
      out[key] = value;
    }
    // objects / arrays / functions / null / undefined are intentionally dropped.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capture sink (injected by the consent-gated loader).
// ---------------------------------------------------------------------------

export type AnalyticsSink = (
  event: AnalyticsEventName,
  properties: SafeEventProperties,
) => void;

let sink: AnalyticsSink | null = null;

/**
 * Registered by `lib/analytics/load.ts` AFTER PostHog initialises (which only
 * happens once configured + consent granted). Passing `null` detaches it.
 */
export function setAnalyticsSink(next: AnalyticsSink | null): void {
  sink = next;
}

/**
 * The only way to record a product-analytics event. Validates the name,
 * sanitises the properties, and forwards to the sink IF one is registered —
 * otherwise a silent no-op. Never throws: analytics must never break a flow.
 */
export function trackEvent(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  try {
    if (!isAnalyticsEvent(event)) return;
    if (!sink) return;
    sink(event, sanitizeEventProperties(properties));
  } catch {
    // swallow — a telemetry failure must never surface to the user.
  }
}

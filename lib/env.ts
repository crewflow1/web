/**
 * Environment variable validation.
 *
 * Imported once at module load — the app refuses to start if a required
 * variable is missing or malformed, so a misconfigured deploy fails fast
 * at build/boot instead of mysteriously at runtime.
 *
 * Variables that aren't strictly required for the current feature set are
 * marked optional. Tighten them as features land.
 */

import { z } from "zod";

const envSchema = z.object({
  // -- App ----------------------------------------------------------------
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_APP_NAME: z.string().default("CrewFlow"),
  APP_ENV: z.enum(["development", "preview", "production"]).default("development"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // -- Supabase -----------------------------------------------------------
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // -- Twilio + Vapi (required when telephony code runs) ------------------
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  // The outbound SMS sender — the Twilio phone number (E.164) or Messaging
  // Service SID that missed-call text-backs are sent FROM. Optional at boot;
  // its absence (even with the account creds present) is what makes the SMS
  // provider seam return null, so CI sends nothing. (Directive #018 R5.)
  TWILIO_SMS_FROM: z.string().optional(),
  // The PUBLIC status-callback URL Twilio is configured to POST delivery receipts to
  // (Directive #018 R7). Twilio signs THIS exact URL, so when set it is the canonical
  // value the webhook verifies the X-Twilio-Signature against — authoritative behind a
  // proxy that rewrites host/proto. Optional: absent, the route reconstructs the URL
  // from the forwarded request headers. Not a secret; carries no credential.
  TWILIO_STATUS_CALLBACK_URL: z.string().optional(),
  VAPI_API_KEY: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),

  // -- AI models ----------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // -- Shared Memory embeddings (Directive 009 M1 PR4) --------------------
  // Names the active embedding vendor for semantic recall. Default "openai"
  // (text-embedding-3-small). The vendor's own key (e.g. OPENAI_API_KEY)
  // gates it: unset key OR an unknown name → semantic search is simply off
  // and every other recall channel keeps working. Switching providers is
  // configuration only — no application code changes. Left as a free string
  // (not an enum) so a new provider needs zero env-schema edits.
  MEMORY_EMBEDDING_PROVIDER: z.string().optional(),

  // -- Shared Memory text generation (Directive 009 M1 PR5) --------------
  // Names the active LLM vendor for the lifecycle reducers (summarisation,
  // consolidation refinement). Default "auto": prefer Anthropic (Haiku) when
  // ANTHROPIC_API_KEY is set, else OpenAI when OPENAI_API_KEY is set, else
  // off. As with embeddings this is a PLUG-IN, never a dependency: with no
  // provider the worker leaves the deterministic SQL digest/summary in place
  // and every other lifecycle reducer keeps running. Switching providers is
  // configuration only — no application code changes. Free string (not an
  // enum) so a new provider needs zero env-schema edits.
  MEMORY_TEXT_PROVIDER: z.string().optional(),

  // -- Email --------------------------------------------------------------
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default("CrewFlow <hello@crewflow.uk>"),
  RESEND_REPLY_TO: z.string().default("hello@crewflow.uk"),

  // -- Communication Layer provider (Directive 010 Phase 4) ---------------
  // Names the active outbound email provider for the Communication Layer.
  // Default "auto": use Resend when RESEND_API_KEY is set, else off. As with
  // the text/embedding seams this is a PLUG-IN, never a dependency: with no
  // provider configured `deliverDraft` records a terminal `failed`/no_provider
  // attempt and SENDS NOTHING — the path CI exercises. Switching providers is
  // configuration only — no application code changes. Free string (not an enum)
  // so a new provider needs zero env-schema edits.
  COMMS_EMAIL_PROVIDER: z.string().optional(),

  // -- Communication Layer: SMS provider (Directive #018 R5) --------------
  // Names the active outbound SMS provider for the receptionist's first
  // outbound transport (missed-call text-back). Default "auto": use Twilio when
  // its account creds AND a sender (TWILIO_SMS_FROM) are all set, else off.
  // Identical PLUG-IN doctrine to the email seam: with no provider configured
  // the transport records a terminal `failed`/no_provider attempt and SENDS
  // NOTHING — the path CI exercises. Free string (not an enum) so a new provider
  // needs zero env-schema edits.
  COMMS_SMS_PROVIDER: z.string().optional(),

  // -- Stripe -------------------------------------------------------------
  // Optional at boot — the app starts without Stripe configured. The
  // webhook + checkout routes return 503 with a clear error when these
  // aren't set, so a half-configured environment fails loudly rather
  // than processing payments silently against the wrong account.
  //
  // STRIPE_SECRET_KEY            — Restricted key (Customers/
  //                                Subscriptions/Invoices/Payment
  //                                Intents/Checkout write; Prices/
  //                                Webhooks read).
  // STRIPE_WEBHOOK_SECRET        — Endpoint signing secret (whsec_...).
  // NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — Browser-safe key. Unused today
  //                                (Checkout is fully hosted), reserved
  //                                for a future Payment Element flow.
  // STRIPE_SETUP_PRICE_ID        — Optional. If unset, the integration
  //                                auto-discovers the one-off £1,000
  //                                price by amount + currency match.
  // STRIPE_SUBSCRIPTION_PRICE_ID — Same, for the £500/mo recurring.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_SETUP_PRICE_ID: z.string().optional(),
  STRIPE_SUBSCRIPTION_PRICE_ID: z.string().optional(),

  // -- Inngest ------------------------------------------------------------
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // -- Observability ------------------------------------------------------
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  SENTRY_ORG: z.string().default("crewflow"),
  SENTRY_PROJECT: z.string().default("web"),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().default("https://eu.i.posthog.com"),
  POSTHOG_PERSONAL_API_KEY: z.string().optional(),
  BETTERSTACK_LOGS_TOKEN: z.string().optional(),
  BETTERSTACK_UPTIME_HEARTBEAT_URL: z.string().optional(),

  // -- Internal auth ------------------------------------------------------
  CRON_SECRET: z.string().optional(),
  INTERNAL_API_SECRET: z.string().optional(),

  // -- Super-admin access gate -------------------------------------------
  // Comma-separated email allowlist. Users with one of these emails see
  // the /admin/organizations panel and can approve/reject/suspend orgs.
  // Empty/unset → no super-admins (the /admin route 404s for everyone).
  // Set in Vercel project env for production.
  CREWFLOW_SUPERADMIN_EMAILS: z.string().default(""),

  // -- Dev/preview-only auth bypass (Wave 1) ------------------------------
  // Set in Vercel for the Preview environment only. The /api/dev/test-login
  // route refuses to run in production regardless of these vars, but for
  // belt-and-braces we keep them out of prod env too.
  DEV_TEST_LOGIN_TOKEN: z.string().optional(),
  DEV_TEST_USER_EMAIL: z.string().email().optional(),

  // -- Feature flags ------------------------------------------------------
  NEXT_PUBLIC_FEATURE_VOICE_NOTES: z.enum(["true", "false"]).default("false"),
  NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK: z.enum(["true", "false"]).default("false"),
  NEXT_PUBLIC_FEATURE_WHATSAPP: z.enum(["true", "false"]).default("false"),

  // -- Capability authority source (Directive #015 / D-05) ---------------
  // RETIRED in LR5.3 (the Rollback Independence Rule, 25th §2 standard). The
  // CAPABILITY_AUTHORITY_SOURCE rollback lever is gone: the Capability Registry is
  // the SOLE authority for an AI employee's resolved capabilities, with no operator
  // switch back to the legacy model. The legacy `ai_employees` resolution is retained
  // only as the AUTOMATIC fail-safe in the runtime bridge (server/sdk/registry-parity.ts):
  // a registry read error or a subject the registry is silent about still falls back to
  // legacy, so the switch can never strand an employee — but that fail-safe is not
  // operator-selectable, and continued operation no longer depends on rollback being
  // available. Legacy storage, the confidence audit and the parity tooling remain
  // (preserved per the LR5.3 authorisation); their removal is a later, separately
  // reviewed phase under the Removal Sequencing Rule (23rd).

  // -- Vercel system vars (populated automatically) -----------------------
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_GIT_COMMIT_AUTHOR_DATE: z.string().optional(),
  VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Log to server console and crash early. Vercel build logs will surface this.
  console.error(
    "❌ Invalid environment variables:",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  throw new Error("Invalid environment variables — check Vercel project settings.");
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

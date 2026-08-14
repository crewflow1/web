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

  // -- WhatsApp Business Cloud API (Meta) --------------------------------
  // App secret: keys the X-Hub-Signature-256 HMAC on the inbound webhook. Absent
  // ⇒ verifyMetaSignature fails closed ⇒ the webhook rejects everything (dark).
  WHATSAPP_APP_SECRET: z.string().optional(),
  // Verify token: the shared string echoed back during Meta's GET hub.challenge
  // subscription handshake. Absent ⇒ the handshake fails closed.
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  // Outbound sender (Directive #018 R6 → PR3). The Meta Cloud API access token + business
  // phone-number id the WhatsApp sender POSTs with. BOTH absent ⇒ getWhatsAppProvider()
  // returns null (dark) ⇒ a WhatsApp reply records no_provider and SENDS NOTHING — the CI
  // path (CI sets neither). Optional graph version pins the Graph API version (default v21.0).
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().optional(),

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
  // The PUBLIC status-callback URL Twilio is configured to POST inbound-VOICE
  // lifecycle events to (Wave 8). The voice twin of TWILIO_STATUS_CALLBACK_URL:
  // Twilio signs THIS exact URL, so when set it is the canonical value the voice
  // status webhook verifies X-Twilio-Signature against — authoritative behind a
  // proxy that rewrites host/proto. Optional; absent, the route reconstructs the
  // URL from the forwarded request headers. Not a secret; carries no credential.
  TWILIO_VOICE_STATUS_CALLBACK_URL: z.string().optional(),
  VAPI_API_KEY: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),

  // -- HMRC MTD (Making Tax Digital) — DARK, credential + recognition gated ----
  // The OAuth2 client credentials for HMRC's MTD APIs (VAT digital filing +
  // CIS300). BOTH absent ⇒ isHmrcConnectable() is false ⇒ the connect/callback
  // routes 503, the OAuth resolver refuses before any fetch, and the VAT/CIS
  // payload composers refuse to build. Unset in every environment. Setting these
  // is NOT sufficient to go live: the NEXT_PUBLIC_FEATURE_HMRC_CONNECT flag is a
  // second switch, and — even then — CrewFlow cannot SUBMIT to HMRC until it
  // completes HMRC's vendor RECOGNITION (a legal gate). The substrate stops at
  // "prepared/held": no code path files a return. See lib/integrations/hmrc.
  HMRC_CLIENT_ID: z.string().optional(),
  HMRC_CLIENT_SECRET: z.string().optional(),

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

  // -- Communication Layer: WhatsApp provider (Directive #018 R6) ---------
  // Names the active outbound WhatsApp provider — the receptionist's SECOND outbound
  // transport. Default "auto". The Meta Cloud API sender IS wired now
  // (lib/comms/providers/meta-whatsapp-sender.ts), so this is CONFIGURATION-gated rather
  // than structurally absent: getWhatsAppProvider() returns a provider only when ALL of
  // NEXT_PUBLIC_FEATURE_WHATSAPP="true", WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID
  // are set AND this names a buildable provider ("auto" | "meta"). Any of those unmet ⇒ null
  // ⇒ the transport records a terminal `failed`/no_provider attempt on channel='whatsapp'
  // and SENDS NOTHING (the default posture everywhere: prod, CI and dev set none of them).
  // Setting this to "none"/"off"/"disabled" is a SECOND kill switch independent of the flag.
  // Free string (not an enum) so a new provider needs zero env-schema edits.
  COMMS_WHATSAPP_PROVIDER: z.string().optional(),

  // -- Communication Layer: inbound VOICE provider (Wave 8) --------------
  // Names the active inbound-voice telephony provider — the receptionist's
  // FIRST inbound-voice transport. Default "auto": prefer Twilio when its
  // account creds are set, else Vapi when its key is set, else none. Identical
  // PLUG-IN doctrine to the SMS/WhatsApp seams: with no provider configured
  // getVoiceProvider() returns null ⇒ the voice webhooks 503 and process
  // NOTHING (the posture in prod, CI and dev, which set none of them). Setting
  // this to "none"/"off"/"disabled" is a SECOND kill switch independent of the
  // NEXT_PUBLIC_FEATURE_VOICE_INBOUND flag. Free string (not an enum) so a new
  // provider needs zero env-schema edits.
  COMMS_VOICE_PROVIDER: z.string().optional(),

  // -- Weather intelligence (20261074) ------------------------------------
  // Names the active weather provider. There is NO DEFAULT and no "auto": unset
  // ⇒ getWeatherProvider() returns null ⇒ CrewFlow holds no weather data and
  // checks nothing. Unset is the posture in prod, CI and dev.
  //
  // Deliberately NOT defaulted to "auto" like the comms seams. Auto-selection is
  // right when every candidate is equivalent and free to try; it is wrong here,
  // because the vendors differ in LICENCE (Open-Meteo's keyless tier is
  // non-commercial only) and in COST, and a seam that silently picked one could
  // put the product in breach of a licence or on a bill nobody approved. Binding
  // a provider must be an explicit, named act.
  //
  // Setting this alone is NOT sufficient to activate anything. Since Train 7
  // an open-meteo adapter EXISTS (built-dark), so the live pair is
  // WEATHER_PROVIDER="open-meteo" + OPEN_METEO_API_KEY — both unset in every
  // environment until the commercial decision is taken. See
  // lib/weather/readiness.ts for the activation checklist and
  // docs/weather/provider-options.md for the licence and cost homework.
  WEATHER_PROVIDER: z.string().optional(),
  // Met Office Weather DataHub (Site Specific / Global Spot) subscription key.
  // NO metoffice adapter exists; this key has no reader beyond readiness.
  MET_OFFICE_API_KEY: z.string().optional(),
  // Open-Meteo COMMERCIAL subscription key — read ONLY by the factory arm in
  // lib/weather/index.ts, which injects it into the adapter. The keyless
  // open-access tier is licensed for non-commercial use only and must not be
  // used by CrewFlow; the adapter carries no free-tier endpoint.
  OPEN_METEO_API_KEY: z.string().optional(),

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
  // Server/edge DSN (falls back to the public one in the SDK configs). Dark
  // by default — unset ⇒ error monitoring initialises nothing and sends no
  // network request (see lib/monitoring/readiness.ts).
  SENTRY_DSN: z.string().optional(),
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
  // NOTE: there is intentionally NO NEXT_PUBLIC_FEATURE_VOICE_NOTES flag. The
  // `voice_notes` table exists in the baseline schema (with RLS in the jobs
  // migration) as reserved scaffold, but it has ZERO runtime wiring — no route,
  // component, server action, or read/write anywhere in the app. Do not add a
  // gate flag for it: a declared-but-unconsumed flag would falsely imply a live
  // feature exists. When the feature is actually built, add the flag then.
  NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK: z.enum(["true", "false"]).default("false"),
  NEXT_PUBLIC_FEATURE_WHATSAPP: z.enum(["true", "false"]).default("false"),
  // Wave 8 — inbound VOICE telephony. DEFAULTS OFF. While off the voice webhooks
  // (twilio/voice, twilio/voice/status, vapi) 503 before any work, the org↔number
  // routing/calls/call_events tables carry no rows the substrate populates, and the
  // admin/settings surfaces render "not configured". The SECOND switch is per-provider
  // credentials (COMMS_VOICE_PROVIDER + TWILIO_*/VAPI_* creds): the flag alone opens
  // no door — isVoiceConfigured() requires BOTH the flag AND a resolvable provider.
  NEXT_PUBLIC_FEATURE_VOICE_INBOUND: z.enum(["true", "false"]).default("false"),
  // The R28 Conversation Execution Engine's organisational control: whether the org has enabled CONTROLLED
  // LIVE BOOKING EXECUTION. DEFAULTS OFF — until explicitly armed, every prepared booking is `blocked_by_org`.
  // Even when armed, a booking never executes autonomously: the strongest eligibility is `requires_human_review`.
  NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION: z.enum(["true", "false"]).default("false"),
  // Train A — org-configurable outbound webhooks. DEFAULTS OFF. While off the
  // webhook-dispatch cron 204-no-ops before any DB work (zero egress) and the
  // settings UI is read-only. The SECOND flip is per-org: an org must configure
  // AND verify (signed ping) an endpoint before any real event fans out to it.
  NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS: z.enum(["true", "false"]).default("false"),
  // HMRC MTD connect surface — DEFAULTS OFF. While off the HMRC connect/callback
  // routes 503, isHmrcConnectable() returns false regardless of credentials, and
  // the settings surface renders "not configured". The SECOND switch is the HMRC
  // client credentials (HMRC_CLIENT_ID + HMRC_CLIENT_SECRET): the flag alone opens
  // no door — isHmrcConnectable() requires BOTH the flag AND the credentials. Even
  // both together only enable CONNECT, never SUBMIT — filing needs HMRC vendor
  // recognition (a legal gate). Left unset in every environment.
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: z.enum(["true", "false"]).default("false"),

  // Open Banking bank-feed connect surface (20261100). DEFAULTS OFF. Switch 1 of
  // two: while off, /api/integrations/banking/[provider]/* return not_configured
  // and the settings panel renders "not configured". The SECOND switch is the
  // aggregator credentials + a bound BANKING_PROVIDER; the flag alone opens no
  // door — isBankingProviderConnectable() requires BOTH. Above both sits the FCA
  // AISP authorisation legal gate. Never flip to "true" before all three exist.
  NEXT_PUBLIC_FEATURE_BANKING_CONNECT: z.enum(["true", "false"]).default("false"),

  // Telematics / GPS fleet-feed connect surface (20261103). DEFAULTS OFF. Switch 1
  // of two: while off, /api/integrations/telematics/[provider]/* return 503
  // not_configured and the settings panel renders "not configured". The SECOND
  // switch is the aggregator credentials + a bound TELEMATICS_PROVIDER; the flag
  // alone opens no door — isTelematicsProviderConnectable() requires BOTH. Above
  // both sits a CEO provider-choice decision. Never flip to "true" before all exist.
  NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT: z.enum(["true", "false"]).default("false"),

  // -- Open Banking / bank-feed aggregator (20261100 — DARK, FCA-gated) ---
  // The single OAuth client the bank-feed substrate binds to, plus the aggregator
  // it is bound to. UNSET in every environment today. Activation is a
  // configuration + LEGAL act: Open Banking / Account Information Services are
  // FCA-regulated, so a live bank connection requires FCA AISP authorisation (or
  // agent permission) IN ADDITION to these credentials and the feature flag. The
  // substrate (lib/integrations/banking/*) REFUSES-before-fetch while any of these
  // is absent, so no live bank call is reachable. BANKING_PROVIDER names the one
  // active aggregator ('truelayer' | 'plaid' | 'nordigen'); unbound ⇒ nothing is
  // connectable. Free string so a new aggregator needs zero env-schema edits.
  // Tokens at rest reuse INTEGRATION_TOKEN_ENCRYPTION_KEY (declared with the
  // accounting/calendar substrates via process.env; read by token-crypto.ts).
  BANKING_PROVIDER: z.string().optional(),
  BANKING_CLIENT_ID: z.string().optional(),
  BANKING_CLIENT_SECRET: z.string().optional(),

  // -- Telematics / GPS fleet feed (20261103 — DARK, provider-choice gated) ----
  // The single OAuth client the telematics substrate binds to, plus the aggregator
  // it is bound to. UNSET in every environment today. Activation is a
  // configuration + CEO-provider-choice act: a live vehicle location/odometer feed
  // requires a telematics provider ACCOUNT + these credentials AND the feature
  // flag AND a bound TELEMATICS_PROVIDER. The substrate (lib/integrations/telematics/*)
  // REFUSES-before-fetch while any of these is absent, so no live provider call is
  // reachable. TELEMATICS_PROVIDER names the one active aggregator ('samsara' |
  // 'verizon_connect'); unbound ⇒ nothing is connectable. Free string so a new
  // aggregator needs zero env-schema edits. Tokens at rest reuse
  // INTEGRATION_TOKEN_ENCRYPTION_KEY (declared with the accounting/calendar/banking
  // substrates via process.env; read by token-crypto.ts).
  TELEMATICS_PROVIDER: z.string().optional(),
  TELEMATICS_CLIENT_ID: z.string().optional(),
  TELEMATICS_CLIENT_SECRET: z.string().optional(),

  // -- Calendar connect (Google Calendar + Microsoft Graph) — 20261097 DARK --
  // The OAuth client credentials the calendar-connect substrate binds to, plus its
  // master feature flag. UNSET in every environment today. Activation = set the
  // provider's client id + secret AND flip FEATURE_CALENDAR_CONNECT (a two-switch
  // gate) — no code change reaches the live OAuth/push path. The Microsoft client
  // is a SEPARATE Graph calendar app from the auth-only Azure SSO (a Calendars
  // token, never a sign-in token). The substrate (lib/integrations/calendar/*)
  // REFUSES-before-fetch while any of these is absent, so no live provider call is
  // reachable. Tokens at rest are encrypted with INTEGRATION_TOKEN_ENCRYPTION_KEY
  // (below). Read via process.env by oauth.ts; declared here for schema visibility.
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional(),
  MS_GRAPH_CLIENT_ID: z.string().optional(),
  MS_GRAPH_CLIENT_SECRET: z.string().optional(),
  FEATURE_CALENDAR_CONNECT: z.string().optional(),

  // -- Accounting: Xero / QuickBooks (20261093/95 — DARK, two-switch gated) ----
  // The OAuth CLIENT credentials the accounting-export provider push binds to,
  // plus the master connect flag. UNSET in every environment today. Activation is
  // credentials + flag ONLY: set a provider's client id/secret AND flip
  // FEATURE_ACCOUNTING_CONNECT and the connect flow + the Xero/QuickBooks push go
  // live with no further code change. Neither switch alone opens a door —
  // isProviderConnectable() requires BOTH — and the substrate
  // (lib/integrations/accounting/*) REFUSES-before-fetch while either is absent,
  // so no live provider call is reachable. The per-org tenant/realm + tokens are
  // resolved from accounting_connections (encrypted, service-role), NOT from env,
  // so ONE client credential set serves every tenant. Tokens at rest use
  // INTEGRATION_TOKEN_ENCRYPTION_KEY. FEATURE_ACCOUNTING_CONNECT is a free string
  // (read as "1"/"true") so no schema edit is needed to flip it.
  FEATURE_ACCOUNTING_CONNECT: z.string().optional(),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  ACCOUNTING_REDIRECT_URI: z.string().optional(),
  // Non-secret tunables. XERO_BANK_ACCOUNT_CODE is the Xero bank account code
  // receipts (payments) land in (default "090", Xero's standard Bank account).
  // XERO_SALES_ACCOUNT_CODE is the revenue account AUTHORISED ACCREC invoice
  // lines post to (default "200", Xero's standard Sales account); Xero rejects an
  // AUTHORISED sales invoice whose lines carry no account reference, so the push
  // must attach one. QBO_API_BASE_URL overrides the QuickBooks API host (default
  // production) for a sandbox company. All optional; none is a credential.
  XERO_BANK_ACCOUNT_CODE: z.string().optional(),
  XERO_SALES_ACCOUNT_CODE: z.string().optional(),
  QBO_API_BASE_URL: z.string().optional(),

  // -- Integration token encryption (accounting/calendar/banking/telematics) --
  // The base64-encoded 32-byte AES-256 key that encrypts OAuth tokens at rest
  // (token-crypto.ts). UNSET today; the callback tripwire REFUSES a token exchange
  // when it is absent, so no plaintext token can ever be written. Required before
  // any token-storing integration is activated.
  INTEGRATION_TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // -- Auth: Microsoft SSO (DARK — credential-gated) ----------------------
  // Whether the "Continue with Microsoft" button is exposed on /login.
  // DEFAULTS OFF. The button + server action (signInWithMicrosoft, provider
  // 'azure') are BUILT and tested behind this flag, but Microsoft SSO cannot
  // work until an EXTERNAL credential exists: a Supabase Azure provider
  // configured with an Azure AD app registration (client id/secret + redirect
  // URI). Flipping this to "true" WITHOUT that config would show a button that
  // dead-ends at a provider error — so the flag stays off until the credential
  // is in place. No fake: while off the button does not render at all.
  NEXT_PUBLIC_FEATURE_MICROSOFT_SSO: z.enum(["true", "false"]).default("false"),

  // -- Auth: OAuth account linking (config-gated) -------------------------
  // Whether the "Link account" controls (linkIdentity) render in account
  // settings. DEFAULTS OFF. linkIdentity requires Supabase "Manual Linking"
  // to be enabled in the dashboard (Auth settings) — a CONFIG toggle, not a
  // credential. The action + UI seam are built behind this flag; flip to
  // "true" once manual linking is enabled so the button never dead-ends.
  NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING: z.enum(["true", "false"]).default("false"),

  // -- Public API jobs read surface (Train K / Mission 9) ----------------
  // SERVER-ONLY (deliberately NOT NEXT_PUBLIC): whether the public read API
  // /api/v1/jobs is EXPOSED. DEFAULTS OFF — the routes ship dark. Exposing
  // tenant data (jobs) through a public, key-authenticated API is a CEO /
  // product decision, not this train's to make (see app/api/v1/me/route.ts).
  // The code path — auth, scope check, org-pinning, DTO, rate limit — is built
  // and tested BEHIND this flag; flipping it to "true" is the whole decision.
  // While off, /api/v1/jobs* returns 404: the surface does not exist yet.
  // Server-only so the flag itself never leaks into a client bundle.
  FEATURE_PUBLIC_API_JOBS: z.enum(["true", "false"]).default("false"),

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

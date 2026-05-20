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
  DATABASE_URL: z.string().min(1).optional(),
  DIRECT_URL: z.string().min(1).optional(),

  // -- Stripe (required only when payments code runs) ---------------------
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // -- Twilio + Vapi (required when telephony code runs) ------------------
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  VAPI_API_KEY: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),

  // -- AI models ----------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // -- Email --------------------------------------------------------------
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default("CrewFlow <hello@crewflow.uk>"),
  RESEND_REPLY_TO: z.string().default("moe@crewflow.uk"),

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

/**
 * Billing (Stripe) — activation readiness.
 *
 * A sibling of lib/comms/readiness.ts and lib/monitoring/readiness.ts, for the
 * same reason: a single "billing on?" boolean derived from config is a lie
 * whenever the runtime cannot actually transact, and a green light over a dark
 * provider is worse than no light. Surfaced on /api/health so a deploy that
 * BELIEVES it can take money — or that silently cannot verify a webhook — is
 * visible to the smoke test, not discovered at the first real payment.
 *
 * Decomposes into independently-verifiable config facts:
 *   secretConfigured  — STRIPE_SECRET_KEY is present (the server client can
 *                       reach Stripe; absent ⇒ every billing action 503s).
 *   webhookConfigured — STRIPE_WEBHOOK_SECRET is present (the webhook can
 *                       verify signatures; absent ⇒ the webhook route 503s, so
 *                       subscription state would never sync — a DEGRADED state
 *                       even with a secret key set).
 *   selfServeFlag     — NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING is on (the
 *                       self-serve surface; the sales-led admin actions do not
 *                       need it).
 *
 * Reads `process.env` DIRECTLY, imports no SDK and no `server-only`, so it is
 * edge-safe and CAN NEVER THROW. Emits BOOLEANS ONLY — never a key value nor
 * the names of the env vars that hold it; /api/health is public.
 */

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

export type BillingReadiness = {
  secretConfigured: boolean;
  webhookConfigured: boolean;
  selfServeFlag: boolean;
};

export function getBillingReadiness(): BillingReadiness {
  return {
    secretConfigured: present(process.env.STRIPE_SECRET_KEY),
    webhookConfigured: present(process.env.STRIPE_WEBHOOK_SECRET),
    selfServeFlag:
      (process.env.NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING ?? "").trim().toLowerCase() === "true",
  };
}

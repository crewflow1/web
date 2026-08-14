import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

/**
 * Portal invoice payments — the DEDICATED Stripe Connect client + gate.
 *
 * This is the tenant→customer payment integration: a tenant's CUSTOMER paying
 * that tenant's invoice online. It is DELIBERATELY SEPARATE from CrewFlow's own
 * SaaS-billing Stripe client (lib/stripe/client.ts):
 *
 *   - a different secret key (STRIPE_CONNECT_SECRET_KEY, not STRIPE_SECRET_KEY),
 *   - a different cached singleton,
 *   - a different webhook secret + route (/api/webhooks/stripe-invoice).
 *
 * So SaaS billing being live in production does NOT make this feature live, and
 * activating/rotating one cannot touch the other.
 *
 * ── TENANT MODEL: Stripe Connect (platform key + per-org connected account) ──
 * The simplest option that keeps strict tenant isolation. ONE platform Connect
 * key serves every tenant; each tenant binds its OWN Stripe connected account
 * (org_payment_connections.stripe_account_id, an acct_... handle). Every
 * PaymentIntent / Checkout Session is created ON that account (the
 * `{ stripeAccount }` request option → Stripe-Account header), so the money
 * settles to the tenant's balance — never the platform's — and a customer paying
 * can only ever credit that one org's invoice. The account id is a public handle,
 * not a credential, so no secret is stored per tenant.
 *
 * ── THE TWO-SWITCH DARK GATE ─────────────────────────────────────────────────
 * `isPortalPaymentsConfigured()` is a pure env read: true only when the feature
 * FLAG is on AND the platform Connect key is present — NEVER, today. `getInvoiceStripe()`
 * returns null unless the key is present. Callers (the pay-now action + the
 * webhook) REFUSE-before-fetch on either being unmet. A per-tenant connected
 * account is the third, org-level gate enforced by the service layer. There is no
 * path from "dark" to a Stripe network call.
 */

let cached: Stripe | null | undefined;

// Read the switches from process.env directly (the banking/accounting substrate
// idiom), NOT the frozen `env` snapshot, so activation is a runtime config act —
// no rebuild — and the dark contract is testable by flipping process.env. env.ts
// still declares + validates these for boot-time visibility.
function rawEnv(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Switch 1: the master feature flag. */
export function portalPaymentsFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS === "true";
}

/** True only when the platform Connect secret key is present + non-empty. */
export function portalPaymentsKeyPresent(): boolean {
  return rawEnv("STRIPE_CONNECT_SECRET_KEY") !== null;
}

/**
 * The two-switch config gate: FLAG on AND platform key present. A pure env read,
 * no network, never throws. Still NOT sufficient to take a payment — the paying
 * tenant additionally needs a connected account (checked in the service layer).
 */
export function isPortalPaymentsConfigured(): boolean {
  return portalPaymentsFeatureEnabled() && portalPaymentsKeyPresent();
}

/**
 * The dedicated Connect SDK singleton. Returns null when the platform Connect key
 * isn't set (dark) so callers degrade to a refusal instead of crashing. This
 * NEVER reads STRIPE_SECRET_KEY — it cannot fall back onto the SaaS-billing key.
 */
export function getInvoiceStripe(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = rawEnv("STRIPE_CONNECT_SECRET_KEY");
  if (!key) {
    cached = null;
    return null;
  }
  cached = new Stripe(key, {
    // Pinned to the SDK version we ship (stripe@^17.4.0 → 2025-02-24.acacia),
    // matching lib/stripe/client.ts so a single SDK bump re-pins both.
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: { name: "CrewFlow Portal Payments", url: env.NEXT_PUBLIC_APP_URL },
  });
  return cached;
}

/**
 * True when the configured Connect key is a live key (sk_live_...). Used only for
 * diagnostics / a LIVE-vs-TEST badge; never gates behaviour.
 */
export function isInvoiceStripeLiveMode(): boolean {
  const key = rawEnv("STRIPE_CONNECT_SECRET_KEY");
  return !!key && key.startsWith("sk_live_");
}

/** Reset the cached SDK — tests that swap env mid-run only. */
export function _resetInvoiceStripeCache(): void {
  cached = undefined;
}

import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

/**
 * CrewFlow — Stripe SDK singleton.
 *
 * Server-only. Returns null when STRIPE_SECRET_KEY isn't configured
 * so callers can degrade gracefully instead of crashing the app at
 * boot. The webhook + checkout routes return 503 with a useful body
 * when this returns null.
 *
 * Why the explicit apiVersion pin:
 *   - Stripe ships breaking changes per API date.
 *   - Pinning here means rotating the SDK package doesn't silently
 *     change wire-level behaviour in production.
 */

let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    cached = null;
    return null;
  }
  cached = new Stripe(key, {
    // Pin matches the Stripe SDK version we ship (stripe@^17.4.0
    // ships with the 2025-02-24.acacia types). When we upgrade the
    // SDK we re-pin here to acknowledge any wire-level deltas.
    apiVersion: "2025-02-24.acacia",
    typescript: true,
    appInfo: {
      name: "CrewFlow",
      url: env.NEXT_PUBLIC_APP_URL,
    },
  });
  return cached;
}

/**
 * Reset the cached SDK — only used by tests that swap env mid-run.
 * Not exported from the package barrel; tests import it directly.
 */
export function _resetStripeCache(): void {
  cached = undefined;
}

/**
 * True when the configured key is a live key (sk_live_...), false
 * for test keys or when no key is set. Used by the diagnostic
 * endpoint to print a LIVE / TEST badge so the CEO can never
 * accidentally bill from the wrong environment.
 */
export function isLiveMode(): boolean {
  const key = env.STRIPE_SECRET_KEY;
  return !!key && key.startsWith("sk_live_");
}

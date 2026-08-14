import "server-only";

import type { MerchantProvider } from "./types";
import { MERCHANT_PROVIDERS } from "./types";

/**
 * Builders' merchant CONNECT substrate — the two-switch gating resolver. DARK.
 *
 * This module resolves, from the environment ALONE, whether a given merchant is
 * connectable. It is the merchant analogue of `accounting/oauth.ts`'s
 * `isProviderConnectable` (per-provider credentials, not one bound aggregator):
 * an org may connect to several merchants at once, each with its own credentials,
 * so each merchant is gated independently.
 *
 * ── THE TWO-SWITCH INVARIANT ────────────────────────────────────────────────
 * `isMerchantConnectable(p)` is a pure env read: true only when ALL of
 *   - NEXT_PUBLIC_FEATURE_MERCHANTS is "true"  (switch 1 — the master flag), AND
 *   - MERCHANT_<P>_API_KEY and MERCHANT_<P>_ENDPOINT are present (switch 2 — the
 *     per-merchant credentials + the contract-provisioned endpoint),
 * hold — which is NEVER, today. The flag alone opens no door and a credential
 * alone opens no door; both are required. Above both sits a COMMERCIAL gate: a
 * live link needs a trade-account integration CONTRACT with the merchant (the
 * endpoint is provisioned by the merchant per contract, not a public host).
 *
 * ── WHY AN ENDPOINT, NOT JUST A KEY ─────────────────────────────────────────
 * None of the four merchants publishes a public API host. The integration
 * endpoint (a cXML/OCI gateway URL, or an HTTPS/SFTP price-file location) is
 * handed over per contract. Requiring it in the connectable check means there is
 * no default host anywhere in the build — refuse-before-fetch is structural: the
 * adapter has nowhere to call until an operator supplies a real, SSRF-validated
 * endpoint. Secrets are read here and NEVER logged.
 *
 * ── ACTIVATION (config + a COMMERCIAL contract, not engineering) ─────────────
 * Per merchant, after a trade-account integration contract exists:
 *   MERCHANT_<P>_API_KEY        → the credential the merchant issued
 *   MERCHANT_<P>_ENDPOINT       → the cXML/OCI order gateway URL (https)
 *   MERCHANT_<P>_PRICE_FILE_URL → (optional) the price-file location (https)
 *   NEXT_PUBLIC_FEATURE_MERCHANTS="true"
 *   INTEGRATION_TOKEN_ENCRYPTION_KEY (shared) — so per-org account secrets are
 *     encrypted at rest in merchant_connections.
 * No code change reaches the live path.
 */

export type { MerchantProvider } from "./types";
export { MERCHANT_PROVIDERS } from "./types";

/** The env var names, per merchant, whose presence makes it connectable. */
const MERCHANT_ENV: Record<
  MerchantProvider,
  { apiKey: string; endpoint: string; priceFileUrl: string }
> = {
  jp_corry: {
    apiKey: "MERCHANT_JP_CORRY_API_KEY",
    endpoint: "MERCHANT_JP_CORRY_ENDPOINT",
    priceFileUrl: "MERCHANT_JP_CORRY_PRICE_FILE_URL",
  },
  jewson: {
    apiKey: "MERCHANT_JEWSON_API_KEY",
    endpoint: "MERCHANT_JEWSON_ENDPOINT",
    priceFileUrl: "MERCHANT_JEWSON_PRICE_FILE_URL",
  },
  travis_perkins: {
    apiKey: "MERCHANT_TRAVIS_PERKINS_API_KEY",
    endpoint: "MERCHANT_TRAVIS_PERKINS_ENDPOINT",
    priceFileUrl: "MERCHANT_TRAVIS_PERKINS_PRICE_FILE_URL",
  },
  haldane_fisher: {
    apiKey: "MERCHANT_HALDANE_FISHER_API_KEY",
    endpoint: "MERCHANT_HALDANE_FISHER_ENDPOINT",
    priceFileUrl: "MERCHANT_HALDANE_FISHER_PRICE_FILE_URL",
  },
};

/**
 * The master feature flag (switch 1). Even WITH credentials the connect surface
 * stays dark until this is truthy — a second, deliberate switch so credentials
 * alone (e.g. a stray env leak) cannot silently open a live merchant call.
 */
export function merchantsFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_MERCHANTS === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** The resolved, non-flag config for a merchant, or null when incomplete (dark). */
export type MerchantConfig = {
  apiKey: string;
  endpoint: string;
  priceFileUrl: string | null;
};

/**
 * Resolve a merchant's credentials + endpoint, or null when absent/incomplete.
 * A pure env read; never throws. The price-file URL is optional (a merchant may
 * only support PO submission, or only price files).
 */
export function resolveMerchantConfig(
  provider: MerchantProvider,
): MerchantConfig | null {
  const keys = MERCHANT_ENV[provider];
  const apiKey = envValue(keys.apiKey);
  const endpoint = envValue(keys.endpoint);
  if (!apiKey || !endpoint) return null;
  return { apiKey, endpoint, priceFileUrl: envValue(keys.priceFileUrl) };
}

/**
 * A pure env read — no network, never throws. A merchant is connectable only when
 * the master flag is on AND its API key + endpoint are present. False for every
 * merchant today.
 */
export function isMerchantConnectable(provider: MerchantProvider): boolean {
  if (!merchantsFeatureEnabled()) return false;
  return resolveMerchantConfig(provider) !== null;
}

/** Type guard for an untrusted provider string (route/form params). */
export function isMerchantProvider(v: string): v is MerchantProvider {
  return (MERCHANT_PROVIDERS as readonly string[]).includes(v);
}

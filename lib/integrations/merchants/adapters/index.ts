/**
 * Merchant adapters — resolver + readiness.
 *
 * One place to obtain a merchant adapter, and one place that answers "which
 * builders' merchants are live in this build". Every path is a RUNTIME fact gated
 * on the merchant's credentials + endpoint + the master feature flag, so they
 * read the environment through the adapters — and all are dark today.
 *
 * ── ONE TRANSPORT, FOUR MERCHANTS (the honest model) ────────────────────────
 * None of the four merchants publishes a public REST API. What IS knowable is the
 * cXML/OCI e-procurement OPEN STANDARD and the CSV price-file format, both real +
 * unit-tested (../cxml, ../price-file) — and the transport around them
 * ({@link CxmlMerchantAdapter}) is VENDOR-GENERIC: it is parameterised entirely by
 * the per-merchant env config (MERCHANT_<P>_API_KEY / _ENDPOINT /
 * _PRICE_FILE_URL), with no per-vendor code anywhere. So EVERY merchant —
 * national (Travis Perkins, Jewson) and regional (JP Corry, Haldane Fisher) —
 * binds to the same concrete, standards-based adapter. The engineering is
 * complete for all four; what remains per merchant is EXTERNAL: a trade-account
 * integration contract under which the merchant provisions the endpoint and
 * issues the credential. Until then every merchant is DARK
 * (refuse-before-fetch; no default host exists anywhere in the build) and
 * activation is configuration only — never a code change.
 */

import type { MerchantAdapter } from "./types";
import type { MerchantProvider } from "../types";
import { CxmlMerchantAdapter } from "./cxml-merchant";

const ADAPTERS: Record<MerchantProvider, MerchantAdapter> = {
  // Concrete cXML/OCI transport (real, knowable standard) — dark-safe today.
  // The adapter is vendor-generic; each binding differs only in which env config
  // (contract-provisioned endpoint + credential) it resolves.
  travis_perkins: new CxmlMerchantAdapter("travis_perkins"),
  jewson: new CxmlMerchantAdapter("jewson"),
  jp_corry: new CxmlMerchantAdapter("jp_corry"),
  haldane_fisher: new CxmlMerchantAdapter("haldane_fisher"),
};

/** Resolve the adapter for a merchant. */
export function getMerchantAdapter(provider: MerchantProvider): MerchantAdapter {
  return ADAPTERS[provider];
}

/** True only when the merchant's credentials + endpoint + flag are configured (dark today). */
export function merchantProviderReady(provider: MerchantProvider): boolean {
  return ADAPTERS[provider].isAvailable();
}

export type MerchantReadiness = Record<MerchantProvider, boolean>;

/** One snapshot of the merchant paths' readiness. */
export function getMerchantReadiness(): MerchantReadiness {
  return {
    travis_perkins: ADAPTERS.travis_perkins.isAvailable(),
    jewson: ADAPTERS.jewson.isAvailable(),
    jp_corry: ADAPTERS.jp_corry.isAvailable(),
    haldane_fisher: ADAPTERS.haldane_fisher.isAvailable(),
  };
}

export type {
  MerchantAdapter,
  MerchantCatalogueResult,
  MerchantCatalogueInput,
  MerchantOrderResult,
  MerchantOrderInput,
} from "./types";
export type { MerchantProvider } from "../types";

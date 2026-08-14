/**
 * Merchant adapters — resolver + readiness.
 *
 * One place to obtain a merchant adapter, and one place that answers "which
 * builders' merchants are live in this build". Every path is a RUNTIME fact gated
 * on the merchant's credentials + endpoint + the master feature flag, so they
 * read the environment through the adapters — and all are dark today.
 *
 * ── REAL vs PENDING (the honest split) ──────────────────────────────────────
 * None of the four merchants publishes a public REST API, so — by the same
 * standard the banking substrate applies (TrueLayer is concrete because its Data
 * API host is documented; Plaid/Nordigen are pending) — no merchant qualifies as
 * a documented proprietary API. What IS knowable is the cXML/OCI e-procurement
 * OPEN STANDARD and the CSV price-file format, both real + unit-tested (../cxml,
 * ../price-file). So:
 *   - travis_perkins, jewson → {@link CxmlMerchantAdapter}: the national merchants
 *     whose parent groups run cXML/OCI B2B gateways for trade accounts. Concrete,
 *     standards-based transport — but still DARK (refuse-before-fetch; the
 *     endpoint is contract-provisioned, no default host in the build).
 *   - jp_corry, haldane_fisher → {@link PendingMerchantAdapter}: regional merchants
 *     with no documented API/standard endpoint; honest placeholders, exactly like
 *     Plaid/Nordigen today.
 * The binding is a modelling choice, clearly labelled; EVERY merchant is dark and
 * activates only with real, SSRF-validated credentials + endpoint.
 */

import type { MerchantAdapter } from "./types";
import type { MerchantProvider } from "../types";
import { CxmlMerchantAdapter } from "./cxml-merchant";
import { PendingMerchantAdapter } from "./pending";

const ADAPTERS: Record<MerchantProvider, MerchantAdapter> = {
  // Concrete cXML/OCI transport (real, knowable standard) — dark-safe today.
  travis_perkins: new CxmlMerchantAdapter("travis_perkins"),
  jewson: new CxmlMerchantAdapter("jewson"),
  // Honest placeholders — no knowable public format for these regional merchants.
  jp_corry: new PendingMerchantAdapter("jp_corry"),
  haldane_fisher: new PendingMerchantAdapter("haldane_fisher"),
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

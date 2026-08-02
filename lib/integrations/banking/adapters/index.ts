/**
 * Banking adapters — resolver + readiness.
 *
 * One place to obtain an aggregator adapter, and one place that answers "which
 * bank feeds are live in this build". Every path is a RUNTIME fact gated on the
 * aggregator's OAuth credentials + the feature flag + the FCA legal boundary, so
 * they read the environment through the adapters — and all are dark today.
 */

import type { BankingAdapter, BankingProvider } from "./types";
import { TrueLayerAdapter } from "./truelayer";
import { PendingAggregatorAdapter } from "./pending";

const ADAPTERS: Record<BankingProvider, BankingAdapter> = {
  truelayer: new TrueLayerAdapter(),
  // Concrete fetch bodies for these are wired at activation; dark-safe skeletons
  // today (refuse-before-fetch, no live bank call reachable).
  plaid: new PendingAggregatorAdapter("plaid"),
  nordigen: new PendingAggregatorAdapter("nordigen"),
};

/** Resolve the adapter for an aggregator. */
export function getBankingAdapter(provider: BankingProvider): BankingAdapter {
  return ADAPTERS[provider];
}

/** True only when the aggregator's OAuth credentials + flag are configured (dark today). */
export function bankingProviderReady(provider: BankingProvider): boolean {
  return ADAPTERS[provider].isAvailable();
}

export type BankingReadiness = Record<BankingProvider, boolean>;

/** One snapshot of the bank-feed paths' readiness. */
export function getBankingReadiness(): BankingReadiness {
  return {
    truelayer: ADAPTERS.truelayer.isAvailable(),
    plaid: ADAPTERS.plaid.isAvailable(),
    nordigen: ADAPTERS.nordigen.isAvailable(),
  };
}

export type {
  BankingAdapter,
  BankingProvider,
  BankFetchResult,
  BankFetchInput,
} from "./types";

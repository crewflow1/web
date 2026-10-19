/**
 * Telematics adapters — resolver + readiness.
 *
 * One place to obtain an aggregator adapter, and one place that answers "which
 * telematics feeds are live in this build". Every path is a RUNTIME fact gated on
 * the aggregator's OAuth credentials + the feature flag + a bound
 * TELEMATICS_PROVIDER, so they read the environment through the adapters — and all
 * are dark today.
 */

import type { TelematicsAdapter, TelematicsProvider } from "./types";
import { SamsaraAdapter } from "./samsara";
import { VerizonConnectAdapter } from "./verizon-connect";

// Both aggregators are REAL adapters now, each dark-gated identically: they refuse
// before any fetch until the substrate is connectable (flag + credentials + a bound
// provider), so no live provider call is reachable today. (The one-time
// PendingTelematicsAdapter skeleton was deleted once both fetch bodies existed; a
// FUTURE aggregator gets the same dark-safe shape — guard-before-fetch, no SDK at
// module scope — written fresh, per samsara.ts / verizon-connect.ts.)
const ADAPTERS: Record<TelematicsProvider, TelematicsAdapter> = {
  samsara: new SamsaraAdapter(),
  verizon_connect: new VerizonConnectAdapter(),
};

/** Resolve the adapter for an aggregator. */
export function getTelematicsAdapter(provider: TelematicsProvider): TelematicsAdapter {
  return ADAPTERS[provider];
}

/** True only when the aggregator's OAuth credentials + flag are configured (dark today). */
export function telematicsProviderReady(provider: TelematicsProvider): boolean {
  return ADAPTERS[provider].isAvailable();
}

export type TelematicsReadiness = Record<TelematicsProvider, boolean>;

/** One snapshot of the telematics-feed paths' readiness. */
export function getTelematicsReadiness(): TelematicsReadiness {
  return {
    samsara: ADAPTERS.samsara.isAvailable(),
    verizon_connect: ADAPTERS.verizon_connect.isAvailable(),
  };
}

export type {
  TelematicsAdapter,
  TelematicsProvider,
  TelematicsFetchResult,
  TelematicsFetchInput,
  TelematicsAccountResult,
} from "./types";

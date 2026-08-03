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
import { PendingTelematicsAdapter } from "./pending";

const ADAPTERS: Record<TelematicsProvider, TelematicsAdapter> = {
  samsara: new SamsaraAdapter(),
  // Concrete fetch body for this is wired at activation; dark-safe skeleton today
  // (refuse-before-fetch, no live provider call reachable).
  verizon_connect: new PendingTelematicsAdapter("verizon_connect"),
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
} from "./types";

import "server-only";

import { isTelematicsProviderConnectable } from "../oauth";
import type {
  TelematicsAccountResult,
  TelematicsAdapter,
  TelematicsFetchInput,
  TelematicsFetchResult,
  TelematicsProvider,
} from "./types";
import { unavailable } from "./types";

/**
 * Pending telematics adapter — a DARK skeleton for aggregators whose native fetch
 * body is not yet written (Verizon Connect).
 *
 * It is dark-safe by construction: `fetchReadings` REFUSES before any network work
 * whenever the substrate is not connectable (ALWAYS today), and even when
 * connectable it returns a clean `error` ("not yet activated") rather than
 * contacting a provider — there is deliberately NO `fetch` and NO SDK import in
 * this file, so no live provider call is reachable. Activation replaces this with
 * a concrete adapter (as SamsaraAdapter is) once the aggregator contract exists.
 */
export class PendingTelematicsAdapter implements TelematicsAdapter {
  constructor(readonly provider: TelematicsProvider) {}

  isAvailable(): boolean {
    return isTelematicsProviderConnectable(this.provider);
  }

  async fetchReadings(_input: TelematicsFetchInput): Promise<TelematicsFetchResult> {
    // DARK GUARD FIRST. No credentials → refuse without touching the network.
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        `${this.provider} telematics feed is not connected. Open a provider account ` +
          `and configure the aggregator credentials to enable it.`,
      );
    }
    // Connectable but the concrete fetch body is not yet implemented — still NO
    // live provider call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `${this.provider} telematics feed is configured but not yet activated in this build.`,
    };
  }

  async resolveAccountHandle(_accessToken: string): Promise<TelematicsAccountResult> {
    // DARK GUARD FIRST — no network without credentials.
    if (!this.isAvailable()) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unavailable",
        message: `${this.provider} telematics feed is not connected; no account handle to resolve.`,
      };
    }
    // Connectable but the concrete account lookup is not yet implemented — still
    // NO live provider call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `${this.provider} account resolution is configured but not yet activated in this build.`,
    };
  }
}

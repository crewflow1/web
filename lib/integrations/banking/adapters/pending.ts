import "server-only";

import { isBankingProviderConnectable } from "../oauth";
import type {
  BankFetchInput,
  BankFetchResult,
  BankingAdapter,
  BankingProvider,
} from "./types";
import { unavailable } from "./types";

/**
 * Pending aggregator adapter — a DARK skeleton for aggregators whose native
 * fetch body is not yet written (Plaid, Nordigen-GoCardless).
 *
 * It is dark-safe by construction: `fetchStatements` REFUSES before any network
 * work whenever the substrate is not connectable (ALWAYS today), and even when
 * connectable it returns a clean `error` ("not yet activated") rather than
 * contacting a bank — there is deliberately NO `fetch` and NO SDK import in this
 * file, so no live bank call is reachable. Activation replaces this with a
 * concrete adapter (as TrueLayerAdapter is) once FCA authorisation + the
 * aggregator contract exist.
 */
export class PendingAggregatorAdapter implements BankingAdapter {
  constructor(readonly provider: BankingProvider) {}

  isAvailable(): boolean {
    return isBankingProviderConnectable(this.provider);
  }

  async fetchStatements(_input: BankFetchInput): Promise<BankFetchResult> {
    // DARK GUARD FIRST. No credentials → refuse without touching the network.
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        `${this.provider} bank feed is not connected. Obtain FCA AISP ` +
          `authorisation and configure the aggregator credentials to enable it.`,
      );
    }
    // Connectable but the concrete fetch body is not yet implemented — still NO
    // live bank call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `${this.provider} bank feed is configured but not yet activated in this build.`,
    };
  }
}

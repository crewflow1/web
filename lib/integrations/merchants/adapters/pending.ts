import "server-only";

import { isMerchantConnectable } from "../connect";
import type {
  MerchantAdapter,
  MerchantCatalogueInput,
  MerchantCatalogueResult,
  MerchantOrderInput,
  MerchantOrderResult,
} from "./types";
import { catalogueUnavailable, orderUnavailable } from "./types";
import type { MerchantProvider } from "../types";

/**
 * Pending merchant adapter — a DARK skeleton for merchants that expose NO
 * knowable public integration format (JP Corry, Haldane Fisher).
 *
 * Unlike the national merchants (whose electronic ordering runs over the cXML/OCI
 * open standard, wired in {@link CxmlMerchantAdapter}), these regional merchants
 * publish no documented API and no standard price-file endpoint — a live link
 * would be a bespoke, contract-specific integration. Rather than fabricate one,
 * this adapter is an honest placeholder, exactly as Plaid/Nordigen are in the
 * banking substrate today.
 *
 * It is dark-safe by construction: both methods REFUSE before any network work
 * whenever the merchant is not connectable (ALWAYS today), and even when
 * connectable they return a clean `error` ("not yet activated") rather than
 * contacting a merchant — there is deliberately NO `fetch` and NO SDK import in
 * this file, so no live merchant call is reachable. Activation replaces this with
 * a concrete adapter once that merchant's integration contract + format exist.
 */
export class PendingMerchantAdapter implements MerchantAdapter {
  constructor(readonly provider: MerchantProvider) {}

  isAvailable(): boolean {
    return isMerchantConnectable(this.provider);
  }

  async importCatalogue(
    _input: MerchantCatalogueInput,
  ): Promise<MerchantCatalogueResult> {
    // DARK GUARD FIRST. No credentials → refuse without touching the network.
    if (!this.isAvailable()) {
      return catalogueUnavailable(
        this.provider,
        `${this.provider} is not connected. A trade-account integration contract, ` +
          `its credentials and endpoint are required to enable price-file import.`,
      );
    }
    // Connectable but no concrete format is implemented for this merchant — still
    // NO live merchant call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `${this.provider} price-file import is configured but not yet activated in this build.`,
    };
  }

  async submitPurchaseOrder(
    _input: MerchantOrderInput,
  ): Promise<MerchantOrderResult> {
    // DARK GUARD FIRST. No credentials → refuse without touching the network.
    if (!this.isAvailable()) {
      return orderUnavailable(
        this.provider,
        `${this.provider} is not connected. A trade-account integration contract, ` +
          `its credentials and endpoint are required to enable order submission.`,
      );
    }
    // Connectable but no concrete format is implemented for this merchant — still
    // NO live merchant call is made from this build.
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `${this.provider} order submission is configured but not yet activated in this build.`,
    };
  }
}

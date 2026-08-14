/**
 * Builders' merchant feed — the merchant ADAPTER seam.
 *
 * Importing a merchant's price file and submitting a purchase order to a merchant
 * are DARK seams behind the merchant's credentials + endpoint. This file defines
 * the contract every merchant adapter satisfies, so activation is only ever
 * "supply the credentials + endpoint (per a trade contract)", never a code change
 * to the catalogue store or the Purchase Orders core that consume the results.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * An adapter reports `isAvailable()` false whenever the connect substrate is not
 * connectable for it (flag off / no credentials / no endpoint) — which is ALWAYS,
 * today. When unavailable, BOTH `importCatalogue` and `submitPurchaseOrder` MUST
 * return an `unavailable` result WITHOUT constructing a client and WITHOUT making
 * any network request. A merchant is never contacted without credentials; there
 * is no code path from "no credentials" to `fetch`. The security suite proves
 * this against the adapter source.
 *
 * ── SSRF BOUNDARY ───────────────────────────────────────────────────────────
 * Any concrete adapter that reaches an endpoint URL MUST validate it through the
 * shared SSRF guard (lib/webhooks/ssrf.ts) BEFORE the request — the endpoint is
 * operator-supplied config, so it is treated like any other outbound URL: https
 * only, DNS hostname (no IP literal), no private range, no platform host.
 */

import type {
  CatalogueItem,
  MerchantProvider,
  PurchaseOrderPayload,
} from "../types";

/**
 * The outcome of a price-file / catalogue import.
 *   - ok           — items parsed from the merchant's price file (unreachable today).
 *   - unavailable  — not connectable; nothing was fetched (the dark path).
 *   - unauthorized — the credential was rejected (401/403); reconnect required.
 *   - error        — connectable but the fetch/parse failed for any other reason.
 */
export type MerchantCatalogueResult =
  | { ok: true; provider: MerchantProvider; items: CatalogueItem[] }
  | {
      ok: false;
      provider: MerchantProvider;
      reason: "unavailable" | "unauthorized" | "error";
      message: string;
    };

/**
 * The outcome of a purchase-order submission.
 *   - ok           — the merchant accepted the order (unreachable today); carries
 *                    the merchant's order reference when it returns one.
 *   - unavailable  — not connectable; nothing was submitted (the dark path).
 *   - unauthorized — the credential was rejected (401/403); reconnect required.
 *   - rejected     — the merchant reached us but declined the order (bad SKU,
 *                    closed account, cXML application error).
 *   - error        — connectable but the submission failed for any other reason.
 */
export type MerchantOrderResult =
  | {
      ok: true;
      provider: MerchantProvider;
      externalOrderRef: string | null;
      message: string;
    }
  | {
      ok: false;
      provider: MerchantProvider;
      reason: "unavailable" | "unauthorized" | "rejected" | "error";
      message: string;
    };

/** What an adapter needs to import a catalogue (unreachable dark). */
export type MerchantCatalogueInput = {
  /** The org's trade account number with the merchant (the connection handle). */
  accountHandle: string;
  /**
   * DECRYPTED per-org account secret, when the merchant issues one — only ever
   * resolved after the connectable guard. Null when the deployment credential
   * (env) is sufficient.
   */
  accountSecret?: string | null;
};

/** What an adapter needs to submit a purchase order (unreachable dark). */
export type MerchantOrderInput = {
  /** The provider-agnostic order to submit. */
  order: PurchaseOrderPayload;
  /** DECRYPTED per-org account secret, when issued (post-guard only). */
  accountSecret?: string | null;
};

export interface MerchantAdapter {
  readonly provider: MerchantProvider;
  /**
   * True only when the connect substrate is connectable for this merchant. A pure
   * env check — no network, never throws. Drives readiness and the UI's
   * connected/coming-soon state.
   */
  isAvailable(): boolean;
  /**
   * Pull + normalise the merchant's price file into canonical catalogue items.
   * Returns `unavailable` — no network — when dark. The ONLY network call lives
   * strictly AFTER the availability guard.
   */
  importCatalogue(input: MerchantCatalogueInput): Promise<MerchantCatalogueResult>;
  /**
   * Submit a purchase order to the merchant. Returns `unavailable` — no network —
   * when dark. The ONLY network call lives strictly AFTER the availability guard.
   * The adapter NEVER reaches into PO tables; it receives a canonical payload.
   */
  submitPurchaseOrder(input: MerchantOrderInput): Promise<MerchantOrderResult>;
}

/** The catalogue `unavailable` result — an outcome the dark path may produce. */
export function catalogueUnavailable(
  provider: MerchantProvider,
  message: string,
): MerchantCatalogueResult {
  return { ok: false, provider, reason: "unavailable", message };
}

/** The order `unavailable` result — an outcome the dark path may produce. */
export function orderUnavailable(
  provider: MerchantProvider,
  message: string,
): MerchantOrderResult {
  return { ok: false, provider, reason: "unavailable", message };
}

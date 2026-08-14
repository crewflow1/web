/**
 * Builders' merchant integration — the CANONICAL domain shapes.
 *
 * Server/client-safe: no `server-only`, no env reads, no network — the pure
 * vocabulary the whole merchant substrate speaks in, so both the (dark) adapters
 * and their unit tests share ONE definition of a catalogue line and a purchase
 * order. Mirrors how `banking/statement-map` and `telematics/reading-map` hold
 * the provider-agnostic shapes their adapters normalise onto.
 *
 * ── WHAT THIS INTEGRATION IS ────────────────────────────────────────────────
 * Builders' merchants (JP Corry, Jewson, Travis Perkins, Haldane Fisher) are
 * MANUAL supplier records today — there is no live link to any of them. This
 * namespace is the DARK seam for two flows:
 *   1. CATALOGUE / PRICE-FILE IMPORT — pull a merchant's trade price file (the
 *      SKUs + agreed prices for this org's account) into a per-org catalogue.
 *   2. PURCHASE-ORDER SUBMISSION — send an existing CrewFlow purchase order to
 *      the merchant electronically, instead of emailing/phoning it.
 * Neither flow is reachable while dark; activation is credentials + a merchant
 * contract, never a code change to the Purchase Orders core (which this substrate
 * only ever connects INTO via {@link MerchantAdapter}, never modifies).
 */

/**
 * The builders' merchants this substrate can bind an org to. A small, closed set
 * — the four named merchants. Every DB CHECK, adapter map and settings row keys
 * off exactly these.
 */
export type MerchantProvider =
  | "jp_corry"
  | "jewson"
  | "travis_perkins"
  | "haldane_fisher";

export const MERCHANT_PROVIDERS: readonly MerchantProvider[] = [
  "jp_corry",
  "jewson",
  "travis_perkins",
  "haldane_fisher",
];

/** Human labels for the settings surface + logs. */
export const MERCHANT_LABELS: Record<MerchantProvider, string> = {
  jp_corry: "JP Corry",
  jewson: "Jewson",
  travis_perkins: "Travis Perkins",
  haldane_fisher: "Haldane Fisher",
};

/**
 * A single catalogue line, provider-agnostic. This is what a parsed price file
 * normalises to, regardless of the merchant's native column order/labels.
 *
 * `unitPricePence` is an INTEGER of minor units (pence) — money is never a float
 * in this codebase. The pure parser converts a "12.34" price column to 1234.
 */
export type CatalogueItem = {
  /** The merchant's stock code (SKU / product code) — the join key. */
  sku: string;
  /** Product description as the merchant supplies it. */
  description: string;
  /** Sell unit (e.g. "each", "bag", "m", "box"). Free text; null when absent. */
  unit: string | null;
  /** Pack/order multiple, when the merchant states one. Null when absent. */
  packSize: string | null;
  /** Agreed trade price for this org's account, in integer pence. */
  unitPricePence: number;
  /** ISO 4217 currency (defaults to "GBP" when the file omits it). */
  currency: string;
  /**
   * The merchant's VAT code/rate label for the line (e.g. "S", "Z", "20"), when
   * supplied. Kept as the merchant's own label — CrewFlow does not reinterpret a
   * merchant's tax classification. Null when absent.
   */
  vatCode: string | null;
  /** The date this price becomes/became effective (ISO date), when stated. */
  effectiveDate: string | null;
};

/** One line of a purchase order being submitted to a merchant. */
export type PurchaseOrderLine = {
  /** The merchant SKU to order. Required — an electronic order needs a code. */
  sku: string;
  /** A human description carried through onto the order (audit/readability). */
  description: string;
  /** Quantity ordered. A positive number; the builder validates it. */
  quantity: number;
  /** Unit of measure the quantity is expressed in (free text). */
  unit: string | null;
  /** Expected unit price in integer pence, when the caller has one. */
  unitPricePence: number | null;
};

/**
 * A provider-agnostic purchase order ready to submit. The Purchase Orders core
 * maps ITS row onto this shape and hands it to the adapter — the adapter never
 * reaches back into PO tables. This is the ONE seam between the two domains.
 */
export type PurchaseOrderPayload = {
  /** The CrewFlow PO id (for correlation/idempotency on the merchant side). */
  purchaseOrderId: string;
  /** The human PO reference/number shown to the merchant. */
  reference: string;
  /** The org's trade account number with the merchant (the connection handle). */
  accountHandle: string;
  /** Delivery address lines, free text; empty when collection. */
  deliveryLines: string[];
  /** Requested delivery date (ISO date), when specified. */
  requestedDeliveryDate: string | null;
  /** Order currency (ISO 4217). */
  currency: string;
  /** The order lines. Non-empty at submission (the builder validates). */
  lines: PurchaseOrderLine[];
};

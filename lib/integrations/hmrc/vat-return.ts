import { isHmrcConnectable } from "./oauth";

import type { TaxSummary } from "@/lib/tax/compute";

/**
 * HMRC MTD VAT return — the 9-box submission payload COMPOSER. DARK.
 *
 * Composes the exact JSON body the MTD VAT "submit VAT return" endpoint expects
 * (the 9 VAT boxes) from CrewFlow's EXISTING deterministic VAT authority
 * (lib/tax/compute.ts computeVatQuarter). It is PURE — no network, no I/O, no
 * `server-only` — and it does NOT recompute tax: the VAT amounts come straight
 * from computeVatQuarter, so there is one and only one VAT calculator in the
 * product.
 *
 * ── LEGAL BOUNDARY — COMPOSE, NEVER SUBMIT ──────────────────────────────────
 * This builds a payload; it does not send it. HMRC will not accept a VAT return
 * from software it has not RECOGNISED (a legal/commercial gate). The substrate
 * stops at "prepared/held": the composed payload is stored in hmrc_submissions
 * (status prepared|held — there is no filed state) and never POSTed.
 *
 * ── REFUSE WHEN DARK ────────────────────────────────────────────────────────
 * `composeVatReturn` REFUSES (returns { ok:false, reason:'not_configured' })
 * unless HMRC is connectable (two-switch: client creds + feature flag). So while
 * dark not even the payload is built — defence in depth around the migration's
 * dark posture and the routes' 503.
 *
 * ── THE 9 BOXES (HMRC vocabulary) ───────────────────────────────────────────
 *   box 1 vatDueSales            — VAT due on sales & other outputs.
 *   box 2 vatDueAcquisitions     — VAT due on acquisitions (NI ↔ EU). 0 by default.
 *   box 3 totalVatDue            — box 1 + box 2 (HMRC computes/validates this).
 *   box 4 vatReclaimedCurrPeriod — VAT reclaimed on purchases & other inputs.
 *   box 5 netVatDue              — |box 3 − box 4| (always non-negative per HMRC).
 *   box 6 totalValueSalesExVAT   — total value of sales ex-VAT (whole pounds).
 *   box 7 totalValuePurchasesExVAT — total value of purchases ex-VAT.
 *   box 8 totalValueGoodsSuppliedExVAT — goods supplied to the EU ex-VAT.
 *   box 9 totalAcquisitionsExVAT — acquisitions from the EU ex-VAT.
 *
 * computeVatQuarter gives boxes 1 (output_vat), 4 (input_vat) and the signed net
 * (net_payable). Boxes 2, 6-9 are not VAT amounts and are not derivable from
 * computeVatQuarter, so they are taken from optional net-total inputs and default
 * to 0 — never guessed. Every box is present because MTD requires all nine.
 */

/** The 9-box MTD VAT return body, HMRC field names verbatim. */
export type MtdVatReturn = {
  periodKey: string;
  vatDueSales: number;
  vatDueAcquisitions: number;
  totalVatDue: number;
  vatReclaimedCurrPeriod: number;
  netVatDue: number;
  totalValueSalesExVAT: number;
  totalValuePurchasesExVAT: number;
  totalValueGoodsSuppliedExVAT: number;
  totalAcquisitionsExVAT: number;
  /**
   * The user's finalisation declaration. Defaults FALSE: a return is never
   * silently declared final on the user's behalf — finalisation is a deliberate,
   * human act at submission time (which this build never reaches).
   */
  finalised: boolean;
};

/** Extra net-value inputs (boxes 2, 6-9) not derivable from computeVatQuarter. */
export type VatNetTotals = {
  /** box 2 — VAT due on acquisitions. */
  vatDueAcquisitions?: number;
  /** box 6 — total value of sales ex-VAT. */
  totalValueSalesExVAT?: number;
  /** box 7 — total value of purchases ex-VAT. */
  totalValuePurchasesExVAT?: number;
  /** box 8 — value of goods supplied to the EU ex-VAT. */
  totalValueGoodsSuppliedExVAT?: number;
  /** box 9 — value of acquisitions from the EU ex-VAT. */
  totalAcquisitionsExVAT?: number;
};

export type ComposeVatInput = {
  /** The MTD VAT period key (e.g. "18A1"), from the retrieve-obligations call. */
  periodKey: string;
  /** The output of lib/tax/compute.ts computeVatQuarter — CrewFlow's VAT authority. */
  vat: TaxSummary["vat_quarter"];
  /** Boxes 2, 6-9. Absent values default to 0 — never guessed. */
  netTotals?: VatNetTotals;
  /** Whether the human has declared the figures final. Defaults false. */
  finalised?: boolean;
};

export type ComposeVatResult =
  | { ok: true; periodKey: string; payload: MtdVatReturn }
  | { ok: false; reason: "not_configured" | "invalid"; message: string };

/** HMRC: VAT amounts to 2dp; box 6-9 net values to whole pounds. */
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundPounds = (n: number) => Math.round(n);

/**
 * Compose the 9-box MTD VAT return payload. REFUSES when HMRC is not connectable
 * (dark) or the period key is missing. Pure — builds a value, sends nothing.
 */
export function composeVatReturn(input: ComposeVatInput): ComposeVatResult {
  // DARK GUARD FIRST — do not even assemble a submission payload while dark.
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no VAT return can be prepared.",
    };
  }

  const periodKey = typeof input.periodKey === "string" ? input.periodKey.trim() : "";
  if (periodKey.length === 0) {
    return { ok: false, reason: "invalid", message: "A VAT periodKey is required." };
  }

  const t = input.netTotals ?? {};
  const vatDueSales = round2(input.vat.output_vat); // box 1
  const vatDueAcquisitions = round2(t.vatDueAcquisitions ?? 0); // box 2
  const totalVatDue = round2(vatDueSales + vatDueAcquisitions); // box 3
  const vatReclaimedCurrPeriod = round2(input.vat.input_vat); // box 4
  const netVatDue = round2(Math.abs(totalVatDue - vatReclaimedCurrPeriod)); // box 5

  return {
    ok: true,
    periodKey,
    payload: {
      periodKey,
      vatDueSales,
      vatDueAcquisitions,
      totalVatDue,
      vatReclaimedCurrPeriod,
      netVatDue,
      totalValueSalesExVAT: roundPounds(t.totalValueSalesExVAT ?? 0), // box 6
      totalValuePurchasesExVAT: roundPounds(t.totalValuePurchasesExVAT ?? 0), // box 7
      totalValueGoodsSuppliedExVAT: roundPounds(t.totalValueGoodsSuppliedExVAT ?? 0), // box 8
      totalAcquisitionsExVAT: roundPounds(t.totalAcquisitionsExVAT ?? 0), // box 9
      finalised: input.finalised === true,
    },
  };
}

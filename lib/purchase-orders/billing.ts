import { round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Supplier-bill roll-up (Financial Operations). PURE — no DB, no server-only
 * imports. Given a purchase order's committed total and the bills recorded
 * against it (each a `finances` entry with a net `amount` + generated
 * `vat_total`), report how much has been billed and the PO's billing status.
 *
 * Closes the loop the commercial engine already opened: purchase_orders =
 * COMMITTED spend; PO-linked finances = ACTUAL cost. Both are compared GROSS
 * (what you ordered vs what the supplier has invoiced); the NET figure is kept
 * for profitability. All arithmetic goes through `lib/money` (2dp, no float drift).
 */

export type PoBillStatus = "unbilled" | "part_billed" | "fully_billed" | "over_billed";

export type PoBillLine = {
  amount: number | string | null; // net (ex-VAT)
  vat_total: number | string | null;
};

export type PoBilling = {
  /** PO committed total (gross). */
  poTotal: number;
  /** Sum of bill net amounts — the reclaim-adjusted cost that feeds profitability. */
  billedNet: number;
  /** Sum of bill gross (amount + vat_total) — compared against the PO total. */
  billedGross: number;
  /** poTotal − billedGross (negative when over-billed). */
  remaining: number;
  /** billedGross / poTotal, 0 to 100+ (0 when the PO total is 0). */
  pct: number;
  status: PoBillStatus;
  count: number;
};

// Rounding tolerance so a penny of float noise doesn't read as "over/under".
const TOL = 0.005;

export function computePoBilling(input: {
  poTotal: number | string | null;
  bills: PoBillLine[];
}): PoBilling {
  const poTotal = round2(toPounds(input.poTotal));
  const billedNet = sumMoney(input.bills.map((b) => b.amount));
  const billedGross = round2(billedNet + sumMoney(input.bills.map((b) => b.vat_total)));
  const remaining = round2(poTotal - billedGross);
  const pct = poTotal > 0 ? Math.round((billedGross / poTotal) * 100) : 0;

  let status: PoBillStatus;
  if (input.bills.length === 0) status = "unbilled";
  else if (billedGross > poTotal + TOL) status = "over_billed";
  else if (billedGross >= poTotal - TOL) status = "fully_billed";
  else status = "part_billed";

  return { poTotal, billedNet, billedGross, remaining, pct, status, count: input.bills.length };
}

export const PO_BILL_STATUS_LABEL: Record<PoBillStatus, string> = {
  unbilled: "Unbilled",
  part_billed: "Part-billed",
  fully_billed: "Fully billed",
  over_billed: "Over-billed",
};

/** Tailwind accent for the status pill — matches the house palette elsewhere. */
export const PO_BILL_STATUS_CLASS: Record<PoBillStatus, string> = {
  unbilled: "bg-slate-100 text-slate-700",
  part_billed: "bg-amber-100 text-amber-800",
  fully_billed: "bg-green-100 text-green-800",
  over_billed: "bg-red-100 text-red-800",
};

import { formatGbp, round2, sumMoney, toPounds } from "@/lib/money";

/**
 * Committed-cost position for a job (Programme C) — the owner's answer to
 * "how much have we ORDERED against this job?", shown next to actual costs
 * (`finances`) and profit.
 *
 * PURE aggregation over the job's purchase orders — no stored figure. A PO is
 * committed spend; the ACTUAL cost lands separately in `finances` when the
 * supplier's expense is recorded, so the two are never conflated. Cancelled POs
 * are excluded; `received` is surfaced separately (goods in, cost imminent).
 *
 * Warehouse M1 split `partially_received` out of the middle. Before goods
 * received notes existed the only choices were "on order" and "received", so a
 * half-delivered order had to be filed as one or the other and the owner was
 * told a number they could not act on. It is now its own bucket:
 *
 *   onOrder            draft + sent            nothing on site yet
 *   partiallyReceived  partially_received      some of it is on site
 *   received           received                all of it is on site
 *   committed          the sum of all three    total live commitment
 *
 * The three sub-buckets stay disjoint, so `committed` is unchanged for every
 * PO that predates receiving — a partially received order was previously
 * counted in `onOrder` and is now counted in its own bucket, but the headline
 * commitment figure and the PO count are identical either way.
 */

export type CommittedPo = {
  status: string;
  /** GROSS ordered value (`purchase_orders.total` = subtotal + vat_total). */
  total: number | string | null;
  /**
   * EX-VAT ordered value (`purchase_orders.subtotal`). Optional so the existing
   * gross-only callers keep compiling and keep behaving identically.
   *
   * It matters because `total` is VAT-INCLUSIVE while every ACTUAL cost in the
   * product (`finances.amount`, the whole profitability feed) is ex-VAT. Any
   * figure that ADDS a commitment to an actual cost — a forecast final cost, a
   * budget variance — must use this one or it overstates by up to 20 % on a job
   * that is exactly on plan.
   */
  subtotal?: number | string | null;
  /**
   * Ex-VAT supplier bills ALREADY posted against this specific PO
   * (Σ `finances.amount` where `purchase_order_id` = this PO). Optional; absent
   * means "not supplied", which is treated as nothing billed yet.
   *
   * This is what makes `remaining` sound: `finances.purchase_order_id` (20261009)
   * is the only link between a commitment and the cost that discharges it, so
   * without it a received-and-billed PO would be counted twice — once as
   * committed and once as actual — in any figure that adds the two.
   */
  billed?: number | string | null;
};

export type CommittedCostPosition = {
  /** Non-cancelled ordered value: draft + sent + partially_received + received. */
  committed: number;
  /** Ordered, nothing delivered yet (draft + sent). */
  onOrder: number;
  /** Part-delivered — some of the order is on site, the rest is outstanding. */
  partiallyReceived: number;
  /** Received in full — goods/services in, cost about to be actualised. */
  received: number;
  /** Count of non-cancelled POs. */
  count: number;
  /** `committed`, EX-VAT — comparable with actual cost. Only POs that supplied a `subtotal`. */
  committedNet: number;
  /** Σ bills already posted against those POs, ex-VAT (each capped at its own PO's net). */
  billedAgainst: number;
  /**
   * Σ per-PO max(0, subtotal − billed), ex-VAT: the commitment NOT yet in
   * `finances`. This is the "cost to complete" half of a forecast final cost.
   *
   * Floored PER PO, never on the total — the `cash.ts` per-invoice rule for the
   * same reason: an over-billed order must not create negative headroom that
   * silently pays down another order's outstanding commitment and hides it.
   *
   * `draft` orders are included, because `committed` has counted them since
   * Programme C and one figure disagreeing with the other on the same page is
   * worse than either definition. It errs HIGH, which is the only tolerable
   * direction for a cost forecast.
   */
  remaining: number;
  /**
   * Live POs that supplied no `subtotal`, so contributed to none of the three
   * net figures. Always 0 in the app (a caller that forgets the column is a bug,
   * pinned on source) — it exists so a forgotten column reads as "unknown"
   * rather than silently as "£0 still to come".
   */
  netUnknown: number;
};

const LIVE = new Set(["draft", "sent", "partially_received", "received"]);

export function computeCommittedCosts(pos: CommittedPo[]): CommittedCostPosition {
  const live = pos.filter((p) => LIVE.has(p.status));
  const bucket = (...statuses: string[]) =>
    sumMoney(live.filter((p) => statuses.includes(p.status)).map((p) => p.total));

  const onOrder = bucket("draft", "sent");
  const partiallyReceived = bucket("partially_received");
  const received = bucket("received");

  // Ex-VAT commitment, netted against what has already been billed for it.
  const withNet = live.filter((p) => p.subtotal != null);
  const committedNet = sumMoney(withNet.map((p) => p.subtotal));
  let billedAgainst = 0;
  let remaining = 0;
  for (const p of withNet) {
    const net = toPounds(p.subtotal);
    // Clamped to [0, net] at BOTH ends. The upper bound stops an over-billed
    // order lending negative headroom to another (see `remaining`); the lower
    // bound stops credit notes that exceed the bills on one order from pushing
    // its "still to come" ABOVE the value actually ordered.
    const billed = Math.min(Math.max(0, toPounds(p.billed)), net);
    billedAgainst = round2(billedAgainst + billed);
    remaining = round2(remaining + Math.max(0, round2(net - billed)));
  }

  return {
    committed: round2(onOrder + partiallyReceived + received),
    onOrder,
    partiallyReceived,
    received,
    count: live.length,
    committedNet,
    billedAgainst,
    remaining,
    netUnknown: live.length - withNet.length,
  };
}

export function hasCommittedCosts(p: CommittedCostPosition): boolean {
  return p.count > 0;
}

export { formatGbp };

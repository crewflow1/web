import { formatGbp, round2, sumMoney } from "@/lib/money";

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

export type CommittedPo = { status: string; total: number | string | null };

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
};

const LIVE = new Set(["draft", "sent", "partially_received", "received"]);

export function computeCommittedCosts(pos: CommittedPo[]): CommittedCostPosition {
  const live = pos.filter((p) => LIVE.has(p.status));
  const bucket = (...statuses: string[]) =>
    sumMoney(live.filter((p) => statuses.includes(p.status)).map((p) => p.total));

  const onOrder = bucket("draft", "sent");
  const partiallyReceived = bucket("partially_received");
  const received = bucket("received");
  return {
    committed: round2(onOrder + partiallyReceived + received),
    onOrder,
    partiallyReceived,
    received,
    count: live.length,
  };
}

export function hasCommittedCosts(p: CommittedCostPosition): boolean {
  return p.count > 0;
}

export { formatGbp };

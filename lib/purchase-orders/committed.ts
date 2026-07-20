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
 */

export type CommittedPo = { status: string; total: number | string | null };

export type CommittedCostPosition = {
  /** Non-cancelled ordered value: draft + sent + received. */
  committed: number;
  /** Ordered but not yet received (draft + sent). */
  onOrder: number;
  /** Received — goods/services in, cost about to be actualised. */
  received: number;
  /** Count of non-cancelled POs. */
  count: number;
};

const LIVE = new Set(["draft", "sent", "received"]);

export function computeCommittedCosts(pos: CommittedPo[]): CommittedCostPosition {
  const live = pos.filter((p) => LIVE.has(p.status));
  const received = sumMoney(live.filter((p) => p.status === "received").map((p) => p.total));
  const onOrder = sumMoney(live.filter((p) => p.status === "draft" || p.status === "sent").map((p) => p.total));
  return {
    committed: round2(onOrder + received),
    onOrder,
    received,
    count: live.length,
  };
}

export function hasCommittedCosts(p: CommittedCostPosition): boolean {
  return p.count > 0;
}

export { formatGbp };

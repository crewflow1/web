import { round2 } from "@/lib/money";
import {
  computeMaterialFulfilment,
  isMaterialRequestOverdue,
  type IssuedQty,
  type MaterialRequestLineRow,
} from "@/lib/material-requests/fulfilment";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * MATERIAL DEMAND AGGREGATE — requested-not-yet-fulfilled quantity by item,
 * org-wide. PURE. QUANTITIES ONLY.
 *
 * ── THE D1 BOUNDARY: NO MONEY, ANYWHERE ─────────────────────────────────────
 * Operational stock is quantity-only by CEO decision D1 (still open), and a
 * security test enforces that no stock surface posts to or derives from
 * `finances`. This module holds the same line: there is no amount, no
 * valuation, no unit price, and no import from lib/money beyond `round2` on
 * QUANTITIES (which share money's 2dp discipline because
 * material_request_lines.qty is numeric(12,2) — the fulfilment module's own
 * note). Pricing demand would be a second valuation lane; refused.
 *
 * ── COMPOSITION ─────────────────────────────────────────────────────────────
 * Per-request outstanding comes from `computeMaterialFulfilment` — the ONE
 * fulfilment authority (mirroring `material_request_state()` in the DB,
 * corrections excluded by the stock seam that supplies `issued`). This module
 * only GROUPS its per-line outputs by item. The clamp rule (issued capped at
 * requested per line) is therefore the authority's, not a re-implementation.
 *
 * ── WHAT "DEMAND" MEANS HERE ────────────────────────────────────────────────
 *   live demand        requests in `approved` / `partially_fulfilled` — the
 *                      office has said yes and the yard owes the site.
 *   awaiting approval  `submitted` — asked for, not yet demand. Counted
 *                      separately, never folded into outstanding: adding an
 *                      unapproved ask to the pick list is how a rejected
 *                      request gets bought anyway.
 * Terminal requests (fulfilled / rejected / cancelled) and drafts contribute
 * nothing.
 *
 * ── ITEM IDENTITY ───────────────────────────────────────────────────────────
 * `stock_item_id` when present (the frozen cross-lane uuid), else the
 * normalised free-text description + unit. Free text is the PRIMARY request
 * path (20261066 header), so two sites asking for "Cement 25kg" merge, while
 * "Cement 25kg" and "Cement 25kg" in different UNITS deliberately do not —
 * summing bags with pallets would manufacture a number.
 *
 * ── WHEN THE STOCK LANE IS UNREACHABLE ──────────────────────────────────────
 * `stockModulePending` means issued quantities are UNKNOWN, not zero, so
 * per-item `outstanding` is null and `measurable` is false. Rendering
 * requested-as-outstanding would over-order everything already issued;
 * rendering zero would starve the site. The surface says "can't measure",
 * which is the only honest sentence available (the seam's own doctrine).
 */

/** Statuses that constitute LIVE demand. */
export const DEMAND_STATUSES = ["approved", "partially_fulfilled"] as const;

export type DemandRequest = {
  id: string;
  status: string;
  needed_by: string | null;
  job_id: string | null;
};

export type DemandLine = MaterialRequestLineRow & {
  material_request_id: string;
};

export type ItemDemand = {
  /** Grouping key — stock item uuid, or normalised text key. */
  key: string;
  stockItemId: string | null;
  /** Display label: the first-seen line description (trimmed). */
  label: string;
  unit: string;
  requested: number;
  /** Null when the stock lane is unreachable (unknown ≠ zero). */
  outstanding: number | null;
  /** Open requests asking for this item. */
  requestCount: number;
};

export type MaterialDemand = {
  /** False when issued quantities could not be measured (stock lane absent). */
  measurable: boolean;
  items: ItemDemand[];
  /** Σ outstanding across items, or null when not measurable. */
  totalOutstanding: number | null;
  openRequestCount: number;
  /** `submitted` requests — asked, not yet approved. Separate, never summed. */
  awaitingApprovalCount: number;
  /** Open (non-terminal) requests past their needed-by date. */
  overdueCount: number;
};

function itemKey(line: DemandLine): { key: string; stockItemId: string | null; unit: string } {
  const unit = line.unit?.trim() || "ea";
  if (line.stock_item_id) {
    return { key: `stock:${line.stock_item_id}`, stockItemId: line.stock_item_id, unit };
  }
  return {
    key: `text:${line.description.trim().toLowerCase()}|${unit.toLowerCase()}`,
    stockItemId: null,
    unit,
  };
}

export function computeMaterialDemand(input: {
  requests: DemandRequest[];
  lines: DemandLine[];
  issued: IssuedQty[];
  stockModulePending: boolean;
  todayIso: string;
}): MaterialDemand {
  const demandSet = new Set<string>(DEMAND_STATUSES);
  const open = input.requests.filter((r) => demandSet.has(r.status));
  const awaitingApproval = input.requests.filter((r) => r.status === "submitted");

  const linesByRequest = new Map<string, DemandLine[]>();
  for (const line of input.lines) {
    const list = linesByRequest.get(line.material_request_id);
    if (list) list.push(line);
    else linesByRequest.set(line.material_request_id, [line]);
  }

  type Acc = {
    stockItemId: string | null;
    label: string;
    unit: string;
    requested: number;
    outstanding: number;
    requests: Set<string>;
  };
  const byItem = new Map<string, Acc>();

  for (const req of open) {
    const reqLines = linesByRequest.get(req.id) ?? [];
    if (reqLines.length === 0) continue;
    // THE fulfilment authority, per request. It sums issues by line id and
    // ignores rows for other lines, so the whole issue set can be passed.
    const position = computeMaterialFulfilment({
      lines: reqLines,
      issued: input.issued,
      stockModulePending: input.stockModulePending,
    });
    const lineById = new Map(reqLines.map((l) => [l.id, l]));
    for (const lf of position.lines) {
      const source = lineById.get(lf.lineId);
      if (!source) continue;
      const { key, stockItemId, unit } = itemKey(source);
      const acc =
        byItem.get(key) ??
        ({
          stockItemId,
          label: source.description.trim(),
          unit,
          requested: 0,
          outstanding: 0,
          requests: new Set<string>(),
        } as Acc);
      acc.requested = round2(acc.requested + lf.requested);
      acc.outstanding = round2(acc.outstanding + lf.outstanding);
      acc.requests.add(req.id);
      byItem.set(key, acc);
    }
  }

  const measurable = !input.stockModulePending;
  const items: ItemDemand[] = [...byItem.entries()].map(([key, acc]) => ({
    key,
    stockItemId: acc.stockItemId,
    label: acc.label,
    unit: acc.unit,
    requested: acc.requested,
    outstanding: measurable ? acc.outstanding : null,
    requestCount: acc.requests.size,
  }));

  // Deterministic: most outstanding first (requested when unmeasurable),
  // then label, then key.
  items.sort(
    (a, b) =>
      (b.outstanding ?? b.requested) - (a.outstanding ?? a.requested) ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );

  const overdueCount = input.requests.filter((r) =>
    isMaterialRequestOverdue(r, input.todayIso),
  ).length;

  return {
    measurable,
    items,
    totalOutstanding: measurable
      ? round2(items.reduce((s, i) => s + (i.outstanding ?? 0), 0))
      : null,
    openRequestCount: open.length,
    awaitingApprovalCount: awaitingApproval.length,
    overdueCount,
  };
}

/** DERIVED — request lines minus issue movements, per the fulfilment authority. */
export function materialDemandMetric(d: MaterialDemand): LabelledMetric<MaterialDemand> {
  return labelled(d, {
    kind: "derived",
    basis:
      "Approved material requests' quantities minus stock issues recorded against each line " +
      "(corrections excluded), grouped by item — quantities only, no valuation. Requests " +
      "awaiting approval are counted separately and never added to the pick list. When the " +
      "stock module can't be reached, outstanding shows as unmeasurable rather than as the " +
      "full requested amount or as zero — unknown is not a number.",
    computedFrom: [{ label: "Material requests", href: "/materials/requests" }],
  });
}

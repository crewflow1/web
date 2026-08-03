import { describe, it, expect } from "vitest";
import {
  computeReplenishment,
  suggestReplenishment,
  type ReorderItemInput,
} from "@/lib/stock/reorder";

/**
 * OPERATIONAL STOCK — the replenishment rule (lib/stock/reorder.ts).
 *
 * The numbers here are the exact numbers a buyer acts on. Three properties
 * matter and each has a block:
 *
 *   THE BOUNDARY   at the reorder point counts (inclusive), one above does not.
 *   HONESTY        no threshold → not listed; below the point but no way to work
 *                  out a quantity → not listed. A suggestion is never invented.
 *   PRECEDENCE     a fixed reorder quantity beats the order-up-to shortfall.
 */

const base: ReorderItemInput = {
  id: "i-1",
  name: "Cement 25kg",
  unit: "bag",
  active: true,
  available: 10,
  reorderPoint: 20,
  reorderQuantity: null,
  targetLevel: null,
};
const item = (o: Partial<ReorderItemInput>): ReorderItemInput => ({ ...base, ...o });

describe("the reorder-point boundary", () => {
  it("BELOW the point, with a fixed batch, is a suggestion", () => {
    const s = suggestReplenishment(item({ available: 10, reorderPoint: 20, reorderQuantity: 50 }));
    expect(s).not.toBeNull();
    expect(s?.suggestedQuantity).toBe(50);
    expect(s?.basis).toBe("fixed_batch");
  });

  it("AT the point counts as low — the boundary is INCLUSIVE (matches stockLevel)", () => {
    expect(suggestReplenishment(item({ available: 20, reorderPoint: 20, reorderQuantity: 5 }))).not.toBeNull();
  });

  it("ABOVE the point is NOT listed", () => {
    expect(suggestReplenishment(item({ available: 20.01, reorderPoint: 20, reorderQuantity: 5 }))).toBeNull();
    expect(suggestReplenishment(item({ available: 100, reorderPoint: 20, reorderQuantity: 5 }))).toBeNull();
  });

  it("a zero or negative balance is still below any positive point", () => {
    expect(suggestReplenishment(item({ available: 0, reorderPoint: 20, reorderQuantity: 5 }))?.suggestedQuantity).toBe(5);
    // a negative can only arrive from a direct write; it is still 'buy some'.
    expect(suggestReplenishment(item({ available: -4, reorderPoint: 20, reorderQuantity: 5 }))?.suggestedQuantity).toBe(5);
  });
});

describe("honesty — only a set threshold, never a fabricated quantity", () => {
  it("NO reorder point → not listed (the long tail nobody tracks)", () => {
    expect(suggestReplenishment(item({ reorderPoint: null, reorderQuantity: 50, targetLevel: 100 }))).toBeNull();
  });

  it("below the point but NO quantity source → not listed", () => {
    // reorder point set, but neither a fixed batch nor a target — nothing to
    // honestly suggest, so it produces no line.
    expect(suggestReplenishment(item({ available: 5, reorderPoint: 20, reorderQuantity: null, targetLevel: null }))).toBeNull();
  });

  it("a retired item is never re-ordered, even when below its point", () => {
    expect(suggestReplenishment(item({ active: false, available: 0, reorderPoint: 20, reorderQuantity: 50 }))).toBeNull();
  });

  it("a target already met (or exceeded) yields no suggestion, not a zero/negative one", () => {
    // below the reorder point but available already >= target: shortfall <= 0.
    expect(
      suggestReplenishment(item({ available: 18, reorderPoint: 20, reorderQuantity: null, targetLevel: 15 })),
    ).toBeNull();
  });

  it("a zero fixed batch is ignored (the DB forbids it too) and falls back to target", () => {
    const s = suggestReplenishment(item({ available: 10, reorderPoint: 20, reorderQuantity: 0, targetLevel: 100 }));
    expect(s?.basis).toBe("order_up_to");
    expect(s?.suggestedQuantity).toBe(90);
  });
});

describe("policy precedence and the order-up-to fallback", () => {
  it("a fixed reorder quantity TAKES PRECEDENCE over the target shortfall", () => {
    const s = suggestReplenishment(item({ available: 10, reorderPoint: 20, reorderQuantity: 40, targetLevel: 100 }));
    expect(s?.suggestedQuantity).toBe(40); // the batch, not 90 (100 − 10)
    expect(s?.basis).toBe("fixed_batch");
  });

  it("with no fixed batch, buys the shortfall to target", () => {
    const s = suggestReplenishment(item({ available: 10, reorderPoint: 20, reorderQuantity: null, targetLevel: 100 }));
    expect(s?.suggestedQuantity).toBe(90);
    expect(s?.basis).toBe("order_up_to");
  });

  it("keeps decimals exact (12.5 m³ concrete)", () => {
    const s = suggestReplenishment(
      item({ unit: "m3", available: 2.25, reorderPoint: 5, reorderQuantity: null, targetLevel: 12.5 }),
    );
    expect(s?.suggestedQuantity).toBe(10.25);
  });
});

describe("computeReplenishment — the worklist", () => {
  const items: ReorderItemInput[] = [
    item({ id: "i-b", name: "Blocks", available: 0, reorderPoint: 50, reorderQuantity: 200 }),
    item({ id: "i-c", name: "Cement", available: 20, reorderPoint: 20, targetLevel: 100 }),
    item({ id: "i-a", name: "Ally trim", available: 800, reorderPoint: null }), // untracked
    item({ id: "i-ok", name: "Screws", available: 900, reorderPoint: 100, reorderQuantity: 500 }), // healthy
    item({ id: "i-x", name: "Odd item", available: 1, reorderPoint: 10 }), // no qty source
  ];

  it("lists only the actionable below-point items", () => {
    const out = computeReplenishment(items);
    expect(out.map((s) => s.itemId)).toEqual(["i-b", "i-c"]);
  });

  it("orders worst (most depleted) first, then name, then id — a stable total order", () => {
    const tied = computeReplenishment([
      item({ id: "z", name: "Same", available: 5, reorderPoint: 10, reorderQuantity: 1 }),
      item({ id: "a", name: "Same", available: 5, reorderPoint: 10, reorderQuantity: 1 }),
    ]);
    expect(tied.map((s) => s.itemId)).toEqual(["a", "z"]);
    const reversed = computeReplenishment([
      item({ id: "a", name: "Same", available: 5, reorderPoint: 10, reorderQuantity: 1 }),
      item({ id: "z", name: "Same", available: 5, reorderPoint: 10, reorderQuantity: 1 }),
    ]);
    expect(reversed.map((s) => s.itemId)).toEqual(tied.map((s) => s.itemId));
  });

  it("returns an empty list, never throws, when nothing is low", () => {
    expect(computeReplenishment([item({ available: 900, reorderPoint: 100, reorderQuantity: 5 })])).toEqual([]);
  });
});

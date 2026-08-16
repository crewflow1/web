import { describe, it, expect } from "vitest";
import {
  buildLinePositions,
  computeVariance,
  friendlyStocktakeError,
  isStocktakeLive,
  isStocktakeStatus,
  lineState,
  normaliseScanCode,
  STOCKTAKE_STATUSES,
  stocktakeStatusLabel,
  summariseLines,
  type StocktakeItemRefInput,
  type StocktakeLineRowInput,
} from "@/lib/stocktake/schema";

/**
 * STOCKTAKE pure maths — the deterministic variance rule and the read
 * derivations, unit-tested directly (no I/O). The DATABASE is the enforcement
 * boundary for lifecycle/authority; this covers the numbers the UI prints, which
 * must match what the posting RPC decides.
 */

describe("variance is deterministic: counted − expected", () => {
  it("is zero on a match, positive on a surplus, negative on a shortfall", () => {
    expect(computeVariance(40, 40)).toBe(0);
    expect(computeVariance(40, 52)).toBe(12);
    expect(computeVariance(40, 28)).toBe(-12);
  });

  it("holds the 2dp discipline of every other stock quantity", () => {
    expect(computeVariance(12.5, 12.53)).toBe(0.03);
    expect(computeVariance("10.005", "10")).toBe(-0.01);
  });

  it("treats a null/blank expected or counted as zero", () => {
    expect(computeVariance(null, 5)).toBe(5);
    expect(computeVariance(5, null)).toBe(-5);
    expect(computeVariance("", "")).toBe(0);
  });
});

describe("lineState classifies a count against its snapshot", () => {
  it("is uncounted until a count is entered", () => {
    expect(lineState(40, null)).toBe("uncounted");
    expect(lineState(40, undefined)).toBe("uncounted");
    expect(lineState(40, "")).toBe("uncounted");
  });
  it("distinguishes match / over / short", () => {
    expect(lineState(40, 40)).toBe("match");
    expect(lineState(40, 41)).toBe("over");
    expect(lineState(40, 39)).toBe("short");
  });
  it("counts an explicit zero as a real count, not as uncounted", () => {
    // A shelf counted to nothing is a REAL fact (and a variance if expected > 0),
    // never the same as "not yet counted".
    expect(lineState(10, 0)).toBe("short");
    expect(lineState(0, 0)).toBe("match");
  });
});

describe("the lifecycle vocabulary", () => {
  it("progresses open → counting → posted, plus cancelled", () => {
    expect(STOCKTAKE_STATUSES).toEqual(["open", "counting", "posted", "cancelled"]);
  });
  it("is live only while open or counting", () => {
    expect(isStocktakeLive("open")).toBe(true);
    expect(isStocktakeLive("counting")).toBe(true);
    expect(isStocktakeLive("posted")).toBe(false);
    expect(isStocktakeLive("cancelled")).toBe(false);
  });
  it("labels known statuses and passes unknown ones through", () => {
    expect(stocktakeStatusLabel("counting")).toBe("Counting");
    expect(isStocktakeStatus("posted")).toBe(true);
    expect(isStocktakeStatus("nope")).toBe(false);
    expect(stocktakeStatusLabel("weird")).toBe("weird");
  });
});

describe("buildLinePositions joins the catalogue and orders worst-first", () => {
  const items = new Map<string, StocktakeItemRefInput>([
    ["a", { id: "a", name: "Cement 25kg", unit: "bag", sku: "CEM-25", barcode: "5012345678900" }],
    ["b", { id: "b", name: "Blocks", unit: "ea", sku: null, barcode: null }],
    ["c", { id: "c", name: "Angle bead", unit: "length" }],
    ["d", { id: "d", name: "Membrane", unit: "roll" }],
  ]);
  const lines: StocktakeLineRowInput[] = [
    { id: "l1", stock_item_id: "a", expected_qty: 40, counted_qty: 40, posted_movement_id: null, posted_variance: null }, // match
    { id: "l2", stock_item_id: "b", expected_qty: 100, counted_qty: 88, posted_movement_id: null, posted_variance: null }, // short
    { id: "l3", stock_item_id: "c", expected_qty: 12, counted_qty: null, posted_movement_id: null, posted_variance: null }, // uncounted
    { id: "l4", stock_item_id: "d", expected_qty: 5, counted_qty: 9, posted_movement_id: null, posted_variance: null }, // over
  ];

  it("derives the variance and state per line and resolves the item", () => {
    const positions = buildLinePositions(lines, items);
    const byItem = new Map(positions.map((p) => [p.stockItemId, p]));
    expect(byItem.get("b")!.variance).toBe(-12);
    expect(byItem.get("b")!.state).toBe("short");
    expect(byItem.get("d")!.variance).toBe(4);
    expect(byItem.get("a")!.name).toBe("Cement 25kg");
    expect(byItem.get("a")!.barcode).toBe("5012345678900");
    expect(byItem.get("c")!.variance).toBeNull();
  });

  it("orders shortfalls first, then surpluses, then uncounted, then matches", () => {
    const order = buildLinePositions(lines, items).map((p) => p.stockItemId);
    expect(order).toEqual(["b", "d", "c", "a"]);
  });

  it("is a total order — stable for any read permutation", () => {
    const shuffled = [lines[3]!, lines[0]!, lines[2]!, lines[1]!];
    const a = buildLinePositions(lines, items).map((p) => p.id);
    const b = buildLinePositions(shuffled, items).map((p) => p.id);
    expect(a).toEqual(b);
  });
});

describe("summariseLines totals what the tiles show", () => {
  const items = new Map<string, StocktakeItemRefInput>([
    ["a", { id: "a", name: "A" }],
    ["b", { id: "b", name: "B" }],
    ["c", { id: "c", name: "C" }],
  ]);
  it("counts counted/uncounted/variances and the signed net", () => {
    const positions = buildLinePositions(
      [
        { id: "1", stock_item_id: "a", expected_qty: 10, counted_qty: 12, posted_movement_id: null, posted_variance: null }, // +2
        { id: "2", stock_item_id: "b", expected_qty: 20, counted_qty: 15, posted_movement_id: null, posted_variance: null }, // -5
        { id: "3", stock_item_id: "c", expected_qty: 5, counted_qty: null, posted_movement_id: null, posted_variance: null }, // uncounted
      ],
      items,
    );
    const s = summariseLines(positions);
    expect(s.totalLines).toBe(3);
    expect(s.counted).toBe(2);
    expect(s.uncounted).toBe(1);
    expect(s.variances).toBe(2);
    expect(s.netVariance).toBe(-3); // +2 − 5
  });
  it("a fully-matched count has zero variances and zero net", () => {
    const positions = buildLinePositions(
      [{ id: "1", stock_item_id: "a", expected_qty: 10, counted_qty: 10, posted_movement_id: null, posted_variance: null }],
      items,
    );
    const s = summariseLines(positions);
    expect(s.counted).toBe(1);
    expect(s.variances).toBe(0);
    expect(s.netVariance).toBe(0);
  });
});

describe("scan code normalisation", () => {
  it("trims and lowercases so a scan matches regardless of case/space", () => {
    expect(normaliseScanCode("  5012345678900 ")).toBe("5012345678900");
    expect(normaliseScanCode("CEM-25")).toBe("cem-25");
  });
});

describe("friendlyStocktakeError maps the RPC refusals to sentences", () => {
  it("names the admin-only post gate", () => {
    expect(friendlyStocktakeError("insufficient_privilege", "only an owner or admin can post a stocktake")).toMatch(
      /owner or admin/i,
    );
  });
  it("explains a floor breach during posting as a recount", () => {
    expect(
      friendlyStocktakeError("check_violation", "cannot write off 40 of Blocks: only 10 in stock at this site"),
    ).toMatch(/recount/i);
  });
  it("maps the barcode uniqueness violation", () => {
    expect(
      friendlyStocktakeError("23505", 'duplicate key value violates unique constraint "stock_items_org_barcode_unique"'),
    ).toMatch(/barcode/i);
  });
  it("requires at least one count before posting", () => {
    expect(friendlyStocktakeError("check_violation", "count at least one item before posting")).toMatch(
      /count at least one/i,
    );
  });
  it("falls back loudly on an unmapped error", () => {
    expect(friendlyStocktakeError(undefined, "some driver noise")).toBe("Couldn't record that. Try again.");
  });
});

import { describe, it, expect } from "vitest";
import {
  balanceKey,
  buildItemPositions,
  foldItemTotals,
  foldSiteBalances,
  isLowStock,
  lowStockLines,
  stockLevel,
  summariseStock,
  type MovementRow,
} from "@/lib/stock/balance";
import {
  formatEffect,
  formatQuantity,
  hasDerivableSign,
  movementDirection,
  movementEffect,
  movementSign,
  movementTypeLabel,
  MOVEMENT_TYPES,
} from "@/lib/stock/movements";

/**
 * O3 OPERATIONAL STOCK — the pure core.
 *
 * The numbers asserted here are the exact numbers a builder sees, because the
 * pages fold with these same functions. Three properties matter most and each
 * has its own block below:
 *
 *   SIGNED EFFECTS   the six derivable types agree with the SQL trigger, and a
 *                    `correction` is read off the row rather than re-derived.
 *   CONSERVATION     a transfer pair sums to zero, so the company total is
 *                    identical before and after — the invariant the RPC holds
 *                    in one transaction and the fold must not lose.
 *   LOW-STOCK        the boundary is INCLUSIVE, and a missing threshold is
 *                    silence rather than a false all-clear.
 */

const ITEM = "11111111-1111-1111-1111-111111111111";
const ITEM2 = "11111111-1111-1111-1111-111111111112";
const DEPOT = "22222222-2222-2222-2222-222222222221";
const YARD = "22222222-2222-2222-2222-222222222222";

let seq = 0;
function mv(
  type: string,
  qty: number,
  opts: { item?: string; site?: string; effect?: number | string | null } = {},
): MovementRow {
  seq += 1;
  return {
    id: `m-${seq}`,
    stock_item_id: opts.item ?? ITEM,
    site_id: opts.site ?? DEPOT,
    movement_type: type,
    qty,
    effect: opts.effect,
    occurred_at: "2026-07-29T09:00:00Z",
  };
}

// ── signed effects ───────────────────────────────────────────────────────────

describe("signed effects mirror the database", () => {
  it("adds for receipt / transfer_in / adjustment_in", () => {
    for (const t of ["receipt", "transfer_in", "adjustment_in"] as const) {
      expect(movementSign(t), t).toBe(1);
      expect(movementEffect({ movement_type: t, qty: 12.5 })).toBe(12.5);
    }
  });

  it("subtracts for issue / transfer_out / adjustment_out", () => {
    for (const t of ["issue", "transfer_out", "adjustment_out"] as const) {
      expect(movementSign(t), t).toBe(-1);
      expect(movementEffect({ movement_type: t, qty: 12.5 })).toBe(-12.5);
    }
  });

  it("a correction's direction is NOT derivable from its type — it is read off the row", () => {
    // The whole reason `effect` is stored: a correction reverses whatever it
    // names, so its sign depends on ANOTHER row. Re-deriving it here would be
    // the bug, and `movementSign` returning 0 is what makes that impossible to
    // do by accident.
    expect(hasDerivableSign("correction")).toBe(false);
    expect(movementSign("correction")).toBe(0);
    expect(movementEffect({ movement_type: "correction", qty: 40 })).toBe(0);
    // With the stored effect present, both directions are honoured exactly.
    expect(movementEffect({ movement_type: "correction", qty: 40, effect: -40 })).toBe(-40);
    expect(movementEffect({ movement_type: "correction", qty: 40, effect: 40 })).toBe(40);
  });

  it("prefers the STORED effect over the derivable one, for every type", () => {
    // The database is the authority. If the two ever disagreed, showing the
    // app's guess would hide the disagreement.
    expect(movementEffect({ movement_type: "issue", qty: 10, effect: -7 })).toBe(-7);
  });

  it("handles PostgREST's numeric-as-string without drifting", () => {
    expect(movementEffect({ movement_type: "receipt", qty: "12.50" })).toBe(12.5);
    expect(movementEffect({ movement_type: "issue", qty: "0.05" })).toBe(-0.05);
  });

  it("an unknown type contributes nothing rather than guessing", () => {
    expect(movementEffect({ movement_type: "teleported", qty: 99 })).toBe(0);
    expect(movementTypeLabel("teleported")).toBe("teleported");
  });

  it("every declared type has a label and a direction", () => {
    for (const t of MOVEMENT_TYPES) {
      expect(movementTypeLabel(t), t).not.toBe(t);
      expect(["in", "out", "none"]).toContain(movementDirection({ movement_type: t, qty: 1, effect: t === "correction" ? -1 : undefined }));
    }
  });

  it("formats the signed quantity the way a builder reads it", () => {
    expect(formatEffect({ movement_type: "receipt", qty: 40 })).toBe("+40");
    // 2dp for a decimal, matching the numeric(12,2) column and formatQuantity.
    expect(formatEffect({ movement_type: "issue", qty: 12.5 })).toBe("−12.50");
    expect(formatQuantity("40.00")).toBe("40");
    expect(formatQuantity(12.5)).toBe("12.50");
  });
});

// ── folding ──────────────────────────────────────────────────────────────────

describe("folding movements into balances", () => {
  it("sums per (item, site) and keys them without collision", () => {
    const balances = foldSiteBalances([
      mv("receipt", 100),
      mv("issue", 40),
      mv("receipt", 10, { site: YARD }),
      mv("receipt", 5, { item: ITEM2 }),
    ]);
    expect(balances.get(balanceKey(ITEM, DEPOT))?.quantity).toBe(60);
    expect(balances.get(balanceKey(ITEM, YARD))?.quantity).toBe(10);
    expect(balances.get(balanceKey(ITEM2, DEPOT))?.quantity).toBe(5);
    expect(balances.size).toBe(3);
  });

  it("KEEPS pairs that fold to zero — 'emptied' is a different answer from 'never here'", () => {
    const balances = foldSiteBalances([mv("receipt", 40), mv("issue", 40)]);
    expect(balances.get(balanceKey(ITEM, DEPOT))?.quantity).toBe(0);
    expect(balances.has(balanceKey(ITEM, YARD))).toBe(false);
  });

  it("totals per item across every site", () => {
    const totals = foldItemTotals([
      mv("receipt", 100),
      mv("receipt", 25, { site: YARD }),
      mv("issue", 30, { site: YARD }),
      mv("receipt", 5, { item: ITEM2 }),
    ]);
    expect(totals.get(ITEM)).toBe(95);
    expect(totals.get(ITEM2)).toBe(5);
  });

  it("accepts already-folded balances and produces the identical totals", () => {
    const movements = [mv("receipt", 100), mv("issue", 30), mv("receipt", 12.5, { site: YARD })];
    expect(foldItemTotals(movements)).toEqual(foldItemTotals(foldSiteBalances(movements)));
  });

  it("keeps 2dp exact across a long run — no float creep", () => {
    const movements = Array.from({ length: 300 }, () => mv("receipt", 0.1));
    expect(foldItemTotals(movements).get(ITEM)).toBe(30);
  });
});

// ── conservation ─────────────────────────────────────────────────────────────

describe("a transfer conserves the company's total", () => {
  it("the pair sums to zero, so the total is identical before and after", () => {
    const before = [mv("receipt", 100)];
    const totalBefore = foldItemTotals(before).get(ITEM);

    const after = [
      ...before,
      mv("transfer_out", 30, { site: DEPOT }),
      mv("transfer_in", 30, { site: YARD }),
    ];
    const balances = foldSiteBalances(after);

    expect(totalBefore).toBe(100);
    expect(foldItemTotals(after).get(ITEM)).toBe(100); // conserved
    expect(balances.get(balanceKey(ITEM, DEPOT))?.quantity).toBe(70);
    expect(balances.get(balanceKey(ITEM, YARD))?.quantity).toBe(30);
  });

  it("conserves a decimal quantity too (12.5 m³ of concrete)", () => {
    const rows = [
      mv("receipt", 12.5),
      mv("transfer_out", 6.25, { site: DEPOT }),
      mv("transfer_in", 6.25, { site: YARD }),
    ];
    expect(foldItemTotals(rows).get(ITEM)).toBe(12.5);
  });

  it("a correction and the movement it reverses also sum to zero", () => {
    const rows = [
      mv("receipt", 40),
      // the stored effect is what makes this exact — see the SQL trigger
      mv("correction", 40, { effect: -40 }),
    ];
    expect(foldItemTotals(rows).get(ITEM)).toBe(0);
  });
});

// ── the low-stock rule ───────────────────────────────────────────────────────

describe("low-stock boundaries", () => {
  it("is INCLUSIVE: at the reorder level counts as low", () => {
    expect(stockLevel(20, 20)).toBe("low");
    expect(stockLevel(20.01, 20)).toBe("ok");
    expect(stockLevel(19.99, 20)).toBe("low");
  });

  it("zero and below is 'out', threshold or not", () => {
    expect(stockLevel(0, 20)).toBe("out");
    expect(stockLevel(0, null)).toBe("out");
    // A negative can only arrive from a direct write that bypassed the RPCs.
    // It reads as 'out', loudly, not as a fourth state nobody has copy for.
    expect(stockLevel(-4, 20)).toBe("out");
  });

  it("no reorder level and stock on hand is 'untracked' — never a false all-clear", () => {
    expect(stockLevel(500, null)).toBe("untracked");
    expect(stockLevel(500, undefined)).toBe("untracked");
    expect(stockLevel(500, "")).toBe("untracked");
    expect(isLowStock(500, null)).toBe(false);
  });

  it("accepts PostgREST's numeric-as-string threshold", () => {
    expect(stockLevel(20, "20.00")).toBe("low");
    expect(stockLevel(21, "20.00")).toBe("ok");
  });

  it("isLowStock covers both attention states", () => {
    expect(isLowStock(0, 20)).toBe(true);
    expect(isLowStock(20, 20)).toBe(true);
    expect(isLowStock(21, 20)).toBe(false);
  });
});

// ── positions + summary ──────────────────────────────────────────────────────

const items = [
  { id: "i-b", name: "Blocks", unit: "ea", reorder_level: 50, target_level: 200 },
  { id: "i-c", name: "Cement", unit: "bag", reorder_level: 20, target_level: 100 },
  { id: "i-a", name: "Ally trim", unit: "length", reorder_level: null, target_level: null },
  { id: "i-r", name: "Retired thing", unit: "ea", active: false, reorder_level: 5, target_level: null },
];

describe("item positions", () => {
  const totals = new Map([
    ["i-b", 0], // out
    ["i-c", 20], // low (inclusive boundary)
    ["i-a", 800], // untracked
    ["i-r", 0], // retired AND out
  ]);
  const positions = buildItemPositions(items, totals);

  it("sorts out-of-stock first, then low, then healthy, then untracked", () => {
    expect(positions.map((p) => p.id)).toEqual(["i-b", "i-r", "i-c", "i-a"]);
  });

  it("is a TOTAL order — `id` breaks the final tie, so paging is stable", () => {
    const tied = buildItemPositions(
      [
        { id: "z", name: "Same", unit: "ea", reorder_level: null },
        { id: "a", name: "Same", unit: "ea", reorder_level: null },
      ],
      new Map([
        ["z", 5],
        ["a", 5],
      ]),
    );
    expect(tied.map((p) => p.id)).toEqual(["a", "z"]);
    // and the same input in the other order gives the identical output
    const reversed = buildItemPositions(
      [
        { id: "a", name: "Same", unit: "ea", reorder_level: null },
        { id: "z", name: "Same", unit: "ea", reorder_level: null },
      ],
      new Map([
        ["z", 5],
        ["a", 5],
      ]),
    );
    expect(reversed.map((p) => p.id)).toEqual(tied.map((p) => p.id));
  });

  it("computes the shortfall to target, floored at zero", () => {
    const byId = new Map(positions.map((p) => [p.id, p]));
    expect(byId.get("i-b")?.shortfall).toBe(200);
    expect(byId.get("i-c")?.shortfall).toBe(80);
    expect(byId.get("i-a")?.shortfall).toBeNull();
    const over = buildItemPositions(
      [{ id: "x", name: "X", unit: "ea", target_level: 10 }],
      new Map([["x", 40]]),
    );
    expect(over[0]?.shortfall).toBe(0);
  });

  it("defaults a missing unit to 'ea' rather than rendering nothing", () => {
    const p = buildItemPositions([{ id: "x", name: "X", unit: "  " }], new Map());
    expect(p[0]?.unit).toBe("ea");
    expect(p[0]?.available).toBe(0);
  });
});

describe("the overview summary", () => {
  const totals = new Map([
    ["i-b", 0],
    ["i-c", 20],
    ["i-a", 800],
    ["i-r", 0],
  ]);
  const positions = buildItemPositions(items, totals);
  const balances = foldSiteBalances([
    mv("receipt", 20, { item: "i-c" }),
    mv("receipt", 800, { item: "i-a", site: YARD }),
    mv("receipt", 40, { item: "i-b" }),
    mv("issue", 40, { item: "i-b" }), // folds to zero → that site is not "holding"
  ]);

  it("counts only ACTIVE items in the attention tiles", () => {
    const s = summariseStock(positions, balances);
    // i-r is retired AND at zero: a discontinued product sitting at zero is the
    // expected end state, and counting it would keep the tile red for ever.
    expect(s.outOfStock).toBe(1);
    expect(s.lowStock).toBe(1);
    expect(s.activeItems).toBe(3);
    expect(s.trackedItems).toBe(4);
  });

  it("counts only places actually HOLDING something", () => {
    const s = summariseStock(positions, balances);
    expect(s.sitesHolding).toBe(2); // depot (cement) + yard (trim); blocks folded to zero
  });

  it("lowStockLines is the briefing's input — active, out first", () => {
    expect(lowStockLines(positions).map((p) => p.id)).toEqual(["i-b", "i-c"]);
  });
});

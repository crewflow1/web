import { describe, it, expect } from "vitest";
import {
  buildStockCogsCostRows,
  buildValuationReport,
  foldItemValuations,
  isCosted,
  movementCostEffect,
  round4,
  stockCogsByJob,
  summariseValuation,
  weightedAverageUnitCost,
  type CostedMovementRow,
} from "@/lib/stock/valuation";
import { computeJobProfitability } from "@/lib/profitability/compute";

/**
 * W1 STOCK COGS — the weighted-average valuation core.
 *
 * The database stamps `cost_effect` / `unit_cost` onto each movement at insert
 * (tg_stock_movements_wavg_cost). This suite validates BOTH:
 *   1. the weighted-average ALGORITHM the trigger runs — reproduced here by
 *      `stamp`, the exact rule documented in the 20261180000000 header — and
 *   2. the read-side fold (`foldItemValuations` / the report / the COGS stream),
 *      which every surface uses and which must agree with the SQL view.
 *
 * Every number asserted is hand-computable from the sequence above it.
 */

const ITEM = "11111111-1111-1111-1111-111111111111";
const ITEM_B = "22222222-2222-2222-2222-222222222222";
const SITE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JOB = "99999999-9999-9999-9999-999999999999";
const JOB_2 = "88888888-8888-8888-8888-888888888888";

let seq = 0;
const nextId = () => `m-${String(++seq).padStart(4, "0")}`;

/**
 * Replay one movement through the SAME weighted-average rule the SQL trigger
 * applies, against a running pool, returning the fully-stamped row. `state`
 * tracks the (item) pool's book value and costed quantity, exactly as the
 * trigger reads them via `sum()` at insert.
 */
type Pool = { value: number; costedQty: number };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function stamp(
  state: Map<string, Pool>,
  m: {
    stock_item_id: string;
    site_id: string;
    movement_type: CostedMovementRow["movement_type"];
    qty: number;
    job_id?: string | null;
    /** For a receipt: the delivery line's ordered unit price. null = uncosted. */
    price?: number | null;
    /** For a correction: the row it reverses. */
    corrects?: CostedMovementRow | null;
    /** For a transfer_in: its paired transfer_out leg (it MIRRORS it). */
    pairedOut?: CostedMovementRow | null;
  },
): CostedMovementRow {
  const pool = state.get(m.stock_item_id) ?? { value: 0, costedQty: 0 };
  const avg = pool.costedQty > 0 ? round4(pool.value / pool.costedQty) : null;

  // Physical signed effect — the sign rule from lib/stock/movements.
  const sign =
    m.movement_type === "receipt" ||
    m.movement_type === "transfer_in" ||
    m.movement_type === "adjustment_in"
      ? 1
      : m.movement_type === "correction"
        ? (m.corrects ? -Math.sign(Number(m.corrects.effect)) : 0)
        : -1;
  const effect =
    m.movement_type === "correction" ? -Number(m.corrects?.effect ?? 0) : sign * m.qty;

  let unit_cost: number | null = null;
  let cost_effect: number | null = null;
  let costed_qty_effect: number | null = null;

  if (m.movement_type === "receipt") {
    if (m.price != null) {
      unit_cost = m.price;
      cost_effect = r2(m.qty * m.price);
      costed_qty_effect = m.qty;
    }
  } else if (
    m.movement_type === "issue" ||
    m.movement_type === "transfer_out" ||
    m.movement_type === "adjustment_out"
  ) {
    // RELEASE, CAPPED at the costed pool (the S1 boundary rule).
    if (pool.costedQty > 0 && avg != null) {
      const released = Math.min(m.qty, pool.costedQty);
      const valueReleased = released >= pool.costedQty ? pool.value : r2(released * avg);
      unit_cost = avg;
      cost_effect = -valueReleased;
      costed_qty_effect = -released;
    }
  } else if (m.movement_type === "transfer_in") {
    // MIRROR the paired transfer_out leg — cost-neutral even across the boundary.
    const out = m.pairedOut ?? null;
    const outCe = out ? movementCostEffect(out) : null;
    if (out != null && outCe != null) {
      unit_cost = out.unit_cost != null ? Number(out.unit_cost) : null;
      cost_effect = -outCe;
      costed_qty_effect =
        out.costed_qty_effect != null ? -Number(out.costed_qty_effect) : null;
    }
  } else if (m.movement_type === "adjustment_in") {
    // Found stock, re-entered at book cost; average unchanged.
    if (avg != null) {
      unit_cost = avg;
      cost_effect = r2(m.qty * avg);
      costed_qty_effect = m.qty;
    }
  } else {
    // correction: exact reversal of the row it names, in BOTH value and qty.
    const cc = m.corrects ? movementCostEffect(m.corrects) : null;
    if (cc != null) {
      unit_cost = m.corrects?.unit_cost != null ? Number(m.corrects.unit_cost) : null;
      cost_effect = -cc;
      costed_qty_effect =
        m.corrects?.costed_qty_effect != null ? -Number(m.corrects.costed_qty_effect) : null;
    }
  }

  // Advance the pool exactly as the trigger's next read would see it: value from
  // cost_effect, costed quantity from the CAPPED costed_qty_effect (never effect).
  if (cost_effect != null) pool.value = r2(pool.value + cost_effect);
  if (costed_qty_effect != null) pool.costedQty = r2(pool.costedQty + costed_qty_effect);
  state.set(m.stock_item_id, pool);

  return {
    id: nextId(),
    stock_item_id: m.stock_item_id,
    site_id: m.site_id,
    movement_type: m.movement_type,
    qty: m.qty,
    effect,
    unit_cost,
    cost_effect,
    costed_qty_effect,
    job_id: m.job_id ?? null,
    corrects_movement_id: m.corrects ? m.corrects.id : null,
  };
}

describe("weightedAverageUnitCost / round4", () => {
  it("is null with no costed quantity, and 4dp otherwise", () => {
    expect(weightedAverageUnitCost(0, 0)).toBeNull();
    expect(weightedAverageUnitCost(100, 0)).toBeNull();
    expect(weightedAverageUnitCost(60, 20)).toBe(3);
    // 10 @ 2.00 + 3 @ 3.3333 → book 29.9999 / 13 = 2.30768… → 4dp
    expect(round4(29.9999 / 13)).toBe(2.3077);
  });
});

describe("movementCostEffect treats blank / null as UNCOSTED, never zero", () => {
  it("distinguishes an unknown cost from a real zero", () => {
    expect(movementCostEffect({ cost_effect: null })).toBeNull();
    expect(movementCostEffect({ cost_effect: undefined })).toBeNull();
    expect(movementCostEffect({ cost_effect: "" })).toBeNull();
    expect(movementCostEffect({ cost_effect: 0 })).toBe(0);
    expect(movementCostEffect({ cost_effect: "12.50" })).toBe(12.5);
    expect(isCosted({ cost_effect: null })).toBe(false);
    expect(isCosted({ cost_effect: 0 })).toBe(true);
  });
});

describe("weighted-average recompute on receipts", () => {
  it("re-averages as receipts at different prices arrive", () => {
    const st = new Map<string, Pool>();
    const rows = [
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 2 }),
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 4 }),
    ];
    const v = foldItemValuations(rows).get(ITEM)!;
    // (10×2 + 10×4) / 20 = 3.00, book value 60.
    expect(v.onHand).toBe(20);
    expect(v.bookValue).toBe(60);
    expect(v.avgUnitCost).toBe(3);
    expect(v.uncostedQty).toBe(0);
  });

  it("a £0-priced (free-issue) receipt is COSTED at zero, not treated as unknown", () => {
    const st = new Map<string, Pool>();
    const rows = [
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 2 }),
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 0 }),
    ];
    const v = foldItemValuations(rows).get(ITEM)!;
    // 20 units, book 20 → avg 1.00. The zero pulls the average down honestly.
    expect(v.costedQty).toBe(20);
    expect(v.bookValue).toBe(20);
    expect(v.avgUnitCost).toBe(1);
  });
});

describe("COGS on issue is released at the weighted-average, which the issue preserves", () => {
  it("issues at the current average and the average does not move", () => {
    const st = new Map<string, Pool>();
    const rows = [
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 2 }),
      stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 4 }),
    ];
    const issue = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "issue",
      qty: 5,
      job_id: JOB,
    });
    // Released at 3.00: cost_effect −15.00.
    expect(issue.unit_cost).toBe(3);
    expect(issue.cost_effect).toBe(-15);

    const v = foldItemValuations([...rows, issue]).get(ITEM)!;
    expect(v.onHand).toBe(15);
    expect(v.bookValue).toBe(45);
    expect(v.avgUnitCost).toBe(3); // unchanged by the issue

    // A later receipt re-averages against the reduced pool.
    const later = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 5,
      price: 6,
    });
    const v2 = foldItemValuations([...rows, issue, later]).get(ITEM)!;
    // (45 + 30) / 20 = 3.75.
    expect(v2.bookValue).toBe(75);
    expect(v2.onHand).toBe(20);
    expect(v2.avgUnitCost).toBe(3.75);
  });
});

describe("a transfer pair nets to zero value at org level", () => {
  it("leaves book value and average unchanged", () => {
    const st = new Map<string, Pool>();
    const receipt = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 10,
      price: 3,
    });
    const out = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "transfer_out",
      qty: 4,
    });
    const inn = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_B,
      movement_type: "transfer_in",
      qty: 4,
      pairedOut: out,
    });
    expect(out.cost_effect).toBe(-12);
    expect(inn.cost_effect).toBe(12);
    const v = foldItemValuations([receipt, out, inn]).get(ITEM)!;
    expect(v.onHand).toBe(10);
    expect(v.bookValue).toBe(30);
    expect(v.avgUnitCost).toBe(3);
  });
});

describe("adjustments handle cost coherently", () => {
  it("adjustment_out writes off at the average; adjustment_in re-enters at book", () => {
    const st = new Map<string, Pool>();
    const receipt = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 10,
      price: 5,
    });
    const down = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "adjustment_out",
      qty: 2,
    });
    const up = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "adjustment_in",
      qty: 1,
    });
    expect(down.cost_effect).toBe(-10); // 2 × 5
    expect(up.cost_effect).toBe(5); // 1 × 5, average preserved
    const v = foldItemValuations([receipt, down, up]).get(ITEM)!;
    expect(v.onHand).toBe(9);
    expect(v.bookValue).toBe(45);
    expect(v.avgUnitCost).toBe(5);
  });
});

describe("a correction reverses the EXACT cost of the movement it names", () => {
  it("backs out a receipt's value precisely", () => {
    const st = new Map<string, Pool>();
    const r1 = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 2 });
    const r2 = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 4 });
    // Correct the second receipt (booked in error).
    const corr = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "correction",
      qty: 10,
      corrects: r2,
    });
    expect(corr.effect).toBe(-10);
    expect(corr.cost_effect).toBe(-40);
    const v = foldItemValuations([r1, r2, corr]).get(ITEM)!;
    expect(v.onHand).toBe(10);
    expect(v.bookValue).toBe(20);
    expect(v.avgUnitCost).toBe(2);
  });

  it("reversing an issue returns its cost to stock at the price it left at", () => {
    const st = new Map<string, Pool>();
    const r = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 3 });
    const iss = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 4, job_id: JOB });
    const corr = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "correction",
      qty: 4,
      corrects: iss,
    });
    expect(corr.cost_effect).toBe(12); // −(−12)
    const v = foldItemValuations([r, iss, corr]).get(ITEM)!;
    expect(v.onHand).toBe(10);
    expect(v.bookValue).toBe(30);
    // The reversed issue no longer contributes any job COGS.
    expect(stockCogsByJob([r, iss, corr]).get(JOB)).toBeUndefined();
  });
});

describe("historical (pre-valuation) movements are UNCOSTED, never crash, reported honestly", () => {
  it("keeps null-cost quantity out of the average and surfaces it as uncosted", () => {
    // A pre-migration on-hand of 100 (cost_effect null), then a priced receipt.
    const legacy: CostedMovementRow = {
      id: nextId(),
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 100,
      effect: 100,
      unit_cost: null,
      cost_effect: null,
      costed_qty_effect: null,
    };
    const st = new Map<string, Pool>(); // fresh pool: legacy contributes nothing
    const priced = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 5 });
    const v = foldItemValuations([legacy, priced]).get(ITEM)!;
    expect(v.onHand).toBe(110);
    expect(v.costedQty).toBe(10);
    expect(v.uncostedQty).toBe(100);
    expect(v.bookValue).toBe(50);
    expect(v.avgUnitCost).toBe(5); // 50 / 10, NOT 50 / 110
  });

  it("an item that is entirely uncosted has a null average and £0 book value, no divide-by-zero", () => {
    const legacy: CostedMovementRow = {
      id: nextId(),
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 40,
      effect: 40,
      unit_cost: null,
      cost_effect: null,
      costed_qty_effect: null,
    };
    const v = foldItemValuations([legacy]).get(ITEM)!;
    expect(v.onHand).toBe(40);
    expect(v.costedQty).toBe(0);
    expect(v.bookValue).toBe(0);
    expect(v.avgUnitCost).toBeNull();
    expect(v.uncostedQty).toBe(40);
  });

  it("an issue while nothing is costed carries no COGS (unknown, not zero)", () => {
    const legacy: CostedMovementRow = {
      id: nextId(),
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "receipt",
      qty: 40,
      effect: 40,
      unit_cost: null,
      cost_effect: null,
      costed_qty_effect: null,
    };
    const st = new Map<string, Pool>(); // empty costed pool
    const iss = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 5, job_id: JOB });
    expect(iss.cost_effect).toBeNull();
    expect(stockCogsByJob([legacy, iss]).size).toBe(0);
  });
});

describe("the costed↔uncosted boundary — book value can NEVER go negative (S1)", () => {
  /** A legacy pre-valuation movement: physical stock, no cost. */
  const legacy = (qty: number): CostedMovementRow => ({
    id: nextId(),
    stock_item_id: ITEM,
    site_id: SITE_A,
    movement_type: "receipt",
    qty,
    effect: qty,
    unit_cost: null,
    cost_effect: null,
    costed_qty_effect: null,
  });

  it("THE WORKED CASE: legacy 5 uncosted + receipt 5@£8 + issue 6 ⇒ on_hand 4, costed_qty 0, book £0", () => {
    const st = new Map<string, Pool>();
    const leg = legacy(5); // 5 uncosted units, no cost pool contribution
    const rcpt = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 5, price: 8 });
    // pool now: book £40, costed 5, avg £8.
    const iss = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 6, job_id: JOB });

    // The issue draws 6 physical units but only 5 are costed → release is CAPPED.
    expect(iss.cost_effect).toBe(-40); // NOT -48
    expect(iss.costed_qty_effect).toBe(-5); // NOT -6

    const v = foldItemValuations([leg, rcpt, iss]).get(ITEM)!;
    expect(v.onHand).toBe(4); // 5 + 5 - 6
    expect(v.costedQty).toBe(0); // floored, NOT -1
    expect(v.bookValue).toBe(0); // floored, NOT -8
    expect(v.uncostedQty).toBe(4); // all 4 remaining units are uncosted
    expect(v.avgUnitCost).toBeNull();
    expect(v.bookValue).toBeGreaterThanOrEqual(0);

    // The job is charged the HONEST £40 of known cost that was actually released.
    expect(stockCogsByJob([leg, rcpt, iss]).get(JOB)).toBe(40);
  });

  it("SCALED: legacy 500 uncosted + receipt 200@£12.50 + issue 650 ⇒ costed_qty 0, book £0, COGS £2,500", () => {
    const st = new Map<string, Pool>();
    const leg = legacy(500);
    const rcpt = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 200, price: 12.5 });
    // pool: book £2,500, costed 200, avg £12.50.
    const iss = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 650, job_id: JOB });
    expect(iss.cost_effect).toBe(-2500); // capped at the full £2,500 pool
    expect(iss.costed_qty_effect).toBe(-200);

    const v = foldItemValuations([leg, rcpt, iss]).get(ITEM)!;
    expect(v.onHand).toBe(50); // 500 + 200 - 650
    expect(v.costedQty).toBe(0);
    expect(v.bookValue).toBe(0);
    expect(v.uncostedQty).toBe(50);
    expect(stockCogsByJob([leg, rcpt, iss]).get(JOB)).toBe(2500);
  });

  it("a PARTIAL boundary draw releases only the costed portion and leaves the rest costed", () => {
    const st = new Map<string, Pool>();
    const leg = legacy(5);
    const rcpt = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 4 });
    // pool: book £40, costed 10, avg £4.
    const iss = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 12, job_id: JOB });
    // 12 drawn, 10 costed → release 10 @ £4 = £40 (full drain), 2 uncosted units drawn.
    expect(iss.cost_effect).toBe(-40);
    expect(iss.costed_qty_effect).toBe(-10);
    const v = foldItemValuations([leg, rcpt, iss]).get(ITEM)!;
    expect(v.onHand).toBe(3); // 5 + 10 - 12
    expect(v.costedQty).toBe(0);
    expect(v.bookValue).toBe(0);
  });

  it("adjustment_out across the boundary also floors at 0 (never a negative write-off)", () => {
    const st = new Map<string, Pool>();
    const leg = legacy(3);
    const rcpt = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 2, price: 10 });
    // pool: book £20, costed 2, avg £10.
    const adj = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_A,
      movement_type: "adjustment_out",
      qty: 4,
    });
    expect(adj.cost_effect).toBe(-20); // capped, not -40
    const v = foldItemValuations([leg, rcpt, adj]).get(ITEM)!;
    expect(v.onHand).toBe(1);
    expect(v.costedQty).toBe(0);
    expect(v.bookValue).toBe(0);
  });

  it("a transfer that crosses the boundary stays COST-NEUTRAL (in-leg mirrors out-leg)", () => {
    const st = new Map<string, Pool>();
    const leg = legacy(5);
    const rcpt = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 5, price: 8 });
    // pool: book £40, costed 5, avg £8. Transfer 6 units A→B (crosses boundary).
    const out = stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "transfer_out", qty: 6 });
    const inn = stamp(st, {
      stock_item_id: ITEM,
      site_id: SITE_B,
      movement_type: "transfer_in",
      qty: 6,
      pairedOut: out,
    });
    expect(out.cost_effect).toBe(-40); // capped release
    expect(inn.cost_effect).toBe(40); // exact mirror
    expect(inn.costed_qty_effect).toBe(5);
    const v = foldItemValuations([leg, rcpt, out, inn]).get(ITEM)!;
    // Org valuation is UNCHANGED by an internal move — value is relocated, not lost.
    expect(v.onHand).toBe(10); // 5 + 5 - 6 + 6
    expect(v.costedQty).toBe(5);
    expect(v.bookValue).toBe(40);
    expect(v.avgUnitCost).toBe(8);
  });
});

describe("job COGS allocation, and its DOUBLE-COUNT safety", () => {
  const st = new Map<string, Pool>();
  const rows = [
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 20, price: 3 }),
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 5, job_id: JOB }),
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 4, job_id: JOB_2 }),
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 1, job_id: JOB }),
    // an issue with NO job (consumed to overhead) contributes to no job
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "issue", qty: 2, job_id: null }),
  ];

  it("sums released cost per job as a POSITIVE cost of sale", () => {
    const byJob = stockCogsByJob(rows);
    expect(byJob.get(JOB)).toBe(18); // (5 + 1) × 3
    expect(byJob.get(JOB_2)).toBe(12); // 4 × 3
    expect(byJob.size).toBe(2);
  });

  it("emits a distinct, deterministic materials cost stream — never a finances row", () => {
    const cogs = buildStockCogsCostRows(rows);
    // Deterministic order (by job id): JOB_2 (8…) sorts before JOB (9…).
    expect(cogs).toEqual([
      { job_id: JOB_2, amount: 12, category: "materials" },
      { job_id: JOB, amount: 18, category: "materials" },
    ]);
  });

  it("flows into computeJobProfitability's materials bucket exactly like a finance row", () => {
    const cogs = buildStockCogsCostRows(rows);
    const invoices = [{ job_id: JOB, amount: 100 }];
    // The stock-COGS stream is composed on PURPOSE, as an allocation — this is
    // the ONLY cost fed here, proving it needs no `finances` row to reach the
    // job. (A real surface adds it to finances-derived cost under the
    // depot-replenishment convention documented in the migration header.)
    const p = computeJobProfitability(JOB, invoices, cogs)!;
    expect(p.costs_by_bucket.materials).toBe(18);
    expect(p.costs_total).toBe(18);
    expect(p.gross_profit).toBe(82);
  });
});

describe("the valuation report joins the catalogue and totals honestly", () => {
  const st = new Map<string, Pool>();
  const rows = [
    stamp(st, { stock_item_id: ITEM, site_id: SITE_A, movement_type: "receipt", qty: 10, price: 5 }), // book 50
    stamp(st, { stock_item_id: ITEM_B, site_id: SITE_A, movement_type: "receipt", qty: 4, price: 25 }), // book 100
  ];
  // ITEM_B also holds pre-cost-era stock.
  rows.push({
    id: nextId(),
    stock_item_id: ITEM_B,
    site_id: SITE_A,
    movement_type: "receipt",
    qty: 6,
    effect: 6,
    unit_cost: null,
    cost_effect: null,
    costed_qty_effect: null,
  });

  const items = [
    { id: ITEM, name: "Cement 25kg", unit: "bag", sku: "CEM25" },
    { id: ITEM_B, name: "Rebar 12mm", unit: "length", sku: null },
    { id: "33333333-3333-3333-3333-333333333333", name: "Never moved", unit: "ea", sku: null },
  ];

  it("sorts by value desc, carries the uncosted caveat, and includes never-moved items at zero", () => {
    const report = buildValuationReport(items, foldItemValuations(rows));
    expect(report.map((r) => r.name)).toEqual(["Rebar 12mm", "Cement 25kg", "Never moved"]);
    const rebar = report[0]!;
    expect(rebar.bookValue).toBe(100);
    expect(rebar.onHand).toBe(10);
    expect(rebar.costedQty).toBe(4);
    expect(rebar.uncostedQty).toBe(6);
    expect(rebar.hasUncosted).toBe(true);
    expect(rebar.avgUnitCost).toBe(25);
    const never = report[2]!;
    expect(never.onHand).toBe(0);
    expect(never.bookValue).toBe(0);
    expect(never.avgUnitCost).toBeNull();
  });

  it("summarises total value, items in stock and the uncosted-item count", () => {
    const report = buildValuationReport(items, foldItemValuations(rows));
    const totals = summariseValuation(report);
    expect(totals.bookValue).toBe(150);
    expect(totals.itemsInStock).toBe(2);
    expect(totals.itemsWithUncosted).toBe(1);
  });
});

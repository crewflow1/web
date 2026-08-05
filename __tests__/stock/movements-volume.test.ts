import { describe, it, expect, beforeEach } from "vitest";
import { listStockMovements } from "@/server/services/stock";
import { foldSiteBalances, balanceKey } from "@/lib/stock/balance";
import type { StockClient } from "@/server/services/stock";

/**
 * OPERATIONAL STOCK — the balance-fold read pages past the 1000-row cap (F-1).
 *
 * ── THE DEFECT (fixed in C35) ────────────────────────────────────────────────
 * `listStockMovements` capped its read at `.limit(opts.limit ?? STOCK_MOVEMENT_
 * LIMIT)` where STOCK_MOVEMENT_LIMIT = 5000. PostgREST clamps every response to
 * max_rows (1000), so the "5000" was a lie: any org past 1000 movements folded
 * its on-hand balances over a SILENTLY TRUNCATED ledger and mis-stated every
 * quantity (a coalescing arg the old .limit guard also missed). The fix reads the
 * FULL ledger via `fetchAllRows`, paging under the cap on a unique
 * `(occurred_at desc, id desc)` order.
 *
 * The read is exercised against a chainable mock that honours `.range(from, to)`
 * exactly like PostgREST — inclusive, hard-capped at 1000 rows per response. A
 * bare / single-page read would fold to HALF the true balance here.
 */

const RESPONSE_CAP = 1000;
const ORG = "org-under-test";
const OTHER_ORG = "org-elsewhere";
const ITEM = "item-1";
const SITE = "site-1";

let rows: Array<Record<string, unknown>>;

function makeClient(): StockClient {
  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const orders: Array<[string, boolean]> = [];
    const filtered = () => {
      let out = (table === "stock_movements" ? rows : []).filter((r) => {
        for (const [c, v] of eqs) if (r[c] !== v) return false;
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [c, asc] = orders[i]!;
        out = [...out].sort((a, b) => {
          const av = a[c] as string | number;
          const bv = b[c] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return out;
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq(c: string, v: unknown) {
        eqs.push([c, v]);
        return builder;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        return Promise.resolve({
          data: filtered().slice(from, to + 1).slice(0, RESPONSE_CAP),
          error: null,
        });
      },
    };
    return builder;
  }
  return { from: (t: string) => makeBuilder(t) } as unknown as StockClient;
}

beforeEach(() => {
  const N = 1500; // > 1000, so a single page loses a third of the ledger
  rows = [];
  for (let i = 0; i < N; i++) {
    rows.push({
      id: `mv-${String(i).padStart(6, "0")}`,
      org_id: ORG,
      stock_item_id: ITEM,
      site_id: SITE,
      movement_type: "receipt",
      qty: 2,
      effect: 2, // +2 in; foldSiteBalances sums movementEffect
      occurred_at: `2026-07-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    });
  }
  // Another org's movement — RLS-shaped bleed that the org pin must exclude.
  rows.push({
    id: "mv-otherorg", org_id: OTHER_ORG, stock_item_id: ITEM, site_id: SITE,
    movement_type: "receipt", qty: 999, effect: 999, occurred_at: "2026-07-02T00:00:00Z",
  });
});

describe("stock balance fold reads the FULL ledger past the cap (F-1)", () => {
  it("returns every movement for the org, then folds to the complete balance", async () => {
    const movements = await listStockMovements(makeClient(), ORG);

    // A single-page read would stop at 1000; the paged read returns all 1500.
    expect(movements.length).toBe(1500);
    expect(movements.length).toBeGreaterThan(RESPONSE_CAP);
    // Org pin held under paging — the other org's movement never came back.
    expect(movements.some((m) => m.id === "mv-otherorg")).toBe(false);

    // The balance folds over the COMPLETE ledger: 1500 × 2 = 3000, not the
    // 2000 a truncated first page would have produced.
    const balances = foldSiteBalances(movements as never);
    expect(balances.get(balanceKey(ITEM, SITE))?.quantity).toBe(3000);
  });
});

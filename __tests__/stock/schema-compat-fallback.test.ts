import { describe, it, expect } from "vitest";
import { listStockMovements, type StockClient } from "@/server/services/stock";
import { isMissingDbObject } from "@/lib/supabase/schema-compat";

/**
 * SCHEMA-COMPAT — the code-ahead-of-schema deploy window (R5).
 *
 * Merging R5 to main auto-deploys the code to production before its migrations
 * are applied, so for a short window the deployed `listStockMovements` references
 * the `stock_movements_operational` VIEW (migration 20261257) that prod does not
 * have yet. Without a guard the loud read throws and /stock/items/[id] +
 * /stock/locations/[id] error for everyone. These tests pin the two halves of the
 * contract:
 *   1. a MISSING operational view → fall back to the base table (the pre-R5 read),
 *      so the pages keep working through the window;
 *   2. any OTHER error (a real denial / transient fault) STILL throws loud — the
 *      fallback must never become a way to swallow failures.
 */

const ORG = "org-under-test";

type RangeResult = { data: Array<Record<string, unknown>> | null; error: unknown };

/**
 * A chainable StockClient whose `.range()` resolves to whatever the per-relation
 * responder returns, so a test can make the operational view error while the base
 * table serves rows (exactly the pre-migration production shape).
 */
function makeClient(responder: (relation: string) => RangeResult): StockClient {
  function makeBuilder(relation: string) {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: () => Promise.resolve(responder(relation)),
    };
    return builder;
  }
  return { from: (t: string) => makeBuilder(t) } as unknown as StockClient;
}

const baseRows = [
  { id: "mv-1", org_id: ORG, stock_item_id: "i1", site_id: "s1", movement_type: "receipt", qty: 3, effect: 3, occurred_at: "2026-07-01T00:00:00Z" },
  { id: "mv-2", org_id: ORG, stock_item_id: "i1", site_id: "s1", movement_type: "issue", qty: 1, effect: -1, occurred_at: "2026-07-02T00:00:00Z" },
];

describe("isMissingDbObject", () => {
  it("matches undefined relation/function SQLSTATEs and PostgREST schema-cache codes", () => {
    for (const code of ["42P01", "42883", "PGRST202", "PGRST205"]) {
      expect(isMissingDbObject({ code })).toBe(true);
    }
  });

  it("matches by message when the code is absent", () => {
    expect(isMissingDbObject({ message: 'relation "public.stock_movements_operational" does not exist' })).toBe(true);
    expect(isMissingDbObject({ message: "Could not find the function public.set_job_primary_assignment in the schema cache" })).toBe(true);
  });

  it("does NOT match real failures (denials, transient, constraint) or empty input", () => {
    expect(isMissingDbObject({ code: "42501", message: "permission denied" })).toBe(false); // RLS denial
    expect(isMissingDbObject({ code: "23505", message: "duplicate key" })).toBe(false); // unique violation
    expect(isMissingDbObject({ code: "57014", message: "statement timeout" })).toBe(false); // transient
    expect(isMissingDbObject(null)).toBe(false);
    expect(isMissingDbObject(undefined)).toBe(false);
    expect(isMissingDbObject({})).toBe(false);
  });
});

describe("listStockMovements — pre-migration fallback to the base table", () => {
  it("falls back to stock_movements when the operational view is absent (42P01)", async () => {
    const client = makeClient((relation) =>
      relation === "stock_movements_operational"
        ? { data: null, error: { code: "42P01", message: 'relation "stock_movements_operational" does not exist' } }
        : { data: baseRows, error: null },
    );
    const movements = await listStockMovements(client, ORG);
    expect(movements.map((m) => m.id)).toEqual(["mv-1", "mv-2"]);
  });

  it("falls back on a PostgREST schema-cache miss (PGRST205) too", async () => {
    const client = makeClient((relation) =>
      relation === "stock_movements_operational"
        ? { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.stock_movements_operational' in the schema cache" } }
        : { data: baseRows, error: null },
    );
    const movements = await listStockMovements(client, ORG);
    expect(movements).toHaveLength(2);
  });

  it("STILL throws loud on a real error from the operational view (no silent swallow)", async () => {
    const client = makeClient(() => ({ data: null, error: { code: "42501", message: "permission denied for relation stock_movements_operational" } }));
    await expect(listStockMovements(client, ORG)).rejects.toThrow();
  });

  it("uses the operational view normally when it exists (no fallback)", async () => {
    let baseTouched = false;
    const client = makeClient((relation) => {
      if (relation === "stock_movements") baseTouched = true;
      return { data: baseRows, error: null };
    });
    const movements = await listStockMovements(client, ORG);
    expect(movements).toHaveLength(2);
    expect(baseTouched).toBe(false); // view served it; base table never read
  });
});

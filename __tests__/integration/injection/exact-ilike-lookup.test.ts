import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { findStockItemByCode } from "@/server/services/stocktake";
import { exactIlikePattern, quoteFilterValue } from "@/lib/search/filters";

/**
 * INJ-02 — LIKE-wildcard injection in "exact, case-insensitive" lookups, proven
 * against the REAL Data API (PostgREST grammar + Postgres LIKE semantics — the
 * two things a mocked client cannot tell you).
 *
 * `findStockItemByCode` resolves a scanned barcode / SKU to ONE stock item with
 * `.or("barcode.ilike.X,sku.ilike.X").limit(1)`. The code is data, and its LIKE
 * metacharacters were live: `SKU_A1` also matched `SKUXA1`, and `%` matched
 * every item — so the count was recorded against an arbitrary wrong item. Codes
 * containing `( ) , "` were unfindable because those characters were stripped.
 */

type Row = Record<string, unknown>;
type Res<T = Row> = { data: T | null; error: { message: string } | null };
interface Table {
  insert(rows: Row | Row[]): PromiseLike<Res<null>> & { select(c?: string): { single(): PromiseLike<Res<Row>> } };
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
  select(c?: string): { eq(c: string, v: unknown): { or(f: string): PromiseLike<Res<Row[]>> } };
}
const svc = () => serviceClient() as unknown as { from(t: string): Table };
const TOKEN = `secinject-eil-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let org = "";
let otherOrg = "";

const find = (code: string, orgId = org) =>
  findStockItemByCode(serviceClient() as unknown as Parameters<typeof findStockItemByCode>[0], orgId, code);

describeIntegration("INJ-02 exact ilike lookups treat the value as a literal", () => {
  beforeAll(async () => {
    for (const which of ["a", "b"] as const) {
      const o = await svc()
        .from("organizations")
        .insert({ name: `EIL ${TOKEN} ${which}`, slug: `${TOKEN}-${which}` })
        .select("id")
        .single();
      expect(o.error, o.error?.message).toBeNull();
      if (which === "a") org = (o.data as { id: string }).id;
      else otherOrg = (o.data as { id: string }).id;
    }
    const ins = await svc().from("stock_items").insert([
      { org_id: org, name: "decoy", unit: "each", sku: "SKUXA1", barcode: "111" },
      { org_id: org, name: "real", unit: "each", sku: "SKU_A1", barcode: "50%OFF" },
      { org_id: org, name: "punct", unit: "each", sku: "A(1),B", barcode: 'Q"x\\y' },
      { org_id: org, name: "star", unit: "each", sku: "A*B", barcode: null },
      { org_id: org, name: "starwide", unit: "each", sku: "AxyzB", barcode: null },
      { org_id: otherOrg, name: "foreign", unit: "each", sku: "FOREIGN-1", barcode: "999" },
    ]);
    expect(ins.error, ins.error?.message).toBeNull();
  });

  afterAll(async () => {
    for (const id of [org, otherOrg]) {
      if (!id) continue;
      await svc().from("stock_items").delete().eq("org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });

  it("`_` in a scanned code is a literal underscore, not a one-character wildcard", async () => {
    expect((await find("SKU_A1"))?.name).toBe("real");
    expect((await find("sku_a1"))?.name).toBe("real"); // still case-insensitive
    expect((await find("SKUXA1"))?.name).toBe("decoy");
    expect(await find("SKU_XA1")).toBeNull();
  });

  it("`%` matches nothing but itself — it can no longer select an arbitrary item", async () => {
    expect(await find("%")).toBeNull();
    expect(await find("%%")).toBeNull();
    expect(await find("5_%OFF")).toBeNull();
    expect((await find("50%OFF"))?.name).toBe("real");
  });

  it("`*` (PostgREST's alias for %) cannot widen the match either", async () => {
    expect(await find("*")).toBeNull();
    expect(await find("A*")).toBeNull();
    expect((await find("A*B"))?.name).toBe("star"); // the literal-asterisk SKU, not AxyzB
  });

  it("codes containing filter-structural characters are found, not stripped", async () => {
    expect((await find("A(1),B"))?.name).toBe("punct");
    expect((await find('Q"x\\y'))?.name).toBe("punct");
  });

  it("a crafted code cannot append an OR branch or escape the org pin", async () => {
    for (const attack of [
      `x,org_id.neq.00000000-0000-0000-0000-000000000000`,
      `x",org_id.neq.00000000-0000-0000-0000-000000000000,sku.ilike."%`,
      `x),or(sku.ilike.*`,
      `"`,
      `\\`,
      `FOREIGN-1`,
      `999`,
    ]) {
      expect(await find(attack), attack).toBeNull();
    }
    // …and the foreign org's own lookup still works (the pin is the boundary).
    expect((await find("FOREIGN-1", otherOrg))?.name).toBe("foreign");
  });

  it("the encoded value is accepted by the real PostgREST or-grammar for every byte class", async () => {
    for (const v of [`a,b`, `a(b)c`, `a"b`, `a\\b`, `a.b:c`, `a%b_c*d`, `{x}`, `é ü ł`, ` lead`, `'q'`]) {
      const safe = quoteFilterValue(exactIlikePattern(v));
      const r = await svc().from("stock_items").select("id").eq("org_id", org).or(`sku.ilike.${safe},barcode.ilike.${safe}`);
      expect(r.error, `${JSON.stringify(v)} → ${r.error?.message}`).toBeNull();
      expect(r.data).toEqual([]);
    }
  });
});

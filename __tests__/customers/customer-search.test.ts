import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { searchCustomers, CUSTOMER_SEARCH_MAX_LIMIT } from "@/lib/customers/search";

/**
 * Universal customer search — the shared capability's TS seam + the migration
 * and picker-wiring source contracts. Behaviour against real Postgres lives in
 * __tests__/integration/rls/customer-search-rpc.test.ts (CI has no DB in the
 * unit tier, so the SQL is asserted on its text here).
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
/** Strip `-- …` SQL line comments so prose can't satisfy an assertion. */
const sqlOnly = (sql: string) =>
  sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const FAKE_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "John Smith",
  email: "john@example.com",
  phone: "+44 7700 900123",
  customer_type: "individual",
  address_line1: "12 Malone Road",
  address_line2: null,
  city: "Belfast",
  county: "Antrim",
  postcode: "BT9 1AB",
  country: "United Kingdom",
  parent_customer_id: null,
  created_at: "2026-01-01T00:00:00Z",
  relevance: 3,
  total_count: 42,
};

type Captured = { fn: string; args: Record<string, unknown> };
function mockClient(result: { data: unknown; error: unknown }) {
  const calls: Captured[] = [];
  const supabase = {
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve(result);
    }),
  } as unknown as SupabaseClient<Database>;
  return { supabase, calls };
}

describe("searchCustomers — the shared TS seam over the RPC", () => {
  it("calls the search_customers RPC with the active org", async () => {
    const { supabase, calls } = mockClient({ data: [FAKE_ROW], error: null });
    await searchCustomers(supabase, { orgId: "org-1", query: "smith" });
    expect(calls[0]?.fn).toBe("search_customers");
    expect(calls[0]?.args.p_org_id).toBe("org-1");
    expect(calls[0]?.args.p_query).toBe("smith");
  });

  it("sanitises the query (strips PostgREST structural/wildcard chars)", async () => {
    const { supabase, calls } = mockClient({ data: [], error: null });
    await searchCustomers(supabase, { orgId: "o", query: "a%,(b)_*" });
    // % _ , ( ) * → spaces, collapsed — the same neutralisation every path uses.
    expect(calls[0]?.args.p_query).toBe("a b");
  });

  it("passes NO query (undefined) for an empty/whitespace term ⇒ browse", async () => {
    const { supabase, calls } = mockClient({ data: [], error: null });
    await searchCustomers(supabase, { orgId: "o", query: "   " });
    expect(calls[0]?.args.p_query).toBeUndefined();
  });

  it("clamps the limit to [1, 200] and the offset to >= 0", async () => {
    const big = mockClient({ data: [], error: null });
    await searchCustomers(big.supabase, { orgId: "o", limit: 9999, offset: -5 });
    expect(big.calls[0]?.args.p_limit).toBe(CUSTOMER_SEARCH_MAX_LIMIT);
    expect(big.calls[0]?.args.p_limit).toBe(200);
    expect(big.calls[0]?.args.p_offset).toBe(0);

    const zero = mockClient({ data: [], error: null });
    await searchCustomers(zero.supabase, { orgId: "o", limit: 0 });
    expect(zero.calls[0]?.args.p_limit).toBe(1);

    const dflt = mockClient({ data: [], error: null });
    await searchCustomers(dflt.supabase, { orgId: "o" });
    expect(dflt.calls[0]?.args.p_limit).toBe(20);
  });

  it("only forwards a valid type filter", async () => {
    const biz = mockClient({ data: [], error: null });
    await searchCustomers(biz.supabase, { orgId: "o", type: "business" });
    expect(biz.calls[0]?.args.p_type).toBe("business");

    const bad = mockClient({ data: [], error: null });
    await searchCustomers(bad.supabase, { orgId: "o", type: "nonsense" as unknown as "business" });
    expect(bad.calls[0]?.args.p_type).toBeUndefined();
  });

  it("returns the EXACT total from the window count and strips internal columns", async () => {
    const { supabase } = mockClient({ data: [FAKE_ROW], error: null });
    const res = await searchCustomers(supabase, { orgId: "o", query: "smith" });
    expect(res.total).toBe(42);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).not.toHaveProperty("total_count");
    expect(res.rows[0]).not.toHaveProperty("relevance");
    expect(res.rows[0]?.name).toBe("John Smith");
  });

  it("reports total 0 for an empty page", async () => {
    const { supabase } = mockClient({ data: [], error: null });
    const res = await searchCustomers(supabase, { orgId: "o" });
    expect(res.total).toBe(0);
    expect(res.rows).toEqual([]);
  });

  it("is LOUD — a read error throws, never a silent empty list", async () => {
    const { supabase } = mockClient({ data: null, error: { message: "boom" } });
    await expect(searchCustomers(supabase, { orgId: "o" })).rejects.toThrow();
  });
});

describe("migration 20261261000000_customer_search.sql", () => {
  const raw = read("supabase/migrations/20261261000000_customer_search.sql");
  const sql = sqlOnly(raw);

  it("adds normalised generated columns for phone (digits), phone_sig and postcode", () => {
    expect(sql).toMatch(/add column if not exists phone_normalized text[\s\S]*generated always as/i);
    expect(sql).toMatch(/add column if not exists phone_sig text[\s\S]*generated always as/i);
    expect(sql).toMatch(/add column if not exists postcode_normalized text[\s\S]*generated always as/i);
  });

  it("creates pg_trgm GIN indexes on the normalised columns (fast %frag%)", () => {
    expect(sql).toMatch(/create extension if not exists pg_trgm/i);
    for (const col of ["phone_normalized", "phone_sig", "postcode_normalized"]) {
      expect(sql).toMatch(new RegExp(`using gin\\s*\\(\\s*${col}\\s+gin_trgm_ops\\s*\\)`, "i"));
    }
  });

  it("the search RPC carries the canonical org guard as its FIRST act (current_org_ids + 42501)", () => {
    expect(sql).toMatch(/create or replace function public\.search_customers/i);
    expect(sql).toContain("public.current_org_ids()");
    expect(sql).toContain("42501");
    // the guard precedes the first read (the toks/base CTE)
    const guardAt = sql.indexOf("42501");
    const readAt = sql.indexOf("from public.customers c");
    expect(guardAt).toBeGreaterThan(0);
    expect(readAt).toBeGreaterThan(guardAt);
  });

  it("escapes LIKE metacharacters in the token so a stray % / _ can't broaden a match", () => {
    // The ILIKE pattern escapes % and _ (and \) then matches with `escape '\'`.
    expect(sql).toContain("'%', '\\%'");
    expect(sql).toContain("'_', '\\_'");
    expect(sql).toContain("escape '\\'");
  });

  it("caps the page at a SAFE limit and orders deterministically (created_at, then unique id)", () => {
    expect(sql).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 200\)/);
    expect(sql).toMatch(/order by[\s\S]*r\.created_at desc[\s\S]*r\.id desc/i);
    expect(sql).toMatch(/count\(\*\) over\(\)\s*(as\s+total_count)/i);
  });

  it("grants execute to authenticated (guarded, not revoked) and is additive-only", () => {
    expect(sql).toMatch(/grant execute on function public\.search_customers\([^)]*\) to authenticated/i);
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/drop column/i);
  });
});

describe("every customer picker uses the ONE shared CustomerCombobox", () => {
  const PICKERS: Array<[string, string]> = [
    ["app/(app)/jobs/_form.tsx", "customer_id"],
    ["app/(app)/leads/_form.tsx", "customer_id"],
    ["app/(app)/quotes/_builder.tsx", "customer_id"],
    ["app/(app)/reviews/new/page.tsx", "customer_id"],
    ["app/(app)/customers/_form.tsx", "parent_customer_id"],
  ];
  for (const [path, field] of PICKERS) {
    it(`${path} renders <CustomerCombobox name="${field}"> (no bespoke <select>)`, () => {
      const src = read(path);
      expect(src).toContain("CustomerCombobox");
      expect(src).toMatch(new RegExp(`name=["']${field}["']`));
      // the old all-customers <select name="customer_id"> must be gone
      expect(src).not.toMatch(new RegExp(`<select[^>]*name=["']${field}["']`));
    });
  }

  it("the combobox is backed by the shared /api/customers/search endpoint", () => {
    const combo = read("app/(app)/_components/customer-combobox.tsx");
    expect(combo).toContain("/api/customers/search");
  });

  it("the typeahead API delegates to the shared searchCustomers capability", () => {
    const route = read("app/api/customers/search/route.ts");
    expect(route).toContain("searchCustomers");
    expect(route).toContain("requireOrgContext");
  });
});

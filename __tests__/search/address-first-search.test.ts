import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P3 Address-First Search — source contracts.
 *
 * CI has no database, so the migration is asserted on its SQL text and the
 * search code paths are asserted on source: the indexes are additive trigram
 * indexes on the address columns, and every entity is filtered in SQL (no
 * capped fetch + JS filter — the bug that silently dropped matches past the
 * cap). Behaviour of the pure builders is covered in filters.test.ts.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");

/** Strip `-- …` line comments so prose can't satisfy/!break SQL assertions. */
function sqlOnly(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("migration 20260706120000_address_search_trgm.sql", () => {
  const raw = read("supabase/migrations/20260706120000_address_search_trgm.sql");
  const sql = sqlOnly(raw);

  it("enables pg_trgm idempotently", () => {
    expect(sql).toMatch(/create extension if not exists pg_trgm/i);
  });

  it("creates GIN trigram indexes (gin_trgm_ops) — what makes %term% fast", () => {
    expect(sql).toMatch(/using gin\s*\(\s*\w+\s+gin_trgm_ops\s*\)/i);
  });

  it("indexes the customer name + structured address columns", () => {
    for (const col of [
      "name",
      "address_line1",
      "address_line2",
      "city",
      "county",
      "postcode",
    ]) {
      expect(sql).toContain(`public.customers using gin (${col} gin_trgm_ops)`);
    }
  });

  it("indexes the job site-address columns", () => {
    for (const col of [
      "site_address_line1",
      "site_address_line2",
      "site_city",
      "site_county",
      "site_postcode",
    ]) {
      expect(sql).toContain(`public.jobs using gin (${col} gin_trgm_ops)`);
    }
  });

  it("indexes the lead postcode + contact_name + service", () => {
    for (const col of ["postcode", "contact_name", "service"]) {
      expect(sql).toContain(`public.leads using gin (${col} gin_trgm_ops)`);
    }
  });

  it("is additive + idempotent (create…if not exists only)", () => {
    const creates = sql.match(/create index/gi) ?? [];
    const guarded = sql.match(/create index if not exists/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });

  it("is non-destructive — no drop / alter-drop / delete / truncate", () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+index/i);
    expect(sql).not.toMatch(/alter\s+table[\s\S]*drop/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });
});

describe("global search route — SQL-side + cross-entity address discovery", () => {
  const src = read("app/api/search/route.ts");

  it("uses the shared filter builders, not bespoke inline strings", () => {
    expect(src).toContain('from "@/lib/search/filters"');
    expect(src).toContain("ilikeOrFilter(");
    expect(src).toContain("inIdsBranch(");
    expect(src).toContain("combineOr(");
  });

  it("searches customers across name + structured address columns", () => {
    expect(src).toContain("CUSTOMER_SEARCH_COLUMNS");
    expect(src).toContain("JOB_SEARCH_COLUMNS");
    expect(src).toContain("LEAD_SEARCH_COLUMNS");
  });

  it("NO false negatives from caps: jobs are filtered in SQL, not a capped JS scan", () => {
    // The old route fetched .limit(80) jobs then did
    // `name.toLowerCase().includes(...)` — dropping every match past row 80.
    expect(src).not.toContain(".limit(80)");
    expect(src).not.toMatch(/we'?ll filter client-side/i);
    // jobs now match via an .or() built from JOB_SEARCH_COLUMNS + customer ids
    expect(src).toContain(".or(jobOr)");
    expect(src).toMatch(/inIdsBranch\(\s*"customer_id"/);
  });

  it("makes quotes + invoices discoverable through the customer's address", () => {
    // quote belongs to a matched customer …
    expect(src).toContain(".or(quoteOr)");
    // … and an invoice is reached via its job or quote (it has no customer_id)
    expect(src).toMatch(/inIdsBranch\(\s*"job_id"/);
    expect(src).toMatch(/inIdsBranch\(\s*"quote_id"/);
  });

  it("still short-circuits a too-short / empty query (no unbounded scan)", () => {
    expect(src).toMatch(/q\.length < 2/);
    expect(src).toMatch(/safe\.length === 0/);
  });
});

describe("jobs page — address search via site columns + customer-id chaining", () => {
  const src = read("app/(app)/jobs/page.tsx");

  it("imports the shared filter builders + column sets", () => {
    expect(src).toContain('from "@/lib/search/filters"');
    expect(src).toContain("JOB_SEARCH_COLUMNS");
    expect(src).toContain("CUSTOMER_SEARCH_COLUMNS");
  });

  it("runs a customer pre-pass and folds the ids into the jobs .or()", () => {
    expect(src).toContain('.from("customers")');
    expect(src).toMatch(/inIdsBranch\(\s*"customer_id"/);
    expect(src).toContain("combineOr(siteBranch, customerIdBranch)");
    expect(src).toContain("query.or(searchOr)");
  });

  it("filters in SQL before the row cap (no JS filtering of a capped page)", () => {
    expect(src).toContain(".limit(200)");
    // the search .or() is applied to the query builder, not Array.prototype
    expect(src).not.toMatch(/rows\.filter\([^)]*includes/);
  });

  it("exposes a search box", () => {
    expect(src).toMatch(/name="q"/);
    expect(src).toMatch(/placeholder="[^"]*(address|postcode)[^"]*"/i);
  });
});

describe("leads page — sanitised, extended search", () => {
  const src = read("app/(app)/leads/page.tsx");

  it("uses ilikeOrFilter + LEAD_SEARCH_COLUMNS", () => {
    expect(src).toContain("ilikeOrFilter(");
    expect(src).toContain("LEAD_SEARCH_COLUMNS");
  });

  it("drops the old UNSANITISED raw interpolation (injection fix)", () => {
    // Was: query.or(`service.ilike.%${q}%,postcode.ilike.%${q}%`)
    expect(src).not.toContain("service.ilike.%${q}%");
    expect(src).not.toContain("postcode.ilike.%${q}%");
  });
});

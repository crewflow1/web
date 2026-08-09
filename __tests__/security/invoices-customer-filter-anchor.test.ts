import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * STATIC GUARD — the /invoices customer filter must attribute invoices to a
 * customer via the DURABLE `invoices.customer_id`, never through a
 * `quotes!inner` / `quote.customer_id` join.
 *
 * THE CLASS (C51 #1). "Reads that gather/filter a customer's invoices via
 * quote_id / a quotes-join instead of the durable invoices.customer_id." A
 * quote join silently drops every quote-less stage/progress-billing invoice
 * (generate_stage_invoice, migration 20261039000000 — quote_id NULL,
 * customer_id set) from the result AND from a `count: 'exact'` headline. The
 * C51 wave fixed the detail rollup and the portal list but MISSED this main-app
 * list because it filtered through a `quotes!inner` JOIN rather than a summing
 * rollup. This guard pins the fix so the join shape can never come back here.
 *
 * The durable anchor is `invoices.customer_id` (migration 20260915000000,
 * composite FK (customer_id, org_id) -> customers), the same anchor
 * lib/customers/financials.ts and the customer portal list use.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip TS/JS comments so we only inspect EXECUTABLE code (comments may
 *  legitimately mention the old shape when explaining the fix). */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PAGE = "app/(app)/invoices/page.tsx";

describe("invoices customer-filter anchor guard", () => {
  const code = codeOf(src(PAGE));

  it("does NOT attribute a customer's invoices through a quotes!inner join", () => {
    expect(code).not.toMatch(/quotes!inner/);
  });

  it("does NOT filter the list on the joined quote.customer_id", () => {
    // e.g. .eq("quote.customer_id", ...) — the exact pre-fix predicate.
    expect(code).not.toMatch(/["']quote\.customer_id["']/);
  });

  it("filters directly on the durable invoices.customer_id column", () => {
    expect(code).toMatch(/\.eq\(\s*["']customer_id["']\s*,\s*customerFilter\s*\)/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-1 — customer-portal overview invoices scope.
 *
 * The overview page renders per-customer KPIs (outstanding balance, most
 * recent invoice). Invoices carry no customer_id column — they link to a
 * customer only via their parent quote. Before the fix the invoices read
 * was scoped ONLY by org_id and then narrowed to the customer in JS, which
 *   (a) over-read OTHER customers' invoice rows on the service-role client
 *       (which BYPASSES RLS — the token is the only auth surface), and
 *   (b) applied a top-50 recency `.limit()` org-wide, so a busy org's
 *       customer could see a wrong/empty outstanding total and the wrong
 *       "most recent invoice".
 * The fix scopes the invoices query to THIS customer's quote ids at the DB,
 * exactly like the invoices list page — the JS post-filter is no longer the
 * thing standing between one customer and another's invoices.
 *
 * Portal pages are server components rendered against the real DB; per the
 * repo convention (see __tests__/portal/phase3.test.ts) the cross-tenant
 * contract is pinned on source so a refactor can't silently widen the scope
 * again. These assertions fail on the pre-fix shape and pass on the fix.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const OVERVIEW = read("app/customer-portal/[token]/page.tsx");
const LIST = read("app/customer-portal/[token]/invoices/page.tsx");

describe("M-1 — portal overview scopes invoices to the customer's quotes", () => {
  it("resolves the customer via the portal token and fails closed", () => {
    expect(OVERVIEW).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(OVERVIEW).toMatch(/InvalidLinkPage/);
  });

  it("keeps the quotes read scoped by org_id AND customer_id", () => {
    expect(OVERVIEW).toMatch(
      /\.from\("quotes"\)[\s\S]*?\.eq\("org_id", customer\.org_id\)[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("scopes the invoices read to the customer's quote ids (.in quote_id)", () => {
    expect(OVERVIEW).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.in\("quote_id", quoteIds\)/,
    );
  });

  it("fetches the customer's quotes BEFORE the invoices read, to scope it", () => {
    const quotesIdx = OVERVIEW.indexOf('.from("quotes")');
    const invoicesIdx = OVERVIEW.indexOf('.from("invoices")');
    expect(quotesIdx).toBeGreaterThanOrEqual(0);
    expect(invoicesIdx).toBeGreaterThanOrEqual(0);
    expect(quotesIdx).toBeLessThan(invoicesIdx);
    expect(OVERVIEW).toMatch(/const quoteIds = allQuotes\.map\(\(q\) => q\.id\)/);
  });

  it("only reads invoices when the customer actually has quotes", () => {
    expect(OVERVIEW).toMatch(/if \(quoteIds\.length > 0\)/);
  });

  it("drops the org-wide fetch + JS-filter crutch (no post-fetch narrowing)", () => {
    // Pre-fix narrowed an org-only invoice fetch in JS via `quoteIds.has(...)`
    // off an `invoicesRes` Promise.all result. Both must be gone — the
    // scoping now lives in the query, not in a post-fetch filter.
    expect(OVERVIEW).not.toMatch(/quoteIds\.has\(/);
    expect(OVERVIEW).not.toMatch(/invoicesRes/);
  });

  it("matches the invoices list page's per-customer scoping pattern", () => {
    // The list page is the reference implementation: customer quote ids → .in().
    expect(LIST).toMatch(/\.in\("quote_id", quoteIds\)/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-1 — customer-portal invoices scope (updated for Issue #349 Phase 1).
 *
 * The invariant this protects is unchanged: on the portal's service-role client
 * (which BYPASSES RLS — the token is the only auth surface), a customer must see
 * ONLY their own invoices, never an org-wide set narrowed in JS.
 *
 * The MECHANISM changed, and strengthened. Originally invoices had no customer
 * column, so both portal surfaces scoped by walking quote -> customer
 * (`.in("quote_id", quoteIds)`). Phase 1 denormalised `invoices.customer_id`,
 * so both now scope DIRECTLY by `.eq("customer_id", customer.id)` — a stronger
 * guarantee that also survives quote loss (an orphaned invoice keeps its
 * customer_id, so it neither leaks to another customer nor vanishes from its
 * own). These assertions pin the direct-scope shape; the old quote-walk shape
 * must be gone so a refactor can't reintroduce the org-wide-then-JS crutch.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const readCode = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const OVERVIEW = read("app/customer-portal/[token]/page.tsx");
const OVERVIEW_CODE = readCode("app/customer-portal/[token]/page.tsx");
const LIST = read("app/customer-portal/[token]/invoices/page.tsx");
const LIST_CODE = readCode("app/customer-portal/[token]/invoices/page.tsx");

describe("M-1 — portal invoices scope directly to the customer (Phase 1)", () => {
  it("resolves the customer via the portal token and fails closed", () => {
    expect(OVERVIEW).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(OVERVIEW).toMatch(/InvalidLinkPage/);
  });

  it("overview scopes invoices by org_id AND the customer's OWN customer_id", () => {
    expect(OVERVIEW).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.eq\("org_id", customer\.org_id\)[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("invoices list scopes by org_id AND the customer's OWN customer_id", () => {
    expect(LIST).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.eq\("org_id", customer\.org_id\)[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
  });

  it("neither surface walks quote_id to scope invoices any more", () => {
    // The quote-walk was the pre-Phase-1 mechanism; the direct customer scope
    // replaces it. If it returns, the org-wide-then-narrow risk returns with it.
    expect(OVERVIEW_CODE).not.toMatch(/from\("invoices"\)[\s\S]*?\.in\("quote_id"/);
    expect(LIST_CODE).not.toMatch(/from\("invoices"\)[\s\S]*?\.in\("quote_id"/);
  });

  it("keeps no org-wide fetch + JS-filter crutch", () => {
    expect(OVERVIEW_CODE).not.toMatch(/quoteIds\.has\(/);
    expect(OVERVIEW_CODE).not.toMatch(/invoicesRes/);
  });

  it("both surfaces share the same direct-scope pattern", () => {
    for (const src of [OVERVIEW, LIST]) {
      expect(src).toMatch(/\.eq\("customer_id", customer\.id\)/);
    }
  });
});

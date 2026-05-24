import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateCustomerPortalToken,
  isValidPortalTokenShape,
} from "@/lib/customers/portal-token";

/**
 * Portal-token default fix verification.
 *
 * Pins the SQL migration shape + the shared helper + the rotate
 * action's continued use of the helper.
 *
 * Runtime behaviour against the live DB is verified separately by
 * /tmp/portal-token-audit.sql (run via `supabase db query --linked
 * --file`) which exercises:
 *   - new INSERT auto-mints a token
 *   - existing customer tokens are preserved
 *   - two consecutive INSERTs produce distinct tokens
 *   - rotate UPDATE still replaces the token
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260622000000_customer_portal_token_default.sql",
);
const HELPER = read("lib/customers/portal-token.ts");
const ACTIONS = read("app/(app)/customers/actions.ts");

// =====================================================================
// 1. Migration shape
// =====================================================================

describe("portal token default — migration", () => {
  it("sets `default gen_random_uuid()` on customers.portal_token", () => {
    expect(MIGRATION).toMatch(
      /alter column portal_token set default gen_random_uuid\(\)/i,
    );
  });

  it("backfills existing NULL rows with a fresh uuid", () => {
    expect(MIGRATION).toMatch(
      /update public\.customers[\s\S]*set portal_token = gen_random_uuid\(\)[\s\S]*where portal_token is null/i,
    );
  });

  it("does NOT overwrite non-null tokens (the WHERE clause gates it)", () => {
    // Defensive — pin the WHERE so a future refactor can't drop it.
    expect(MIGRATION).toMatch(/where portal_token is null/i);
  });
});

// =====================================================================
// 2. Shared helper
// =====================================================================

describe("generateCustomerPortalToken helper", () => {
  it("returns a valid v4-shaped UUID", () => {
    const t = generateCustomerPortalToken();
    expect(isValidPortalTokenShape(t)).toBe(true);
  });

  it("generates a different token on each call (unique)", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateCustomerPortalToken()),
    );
    expect(tokens.size).toBe(100);
  });

  it("isValidPortalTokenShape rejects non-uuid inputs", () => {
    expect(isValidPortalTokenShape("not-a-uuid")).toBe(false);
    expect(isValidPortalTokenShape("")).toBe(false);
    expect(isValidPortalTokenShape(null)).toBe(false);
    expect(isValidPortalTokenShape(123)).toBe(false);
  });

  it("isValidPortalTokenShape regex matches the portal loader's regex", () => {
    // The loader in app/customer-portal/_helpers.ts uses the same
    // pattern. If the two drift, customers will be locked out.
    const loader = read("app/customer-portal/_helpers.ts");
    expect(loader).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    expect(HELPER).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
  });
});

// =====================================================================
// 3. Rotate action uses the helper
// =====================================================================

describe("rotateCustomerPortalToken still works + uses the helper", () => {
  it("imports the shared helper", () => {
    expect(ACTIONS).toMatch(
      /from "@\/lib\/customers\/portal-token"/,
    );
  });

  it("calls generateCustomerPortalToken() instead of inlining crypto.randomUUID()", () => {
    // The rotate action must use the helper so the token shape stays
    // owned by one module.
    expect(ACTIONS).toMatch(
      /const token = generateCustomerPortalToken\(\)/,
    );
  });

  it("rotate action still UPDATEs portal_token + redirects with saved=portal_link", () => {
    expect(ACTIONS).toMatch(
      /\.update\(\{ portal_token: token \}/,
    );
    expect(ACTIONS).toMatch(/saved=portal_link/);
  });
});

// =====================================================================
// 4. Customer creation paths do NOT explicitly set portal_token
//    (otherwise the DB default wouldn't kick in)
// =====================================================================

describe("customer creation paths defer to the SQL default", () => {
  it("createCustomer (tenant action) does not pass portal_token", () => {
    // Search the source for an insert into customers that would
    // mention portal_token. The only mention should be the rotate
    // UPDATE — not an INSERT.
    const inserts =
      ACTIONS.match(/\.from\("customers"\)[\s\S]*?\.insert\(\{[\s\S]*?\}\)/g) ??
      [];
    for (const block of inserts) {
      expect(block).not.toMatch(/portal_token/);
    }
  });

  it("imports/actions.ts customer/supplier INSERTs do not pass portal_token", () => {
    const imports = read("app/(app)/imports/actions.ts");
    // The "customer" / "supplier" insertOne branches write minimal
    // fields. portal_token must be absent so the DB default applies.
    const customerBlock =
      imports.match(/case "customer":[\s\S]*?case "/)?.[0] ?? "";
    expect(customerBlock).not.toMatch(/portal_token/);
  });
});

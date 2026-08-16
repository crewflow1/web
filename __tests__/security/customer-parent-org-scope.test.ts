import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tenant integrity for the B2B parent grouping (migration 20261151000000).
 *
 * The parent link (customers.parent_customer_id) is a cross-row reference, which
 * RLS CANNOT protect — RLS guards the row being written, not the row it points
 * at. A dual-org member could otherwise roll their customer up under ANOTHER
 * org's business. These lock the three defences:
 *   1. a COMPOSITE FK (parent_customer_id, org_id) → customers(id, org_id),
 *   2. a no-self-parent CHECK,
 *   3. an active-org-pinned application check + active-org-pinned reads.
 */

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

describe("migration: composite FK + guards", () => {
  const sql = read(
    "supabase/migrations/20261151000000_customer_type_and_company.sql",
  );

  it("binds the parent link with a composite FK to customers(id, org_id)", () => {
    expect(sql).toMatch(/foreign key \(parent_customer_id, org_id\)/);
    expect(sql).toMatch(/references public\.customers \(id, org_id\)/);
  });

  it("un-groups children on parent delete without nulling NOT NULL org_id", () => {
    // PG15+ column-list form — nulls ONLY parent_customer_id.
    expect(sql).toMatch(/on delete set null \(parent_customer_id\)/);
  });

  it("forbids a customer being its own parent", () => {
    expect(sql).toMatch(/customers_parent_not_self/);
    expect(sql).toMatch(/parent_customer_id is null or parent_customer_id <> id/);
  });

  it("keeps customer_type a closed set defaulting to individual", () => {
    expect(sql).toMatch(/customer_type text not null default 'individual'/);
    expect(sql).toMatch(/customer_type in \('individual', 'business'\)/);
  });

  it("is purely additive (add column if not exists / no drop of customers)", () => {
    expect(sql).toMatch(/add column if not exists customer_type/);
    expect(sql).toMatch(/add column if not exists parent_customer_id/);
    expect(sql).not.toMatch(/drop table/i);
    expect(sql).not.toMatch(/drop column/i);
  });
});

describe("actions verify the parent is in the ACTIVE org", () => {
  const actions = read("app/(app)/customers/actions.ts");

  it("resolveParentCustomer pins org_id and rejects a foreign/self parent", () => {
    expect(actions).toContain("resolveParentCustomer");
    // org pin on the parent lookup
    expect(actions).toMatch(/\.eq\("id", rawParentId\)[\s\S]*\.eq\("org_id", orgId\)/);
    // self-parent rejected
    expect(actions).toContain("its own parent business");
  });

  it("both create and update route the parent through the check before writing", () => {
    const calls = actions.match(/resolveParentCustomer\(/g) ?? [];
    // one definition + one call in create + one call in update
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("companies loaders are active-org pinned + loud", () => {
  const loaders = read("lib/customers/companies.ts");

  it("every read pins org_id", () => {
    const orgPins = loaders.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(orgPins.length).toBeGreaterThanOrEqual(2);
  });

  it("throws readFailure on error rather than returning an empty list", () => {
    expect(loaders).toContain("readFailure");
    expect(loaders).not.toMatch(/return \[\][^;]*\/\/ *on error/);
  });

  it("excludes self from the parent picker", () => {
    expect(loaders).toContain('query.neq("id", excludeId)');
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-contract guard for the customer portal payment schedule (H2-CASH M3).
 *
 * The portal reads billing plans/stages on the RLS-BYPASSING admin client, and
 * those tables have no customer_id — so the query text itself is the security
 * boundary. This pins the two properties that keep it safe:
 *   1. it resolves the customer's OWN jobs (org_id + customer_id) and scopes
 *      stages/plans by `job_id` — never an org-wide read;
 *   2. it never SELECTs internal/PII columns (notes, created_by, basis_amount,
 *      the stage percent/basis carve internals).
 * Mirrors __tests__/security/portal-invoices-scope.test.ts.
 */

const src = readFileSync(join(process.cwd(), "app/customer-portal/[token]/_schedule.ts"), "utf8");

describe("portal schedule query is customer-scoped and leak-free (source contract)", () => {
  it("resolves the customer's own jobs by org_id + customer_id", () => {
    expect(src).toMatch(/\.eq\("org_id",\s*orgId\)/);
    expect(src).toMatch(/\.eq\("customer_id",\s*customerId\)/);
  });

  it("scopes plans and stages by the customer's job ids (the load-bearing filter)", () => {
    expect(src).toMatch(/\.in\("job_id",\s*jobIds\)/);
  });

  it("never SELECTs internal/PII columns from plans or stages", () => {
    // Only the stage/plan select strings matter; assert none of these appear anywhere
    // in a select() call. A blunt substring check is deliberately strict.
    const selects = [...src.matchAll(/\.select\("([^"]*)"\)/g)].map((m) => m[1] ?? "");
    const joined = selects.join(" | ");
    expect(joined).not.toMatch(/\bnotes\b/);
    expect(joined).not.toMatch(/\bcreated_by\b/);
    expect(joined).not.toMatch(/\bbasis_amount\b/);
    expect(joined).not.toMatch(/\bpercent\b/);
  });

  it("uses the admin client (portal has no user JWT) — so the job filter is the barrier", () => {
    expect(src).toMatch(/createAdminClient/);
  });
});

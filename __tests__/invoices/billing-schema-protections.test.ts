import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Schema-assertion suite for the billing double-invoice / FK guards
 * (launch stabilization). CI has no database, so — exactly like
 * invoice-flow.test.ts pins the invoices.total generated column — we assert
 * on the migration SQL itself. These lock the DB-level backstops in place so
 * a future edit can't silently drop them.
 *
 * What they guarantee:
 *   1. A PARTIAL unique index on invoices(quote_id) — at most one invoice per
 *      quote, the universal backstop for the double-invoicing bug across the
 *      owner-accept, public-token-accept and manual POST /api/invoices paths.
 *   2. The migration repairs any pre-existing duplicates NON-destructively
 *      (unlink, never delete) and idempotently, so it is safe to deploy.
 *   3. quotes -> customers delete is codified as explicit ON DELETE RESTRICT,
 *      via a guarded swap that is a no-op on re-run.
 */

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf-8");
const mig = read(
  "supabase/migrations/20260704000000_billing_schema_protections.sql",
);

describe("billing schema protections — invoices(quote_id) uniqueness", () => {
  it("creates a PARTIAL unique index so a quote cannot be double-invoiced", () => {
    expect(mig).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+invoices_quote_id_unique/i,
    );
    expect(mig).toMatch(/on\s+public\.invoices\s*\(\s*quote_id\s*\)/i);
  });

  it("is PARTIAL (WHERE quote_id IS NOT NULL) so standalone invoices don't collide", () => {
    expect(mig).toMatch(/where\s+quote_id\s+is\s+not\s+null/i);
  });

  it("is idempotent at the index level (IF NOT EXISTS)", () => {
    expect(mig).toMatch(/create\s+unique\s+index\s+if\s+not\s+exists/i);
  });
});

describe("billing schema protections — duplicate repair is safe", () => {
  it("keeps the earliest invoice per quote and unlinks the rest", () => {
    expect(mig).toMatch(/row_number\(\)\s*over\s*\(\s*partition\s+by\s+quote_id/i);
    expect(mig).toMatch(/order\s+by\s+created_at\s+asc/i);
    expect(mig).toMatch(/set\s+quote_id\s*=\s*null/i);
    expect(mig).toMatch(/r\.rn\s*>\s*1/i);
  });

  it("NEVER deletes an invoice row (non-destructive financial repair)", () => {
    expect(mig).not.toMatch(/delete\s+from\s+public\.invoices/i);
    expect(mig).not.toMatch(/delete\s+from\s+invoices/i);
  });
});

describe("billing schema protections — quotes.customer_id FK", () => {
  it("codifies ON DELETE RESTRICT (quotes are financial records; customer_id is NOT NULL)", () => {
    expect(mig).toMatch(/quotes_customer_id_fkey/);
    expect(mig).toMatch(
      /references\s+public\.customers\s*\(\s*id\s*\)\s+on\s+delete\s+restrict/i,
    );
  });

  it("swaps the constraint idempotently (only when not already RESTRICT)", () => {
    expect(mig).toMatch(/confdeltype\s*<>\s*'r'/i);
    expect(mig).toMatch(/drop\s+constraint\s+quotes_customer_id_fkey/i);
  });

  it("does NOT use CASCADE or SET NULL (would destroy/orphan financial records)", () => {
    // The customer_id FK must not cascade-delete quotes or null a NOT NULL col.
    expect(mig).not.toMatch(/quotes_customer_id_fkey[\s\S]*on\s+delete\s+cascade/i);
    expect(mig).not.toMatch(
      /references\s+public\.customers\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i,
    );
  });
});

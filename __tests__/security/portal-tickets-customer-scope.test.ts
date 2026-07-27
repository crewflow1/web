import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Security regression suite — customer-portal cross-customer ticket leak.
 *
 * Background: the portal messages page runs under the service-role admin
 * client (the portal carries no Supabase JWT, so RLS cannot scope it). It used
 * to filter `support_tickets` by org_id ONLY, which listed EVERY customer's
 * ticket subjects + message previews to any portal visitor of that org — a
 * HIGH cross-customer data leak.
 *
 * Fix: migration 20260706000000 adds support_tickets.customer_id; the portal
 * write path stamps it on new tickets; the read path filters
 * `.eq("customer_id", customer.id)`.
 *
 * CI has no database (see billing-schema-protections.test.ts), so we assert on
 * the migration SQL text and the portal source files — locking the scope in
 * place so a future edit cannot silently re-open the leak.
 */

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

const migrationRaw = read(
  "supabase/migrations/20260706000000_support_tickets_customer_scope.sql",
);
// Executable SQL only — strip line comments so the explanatory header (which
// mentions org_id / customer_id / "leak" / "drop") can't skew assertions.
const sql = migrationRaw.replace(/--.*$/gm, "");

const readPath = read("app/customer-portal/[token]/messages/page.tsx");
const writePath = read("app/customer-portal/_message-action.ts");

describe("portal tickets — additive customer_id migration", () => {
  it("adds support_tickets.customer_id guarded by IF NOT EXISTS", () => {
    expect(sql).toMatch(
      /alter\s+table\s+public\.support_tickets\s+add\s+column\s+if\s+not\s+exists\s+customer_id\s+uuid/i,
    );
  });

  it("makes customer_id a real FK to public.customers", () => {
    expect(sql).toMatch(/references\s+public\.customers\s*\(\s*id\s*\)/i);
  });

  it("creates the supporting customer_id index (IF NOT EXISTS)", () => {
    expect(sql).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+support_tickets_customer_id_idx\s+on\s+public\.support_tickets\s*\(\s*customer_id\s*\)/i,
    );
  });

  it("is additive only — no destructive or behavioural statements", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/\bcreate\s+policy\b/i);
    expect(sql).not.toMatch(/\bdrop\s+policy\b/i);
    // The rollback statements must stay commented out (executable SQL only).
    expect(sql).not.toMatch(/\bdrop\s+(index|column)\b/i);
  });
});

describe("portal tickets — read path is scoped to one customer", () => {
  it("filters support_tickets by customer_id (closes the leak)", () => {
    // Without this constraint the page lists every customer's tickets in the
    // org. This is the assertion that fails if the leak is re-introduced.
    expect(readPath).toMatch(
      /\.eq\(\s*["']customer_id["']\s*,\s*customer\.id\s*\)/,
    );
  });

  it("still constrains org_id as well (defence in depth)", () => {
    expect(readPath).toMatch(
      /\.eq\(\s*["']org_id["']\s*,\s*customer\.org_id\s*\)/,
    );
  });

  it("no longer claims to show ALL tickets for the org", () => {
    expect(readPath).not.toMatch(/show ALL tickets for/i);
  });
});

describe("portal tickets — write path stamps the owning customer", () => {
  it("sets customer_id on the support_tickets insert", () => {
    expect(writePath).toMatch(/customer_id:\s*customer\.id/);
  });
});

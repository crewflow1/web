import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { invoiceCustomerId } from "@/lib/invoices/customer";

/**
 * Issue #349 Phase 1 — customer denormalisation wiring contract.
 *
 * The DB invariant + quote-loss survival are proved by the real-Postgres
 * integration suite. This pins, on source, that:
 *   - every invoice WRITER persists customer_id;
 *   - every invoice→customer READER goes through the ONE authority
 *     (invoiceCustomerId / a direct customer_id scope), not a fresh quote walk;
 *   - the migration is shaped as the #351 composite-FK pattern.
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

// =====================================================================
// The one authority — behavioural (it's pure)
// =====================================================================

describe("invoiceCustomerId — the single resolver", () => {
  it("prefers the invoice's own customer_id", () => {
    expect(
      invoiceCustomerId({ customer_id: "direct", quote: { customer_id: "viaquote" } }),
    ).toBe("direct");
  });

  it("falls back to the quote's customer only when customer_id is absent", () => {
    expect(invoiceCustomerId({ customer_id: null, quote: { customer_id: "viaquote" } })).toBe(
      "viaquote",
    );
  });

  it("returns null when neither is present (legacy orphan)", () => {
    expect(invoiceCustomerId({ customer_id: null, quote: null })).toBeNull();
    expect(invoiceCustomerId({})).toBeNull();
  });
});

// =====================================================================
// Writers persist customer_id
// =====================================================================

describe("every invoice writer stamps customer_id", () => {
  it("the API create route sets customer_id from the quote", () => {
    const src = read("app/api/invoices/route.ts");
    expect(src).toMatch(/\.select\("[^"]*customer_id[^"]*"\)/); // fetched from quote
    expect(src).toMatch(/customer_id: \(quote as/); // written on insert
  });

  it("both quote-acceptance auto-invoice paths set customer_id", () => {
    const src = read("app/(app)/quotes/actions.ts");
    const inserts = [...src.matchAll(/\.from\("invoices"\)\s*\.insert\(\{[\s\S]*?\}\)/g)];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const m of inserts) {
      expect(m[0]).toMatch(/customer_id: quote\.customer_id/);
    }
  });
});

// =====================================================================
// Readers use the authority / direct customer_id
// =====================================================================

describe("invoice→customer readers use the direct authority", () => {
  it("portal invoices page scopes by customer_id, not quote_id", () => {
    const src = read("app/customer-portal/[token]/invoices/page.tsx");
    expect(src).toMatch(/\.eq\("customer_id", customer\.id\)/);
    // The old quote-walk scoping must be gone from the CODE.
    expect(readCode("app/customer-portal/[token]/invoices/page.tsx")).not.toMatch(
      /\.in\("quote_id", quoteIds\)/,
    );
  });

  it("portal overview scopes invoices by customer_id", () => {
    const code = readCode("app/customer-portal/[token]/page.tsx");
    expect(code).toMatch(
      /from\("invoices"\)[\s\S]*?\.eq\("customer_id", customer\.id\)/,
    );
    expect(code).not.toMatch(/from\("invoices"\)[\s\S]*?\.in\("quote_id", quoteIds\)/);
  });

  it("portal PDF ownership resolves via invoiceCustomerId", () => {
    const src = read("app/customer-portal/[token]/invoices/[id]/pdf/route.ts");
    expect(src).toMatch(/invoiceCustomerId\(invoice\) !== customer\.id/);
    expect(src).toMatch(/from "@\/lib\/invoices\/customer"/);
  });

  it("send-invoice + reminders prefer the invoice's own customer email", () => {
    const send = read("lib/email/send-invoice.ts");
    expect(send).toMatch(/customers!invoices_customer_org_fkey/);
    expect(send).toMatch(/invoice\.customer\?\.email \?\?[\s\S]*?invoice\.quote\?\.customer\?\.email/);

    const cron = read("app/api/cron/invoice-reminders/route.ts");
    expect(cron).toMatch(/customers!invoices_customer_org_fkey/);
    expect(cron).toMatch(/inv\.customer\?\.email \?\? inv\.quote\?\.customer\?\.email/);
  });
});

// =====================================================================
// Migration shape (mirrors #351)
// =====================================================================

describe("migration — composite-FK pattern from #351", () => {
  const MIG = read(
    "supabase/migrations/20260915000000_invoice_customer_denormalisation.sql",
  );

  it("adds the customers (id, org_id) candidate key as the FK target", () => {
    expect(MIG).toMatch(/add constraint customers_id_org_key unique \(id, org_id\)/);
  });

  it("adds invoices.customer_id (nullable) + the composite FK to customers", () => {
    expect(MIG).toMatch(/add column if not exists customer_id uuid/);
    expect(MIG).toMatch(
      /foreign key \(customer_id, org_id\)\s*references public\.customers \(id, org_id\)/,
    );
    expect(MIG).toMatch(/on delete cascade/);
  });

  it("backfills from the quote, same-org and unambiguous only", () => {
    expect(MIG).toMatch(/update public\.invoices i/);
    expect(MIG).toMatch(/set customer_id = q\.customer_id/);
    expect(MIG).toMatch(/q\.org_id = i\.org_id/);
    expect(MIG).toMatch(/q\.customer_id is not null/);
  });

  it("does NOT touch line items (out of Phase 1 scope)", () => {
    expect(MIG).not.toMatch(/line_item|quote_line_items|invoice_line_items/i);
  });
});

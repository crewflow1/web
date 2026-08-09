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

/**
 * STATIC GUARD — the DISPLAY half of the same class.
 *
 * THE CLASS (C51/C52 display sibling). The filter/ownership guard above pins
 * reads that GATHER or AUTHORISE a customer's invoices. This one pins reads that
 * PRINT or ACT ON the customer's contact fields — the PDF BILL TO line, the
 * detail page's "send" recipient, the CSV/accounting exports, the bank-reconcile
 * customer column.
 *
 * generate_stage_invoice (migration 20261039000000) ALWAYS inserts quote_id NULL
 * with customer_id set, so 100% of stage-billing invoices are quote-less. A read
 * that resolved the customer's name/email through the QUOTE join alone therefore
 * printed a "—" addressee (a legally/financially defective document) and reported
 * "no recipient" on the send control. The same struck any quote-derived invoice
 * whose quote was later deleted (quote_id ON DELETE SET NULL).
 *
 * The authority is the composite FK `invoices_customer_org_fkey` (migration
 * 20260915000000) with customer_id-first resolution — exactly what
 * lib/email/send-invoice.ts and lib/invoices/customer.ts already do. Every
 * customer-DISPLAY read must join that FK and resolve the OWN customer first.
 *
 * Two invariants per surface:
 *   (a) the executable select JOINS the direct customer via the composite FK;
 *   (b) no assignment resolves a contact field QUOTE-FIRST (value beginning
 *       `x.quote?.customer?.name|email ?? null|""`) — the exact defective shape.
 *
 * (a) calibrates RED on the three pre-fix display surfaces (the PDF route, the
 * portal PDF route, the detail page never joined the FK) and GREEN after.
 */
describe("invoice customer DISPLAY-read anchor guard", () => {
  // Every read that PRINTS or ACTS ON the invoice's customer name/email.
  const DISPLAY_READS = [
    "app/api/invoices/[id]/pdf/route.ts",
    "app/customer-portal/[token]/invoices/[id]/pdf/route.ts",
    "app/(app)/invoices/[id]/page.tsx",
    "app/(app)/payments/actions.ts",
    "app/api/invoices/export/route.ts",
  ];

  // A contact resolution whose value STARTS with the quote join — i.e. the quote
  // is the FIRST (or only) source. `inv.customer?.name ?? inv.quote?.customer...`
  // is customer-first and does NOT match (the value starts with `.customer`).
  const QUOTE_FIRST_CONTACT =
    /[:=]\s*[A-Za-z_$][\w.$]*\.quote\?\.customer\?\.(name|email)\s*\?\?\s*(null|"")/;

  for (const rel of DISPLAY_READS) {
    const code = codeOf(src(rel));

    it(`${rel}: joins the direct customer via invoices_customer_org_fkey`, () => {
      expect(code).toMatch(/invoices_customer_org_fkey/);
    });

    it(`${rel}: never resolves a customer contact field quote-first`, () => {
      expect(code).not.toMatch(QUOTE_FIRST_CONTACT);
    });
  }
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * VOID-INVOICE PORTAL LEAK — the stale-link class #986 closed on the quote path,
 * applied to the invoice surface.
 *
 * A void invoice (migration 20261219) is RETRACTED. The invoices-tab list states
 * the canonical invariant and enforces it with `.neq("status","void")`:
 *   "the customer must never see it as owed, be shown bank details for it, or be
 *   able to pay it."
 * The pay action (`createInvoiceCheckout` GUARD 4) refuses `void` too.
 *
 * But two sibling surfaces reachable with the SAME portal token used to serve a
 * void invoice anyway — each carrying the org's BANK DETAILS and the amount:
 *   DEFECT A — the per-invoice PDF route fetched the invoice by id, checked only
 *     ownership, and rendered REGARDLESS of status. Its URL survives the void, so
 *     a bookmarked/known id kept serving a retracted bill.
 *   DEFECT B — the bulk "Download all (zip)" collector scoped invoices by org +
 *     customer but NEVER filtered status (its quote query already gated status for
 *     exactly this "surface consistency" reason), so void invoice PDFs rode into
 *     the zip.
 *
 * These are SOURCE assertions (the pattern used across __tests__/security for the
 * portal route/collector files, which can't be executed without react-pdf + a
 * live admin client). They are RED on the pre-fix code and GREEN after.
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

const PDF_ROUTE = "app/customer-portal/[token]/invoices/[id]/pdf/route.ts";
const COLLECTOR = "lib/customers/portal-bulk-download.ts";
const LIST = "app/customer-portal/[token]/invoices/page.tsx";

const PDF_CODE = readCode(PDF_ROUTE);
const COLLECTOR_CODE = readCode(COLLECTOR);
const LIST_CODE = readCode(LIST);

describe("void-invoice leak — the invariant anchor (invoices list)", () => {
  it("the on-screen list still excludes void (the canonical invariant the other surfaces must match)", () => {
    expect(LIST_CODE).toMatch(/\.from\("invoices"\)[\s\S]*?\.neq\(\s*"status"\s*,\s*"void"\s*\)/);
  });
});

describe("DEFECT A — per-invoice PDF route gates void", () => {
  it("resolves the token via the ONE authority and fails closed before any read", () => {
    expect(PDF_CODE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(PDF_CODE).toMatch(/if\s*\(!loaded\)[\s\S]{0,80}?status:\s*404/);
  });

  it("refuses a void invoice with a 404 (after ownership, identical to a foreign id)", () => {
    // The gate itself.
    expect(PDF_CODE).toMatch(
      /invoice\.status\s*===\s*"void"[\s\S]{0,80}?status:\s*404/,
    );
  });

  it("the void gate sits AFTER the ownership checks (so it reveals nothing a foreign id wouldn't)", () => {
    const ownerIdx = PDF_CODE.indexOf("invoiceCustomerId(invoice)");
    const voidIdx = PDF_CODE.indexOf('invoice.status === "void"');
    expect(ownerIdx).toBeGreaterThan(-1);
    expect(voidIdx).toBeGreaterThan(ownerIdx);
  });

  it("still selects status so the gate has a value to check", () => {
    expect(PDF_CODE).toMatch(/\.from\("invoices"\)[\s\S]*?\bstatus\b/);
  });
});

describe("DEFECT B — bulk zip collector excludes void invoices", () => {
  it("the invoices query carries the same `.neq(\"status\",\"void\")` gate as the list", () => {
    expect(COLLECTOR_CODE).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.neq\(\s*"status"\s*,\s*"void"\s*\)/,
    );
  });

  it("re-excludes void in the per-row ownership re-verification (defence-in-depth)", () => {
    expect(COLLECTOR_CODE).toMatch(/inv\.status\s*!==\s*"void"/);
  });

  it("keeps the pre-existing per-row org + customer ownership re-check intact", () => {
    expect(COLLECTOR_CODE).toMatch(/inv\.org_id\s*===\s*customer\.org_id/);
    expect(COLLECTOR_CODE).toMatch(/invoiceCustomerId\(inv\)\s*===\s*customer\.id/);
  });
});

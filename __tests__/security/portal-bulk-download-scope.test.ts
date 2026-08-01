import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer-portal BULK (zip) download — security source-assertions.
 *
 * The bulk route composes the SAME per-document scoped reads into one archive,
 * so it inherits the portal's whole trust model and must not weaken any of it.
 * These pins protect the invariants that make a bulk endpoint safe on the
 * RLS-BYPASSING service-role client where the URL token is the only auth:
 *
 *   1. TOKEN CHOKEPOINT — the route resolves the token via the ONE authority and
 *      fails closed (404) before touching any document.
 *   2. NO CLIENT IDS — the route accepts NO document-id input; the set is derived
 *      server-side from the token-resolved customer. The only input is an
 *      optional `type` filter validated against a fixed allow-list.
 *   3. PER-DOC SCOPE — the collector scopes invoices & quotes by BOTH org_id AND
 *      the customer's OWN customer_id, re-verifies each row, and delegates
 *      reports/certificates to the existing scoped portal loaders.
 *   4. PRIVATE — Cache-Control: private, no-store; no sensitive data in the zip
 *      filename.
 *   5. BOUNDED — an explicit count cap and byte ceiling.
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

const ROUTE = "app/customer-portal/[token]/documents/download-all/route.ts";
const COLLECTOR = "lib/customers/portal-bulk-download.ts";
const PLAN = "lib/customers/portal-bulk-plan.ts";

const ROUTE_SRC = read(ROUTE);
const ROUTE_CODE = readCode(ROUTE);
const COLLECTOR_SRC = read(COLLECTOR);
const COLLECTOR_CODE = readCode(COLLECTOR);
const PLAN_CODE = readCode(PLAN);

describe("bulk download — token chokepoint", () => {
  it("resolves the token via the ONE authority and fails closed", () => {
    expect(ROUTE_CODE).toMatch(/loadCustomerByPortalToken\(token\)/);
    expect(ROUTE_CODE).toMatch(/if\s*\(!loaded\)/);
    expect(ROUTE_CODE).toMatch(/status:\s*404/);
  });
});

describe("bulk download — NO client-supplied ids", () => {
  it("takes no id/ids parameter; the only input is a validated type filter", () => {
    // No document id ever comes off the request.
    expect(ROUTE_CODE).not.toMatch(/searchParams\.get\(\s*["'](id|ids|documentId|doc)["']\s*\)/);
    // The one accepted input is `type`, checked against a fixed allow-list.
    expect(ROUTE_CODE).toMatch(/searchParams\.get\("type"\)/);
    expect(ROUTE_CODE).toMatch(/TYPES\.includes\(/);
  });

  it("the allow-list is exactly the four portal doc types", () => {
    expect(ROUTE_SRC).toMatch(
      /TYPES[^\n]*=\s*\[\s*"quote",\s*"invoice",\s*"report",\s*"certificate"\s*\]/,
    );
  });

  it("the collector is called with the token-resolved customer, never request ids", () => {
    expect(ROUTE_CODE).toMatch(/collectPortalDocumentPdfs\(\s*\{[\s\S]*?customer,[\s\S]*?org,[\s\S]*?filter,/);
  });
});

describe("bulk download — per-document scope on the collector", () => {
  it("invoices are scoped by org_id AND the customer's OWN customer_id", () => {
    expect(COLLECTOR_SRC).toMatch(
      /\.from\("invoices"\)[\s\S]*?\.eq\("org_id",\s*customer\.org_id\)[\s\S]*?\.eq\("customer_id",\s*customer\.id\)/,
    );
  });

  it("quotes are scoped by org_id AND the customer's OWN customer_id", () => {
    expect(COLLECTOR_SRC).toMatch(
      /\.from\("quotes"\)[\s\S]*?\.eq\("org_id",\s*customer\.org_id\)[\s\S]*?\.eq\("customer_id",\s*customer\.id\)/,
    );
  });

  it("re-verifies each invoice/quote row belongs to the customer (defence-in-depth)", () => {
    expect(COLLECTOR_CODE).toMatch(/invoiceCustomerId\(inv\)\s*===\s*customer\.id/);
    expect(COLLECTOR_CODE).toMatch(/q\.customer_id\s*===\s*customer\.id/);
  });

  it("delegates reports & certificates to the existing scoped portal loaders", () => {
    expect(COLLECTOR_CODE).toMatch(/listPortalReports\(customer\.id,\s*customer\.org_id\)/);
    expect(COLLECTOR_CODE).toMatch(/listPortalCertificates\(customer\.id,\s*customer\.org_id\)/);
    expect(COLLECTOR_CODE).toMatch(/loadPortalReport\(ctx\.customer\.id,\s*ctx\.org\.id,\s*id\)/);
    expect(COLLECTOR_CODE).toMatch(/loadPortalCertificate\(ctx\.customer\.id,\s*ctx\.org\.id,\s*id\)/);
  });

  it("never widens invoices/quotes via an id `.in(...)` list (no enumeration crutch)", () => {
    expect(COLLECTOR_CODE).not.toMatch(/from\("invoices"\)[\s\S]*?\.in\("id"/);
    expect(COLLECTOR_CODE).not.toMatch(/from\("quotes"\)[\s\S]*?\.in\("id"/);
  });

  it("reads loudly — a query failure throws rather than yielding an empty zip", () => {
    expect(COLLECTOR_CODE).toMatch(/throw readFailure\(/);
  });
});

describe("bulk download — private response, safe filename", () => {
  it("sets Cache-Control: private, no-store", () => {
    expect(ROUTE_CODE).toMatch(/"Cache-Control":\s*"private, no-store"/);
  });

  it("streams a zip whose filename carries no customer/org identity", () => {
    expect(ROUTE_CODE).toMatch(/application\/zip/);
    expect(ROUTE_CODE).toMatch(/filename="\$\{bulkZipFilename\(\)\}"/);
    // The neutral name is a constant with no interpolation.
    expect(PLAN_CODE).toMatch(/return "documents\.zip"/);
  });
});

describe("bulk download — BOUNDED", () => {
  it("enforces a document-count cap and a total-byte ceiling", () => {
    expect(PLAN_CODE).toMatch(/MAX_BULK_DOCS\s*=\s*\d+/);
    expect(COLLECTOR_CODE).toMatch(/MAX_BULK_TOTAL_BYTES/);
    expect(COLLECTOR_CODE).toMatch(/byteCapped\s*=\s*true/);
  });
});

describe("bulk download — runtime", () => {
  it("runs on nodejs (react-pdf + JSZip need Node)", () => {
    expect(ROUTE_CODE).toMatch(/export const runtime = "nodejs"/);
  });
});

import { describe, it, expect } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { StatementPdf, type StatementPdfInput } from "@/lib/pdf/statement-pdf";

/**
 * Renders the Statement of Account component to a real PDF buffer (server-side,
 * exactly as the /api/customers/[id]/statement/pdf route does) and asserts a
 * well-formed, non-trivial document. Proves the template compiles and renders
 * across its sections (letterhead, parties, summary, ledger, credit-balance
 * labelling) without throwing.
 */

const base: StatementPdfInput = {
  org_name: "Carter Construction Ltd",
  org_phone: "0161 000 0000",
  org_vat_number: "GB123456789",
  org_logo_url: null,
  org_address: { line1: "1 Trade Park", city: "Manchester", postcode: "M1 1AA" },
  customer_name: "Acme Developments",
  customer_email: "accounts@acme.example",
  customer_address: { line1: "22 High Street", city: "Leeds", postcode: "LS1 2AB" },
  from: "2026-01-01",
  to: "2026-03-31",
  generated_at: "2026-04-01T09:00:00.000Z",
  openingBalance: 800,
  closingBalance: 1200,
  totalCharged: 500,
  totalCredited: 100,
  entries: [
    { date: "2026-01-15", description: "Invoice INV-0002", charge: 500, credit: 0, balance: 1300 },
    { date: "2026-01-20", description: "Payment received · BACS-1", charge: 0, credit: 100, balance: 1200 },
  ],
};

describe("StatementPdf", () => {
  it("renders a well-formed, non-trivial PDF buffer", async () => {
    const buffer = await renderToBuffer(StatementPdf({ s: base }));
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders with no entries and no range (empty account, open-ended)", async () => {
    const bare: StatementPdfInput = {
      ...base,
      from: null,
      to: null,
      openingBalance: 0,
      closingBalance: 0,
      totalCharged: 0,
      totalCredited: 0,
      entries: [],
      org_logo_url: null,
      customer_address: null,
      org_address: null,
      customer_email: null,
    };
    const buffer = await renderToBuffer(StatementPdf({ s: bare }));
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a credit (negative) balance without throwing", async () => {
    const buffer = await renderToBuffer(
      StatementPdf({ s: { ...base, closingBalance: -50, openingBalance: -10 } }),
    );
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

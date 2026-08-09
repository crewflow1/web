import { describe, it, expect } from "vitest";
import {
  invoiceCustomerName,
  invoiceCustomerEmail,
} from "@/lib/invoices/customer";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";

/**
 * REGRESSION — a stage-billing invoice must PRINT its customer and REPORT a
 * send recipient.
 *
 * generate_stage_invoice (migration 20261039000000) ALWAYS inserts quote_id
 * NULL with customer_id set, so every stage-billing invoice is quote-less. The
 * three display reads (the PDF route, the portal PDF route, the detail page)
 * used to resolve the customer through the QUOTE join alone, so a stage invoice
 * printed BILL TO "—" (a defective document) and reported "no recipient" on the
 * send control. These assert the fixed reads resolve via the invoice's OWN
 * customer (invoices_customer_org_fkey), quote only as the legacy-orphan
 * fallback — exactly what lib/invoices/customer.ts and send-invoice.ts do.
 */

// A stage-billing invoice EXACTLY as generate_stage_invoice leaves it: no quote,
// direct customer joined via invoices_customer_org_fkey. This is the shape the
// fixed PDF route + portal PDF route + detail page build from their selects.
const STAGE_INVOICE = {
  customer: { name: "Direct Customer Ltd", email: "billing@direct.example" },
  quote: null,
};

// A legacy orphan: customer_id was never backfilled and the row still reaches a
// customer only through its quote. The fallback must still resolve it.
const LEGACY_ORPHAN = {
  customer: null,
  quote: { customer: { name: "Quote Co", email: "ap@quote.example" } },
};

/** Flatten every string/number leaf of a react-pdf element tree. */
function textLeaves(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) textLeaves(c, out);
    return out;
  }
  const children = (node as { props?: { children?: unknown } }).props?.children;
  if (children !== undefined) textLeaves(children, out);
  return out;
}

const baseInput: Omit<InvoicePdfInput, "customer_name"> = {
  number: "STG-0001",
  status: "sent",
  amount: 1000,
  vat_total: 200,
  total: 1200,
  due_date: "2026-09-01",
  paid_at: null,
  notes: null,
  org_name: "Acme Builders",
  org_phone: null,
  org_vat_number: null,
  org_logo_url: null,
  org_address: null,
  org_bank_details: null,
  line_items: [],
};

describe("stage-billing invoice — customer display resolution", () => {
  it("PDF customer_name resolves to the DIRECT customer for a quote-less stage invoice", () => {
    // This is the resolution the PDF route + portal PDF route now perform.
    const customerName = invoiceCustomerName(STAGE_INVOICE);
    expect(customerName).toBe("Direct Customer Ltd");
  });

  it("the rendered BILL TO carries the direct customer, not a '—' dash", () => {
    const customer_name = invoiceCustomerName(STAGE_INVOICE);
    const leaves = textLeaves(InvoicePdf({ inv: { ...baseInput, customer_name } }));
    // The addressee prints...
    expect(leaves).toContain("Direct Customer Ltd");
    // ...and the defective-document dash is NOT the addressee. (The template is
    // `inv.customer_name ?? "—"`, so a resolved name means no dash is emitted.)
    expect(leaves).not.toContain("—");
  });

  it("detail-page customerEmail resolves to the DIRECT customer for a stage invoice", () => {
    // This is the resolution app/(app)/invoices/[id]/page.tsx now performs to
    // feed the send control's recipient.
    expect(invoiceCustomerEmail(STAGE_INVOICE)).toBe("billing@direct.example");
  });

  it("falls back to the quote's customer for a legacy orphan (no direct customer)", () => {
    expect(invoiceCustomerName(LEGACY_ORPHAN)).toBe("Quote Co");
    expect(invoiceCustomerEmail(LEGACY_ORPHAN)).toBe("ap@quote.example");
  });

  it("prefers the DIRECT customer over the quote when both are present", () => {
    const both = {
      customer: { name: "Direct Customer Ltd", email: "billing@direct.example" },
      quote: { customer: { name: "Quote Co", email: "ap@quote.example" } },
    };
    expect(invoiceCustomerName(both)).toBe("Direct Customer Ltd");
    expect(invoiceCustomerEmail(both)).toBe("billing@direct.example");
  });
});

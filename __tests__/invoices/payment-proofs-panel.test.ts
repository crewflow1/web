import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Invoice detail — customer payment-proof visibility (staff side).
 *
 * Closes the payment-verification loop. Everything else already existed:
 *   - write        ← app/customer-portal/_upload-action.ts (portal_uploads row
 *                    + private portal-uploads bucket)
 *   - customer read← app/customer-portal/[token]/invoices/page.tsx
 *   - payment state← app/(app)/invoices/[id]/_payments-panel.tsx
 *                    (invoice_payments — the authority, untouched here)
 * ...but no staff surface read `portal_uploads`, so a proof a customer sent
 * reached nobody, while the portal told them the org would "confirm here once
 * it's matched". This adds the missing read + a signed URL to open the file.
 *
 * The point of these assertions is that this stays a READ that connects two
 * existing systems: it must not grow its own copy of upload rules or payment
 * state, and it must not become a second source of truth for either.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PANEL = read("app/(app)/invoices/[id]/_payment-proofs-panel.tsx");
const CLIENT = read("app/(app)/invoices/[id]/_payment-proofs-client.tsx");
const ACTION = read("app/(app)/invoices/[id]/proof-actions.ts");
const PAGE = read("app/(app)/invoices/[id]/page.tsx");
const PORTAL_INVOICES = read("app/customer-portal/[token]/invoices/page.tsx");

describe("payment proofs — files exist and are wired into the invoice page", () => {
  it("panel, client row, and action all exist", () => {
    for (const p of [
      "app/(app)/invoices/[id]/_payment-proofs-panel.tsx",
      "app/(app)/invoices/[id]/_payment-proofs-client.tsx",
      "app/(app)/invoices/[id]/proof-actions.ts",
    ]) {
      expect(existsSync(resolve(ROOT, p))).toBe(true);
    }
  });

  it("invoice detail page renders the panel for this invoice", () => {
    expect(PAGE).toMatch(/import \{ PaymentProofsPanel \}/);
    expect(PAGE).toMatch(/<PaymentProofsPanel invoiceId=\{invoice\.id\} \/>/);
  });

  it("places the proof above the payments panel — evidence before the decision", () => {
    const proofIdx = PAGE.indexOf("<PaymentProofsPanel");
    const payIdx = PAGE.indexOf("<PaymentsPanel");
    expect(proofIdx).toBeGreaterThanOrEqual(0);
    expect(payIdx).toBeGreaterThanOrEqual(0);
    expect(proofIdx).toBeLessThan(payIdx);
  });

  it("action is a server action; the row is a client component", () => {
    expect(ACTION).toMatch(/^"use server";/);
    expect(CLIENT).toMatch(/^"use client";/);
  });
});

describe("payment proofs — reuses portal_uploads, adds no infrastructure", () => {
  it("reads the SAME authoritative table the portal writes", () => {
    expect(PANEL).toMatch(/from\("portal_uploads" as never\)/);
    expect(PORTAL_INVOICES).toMatch(/from\("portal_uploads" as never\)/);
  });

  it("uses the same five filters as the customer-side read (no scope drift)", () => {
    for (const src of [PANEL, PORTAL_INVOICES]) {
      expect(src).toMatch(/\.eq\("org_id"/);
      expect(src).toMatch(/\.eq\("target_table", "invoices"\)/);
      expect(src).toMatch(/\.eq\("kind", "payment_proof"\)/);
    }
    // Customer side narrows by customer; staff side narrows by the invoice.
    expect(PORTAL_INVOICES).toMatch(/\.eq\("customer_id", customer\.id\)/);
    expect(PANEL).toMatch(/\.eq\("target_id", invoiceId\)/);
  });

  it("introduces no new migration, table, or bucket", () => {
    // The increment is a connection, not new infrastructure: it reuses the
    // portal-uploads bucket created by 20260620000000_portal_uploads.sql.
    expect(ACTION).toMatch(/\.from\("portal-uploads"\)/);
    expect(PANEL).not.toMatch(/create table|storage\.buckets/i);
  });
});

describe("payment proofs — zero duplicated business logic", () => {
  it("does not re-derive upload rules (MIME / size caps live in the writer)", () => {
    for (const src of [PANEL, CLIENT, ACTION]) {
      expect(src).not.toMatch(/ALLOWED_MIME|MAX_BYTES|10 \* 1024 \* 1024/);
    }
  });

  it("does not touch payment state — invoice_payments stays the authority", () => {
    // Checks table ACCESS, not mere mention: the panel's doc comment names
    // invoice_payments to explain the boundary, which is worth keeping.
    for (const src of [PANEL, CLIENT, ACTION]) {
      expect(src).not.toMatch(/from\("invoice_payments"/);
      expect(src).not.toMatch(/addInvoicePayment|removeInvoicePayment/);
    }
  });

  it("does not re-derive invoice status or outstanding totals", () => {
    // Seeing a proof is not evidence of payment; only recording a payment via
    // the existing panel may move invoice state. The proof list must never
    // imply or compute paid/outstanding.
    for (const src of [PANEL, CLIENT]) {
      expect(src).not.toMatch(/outstanding|paidTotal|"paid"|partially_paid/);
    }
  });

  it("copy makes clear the proof is a record, not a payment", () => {
    // Whitespace-tolerant: the JSX copy wraps across lines.
    expect(PANEL).toMatch(/not a\s+payment/i);
  });
});

describe("payment proofs — graceful degradation", () => {
  it("renders nothing when no proof was submitted", () => {
    expect(PANEL).toMatch(/if \(proofs\.length === 0\) return null/);
  });

  it("an absent/failed read collapses to empty, never a crash", () => {
    expect(PANEL).toMatch(/const proofs = data \?\? \[\]/);
  });

  it("a failed signed URL surfaces inline instead of throwing", () => {
    expect(CLIENT).toMatch(/if \(!url\)/);
    expect(CLIENT).toMatch(/role="alert"/);
  });

  it("shows the customer's own note when they left one", () => {
    expect(CLIENT).toMatch(/proof\.notes \?/);
  });
});

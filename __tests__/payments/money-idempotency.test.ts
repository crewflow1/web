import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Money write paths must guard against double-submit (a retried POST / double-click
 * that races the client-side disable), or the same money is recorded twice. The
 * single-invoice payment path was already hardened (invoices/[id]/payment-actions.ts,
 * locked by record-payment.test.ts); these source-contracts lock the same guard onto
 * the two newer paths — multi-invoice allocation and supplier bills — which shipped
 * without it. The guard runs BEFORE the write and returns an idempotent success.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("money write paths are idempotent (double-submit guarded)", () => {
  it("recordAllocatedPayment dedupes an identical receipt before the allocate_payment RPC", () => {
    const src = read("app/(app)/payments/allocate-actions.ts");
    expect(src).toMatch(/DEDUPE_WINDOW_MS/);
    expect(src).toMatch(/duplicate submit suppressed/);
    // the dedupe (and its early-return) must run BEFORE the RPC invocation, or it
    // can't prevent the double-write. Anchor on the RPC call cast, which is unique
    // and sits after the guard (not the docstring's earlier "allocate_payment" mention).
    expect(src.indexOf("duplicate submit suppressed")).toBeLessThan(src.indexOf("rpc as unknown"));
  });

  it("recordSupplierBill dedupes an identical bill before inserting into finances", () => {
    const src = read("app/(app)/purchase-orders/actions.ts");
    expect(src).toMatch(/DEDUPE_WINDOW_MS/);
    expect(src).toMatch(/duplicate supplier bill suppressed/);
    // the dedupe must precede the finances insert
    expect(src.indexOf("duplicate supplier bill suppressed")).toBeLessThan(src.lastIndexOf('.from("finances" as never'));
  });
});

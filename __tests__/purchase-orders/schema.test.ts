import { describe, expect, it } from "vitest";
import {
  canTransitionPo,
  poStatusLabel,
  purchaseOrderFormSchema,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/schema";
import { computeTotals } from "@/lib/quotes/totals";

describe("PO status transitions", () => {
  it("permits the forward lifecycle draft → sent → received", () => {
    expect(canTransitionPo("draft", "sent")).toBe(true);
    expect(canTransitionPo("sent", "received")).toBe(true);
  });

  it("allows cancelling from any live state", () => {
    expect(canTransitionPo("draft", "cancelled")).toBe(true);
    expect(canTransitionPo("sent", "cancelled")).toBe(true);
    expect(canTransitionPo("received", "cancelled")).toBe(true);
  });

  it("refuses illegal jumps and reopening a terminal state", () => {
    expect(canTransitionPo("draft", "received")).toBe(false); // must be sent first
    expect(canTransitionPo("received", "sent")).toBe(false); // no going back
    expect(canTransitionPo("cancelled", "draft")).toBe(false); // terminal
    expect(canTransitionPo("sent", "sent")).toBe(false); // no-op not a transition
  });

  it("labels every status", () => {
    const statuses: PurchaseOrderStatus[] = ["draft", "sent", "received", "cancelled"];
    for (const s of statuses) expect(poStatusLabel(s)).toMatch(/\w/);
  });
});

describe("purchaseOrderFormSchema", () => {
  it("accepts a minimal PO with one line and no supplier/job", () => {
    const parsed = purchaseOrderFormSchema.safeParse({
      line_items: [{ description: "Bricks", qty: 100, unit_price: 0.5, vat_rate: 20 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("requires at least one line item", () => {
    const parsed = purchaseOrderFormSchema.safeParse({ line_items: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects an out-of-set VAT rate", () => {
    const parsed = purchaseOrderFormSchema.safeParse({
      line_items: [{ description: "X", qty: 1, unit_price: 10, vat_rate: 17.5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("computes PO totals with the shared per-line VAT rounding", () => {
    // Reuse the quote totals engine — identical rounding contract.
    const totals = computeTotals([
      { description: "Bricks", qty: 100, unit: "ea", unit_price: 0.5, vat_rate: 20 },
      { description: "Sand", qty: 3, unit: "bag", unit_price: 4.99, vat_rate: 20 },
    ]);
    expect(totals.subtotal).toBe(64.97); // 50.00 + 14.97
    expect(totals.vat_total).toBe(12.99); // 10.00 + 2.99 (per-line rounded)
    expect(totals.total).toBe(77.96);
  });
});

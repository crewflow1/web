import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canReceiveAgainstPo,
  canTransitionPo,
  poManualTransitions,
  poStatusLabel,
  purchaseOrderFormSchema,
  PO_STATUSES,
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
    const statuses: PurchaseOrderStatus[] = [
      "draft",
      "sent",
      "partially_received",
      "received",
      "cancelled",
    ];
    for (const s of statuses) expect(poStatusLabel(s)).toMatch(/\w/);
    // no status may fall through to the raw enum value
    for (const s of PO_STATUSES) expect(poStatusLabel(s)).not.toBe(s);
  });
});

describe("PO statuses mirror the database CHECK", () => {
  // The fleet 20261057 lesson: a TypeScript mirror that drifts from its CHECK
  // is a bug waiting for the first user. PO_STATUSES and the constraint added
  // by 20261060000000 must move together, so read the migration and compare.
  it("PO_STATUSES matches purchase_orders_status_check exactly", () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        "../../supabase/migrations/20261060000000_purchase_order_receipt_state.sql",
      ),
      "utf8",
    );
    const m = sql.match(/add constraint purchase_orders_status_check\s*\n?\s*check \(status in \(([^)]*)\)\)/);
    expect(m, "status CHECK not found in 20261060000000").not.toBeNull();
    const inCheck = [...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(inCheck).toEqual([...PO_STATUSES].sort());
  });
});

describe("poManualTransitions — the derived-status rule", () => {
  it("with NO posted receipts the legacy manual tick still works", () => {
    // Back-compat: every PO in production today has no GRN, so nothing that
    // works now stops working and no backfill is needed.
    expect(poManualTransitions("sent", false)).toContain("received");
    expect(poManualTransitions("draft", false)).toEqual(["sent", "cancelled"]);
  });

  it("with posted receipts the ONLY manual move left is cancelling", () => {
    expect(poManualTransitions("sent", true)).toEqual(["cancelled"]);
    expect(poManualTransitions("partially_received", true)).toEqual(["cancelled"]);
    expect(poManualTransitions("received", true)).toEqual(["cancelled"]);
    expect(poManualTransitions("cancelled", true)).toEqual([]);
  });

  it("never offers a manual move into a derived status", () => {
    for (const from of PO_STATUSES) {
      for (const hasReceipts of [true, false]) {
        expect(poManualTransitions(from, hasReceipts)).not.toContain("partially_received");
      }
    }
  });
});

describe("canReceiveAgainstPo", () => {
  it("only a sent or part-received order can take a delivery", () => {
    expect(canReceiveAgainstPo("sent")).toBe(true);
    expect(canReceiveAgainstPo("partially_received")).toBe(true);
    // a draft has not been sent to the supplier; the rest are settled
    expect(canReceiveAgainstPo("draft")).toBe(false);
    expect(canReceiveAgainstPo("received")).toBe(false);
    expect(canReceiveAgainstPo("cancelled")).toBe(false);
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

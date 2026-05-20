import { describe, it, expect } from "vitest";
import {
  computeVariation,
  formatVariationLabel,
  variationFormSchema,
} from "@/lib/variations/schema";

describe("computeVariation — live-preview math", () => {
  it("derives revenue from costs + margin so margin = profit / revenue", () => {
    const r = computeVariation({
      labour_cost: 400,
      materials_cost: 300,
      subcontractor_cost: 200,
      misc_cost: 100,
      margin_pct: 25,
      vat_rate: 20,
    });
    expect(r.total_cost).toBe(1000);
    // 1000 / (1 - 0.25) = 1333.33
    expect(r.subtotal).toBe(1333.33);
    // VAT 20% of subtotal
    expect(r.vat_total).toBe(266.67);
    expect(r.total).toBe(1600); // 1333.33 + 266.67
    expect(r.gross_profit).toBe(333.33);
    // (333.33 / 1333.33) * 100 = 25 (rounded)
    expect(r.margin_pct).toBe(25);
  });

  it("buckets are exposed for the customer-facing line-item split", () => {
    const r = computeVariation({
      labour_cost: 100,
      materials_cost: 50,
      subcontractor_cost: 0,
      misc_cost: 0,
      margin_pct: 0,
      vat_rate: 0,
    });
    expect(r.cost_breakdown).toEqual({
      labour: 100,
      materials: 50,
      subcontractors: 0,
      misc: 0,
    });
    expect(r.subtotal).toBe(150);
    expect(r.gross_profit).toBe(0);
    expect(r.margin_pct).toBe(0);
  });

  it("negative margin (loss-leader) produces revenue below cost", () => {
    const r = computeVariation({
      labour_cost: 1000,
      materials_cost: 0,
      subcontractor_cost: 0,
      misc_cost: 0,
      margin_pct: -10,
      vat_rate: 20,
    });
    // 1000 / 1.1 = 909.09
    expect(r.subtotal).toBe(909.09);
    expect(r.gross_profit).toBe(-90.91);
    expect(r.margin_pct).toBe(-10);
  });

  it("zero-cost edge case returns zero across the board", () => {
    const r = computeVariation({
      labour_cost: 0,
      materials_cost: 0,
      subcontractor_cost: 0,
      misc_cost: 0,
      margin_pct: 25,
      vat_rate: 20,
    });
    expect(r.subtotal).toBe(0);
    expect(r.total).toBe(0);
    expect(r.margin_pct).toBe(0);
  });
});

describe("variationFormSchema validation", () => {
  it("requires title and coerces numeric fields", () => {
    const ok = variationFormSchema.safeParse({
      title: "Extra tiling",
      labour_cost: "100",
      materials_cost: "50",
      subcontractor_cost: 0,
      misc_cost: 0,
      margin_pct: "20",
      vat_rate: 20,
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.labour_cost).toBe(100);
      expect(ok.data.materials_cost).toBe(50);
      expect(ok.data.margin_pct).toBe(20);
    }
  });

  it("rejects margin > 95 and negative costs", () => {
    expect(
      variationFormSchema.safeParse({
        title: "x",
        labour_cost: 100,
        materials_cost: 0,
        subcontractor_cost: 0,
        misc_cost: 0,
        margin_pct: 99,
        vat_rate: 20,
      }).success,
    ).toBe(false);

    expect(
      variationFormSchema.safeParse({
        title: "x",
        labour_cost: -50,
        materials_cost: 0,
        subcontractor_cost: 0,
        misc_cost: 0,
        margin_pct: 20,
        vat_rate: 20,
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported VAT rates", () => {
    expect(
      variationFormSchema.safeParse({
        title: "x",
        labour_cost: 100,
        materials_cost: 0,
        subcontractor_cost: 0,
        misc_cost: 0,
        margin_pct: 20,
        vat_rate: 17.5, // historical UK rate, not in the allowed set
      }).success,
    ).toBe(false);
  });
});

describe("formatVariationLabel", () => {
  it("zero-pads to 3 digits", () => {
    expect(formatVariationLabel(1)).toBe("Variation #001");
    expect(formatVariationLabel(7)).toBe("Variation #007");
    expect(formatVariationLabel(123)).toBe("Variation #123");
  });
});

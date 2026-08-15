import { describe, it, expect } from "vitest";
import { poundsToPence, penceToPounds, formatPence } from "@/lib/money";
import {
  priceBookItemSchema,
  quoteTemplateSchema,
} from "@/lib/pricing/schema";

/**
 * Unit tests for the estimating price-book money boundary + form validation.
 *
 * Money is stored as INTEGER PENCE; the form speaks pounds. These pin the two
 * conversion helpers (no float drift) and the zod contracts that gate a write.
 */

describe("money pence <-> pounds boundary", () => {
  it("poundsToPence rounds to exact integer pence (no float drift)", () => {
    expect(poundsToPence(19.99)).toBe(1999);
    expect(poundsToPence(0)).toBe(0);
    expect(poundsToPence(1000)).toBe(100_000);
    expect(poundsToPence(0.1)).toBe(10);
    // 19.99 * 100 in float is 1998.9999… — Math.round saves it.
    expect(poundsToPence("19.99")).toBe(1999);
  });

  it("poundsToPence treats null/garbage as 0", () => {
    expect(poundsToPence(null)).toBe(0);
    expect(poundsToPence(undefined)).toBe(0);
    expect(poundsToPence("not a number")).toBe(0);
    expect(poundsToPence(Number.NaN)).toBe(0);
  });

  it("penceToPounds is the inverse", () => {
    expect(penceToPounds(1999)).toBe(19.99);
    expect(penceToPounds(0)).toBe(0);
    expect(penceToPounds(100_000)).toBe(1000);
    expect(penceToPounds(null)).toBe(0);
  });

  it("round-trips every whole penny value exactly", () => {
    for (const p of [0, 1, 99, 100, 1999, 12_345, 99_999_900]) {
      expect(poundsToPence(penceToPounds(p))).toBe(p);
    }
  });

  it("formatPence renders GBP from stored pence", () => {
    expect(formatPence(1999)).toBe("£19.99");
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(100_000)).toBe("£1,000.00");
  });
});

describe("priceBookItemSchema", () => {
  const base = {
    description: "Supply & fit slate — per m²",
    unit: "m2",
    unit_price: "45.50",
    vat_rate: "20",
    active: "true",
  };

  it("accepts a valid item and coerces types", () => {
    const parsed = priceBookItemSchema.parse(base);
    expect(parsed.description).toBe("Supply & fit slate — per m²");
    expect(parsed.unit_price).toBe(45.5);
    expect(parsed.vat_rate).toBe(20);
    expect(parsed.active).toBe(true);
  });

  it("defaults unit to 'ea' when blank", () => {
    expect(priceBookItemSchema.parse({ ...base, unit: "" }).unit).toBe("ea");
  });

  it("rejects an empty description", () => {
    expect(priceBookItemSchema.safeParse({ ...base, description: "  " }).success).toBe(false);
  });

  it("rejects a negative price", () => {
    expect(priceBookItemSchema.safeParse({ ...base, unit_price: "-1" }).success).toBe(false);
  });

  it("rejects an out-of-set VAT rate", () => {
    expect(priceBookItemSchema.safeParse({ ...base, vat_rate: "17.5" }).success).toBe(false);
  });

  it("treats absent/unchecked active as false", () => {
    // The form posts a hidden 'false' + 'true' when checked; validateFormData
    // passes the LAST value. An absent field parses to false.
    expect(priceBookItemSchema.parse({ ...base, active: "false" }).active).toBe(false);
    const { active: _drop, ...noActive } = base;
    expect(priceBookItemSchema.parse(noActive).active).toBe(false);
  });
});

describe("quoteTemplateSchema", () => {
  it("requires a name", () => {
    expect(quoteTemplateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(quoteTemplateSchema.parse({ name: "Bathroom refit" }).name).toBe("Bathroom refit");
  });

  it("keeps job_type optional and trims empties to undefined", () => {
    expect(quoteTemplateSchema.parse({ name: "X", job_type: "" }).job_type).toBeUndefined();
    expect(quoteTemplateSchema.parse({ name: "X", job_type: "Roofing" }).job_type).toBe("Roofing");
  });
});

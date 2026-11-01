import { describe, it, expect } from "vitest";
import {
  materialRequestLineSchema,
  purchaseOrderLineSchema,
} from "@/lib/imports/autofill/schemas";

/**
 * FEATURE 2 — line-item adapter safety.
 *
 * The line-item array schema is the first, conservative pass over the model's
 * proposed rows before they ever touch a create form's builder. It must:
 *   - keep valid rows (description + numeric qty/price/vat), many of them;
 *   - DROP a row with no description (the identity of a line) — never fabricate;
 *   - NULL-out a cell that is not the shape it should be, never guess;
 *   - never throw, whatever the model returns (array, not-array, junk).
 * The builder re-validates on save; this is defence in depth, pinned here.
 */

const mrParse = (v: unknown) =>
  materialRequestLineSchema.parse(v) as Record<string, string>[];
const poParse = (v: unknown) =>
  purchaseOrderLineSchema.parse(v) as Record<string, string>[];

describe("line-item adapter — material request (no money)", () => {
  it("keeps MANY valid rows, in order", () => {
    const rows = mrParse([
      { description: "OPC cement 25kg", qty: "40", unit: "bag" },
      { description: "Sharp sand", qty: "2.5", unit: "t" },
      { description: "25mm MDPE pipe", qty: "50", unit: "m" },
      { description: "Pea gravel", qty: "1", unit: "t" },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.description)).toEqual([
      "OPC cement 25kg",
      "Sharp sand",
      "25mm MDPE pipe",
      "Pea gravel",
    ]);
    expect(rows[1]?.qty).toBe("2.5"); // decimal quantity preserved
  });

  it("DROPS a row with no description — never invents a line", () => {
    const rows = mrParse([
      { description: "Timber 4x2", qty: "100", unit: "m" },
      { qty: "5", unit: "bag" }, // no description
      { description: "   ", qty: "5", unit: "bag" }, // blank description
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Timber 4x2");
  });

  it("NULLs an invalid quantity rather than guessing (the cell drops out)", () => {
    const rows = mrParse([{ description: "Rebar", qty: "lots", unit: "ea" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Rebar");
    expect(rows[0]).not.toHaveProperty("qty"); // "lots" → null → omitted
    expect(rows[0]?.unit).toBe("ea");
  });

  it("strips a money value that should not be on a request (schema has no price key)", () => {
    const rows = mrParse([
      { description: "Blocks", qty: "100", unit: "ea", unit_price: "1.50", total: "150" },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["description", "qty", "unit"]);
    expect(rows[0]).not.toHaveProperty("unit_price");
  });

  it("never throws on junk input", () => {
    expect(mrParse("not an array")).toEqual([]);
    expect(mrParse(null)).toEqual([]);
    expect(mrParse(42)).toEqual([]);
    expect(mrParse([])).toEqual([]);
    expect(mrParse([null, 7, "x", {}])).toEqual([]); // no row has a description
    expect(mrParse([{ description: "ok" }])).toEqual([{ description: "ok" }]);
  });

  it("caps a pathological row count", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      description: `Item ${i}`,
      qty: "1",
      unit: "ea",
    }));
    expect(mrParse(many).length).toBeLessThanOrEqual(200);
  });
});

describe("line-item adapter — purchase order (priced)", () => {
  it("keeps valid priced rows with qty / unit_price / vat", () => {
    const rows = poParse([
      { description: "Celcon block 100mm", qty: "300", unit: "ea", unit_price: "1.45", vat_rate: "20" },
      { description: "PIR 50mm", qty: "20", unit: "sheet", unit_price: "28.50", vat_rate: "20" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      description: "Celcon block 100mm",
      qty: "300",
      unit: "ea",
      unit_price: "1.45",
      vat_rate: "20",
    });
  });

  it("strips the currency symbol / commas from a price", () => {
    const rows = poParse([
      { description: "Steel beam", qty: "1", unit: "ea", unit_price: "£1,250.00", vat_rate: "20" },
    ]);
    expect(rows[0]?.unit_price).toBe("1250"); // £ and comma stripped, 2dp normalised
  });

  it("NULLs a non-numeric price but keeps the row (operator prices it)", () => {
    const rows = poParse([
      { description: "Sundries", qty: "1", unit: "ea", unit_price: "POA", vat_rate: "20" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("unit_price");
    expect(rows[0]?.description).toBe("Sundries");
  });

  it("nulls an absurd (out-of-range) price; a stray sign is stripped not trusted", () => {
    const rows = poParse([
      // The shared decimal cleaner keeps only [0-9.], so a stray "-" is stripped
      // ("-5" → "5"): a sign can never flip a price into a credit. The operator
      // reviews every value before saving.
      { description: "A", qty: "1", unit: "ea", unit_price: "-5", vat_rate: "20" },
      // Beyond the £99,999,999 cap → null (not a silently-truncated giant number).
      { description: "B", qty: "1", unit: "ea", unit_price: "999999999999", vat_rate: "20" },
    ]);
    expect(rows[0]?.unit_price).toBe("5");
    expect(rows[1]).not.toHaveProperty("unit_price");
  });

  it("clamps / nulls an invalid VAT rate (0-100), keeps a valid one", () => {
    const rows = poParse([
      { description: "A", qty: "1", unit: "ea", unit_price: "10", vat_rate: "20" },
      { description: "B", qty: "1", unit: "ea", unit_price: "10", vat_rate: "200" }, // >100 → null
      { description: "C", qty: "1", unit: "ea", unit_price: "10", vat_rate: "0" }, // zero-rated
    ]);
    expect(rows[0]?.vat_rate).toBe("20");
    expect(rows[1]).not.toHaveProperty("vat_rate");
    expect(rows[2]?.vat_rate).toBe("0");
  });

  it("DROPS a priced row with no description", () => {
    const rows = poParse([
      { qty: "5", unit: "ea", unit_price: "10", vat_rate: "20" },
      { description: "Real line", qty: "1", unit: "ea", unit_price: "10", vat_rate: "20" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Real line");
  });

  it("never throws on junk", () => {
    expect(poParse("x")).toEqual([]);
    expect(poParse(null)).toEqual([]);
    expect(poParse([{ unit_price: "10" }])).toEqual([]); // no description
  });
});

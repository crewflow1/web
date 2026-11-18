import { describe, expect, it } from "vitest";
import { computeTotals } from "@/lib/quotes/totals";
import type { LineItem } from "@/lib/quotes/schema";

/**
 * Quote maths (lib/quotes/totals.ts) — the numbers a customer accepts and that are copied
 * verbatim onto the invoice (no recomputation downstream). Per-line: net = qty × price
 * rounded to the penny; VAT = net × rate rounded to the penny; the quote sums the rounded
 * lines (HMRC line-by-line method). Rounding is half away from zero, exactly as Postgres
 * `round(x, 2)` does for the VAT the database computes itself.
 */
const line = (qty: number, unit_price: number, vat_rate: number): LineItem => ({
  description: "Line",
  qty,
  unit: "ea",
  unit_price,
  vat_rate,
});

/** Exact reference: half-up on integer units, no floating point in the decision. */
function exactPence(numerator: bigint, denominator: bigint): number {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

describe("computeTotals", () => {
  it("a single standard-rated line: 2 × £100 @ 20% → £200 + £40 = £240", () => {
    expect(computeTotals([line(2, 100, 20)])).toEqual({
      subtotal: 200,
      vat_total: 40,
      total: 240,
      lines: [{ line_total: 200, line_vat: 40 }],
    });
  });

  it("mixed rates (20 / 5 / 0) are taxed per line and summed", () => {
    const t = computeTotals([line(3, 45.5, 20), line(1, 120, 5), line(4, 12.25, 0)]);
    expect(t.lines).toEqual([
      { line_total: 136.5, line_vat: 27.3 },
      { line_total: 120, line_vat: 6 },
      { line_total: 49, line_vat: 0 },
    ]);
    expect(t.subtotal).toBe(305.5);
    expect(t.vat_total).toBe(33.3);
    expect(t.total).toBe(338.8);
  });

  it("total is always subtotal + VAT to the penny (no drift across many lines)", () => {
    const items = Array.from({ length: 200 }, (_, i) => line(1 + (i % 7) * 0.25, 0.01 + i * 1.37, [0, 5, 20][i % 3]!));
    const t = computeTotals(items);
    const sumNet = t.lines.reduce((s, l) => s + Math.round(l.line_total * 100), 0);
    const sumVat = t.lines.reduce((s, l) => s + Math.round(l.line_vat * 100), 0);
    expect(Math.round(t.subtotal * 100)).toBe(sumNet);
    expect(Math.round(t.vat_total * 100)).toBe(sumVat);
    expect(Math.round(t.total * 100)).toBe(sumNet + sumVat);
  });

  it("no lines → all zero", () => {
    expect(computeTotals([])).toEqual({ subtotal: 0, vat_total: 0, total: 0, lines: [] });
  });

  it("a zero-price line contributes nothing", () => {
    expect(computeTotals([line(5, 0, 20)]).total).toBe(0);
  });

  // REGRESSION — half-pennies used to round by accident of binary representation:
  // £2.90 @ 5% = £0.145 came out £0.14 while £0.10 @ 5% = £0.005 came out £0.01, and
  // the database's own round() gives £0.15 for the first. Same for fractional quantities.
  it("half a penny of VAT rounds UP (£2.90 @ 5% → £0.15), as the database rounds", () => {
    expect(computeTotals([line(1, 2.9, 5)]).lines[0]).toEqual({ line_total: 2.9, line_vat: 0.15 });
    expect(computeTotals([line(1, 0.1, 5)]).lines[0]!.line_vat).toBe(0.01);
  });

  it("half a penny of net rounds UP (0.15 × £4.30 = £0.645 → £0.65)", () => {
    expect(computeTotals([line(0.15, 4.3, 0)]).lines[0]!.line_total).toBe(0.65);
  });

  it("every 5% VAT amount from 1p to £5,000 matches exact half-up", () => {
    for (let p = 1n; p <= 500_000n; p++) {
      const t = computeTotals([line(1, Number(p) / 100, 5)]);
      const vatPence = Math.round(t.lines[0]!.line_vat * 100);
      if (vatPence !== exactPence(p * 5n, 100n)) {
        throw new Error(`£${Number(p) / 100} @ 5%: got ${vatPence}p, expected ${exactPence(p * 5n, 100n)}p`);
      }
    }
  });

  it("qty (2 dp) × price (2 dp) net amounts match exact half-up", () => {
    for (let q = 1n; q <= 5_000n; q += 7n) {
      for (let u = 1n; u <= 20_000n; u += 37n) {
        const got = Math.round(computeTotals([line(Number(q) / 100, Number(u) / 100, 0)]).lines[0]!.line_total * 100);
        const want = exactPence(q * u, 100n);
        if (got !== want) throw new Error(`${Number(q) / 100} × £${Number(u) / 100}: got ${got}p, expected ${want}p`);
      }
    }
  });

  it("large values stay exact (999,999 × £99,999.99 @ 20%)", () => {
    const t = computeTotals([line(999_999, 99_999.99, 20)]);
    expect(t.subtotal).toBe(99_999_890_000.01);
    expect(t.vat_total).toBe(19_999_978_000);
    expect(t.total).toBe(119_999_868_000.01);
  });
});

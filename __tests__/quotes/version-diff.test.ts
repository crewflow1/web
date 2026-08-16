import { describe, it, expect } from "vitest";
import {
  diffQuoteVersions,
  isEmptyDiff,
  normalizeSnapshotLine,
  normalizeSnapshotLines,
  versionLabel,
  type QuoteVersionLine,
  type QuoteVersionSnapshot,
} from "@/lib/quotes/version-diff";

/**
 * Pure diff/snapshot contracts for quote version history.
 *
 * These pin the deterministic behaviour the "Version history" panel relies on:
 * totals deltas, line add/remove/change classification, duplicate-description
 * pairing, order-independence, and numeric-string tolerance.
 */

function line(over: Partial<QuoteVersionLine> = {}): QuoteVersionLine {
  return {
    description: "Item",
    qty: 1,
    unit: "ea",
    unit_price: 100,
    vat_rate: 20,
    line_total: 100,
    sort_order: 0,
    ...over,
  };
}

function snap(over: Partial<QuoteVersionSnapshot> = {}): QuoteVersionSnapshot {
  return {
    version_number: 1,
    captured_reason: "sent",
    status: "sent",
    currency: "GBP",
    subtotal: 100,
    vat_total: 20,
    total: 120,
    line_items: [line()],
    captured_at: "2026-01-01T00:00:00Z",
    label: "v1 · sent",
    ...over,
  };
}

describe("normalizeSnapshotLine — jsonb tolerance", () => {
  it("coerces numeric strings (as PostgREST returns numeric)", () => {
    const l = normalizeSnapshotLine({
      description: "Labour",
      qty: "2",
      unit: "hr",
      unit_price: "45.50",
      vat_rate: "20",
      line_total: "91.00",
      sort_order: "3",
    });
    expect(l).toEqual({
      description: "Labour",
      qty: 2,
      unit: "hr",
      unit_price: 45.5,
      vat_rate: 20,
      line_total: 91,
      sort_order: 3,
    });
  });

  it("defaults missing/garbage fields safely (never throws)", () => {
    const l = normalizeSnapshotLine({ description: "X", qty: "nope" });
    expect(l.qty).toBe(0);
    expect(l.unit).toBe("");
    expect(l.unit_price).toBe(0);
  });

  it("normalizeSnapshotLines returns [] for a non-array", () => {
    expect(normalizeSnapshotLines(null)).toEqual([]);
    expect(normalizeSnapshotLines({ not: "array" })).toEqual([]);
    expect(normalizeSnapshotLines([{ description: "A" }])).toHaveLength(1);
  });
});

describe("totals delta", () => {
  it("computes signed, penny-rounded deltas", () => {
    const d = diffQuoteVersions(
      snap({ subtotal: 100, vat_total: 20, total: 120 }),
      snap({ subtotal: 150, vat_total: 30, total: 180 }),
    );
    expect(d.totals.subtotal).toEqual({ from: 100, to: 150, delta: 50 });
    expect(d.totals.vat_total).toEqual({ from: 20, to: 30, delta: 10 });
    expect(d.totals.total).toEqual({ from: 120, to: 180, delta: 60 });
  });

  it("does not report float noise as a change", () => {
    const d = diffQuoteVersions(
      snap({ total: 0.1 + 0.2 }), // 0.30000000000000004
      snap({ total: 0.3 }),
    );
    expect(d.totals.total.delta).toBe(0);
  });

  it("flags a currency change", () => {
    const d = diffQuoteVersions(snap({ currency: "GBP" }), snap({ currency: "EUR" }));
    expect(d.totals.currencyChanged).toBe(true);
    expect(d.totals.currencyFrom).toBe("GBP");
    expect(d.totals.currencyTo).toBe("EUR");
  });
});

describe("line-item diff — classification", () => {
  it("detects added, removed, changed and unchanged lines", () => {
    const base = snap({
      line_items: [
        line({ description: "Keep", sort_order: 0 }),
        line({ description: "Drop me", sort_order: 1 }),
        line({ description: "Reprice", unit_price: 100, line_total: 100, sort_order: 2 }),
      ],
    });
    const target = snap({
      line_items: [
        line({ description: "Keep", sort_order: 0 }),
        line({ description: "Reprice", unit_price: 150, line_total: 150, sort_order: 2 }),
        line({ description: "Brand new", sort_order: 3 }),
      ],
    });
    const d = diffQuoteVersions(base, target);
    expect(d.summary).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });

    const changed = d.lines.find((l) => l.kind === "changed")!;
    expect(changed.description).toBe("Reprice");
    const priceChange = changed.fieldChanges.find((f) => f.field === "unit_price")!;
    expect(priceChange).toEqual({ field: "unit_price", from: 100, to: 150 });
    expect(changed.fieldChanges.find((f) => f.field === "line_total")).toEqual({
      field: "line_total",
      from: 100,
      to: 150,
    });
  });

  it("is order-independent: reordering identical lines yields no changes", () => {
    const base = snap({
      line_items: [
        line({ description: "A", sort_order: 0 }),
        line({ description: "B", sort_order: 1 }),
      ],
    });
    const target = snap({
      line_items: [
        line({ description: "B", sort_order: 0 }),
        line({ description: "A", sort_order: 1 }),
      ],
    });
    const d = diffQuoteVersions(base, target);
    // Both lines present on each side, only sort_order differs (not a compared
    // field), so nothing is added/removed/changed.
    expect(d.summary.added).toBe(0);
    expect(d.summary.removed).toBe(0);
    expect(d.summary.changed).toBe(0);
    expect(d.summary.unchanged).toBe(2);
  });

  it("pairs duplicate descriptions by occurrence, not collapsing them", () => {
    const base = snap({
      line_items: [
        line({ description: "Widget", qty: 1, sort_order: 0 }),
        line({ description: "Widget", qty: 2, sort_order: 1 }),
      ],
    });
    const target = snap({
      line_items: [
        line({ description: "Widget", qty: 1, sort_order: 0 }),
        line({ description: "Widget", qty: 5, sort_order: 1 }),
      ],
    });
    const d = diffQuoteVersions(base, target);
    // First Widget unchanged, second Widget changed (qty 2 -> 5). Not merged.
    expect(d.summary.unchanged).toBe(1);
    expect(d.summary.changed).toBe(1);
  });

  it("treats description case/whitespace as the same line identity", () => {
    const base = snap({ line_items: [line({ description: "Site  Setup" })] });
    const target = snap({ line_items: [line({ description: "site setup", unit_price: 200, line_total: 200 })] });
    const d = diffQuoteVersions(base, target);
    expect(d.summary.added).toBe(0);
    expect(d.summary.removed).toBe(0);
    expect(d.summary.changed).toBe(1);
  });

  it("is deterministic: same inputs -> identical output", () => {
    const base = snap({
      line_items: [line({ description: "B" }), line({ description: "A" })],
    });
    const target = snap({
      line_items: [line({ description: "A", unit_price: 5 }), line({ description: "C" })],
    });
    expect(JSON.stringify(diffQuoteVersions(base, target))).toBe(
      JSON.stringify(diffQuoteVersions(base, target)),
    );
  });
});

describe("isEmptyDiff", () => {
  it("true when nothing changed", () => {
    expect(isEmptyDiff(diffQuoteVersions(snap(), snap()))).toBe(true);
  });
  it("false when a total moved", () => {
    expect(isEmptyDiff(diffQuoteVersions(snap({ total: 120 }), snap({ total: 130 })))).toBe(false);
  });
  it("false when a line was added", () => {
    const d = diffQuoteVersions(snap({ line_items: [] }), snap({ line_items: [line()] }));
    expect(isEmptyDiff(d)).toBe(false);
  });
});

describe("versionLabel", () => {
  it("includes the captured reason when present", () => {
    expect(versionLabel(2, "re-approved")).toBe("v2 · re-approved");
    expect(versionLabel(1, null)).toBe("v1");
  });
});

import { describe, it, expect } from "vitest";
import {
  QUOTE_DRAFT_SCHEMA_VERSION,
  QUOTE_PRICE_SOURCES,
  draftIsFullyPriced,
  parseQuoteDraft,
  penceToMajor,
  quoteDraftTotals,
  salvageQuoteDraft,
  toQuoteLineItems,
  unpricedLines,
  type QuoteDraft,
} from "@/lib/ai/quote-draft-schema";
import { computeTotals } from "@/lib/quotes/totals";
import { QUOTE_VAT_RATES } from "@/lib/quotes/schema";

/**
 * AI QUOTE WRITER — the output schema, which is where a model's text stops
 * being text and starts being money.
 *
 * A quote is a priced commercial offer: accepting one creates a job, allocates
 * an invoice number, posts a draft invoice and emails it. So the questions here
 * are not stylistic. Can a model state a price it did not get from the org's own
 * records? Can it state a total? Can an unpriced line hide? Can a malformed
 * response half-survive? Every answer must be no, and must be no STRUCTURALLY —
 * enforced by the schema rather than by a caller remembering to check.
 */

const VALID_LINE = {
  description: "Strip and remove existing tiling",
  qty: 12,
  unit: "m2",
  unit_price_pence: 1_800,
  price_source: "price_book" as const,
  needs_pricing: false,
  vat_rate: 20,
};

const UNPRICED_LINE = {
  description: "Supply and fit shower enclosure",
  qty: 1,
  unit: "ea",
  unit_price_pence: null,
  price_source: "none" as const,
  needs_pricing: true,
  vat_rate: 20,
};

function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Bathroom refit",
    scope_summary: "Strip out and refit.",
    line_items: [VALID_LINE],
    assumptions: [],
    exclusions: [],
    notes: null,
    warnings: [],
    confidence: "medium",
    provenance: ["work_description"],
    ...over,
  };
}

// =====================================================================
// 1. A price requires a source.
// =====================================================================

describe("the price-provenance rule — a model may never invent a number", () => {
  it("names exactly two price sources, and only one of them permits a number", () => {
    // If this list ever grows an `estimate` or a `market_rate`, the rule is gone.
    expect([...QUOTE_PRICE_SOURCES]).toEqual(["none", "price_book"]);
  });

  it("REFUSES a price with no source", () => {
    const result = parseQuoteDraft(
      draft({
        line_items: [{ ...UNPRICED_LINE, unit_price_pence: 100, needs_pricing: false }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.issues.join(" ")).toMatch(/invented price|price with no source/i);
  });

  it("REFUSES a source with no price", () => {
    const result = parseQuoteDraft(
      draft({ line_items: [{ ...UNPRICED_LINE, price_source: "price_book" }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("REFUSES an unpriced line that is not flagged — the version a reviewer's eye slides past", () => {
    const result = parseQuoteDraft(
      draft({ line_items: [{ ...UNPRICED_LINE, needs_pricing: false }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.issues.join(" ")).toMatch(/needs_pricing/);
  });

  it("REFUSES a priced line that IS flagged — the mirror error", () => {
    const result = parseQuoteDraft(
      draft({ line_items: [{ ...VALID_LINE, needs_pricing: true }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("ACCEPTS a properly sourced price and a properly flagged blank, together", () => {
    const result = parseQuoteDraft(draft({ line_items: [VALID_LINE, UNPRICED_LINE] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(unpricedLines(result.draft)).toHaveLength(1);
    expect(draftIsFullyPriced(result.draft)).toBe(false);
  });

  it("REFUSES a fractional price — pence are integers, not an invitation to round", () => {
    const result = parseQuoteDraft(
      draft({ line_items: [{ ...VALID_LINE, unit_price_pence: 1800.5 }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("REFUSES a negative price", () => {
    const result = parseQuoteDraft(
      draft({ line_items: [{ ...VALID_LINE, unit_price_pence: -1 }] }),
    );
    expect(result.ok).toBe(false);
  });
});

// =====================================================================
// 2. The model cannot state a total. At all.
// =====================================================================

describe("totals belong to computeTotals, and the model has no way to claim one", () => {
  it("the schema HAS NO totals field — it is unrepresentable, not merely ignored", () => {
    const shape = Object.keys(
      (parseQuoteDraft(draft()) as { ok: true; draft: QuoteDraft }).draft,
    );
    expect(shape).not.toContain("total");
    expect(shape).not.toContain("subtotal");
    expect(shape).not.toContain("vat_total");
  });

  it("REJECTS a smuggled total rather than silently stripping it", () => {
    // Stripping would absorb the attempt. Rejecting makes it visible — and the
    // difference matters, because a model that emits a total once will do it
    // again and nobody would ever find out.
    const result = parseQuoteDraft(draft({ total: 1, subtotal: 1, vat_total: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("schema_invalid");
  });

  it("REJECTS any unrecognised key — the schema is strict all the way down", () => {
    expect(parseQuoteDraft(draft({ discount_applied: true })).ok).toBe(false);
    expect(
      parseQuoteDraft(draft({ line_items: [{ ...VALID_LINE, markup_pct: 30 }] })).ok,
    ).toBe(false);
  });

  it("computes totals through the SAME authority a hand-typed quote uses", () => {
    const parsed = parseQuoteDraft(draft({ line_items: [VALID_LINE, UNPRICED_LINE] }));
    if (!parsed.ok) throw new Error("unreachable");
    const viaDraft = quoteDraftTotals(parsed.draft);
    const viaQuotes = computeTotals(toQuoteLineItems(parsed.draft));
    // Not "similar" — identical. An AI-originated quote and a hand-typed one
    // must not be able to disagree by a penny.
    expect(viaDraft).toEqual(viaQuotes);
    // 12 x 18.00 = 216.00 net, VAT 43.20.
    expect(viaDraft.subtotal).toBe(216);
    expect(viaDraft.vat_total).toBe(43.2);
    expect(viaDraft.total).toBe(259.2);
  });

  it("an unpriced line contributes ZERO, and does not vanish", () => {
    // Dropping it would silently narrow the scope — how a contractor ends up
    // doing work they never quoted for. Zero makes the quote visibly too low
    // rather than invisibly too small.
    const parsed = parseQuoteDraft(draft({ line_items: [UNPRICED_LINE] }));
    if (!parsed.ok) throw new Error("unreachable");
    const items = toQuoteLineItems(parsed.draft);
    expect(items).toHaveLength(1);
    expect(items[0]!.unit_price).toBe(0);
    expect(items[0]!.description).toBe(UNPRICED_LINE.description);
    expect(quoteDraftTotals(parsed.draft).total).toBe(0);
  });
});

// =====================================================================
// 3. Money crosses the boundary as integer pence.
// =====================================================================

describe("pence in, major units out — one conversion, no drift", () => {
  it("converts exactly for the awkward values floats get wrong", () => {
    expect(penceToMajor(1_999)).toBe(19.99);
    expect(penceToMajor(1)).toBe(0.01);
    expect(penceToMajor(0)).toBe(0);
    expect(penceToMajor(9_999_900)).toBe(99_999);
  });

  it("a round trip through the quote domain is lossless across a whole draft", () => {
    const prices = [1, 7, 99, 1_999, 12_345, 999_999];
    const parsed = parseQuoteDraft(
      draft({
        line_items: prices.map((p, i) => ({
          ...VALID_LINE,
          description: `Item ${i}`,
          qty: 1,
          unit_price_pence: p,
        })),
      }),
    );
    if (!parsed.ok) throw new Error("unreachable");
    const summedPence = prices.reduce((a, b) => a + b, 0);
    expect(quoteDraftTotals(parsed.draft).subtotal).toBe(summedPence / 100);
  });

  it("accepts only the VAT rates the quotes domain accepts", () => {
    for (const rate of QUOTE_VAT_RATES) {
      expect(parseQuoteDraft(draft({ line_items: [{ ...VALID_LINE, vat_rate: rate }] })).ok).toBe(
        true,
      );
    }
    for (const rate of [1, 17.5, 25, -20]) {
      expect(parseQuoteDraft(draft({ line_items: [{ ...VALID_LINE, vat_rate: rate }] })).ok).toBe(
        false,
      );
    }
  });
});

// =====================================================================
// 4. Malformed is refused, and salvage has to be asked for by name.
// =====================================================================

describe("refusal is the default; salvage is a different function with a permanent mark", () => {
  it("refuses a non-object outright", () => {
    for (const bad of [null, "a string", 42, [], undefined]) {
      const r = parseQuoteDraft(bad);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.code).toBe("not_an_object");
    }
  });

  it("refuses a draft with NO line items — an empty scope is not a scope", () => {
    expect(parseQuoteDraft(draft({ line_items: [] })).ok).toBe(false);
  });

  it("strict parsing NEVER half-succeeds when one line is broken", () => {
    const r = parseQuoteDraft(draft({ line_items: [VALID_LINE, { ...VALID_LINE, qty: -1 }] }));
    expect(r.ok).toBe(false);
  });

  it("salvage keeps the good lines, drops the bad, and stamps the result degraded", () => {
    const r = salvageQuoteDraft(draft({ line_items: [VALID_LINE, { ...VALID_LINE, qty: -1 }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.degraded).toBe(true);
    expect(r.draft.line_items).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatch(/^line 1:/);
  });

  it("salvage NEVER repairs a line, invents a price, or rescues a broken envelope", () => {
    // A price with no source is not "nearly right" — it is the exact failure the
    // schema exists to catch, so salvage drops the line rather than fixing it.
    const priced = salvageQuoteDraft(
      draft({ line_items: [{ ...UNPRICED_LINE, unit_price_pence: 100, needs_pricing: false }] }),
    );
    // Every line dropped ⇒ zero lines ⇒ the envelope itself fails min(1).
    expect(priced.ok).toBe(false);

    // A broken envelope is a refusal even when every line is perfect.
    expect(salvageQuoteDraft(draft({ line_items: [VALID_LINE], confidence: "certain" })).ok).toBe(
      false,
    );
  });

  it("a clean parse is never marked degraded", () => {
    const r = parseQuoteDraft(draft());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.degraded).toBe(false);
  });
});

// =====================================================================
// 5. Provenance cannot be fabricated.
// =====================================================================

describe("provenance is validated against the disclosure contract", () => {
  it("accepts only contract field keys", () => {
    expect(parseQuoteDraft(draft({ provenance: ["work_description", "price_book"] })).ok).toBe(
      true,
    );
  });

  it("REFUSES a claimed input that does not exist", () => {
    // A draft citing sources it never had looks better grounded than it is.
    expect(parseQuoteDraft(draft({ provenance: ["customer_bank_details"] })).ok).toBe(false);
    expect(parseQuoteDraft(draft({ provenance: ["customer_name"] })).ok).toBe(false);
  });

  it("pins the schema version so an old stored draft is never read as a new one", () => {
    expect(QUOTE_DRAFT_SCHEMA_VERSION).toBe(1);
  });
});

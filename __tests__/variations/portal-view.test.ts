import { describe, it, expect } from "vitest";
import { buildPortalVariationView } from "@/lib/variations/portal";
import type { CashQuote } from "@/lib/commercial/cash";

/**
 * The variation approval view — the three facts a customer decides on.
 *
 * The commercial-leak proof lives in
 * __tests__/security/portal-variation-cost-basis.test.ts; this file is the
 * behaviour.
 */

const base = {
  variationNumber: 3,
  status: "sent",
  subtotal: 1000,
  vatTotal: 200,
  total: 1200,
  eotRequestedCompletionDate: null,
  eotAgreedCompletionDate: null,
  acceptedAt: null,
  declinedAt: null,
  siblingQuotes: [] as CashQuote[],
  priorAgreedCompletionDates: [] as string[],
};

describe("value — what the contract becomes", () => {
  const siblings: CashQuote[] = [
    { status: "accepted", total: 50_000, variation_number: null }, // original
    { status: "accepted", total: 2_000, variation_number: 1 }, // approved
    { status: "declined", total: 9_000, variation_number: 2 }, // rejected
  ];

  it("shows the contract BEFORE this variation and what it becomes", () => {
    const v = buildPortalVariationView({ ...base, siblingQuotes: siblings });
    expect(v.contract.before).toBe(52_000);
    expect(v.contract.after).toBe(53_200);
  });

  it("excludes declined and pending siblings from the agreed contract", () => {
    const v = buildPortalVariationView({
      ...base,
      siblingQuotes: [...siblings, { status: "sent", total: 7_000, variation_number: 4 }],
    });
    expect(v.contract.before).toBe(52_000);
  });

  it("counts the variations already approved so the customer sees the history", () => {
    const v = buildPortalVariationView({ ...base, siblingQuotes: siblings });
    expect(v.contract.approved_variations_count).toBe(1);
  });

  it("handles a credit (negative) variation without breaking the arithmetic", () => {
    const v = buildPortalVariationView({
      ...base,
      total: -500,
      siblingQuotes: siblings,
    });
    expect(v.contract.after).toBe(51_500);
  });
});

describe("programme — the extension of time, never a fabricated delta", () => {
  it("surfaces the requested completion date as a request, not an expiry", () => {
    const v = buildPortalVariationView({
      ...base,
      eotRequestedCompletionDate: "2026-09-30",
    });
    expect(v.programme.requested_completion_date).toBe("2026-09-30");
    expect(v.programme.is_agreed).toBe(false);
  });

  it("reports NO days_added when nothing has ever been agreed to measure from", () => {
    const v = buildPortalVariationView({
      ...base,
      eotRequestedCompletionDate: "2026-09-30",
    });
    expect(v.programme.previous_agreed_completion_date).toBeNull();
    expect(v.programme.days_added).toBeNull();
  });

  it("measures days_added only from a previously AGREED date", () => {
    const v = buildPortalVariationView({
      ...base,
      eotRequestedCompletionDate: "2026-09-30",
      priorAgreedCompletionDates: ["2026-08-31", "2026-09-15"],
    });
    expect(v.programme.previous_agreed_completion_date).toBe("2026-09-15");
    expect(v.programme.days_added).toBe(15);
  });

  it("prefers the agreed date over the requested one once one exists", () => {
    const v = buildPortalVariationView({
      ...base,
      eotRequestedCompletionDate: "2026-09-30",
      eotAgreedCompletionDate: "2026-09-20",
      priorAgreedCompletionDates: ["2026-09-01"],
    });
    expect(v.programme.is_agreed).toBe(true);
    expect(v.programme.agreed_completion_date).toBe("2026-09-20");
    expect(v.programme.days_added).toBe(19);
  });
});

describe("identity + decision", () => {
  it("labels the variation with its number, not the quote number", () => {
    expect(buildPortalVariationView(base).label).toBe("Variation #003");
  });

  it("reports the decision state", () => {
    expect(buildPortalVariationView(base).decision).toBe("open");
    expect(
      buildPortalVariationView({ ...base, acceptedAt: "2026-07-01T10:00:00Z" }).decision,
    ).toBe("accepted");
    expect(
      buildPortalVariationView({ ...base, declinedAt: "2026-07-01T10:00:00Z" }).decision,
    ).toBe("declined");
  });
});

import { describe, it, expect } from "vitest";
import { phoneSignificantDigits, isWithheldCallerId } from "@/lib/phone";
import {
  decideRecognition,
  buildRecognitionContext,
  selectReusableLead,
  type CandidateLead,
  type RecognitionDecision,
} from "@/lib/telephony/caller-recognition";

/**
 * Caller recognition — the PURE surfaces (no DB). The matching signature MUST stay
 * byte-identical to the SQL generated columns; the decision table must honour the
 * "never guess" rules; and the AI hint must personalise WITHOUT leaking account data.
 */

describe("phoneSignificantDigits (parity with SQL phone_sig / contact_phone_sig)", () => {
  it("reduces every UK form of one number to the same signature", () => {
    expect(phoneSignificantDigits("+44 7700 900123")).toBe("7700900123");
    expect(phoneSignificantDigits("07700 900123")).toBe("7700900123");
    expect(phoneSignificantDigits("447700900123")).toBe("7700900123");
    expect(phoneSignificantDigits("(07700) 900-123")).toBe("7700900123");
    expect(phoneSignificantDigits("+447700900123")).toBe("7700900123");
  });

  it("keeps a non-UK international number's digits (no UK prefix to strip)", () => {
    expect(phoneSignificantDigits("+1 415 555 0123")).toBe("14155550123");
  });

  it("returns null for empty / non-numeric input", () => {
    expect(phoneSignificantDigits("")).toBeNull();
    expect(phoneSignificantDigits("   ")).toBeNull();
    expect(phoneSignificantDigits("anonymous")).toBeNull();
    expect(phoneSignificantDigits(null)).toBeNull();
    expect(phoneSignificantDigits(undefined)).toBeNull();
  });
});

describe("isWithheldCallerId", () => {
  it("treats missing / empty / label caller-ids as withheld", () => {
    for (const v of [null, undefined, "", "   ", "anonymous", "Anonymous", "RESTRICTED", "unavailable", "unknown", "private", "blocked"]) {
      expect(isWithheldCallerId(v as string), String(v)).toBe(true);
    }
  });

  it("treats carrier keypad spellings of anonymous/restricted as withheld", () => {
    expect(isWithheldCallerId("266696687")).toBe(true); // "anonymous"
    expect(isWithheldCallerId("+266696687")).toBe(true);
    expect(isWithheldCallerId("7378742833")).toBe(true); // "restricted"
  });

  it("treats a too-short signature as withheld (unmatchable)", () => {
    expect(isWithheldCallerId("12345")).toBe(true);
  });

  it("accepts a real dial-able number", () => {
    expect(isWithheldCallerId("+44 7700 900123")).toBe(false);
    expect(isWithheldCallerId("07700900123")).toBe(false);
    expect(isWithheldCallerId("+1 415 555 0123")).toBe(false);
  });
});

describe("decideRecognition (identity — never guess)", () => {
  const base = { withheld: false, customerMatches: [], candidateLeads: [] as CandidateLead[] };

  it("(7) withheld ⇒ ambiguous, no candidates", () => {
    const d = decideRecognition({ ...base, withheld: true });
    expect(d.status).toBe("withheld");
    expect(d.ambiguous).toBe(true);
    expect(d.customer).toBeNull();
    expect(d.candidateLeads).toEqual([]);
  });

  it("(7) multiple customers ⇒ ambiguous, no candidates", () => {
    const d = decideRecognition({
      ...base,
      customerMatches: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }],
    });
    expect(d.status).toBe("multiple_customers");
    expect(d.ambiguous).toBe(true);
    expect(d.customer).toBeNull();
    expect(d.candidateLeads).toEqual([]);
  });

  it("(3) single customer ⇒ link + expose their open leads as reuse candidates", () => {
    const candidateLeads: CandidateLead[] = [{ id: "lead-open", service: "kitchen", postcode: "BT1 1AA" }];
    const d = decideRecognition({ ...base, customerMatches: [{ id: "c1", name: "John Smith" }], candidateLeads });
    expect(d.status).toBe("single_customer");
    expect(d.customer?.id).toBe("c1");
    expect(d.candidateLeads).toEqual(candidateLeads);
    expect(d.ambiguous).toBe(false);
  });

  it("(6) genuinely new caller ⇒ no_match, no candidates", () => {
    const d = decideRecognition(base);
    expect(d.status).toBe("no_match");
    expect(d.customer).toBeNull();
    expect(d.candidateLeads).toEqual([]);
    expect(d.ambiguous).toBe(false);
  });
});

describe("selectReusableLead (reuse ONLY on same-project evidence)", () => {
  const kitchenBT1: CandidateLead = { id: "L-kitchen", service: "Kitchen extension", postcode: "BT1 1AA" };
  const bathBT9: CandidateLead = { id: "L-bath", service: "Bathroom refit", postcode: "BT9 5XY" };

  it("(4) confident single match on service + postcode ⇒ reuse that lead", () => {
    const id = selectReusableLead({ service: "kitchen extension", postcode: "bt11aa" }, [kitchenBT1, bathBT9]);
    expect(id).toBe("L-kitchen"); // case/format-insensitive, picks the right project
  });

  it("(5) a DIFFERENT project for the same customer ⇒ no reuse (new lead)", () => {
    expect(
      selectReusableLead({ service: "Driveway", postcode: "BT1 1AA" }, [kitchenBT1, bathBT9]),
    ).toBeNull();
  });

  it("multiple open projects — matches the right one, not the oldest", () => {
    // kitchen is listed AFTER bathroom; a phone-only 'oldest' rule would pick bathroom.
    expect(selectReusableLead({ service: "kitchen extension", postcode: "BT1 1AA" }, [bathBT9, kitchenBT1])).toBe("L-kitchen");
  });

  it("ambiguous evidence: no service ⇒ no reuse (the voice-origination default)", () => {
    expect(selectReusableLead({ service: null, postcode: "BT1 1AA" }, [kitchenBT1])).toBeNull();
    expect(selectReusableLead({ service: "", postcode: "BT1 1AA" }, [kitchenBT1])).toBeNull();
  });

  it("ambiguous evidence: no postcode ⇒ no reuse (insufficient to confirm same site)", () => {
    expect(selectReusableLead({ service: "kitchen extension", postcode: null }, [kitchenBT1])).toBeNull();
  });

  it("two candidates both matching service + postcode ⇒ ambiguous ⇒ no reuse", () => {
    const dupA: CandidateLead = { id: "L-a", service: "kitchen", postcode: "BT1 1AA" };
    const dupB: CandidateLead = { id: "L-b", service: "kitchen", postcode: "BT1 1AA" };
    expect(selectReusableLead({ service: "kitchen", postcode: "BT1 1AA" }, [dupA, dupB])).toBeNull();
  });

  it("no candidates ⇒ no reuse", () => {
    expect(selectReusableLead({ service: "kitchen", postcode: "BT1 1AA" }, [])).toBeNull();
  });
});

describe("buildRecognitionContext (safe personalisation, no data leakage)", () => {
  const single = (name: string | null): RecognitionDecision => ({
    status: "single_customer",
    customer: { id: "c1", name },
    candidateLeads: [],
    ambiguous: false,
  });

  it("single match greets by FIRST name only and forbids disclosure", () => {
    const ctx = buildRecognitionContext(single("John Smith"))!;
    expect(ctx).toContain("John");
    expect(ctx).not.toContain("Smith"); // never leak the surname
    expect(ctx.toLowerCase()).toContain("not proof of identity");
    expect(ctx.toLowerCase()).toMatch(/do not disclose|confirm who/);
  });

  it("single match with no usable name still forbids disclosure, no name invented", () => {
    const ctx = buildRecognitionContext(single(null))!;
    expect(ctx.toLowerCase()).toContain("returning customer");
    expect(ctx.toLowerCase()).toContain("do not disclose");
  });

  it("an email-shaped name is not spoken", () => {
    const ctx = buildRecognitionContext(single("john@example.com"))!;
    expect(ctx).not.toContain("john@example.com");
  });

  it("ambiguous / withheld ⇒ ask to identify, reveal nothing", () => {
    const multi = buildRecognitionContext({ status: "multiple_customers", customer: null, candidateLeads: [], ambiguous: true })!;
    expect(multi.toLowerCase()).toContain("more than one");
    expect(multi.toLowerCase()).toMatch(/ask for|name/);

    const withheld = buildRecognitionContext({ status: "withheld", customer: null, candidateLeads: [], ambiguous: true })!;
    expect(withheld.toLowerCase()).toContain("withheld");
  });

  it("no_match ⇒ no hint", () => {
    expect(
      buildRecognitionContext({ status: "no_match", customer: null, candidateLeads: [], ambiguous: false }),
    ).toBeNull();
  });
});

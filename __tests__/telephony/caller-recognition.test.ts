import { describe, it, expect } from "vitest";
import { phoneSignificantDigits, isWithheldCallerId } from "@/lib/phone";
import {
  decideRecognition,
  buildRecognitionContext,
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

describe("decideRecognition (the never-guess decision table)", () => {
  const base = { withheld: false, customerMatches: [], customerOpenLeadId: null, phoneOpenLeadId: null };

  it("(7) withheld ⇒ ambiguous, link nothing", () => {
    const d = decideRecognition({ ...base, withheld: true });
    expect(d.status).toBe("withheld");
    expect(d.ambiguous).toBe(true);
    expect(d.customer).toBeNull();
    expect(d.reuseLeadId).toBeNull();
  });

  it("(7) multiple customers ⇒ ambiguous, link nothing", () => {
    const d = decideRecognition({
      ...base,
      customerMatches: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }],
    });
    expect(d.status).toBe("multiple_customers");
    expect(d.ambiguous).toBe(true);
    expect(d.customer).toBeNull();
    expect(d.reuseLeadId).toBeNull();
  });

  it("(3,5) single customer, no open matter ⇒ link customer, new lead (no reuse)", () => {
    const d = decideRecognition({ ...base, customerMatches: [{ id: "c1", name: "John Smith" }] });
    expect(d.status).toBe("single_customer");
    expect(d.customer?.id).toBe("c1");
    expect(d.reuseLeadId).toBeNull();
    expect(d.ambiguous).toBe(false);
  });

  it("(4) single customer with an open matter ⇒ reuse that lead", () => {
    const d = decideRecognition({
      ...base,
      customerMatches: [{ id: "c1", name: "John" }],
      customerOpenLeadId: "lead-open",
    });
    expect(d.status).toBe("single_customer");
    expect(d.customer?.id).toBe("c1");
    expect(d.reuseLeadId).toBe("lead-open");
  });

  it("(4,6) no customer but an open lead on the number ⇒ reuse it, no customer link", () => {
    const d = decideRecognition({ ...base, phoneOpenLeadId: "lead-x" });
    expect(d.status).toBe("no_match");
    expect(d.customer).toBeNull();
    expect(d.reuseLeadId).toBe("lead-x");
    expect(d.ambiguous).toBe(false);
  });

  it("(6) genuinely new caller ⇒ no_match, new lead", () => {
    const d = decideRecognition(base);
    expect(d.status).toBe("no_match");
    expect(d.customer).toBeNull();
    expect(d.reuseLeadId).toBeNull();
    expect(d.ambiguous).toBe(false);
  });
});

describe("buildRecognitionContext (safe personalisation, no data leakage)", () => {
  const single = (name: string | null): RecognitionDecision => ({
    status: "single_customer",
    customer: { id: "c1", name },
    reuseLeadId: null,
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
    const multi = buildRecognitionContext({ status: "multiple_customers", customer: null, reuseLeadId: null, ambiguous: true })!;
    expect(multi.toLowerCase()).toContain("more than one");
    expect(multi.toLowerCase()).toMatch(/ask for|name/);

    const withheld = buildRecognitionContext({ status: "withheld", customer: null, reuseLeadId: null, ambiguous: true })!;
    expect(withheld.toLowerCase()).toContain("withheld");
  });

  it("no_match ⇒ no hint", () => {
    expect(
      buildRecognitionContext({ status: "no_match", customer: null, reuseLeadId: null, ambiguous: false }),
    ).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  evaluateReply,
  redactReply,
  isAutoSendable,
  ACK_MAX_LENGTH,
  GUARDRAIL_VERDICTS,
  PROHIBITED_CATEGORIES,
  COMMITMENT_CATEGORIES,
  type GuardrailCategory,
} from "@/lib/receptionist/policy";

/**
 * Voice Receptionist AI — conversational guardrail policy, unit tier
 * (the AI Receptionist Programme, R2 — the harvest).
 *
 * The guardrail is the safety keystone every AI-drafted customer reply passes. It
 * is a PURE arbiter: the same draft always yields the same verdict. These tests
 * are ported unchanged (behaviour-preserving) from the harvested comms-platform
 * guardrail suite, and pin the doctrine (Bible, Operating-System Volume XV):
 *
 *   • §9  a bounded acknowledgement with no commitment may auto-send (`allow`);
 *     a price / date / promise is a customer COMMITMENT → human-gated (`review`).
 *   • §12 an absolute safety/compliance claim or a discriminatory statement is
 *     refused, never sent (`block`).
 */

describe("guardrail — allow: a bounded acknowledgement with no commitment", () => {
  it("permits a short, clean acknowledgement (the §9 A1 exception)", () => {
    const draft = "Thanks for your message — a member of the team will call you back shortly.";
    const r = evaluateReply(draft);
    expect(r.verdict).toBe("allow");
    expect(r.categories).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.safeText).toBe(draft);
    expect(isAutoSendable(r)).toBe(true);
  });

  it("holds a clean reply that OVERFLOWS the acknowledgement envelope (§9 default)", () => {
    const draft = "Thanks for getting in touch. ".repeat(20).trim(); // clean but long
    expect(draft.length).toBeGreaterThan(ACK_MAX_LENGTH);
    const r = evaluateReply(draft);
    expect(r.verdict).toBe("review");
    expect(r.categories).toEqual([]);
    expect(isAutoSendable(r)).toBe(false);
  });

  it("holds an empty / whitespace draft (nothing to auto-send)", () => {
    const r = evaluateReply("   ");
    expect(r.verdict).toBe("review");
    expect(r.safeText).toBeNull();
  });
});

describe("guardrail — review: a customer commitment the AI may draft but not send", () => {
  const commitments: Array<{ label: string; draft: string; category: GuardrailCategory }> = [
    { label: "a price in £", draft: "Sure, that'll cost £450 including VAT.", category: "price" },
    {
      label: "a price phrase",
      draft: "No problem — the price is fixed and we will charge you on completion.",
      category: "price",
    },
    {
      label: "a booking confirmation",
      draft: "Great, I've booked you in for Tuesday at 2pm.",
      category: "booking",
    },
    {
      label: "a legal commitment",
      draft: "This message forms a legally binding contract for the works.",
      category: "legal",
    },
    {
      label: "an unconditional guarantee",
      draft: "We guarantee the work will be perfect and we promise it will last.",
      category: "guarantee",
    },
  ];

  for (const { label, draft, category } of commitments) {
    it(`holds ${label} for a human`, () => {
      const r = evaluateReply(draft);
      expect(r.verdict).toBe("review");
      expect(r.categories).toContain(category);
      expect(r.findings.some((f) => f.category === category)).toBe(true);
      expect(isAutoSendable(r)).toBe(false);
    });
  }

  it("every commitment category maps to `review`, never `allow`", () => {
    for (const c of COMMITMENT_CATEGORIES) {
      expect(GUARDRAIL_VERDICTS).toContain("review");
      expect(PROHIBITED_CATEGORIES).not.toContain(c);
    }
  });
});

describe("guardrail — block: an absolute prohibition, refused and never sent (§12)", () => {
  it("blocks an absolute safety claim", () => {
    const r = evaluateReply("Don't worry, your gas boiler is completely safe.");
    expect(r.verdict).toBe("block");
    expect(r.categories).toContain("safety_claim");
    expect(r.safeText).toBeNull();
    expect(isAutoSendable(r)).toBe(false);
  });

  it("blocks an absolute compliance claim", () => {
    const r = evaluateReply("The installation is fully compliant and meets all regulations.");
    expect(r.verdict).toBe("block");
    expect(r.categories).toContain("safety_claim");
  });

  it("blocks a discriminatory refusal of service", () => {
    const r = evaluateReply("We won't serve you because of your nationality.");
    expect(r.verdict).toBe("block");
    expect(r.categories).toContain("discrimination");
  });

  it("blocks a decision conditioned on a protected characteristic", () => {
    const r = evaluateReply("We priced it higher because of your age.");
    expect(r.verdict).toBe("block");
    expect(r.categories).toContain("discrimination");
  });

  it("takes the MAX severity — a block claim beats a co-occurring review commitment", () => {
    const r = evaluateReply("That'll cost £500. And your boiler is completely safe.");
    expect(r.verdict).toBe("block");
    expect(r.categories).toContain("price");
    expect(r.categories).toContain("safety_claim");
  });
});

describe("guardrail — redaction surfaces the safe remainder", () => {
  it("drops the offending sentence and keeps a clean, sendable lead-in", () => {
    const r = evaluateReply("Thanks for reaching out. It'll cost £450.");
    expect(r.verdict).toBe("review");
    expect(r.safeText).toBe("Thanks for reaching out.");
  });

  it("redactReply removes any sentence carrying a flagged span", () => {
    const redacted = redactReply("Hello there. We guarantee a perfect job. Speak soon.");
    expect(redacted).toBe("Hello there. Speak soon.");
  });

  it("offers no safe remainder when the whole draft is a commitment", () => {
    const r = evaluateReply("That'll cost £450 and we guarantee it.");
    expect(r.safeText).toBeNull();
  });
});

describe("guardrail — determinism (no clock, no RNG: the same draft always decides the same)", () => {
  it("returns a deep-equal result across repeated calls", () => {
    const draft = "We've booked you in for Friday at 9am and it'll cost £120.";
    expect(evaluateReply(draft)).toEqual(evaluateReply(draft));
  });

  it("categories come back in canonical order, de-duplicated", () => {
    const r = evaluateReply("£100. £200. We guarantee it. We promise it.");
    // price precedes guarantee in GUARDRAIL_CATEGORIES; each appears once.
    expect(r.categories).toEqual(["price", "guarantee"]);
  });
});

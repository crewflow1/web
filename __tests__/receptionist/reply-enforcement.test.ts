import { describe, it, expect } from "vitest";
import {
  enforceReceptionistReply,
  type ReceptionistReplyDecision,
} from "@/server/services/receptionist";
import {
  evaluateReply,
  isAutoSendable,
  ACK_MAX_LENGTH,
  GUARDRAIL_VERDICTS,
} from "@/lib/receptionist/policy";
import {
  detectBookingIntent,
  composeBookingConfirmation,
} from "@/lib/receptionist/intent";

/**
 * Voice Receptionist AI — the canonical reply-enforcement seam, unit tier
 * (the AI Receptionist Programme, R3 — canonical policy enforcement).
 *
 * `enforceReceptionistReply` (server/services/receptionist.ts) is the SINGLE, load-bearing
 * chokepoint every AI-generated customer reply must pass before it can proceed. It DELEGATES the
 * verdict to the harvested guardrail (`evaluateReply`) and applies the enforcement decision:
 * DENY BY DEFAULT. These tests pin that behaviour:
 *
 *   1. Only a policy `allow` yields `allowed: true`; a `review`, a `block`, or an empty draft
 *      does not — the crisp law `allowed === (verdict === "allow")`.
 *   2. The seam is a pure passthrough of the harvested policy — it neither softens nor overrides a
 *      verdict; its `result` is exactly `evaluateReply(draft)`.
 *   3. THE KEYSTONE, at the enforcement seam: a composed booking confirmation is a customer
 *      commitment BY CONSTRUCTION, so it can never clear — `allowed` is always `false`.
 *
 * The seam's SINGLE-PATH / no-bypass property is proven from source in
 * __tests__/security/receptionist-enforcement-invariants.test.ts.
 */

// =====================================================================
// 1. Deny by default — only a clean `allow` clears.
// =====================================================================

describe("enforceReceptionistReply — deny by default", () => {
  it("clears a bounded acknowledgement with no commitment (allow → allowed)", () => {
    const d = enforceReceptionistReply(
      "Thanks for your message — a member of the team will call you back shortly.",
    );
    expect(d.verdict).toBe("allow");
    expect(d.allowed).toBe(true);
    expect(d.categories).toEqual([]);
    expect(d.safeText).not.toBeNull();
  });

  it("holds a customer commitment (price → review, not allowed)", () => {
    const d = enforceReceptionistReply("Sure, that'll cost £450 including VAT.");
    expect(d.verdict).toBe("review");
    expect(d.allowed).toBe(false);
    expect(d.categories).toContain("price");
  });

  it("refuses an absolute safety claim (block → not allowed)", () => {
    const d = enforceReceptionistReply("Don't worry, your gas boiler is completely safe.");
    expect(d.verdict).toBe("block");
    expect(d.allowed).toBe(false);
    expect(d.categories).toContain("safety_claim");
    expect(d.safeText).toBeNull();
  });

  it("holds an empty / whitespace draft (nothing to auto-send)", () => {
    const d = enforceReceptionistReply("   ");
    expect(d.allowed).toBe(false);
    expect(d.verdict).toBe("review");
  });

  it("holds a clean reply that overflows the acknowledgement envelope", () => {
    const draft = "Thanks for getting in touch. ".repeat(20).trim();
    expect(draft.length).toBeGreaterThan(ACK_MAX_LENGTH);
    const d = enforceReceptionistReply(draft);
    expect(d.verdict).toBe("review");
    expect(d.allowed).toBe(false);
  });

  it("THE LAW: `allowed` is true for exactly the `allow` verdict, nothing else", () => {
    const drafts = [
      "Thanks for your message — we'll be in touch shortly.", // allow
      "Sure, that'll cost £450 including VAT.", // review (price)
      "Great, I've booked you in for Tuesday at 2pm.", // review (booking)
      "This message forms a legally binding contract for the works.", // review (legal)
      "We guarantee the work will be perfect and we promise it will last.", // review (guarantee)
      "Don't worry, your boiler is completely safe.", // block (safety)
      "We won't serve you because of your nationality.", // block (discrimination)
      "   ", // empty → review
      "Thanks for getting in touch. ".repeat(20).trim(), // overflow → review
    ];
    for (const draft of drafts) {
      const d = enforceReceptionistReply(draft);
      expect(d.allowed, `allowed must equal (verdict === "allow") for: ${draft.slice(0, 40)}`).toBe(
        d.verdict === "allow",
      );
    }
  });
});

// =====================================================================
// 2. The seam is a faithful passthrough of the harvested policy.
// =====================================================================

describe("enforceReceptionistReply — delegates to the harvested policy verbatim", () => {
  const drafts = [
    "Thanks, we'll call you back shortly.",
    "That'll cost £120 and we guarantee it.",
    "Don't worry, the installation is fully compliant and meets all regulations.",
    "I've scheduled your callback for this afternoon.",
    "",
  ];

  for (const draft of drafts) {
    it(`mirrors evaluateReply for: ${draft.slice(0, 36) || "(empty)"}`, () => {
      const decision = enforceReceptionistReply(draft);
      const policy = evaluateReply(draft);
      // The verdict, its justification, its categories, and the safe remainder all pass through.
      expect(decision.verdict).toBe(policy.verdict);
      expect(decision.reason).toBe(policy.reason);
      expect(decision.categories).toEqual(policy.categories);
      expect(decision.safeText).toBe(policy.safeText);
      // The full result is carried through intact for audit.
      expect(decision.result).toEqual(policy);
      // `allowed` is exactly the policy's auto-sendable predicate — no softening, no override.
      expect(decision.allowed).toBe(isAutoSendable(policy));
    });
  }

  it("the verdict always lies in the bounded guardrail codomain", () => {
    for (const draft of drafts) {
      expect(GUARDRAIL_VERDICTS).toContain(enforceReceptionistReply(draft).verdict);
    }
  });

  it("is deterministic — the same draft always decides the same (no clock, no RNG)", () => {
    const draft = "We've booked you in for Friday at 9am and it'll cost £120.";
    const a: ReceptionistReplyDecision = enforceReceptionistReply(draft);
    const b: ReceptionistReplyDecision = enforceReceptionistReply(draft);
    expect(a).toEqual(b);
  });
});

// =====================================================================
// 3. THE KEYSTONE at the seam — a booking confirmation can never clear.
// =====================================================================

describe("enforceReceptionistReply — a booking confirmation is never auto-sendable", () => {
  const messages = [
    "please book me in for Monday morning",
    "can you call me back this afternoon",
    "are you free next week?",
    "could you come Tuesday at 2pm",
    "I'd like a callback tomorrow morning",
  ];

  for (const message of messages) {
    it(`holds the confirmation proposed for: ${message}`, () => {
      const intent = detectBookingIntent(message);
      expect(intent, `expected a booking intent for: ${message}`).not.toBeNull();
      if (!intent) return;
      const decision = enforceReceptionistReply(composeBookingConfirmation(intent));
      expect(decision.verdict).toBe("review");
      expect(decision.categories).toContain("booking");
      expect(decision.allowed).toBe(false);
    });
  }
});

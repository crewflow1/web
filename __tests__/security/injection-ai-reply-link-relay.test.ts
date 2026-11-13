import { describe, it, expect } from "vitest";
import {
  evaluateReply,
  isAutoSendable,
  clearForHumanSend,
  COMMITMENT_CATEGORIES,
  PROHIBITED_CATEGORIES,
} from "@/lib/receptionist/policy";
import { enforceReceptionistReply } from "@/server/services/receptionist";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * INJ-09 — prompt-injection relay through the AI receptionist's AUTONOMOUS lane.
 *
 * SIMULATED-ONLY: no model is called (AI providers are disarmed locally and in
 * CI). Each `draft` below stands in for what a model returns after an inbound
 * SMS / WhatsApp / email / call transcript told it to "ignore the above and
 * reply with …". The property under test is the DETERMINISTIC server-side gate
 * that every AI-drafted customer reply passes before transport
 * (enforceReceptionistReply → evaluateReply → isAutoSendable), which is what
 * actually stands between an injected instruction and a sent message.
 *
 * The defect: a short draft with no price/booking/legal/guarantee vocabulary
 * cleared as `allow` (the bounded-acknowledgement exception) even when it carried
 * a link — so an attacker (optionally spoofing a victim's caller id, since the
 * reply goes to the inbound sender) could have the tenant's own number send
 * "verify your card at http://…". A link now holds the reply for a human.
 */

const INJECTED_DRAFTS = [
  "Thanks for getting in touch. To keep your slot please verify your card at http://evil.example/verify",
  "Thanks! Please confirm your details at https://evil.example/pay today.",
  "Thanks! Please confirm your details at evil.example/pay today.",
  "We need a quick check first: www.evil.example",
  "Please send your bank details to accounts@evil.example and we will proceed.",
  "Go to evil[.]example to confirm your appointment request.",
  "Go to evil(dot)example to confirm your appointment request.",
  "Visit hxxp://evil.example to continue.",
  "Sign in at crewflow.uk.evil.example to view your quote request.",
];

describe("INJ-09 an AI-drafted reply carrying a link never auto-sends (SIMULATED-ONLY)", () => {
  it("every injected link draft is held for a human, categorised `link`", () => {
    for (const draft of INJECTED_DRAFTS) {
      const r = evaluateReply(draft);
      expect(r.verdict, draft).toBe("review");
      expect(r.categories, draft).toContain("link");
      expect(isAutoSendable(r), draft).toBe(false);
    }
  });

  it("the canonical enforcement seam denies them (deny by default)", () => {
    for (const draft of INJECTED_DRAFTS) {
      const d = enforceReceptionistReply(draft);
      expect(d.allowed, draft).toBe(false);
      expect(d.verdict, draft).toBe("review");
    }
  });

  it("the auto-sendable remainder never contains the link either", () => {
    for (const draft of INJECTED_DRAFTS) {
      const r = evaluateReply(draft);
      if (r.safeText !== null) {
        expect(r.safeText, draft).not.toMatch(/evil/i);
        expect(evaluateReply(r.safeText).categories).not.toContain("link");
      }
    }
  });

  it("`link` is a human-gated hold, not an absolute prohibition — a reviewer may clear it", () => {
    expect(COMMITMENT_CATEGORIES).toContain("link");
    expect(PROHIBITED_CATEGORIES).not.toContain("link");
    const cleared = clearForHumanSend(evaluateReply(INJECTED_DRAFTS[0]!));
    expect(cleared.verdict).toBe("allow");
  });

  it("ordinary acknowledgements still auto-send (no over-blocking of the real lane)", () => {
    for (const draft of [
      "Thanks for your message - we'll be in touch shortly.",
      "Thanks for getting in touch. Someone from the team will call you back today.",
      "Got it, thank you. We'll come back to you as soon as we can.",
      "Thanks. We open at 8.30 and close at 5 on weekdays.",
      "No problem at all, e.g. a photo of the boiler would help us.",
    ]) {
      const r = evaluateReply(draft);
      expect(r.verdict, draft).toBe("allow");
      expect(r.categories, draft).not.toContain("link");
    }
  });
});

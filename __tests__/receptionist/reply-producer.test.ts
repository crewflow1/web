import { describe, it, expect } from "vitest";
import {
  composeReceptionistReply,
  type ReplyContext,
} from "@/lib/receptionist/reply";
import { evaluateReply, isAutoSendable, ACK_MAX_LENGTH } from "@/lib/receptionist/policy";
import { INBOUND_CHANNELS, type InboundChannel } from "@/lib/receptionist/types";

/**
 * Voice Receptionist AI — the deterministic reply PRODUCER, unit tier
 * (the AI Receptionist Programme, R4 — reply production & audit pipeline).
 *
 * `composeReceptionistReply` (lib/receptionist/reply.ts) is the pure Draft in the
 * canonical Draft → Enforce → Audit pipeline. Two properties matter and are proven
 * here without a database or a model:
 *   1. It is DETERMINISTIC — the same context always yields the same draft (no
 *      clock, no RNG, no model), so a produced reply is reconstructable.
 *   2. THE KEYSTONE: every draft it composes clears the harvested guardrail as
 *      `allow` — a bounded, commitment-free acknowledgement, never a `review` and
 *      never a `block`. The producer is SAFE BY CONSTRUCTION: it can only ever
 *      compose an auto-sendable acknowledgement, so the deterministic path can
 *      never manufacture a customer commitment or a prohibited claim.
 *
 * The producer must NOT reach the policy itself (enforcement is the server seam's
 * job) — so this suite, not the producer, calls `evaluateReply` to prove the
 * produced draft's fate.
 */

// Every context the producer is asked to serve: each channel, plus the no-context
// default (an enquiry whose channel is unknown).
const CONTEXTS: ReplyContext[] = [
  {},
  { channel: null },
  ...INBOUND_CHANNELS.map((channel) => ({ channel }) satisfies ReplyContext),
];

// =====================================================================
// 1. Determinism — the same context always composes the same draft.
// =====================================================================

describe("composeReceptionistReply — deterministic (no clock, no RNG, no model)", () => {
  for (const context of CONTEXTS) {
    it(`is stable for channel: ${context.channel ?? "(none)"}`, () => {
      const a = composeReceptionistReply(context);
      const b = composeReceptionistReply(context);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(0);
    });
  }

  it("selects a stable phrasing by channel shape (voice vs message)", () => {
    // A live voice call and a written message get distinct, but internally
    // consistent, phrasings — a real deterministic input → output mapping.
    const voice = composeReceptionistReply({ channel: "phone" });
    expect(composeReceptionistReply({ channel: "whatsapp_call" })).toBe(voice);

    const message = composeReceptionistReply({ channel: "sms" });
    for (const channel of ["whatsapp_msg", "instagram_dm", "facebook_dm", "manual"] as const) {
      expect(composeReceptionistReply({ channel })).toBe(message);
    }
    // The default (unknown channel) falls back to the message phrasing.
    expect(composeReceptionistReply()).toBe(message);
    expect(voice).not.toBe(message);
  });
});

// =====================================================================
// 2. THE KEYSTONE — every produced draft clears the guardrail as `allow`.
// =====================================================================

describe("composeReceptionistReply — every draft is a guardrail `allow`", () => {
  for (const context of CONTEXTS) {
    it(`clears enforcement for channel: ${context.channel ?? "(none)"}`, () => {
      const draft = composeReceptionistReply(context);
      const result = evaluateReply(draft);

      // Auto-sendable: a clean, bounded acknowledgement, nothing held or refused.
      expect(result.verdict).toBe("allow");
      expect(isAutoSendable(result)).toBe(true);

      // No commitment and no prohibited claim was drafted.
      expect(result.categories).toEqual([]);
      expect(result.findings).toEqual([]);

      // Within the acknowledgement envelope, and the safe remainder is the draft.
      expect(draft.trim().length).toBeGreaterThan(0);
      expect(draft.length).toBeLessThanOrEqual(ACK_MAX_LENGTH);
      expect(result.safeText).toBe(draft.trim());
    });
  }

  it("THE LAW: the producer NEVER composes a `review` or a `block`", () => {
    const verdicts = new Set(
      CONTEXTS.map((c) => evaluateReply(composeReceptionistReply(c)).verdict),
    );
    // The producer's entire codomain is the single verdict `allow`.
    expect([...verdicts]).toEqual(["allow"]);
  });

  it("covers every declared inbound channel", () => {
    // If a channel is ever added, its produced draft must still be an `allow`.
    for (const channel of INBOUND_CHANNELS as readonly InboundChannel[]) {
      expect(evaluateReply(composeReceptionistReply({ channel })).verdict).toBe("allow");
    }
  });
});

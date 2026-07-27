import type { InboundChannel } from "@/lib/receptionist/types";

/**
 * CrewFlow HQ — Voice Receptionist AI: the deterministic reply PRODUCER
 * (the AI Receptionist Programme, R4 — REPLY PRODUCTION & AUDIT PIPELINE).
 *
 * The pure layer that COMPOSES the one reply an autonomous receptionist may draft
 * without a human behind it: a bounded, commitment-free ACKNOWLEDGEMENT — "we have
 * your message; a person will come back to you." It is the Draft in the canonical
 * Draft → Enforce → Audit pipeline.
 *
 * A shared, PURE module — the exact discipline of {@link
 * import("@/lib/receptionist/intent")} and {@link import("@/lib/receptionist/policy")}:
 * NOT server-only, NO I/O, no clock, no RNG, and NO model. It COMPOSES; it does not
 * generate. The same context always yields the same draft, so a produced reply is
 * reconstructable from named rules alone (the "no black box" bar), never an opaque
 * sample. (A richer, AI-DRAFTED reply is a later increment and the explicit R4
 * non-goal "AI behaviour expansion"; when it lands it flows through the SAME
 * enforce+audit pipeline, never around it.)
 *
 * SAFE BY CONSTRUCTION. Every branch returns a fixed, pre-vetted phrase with no
 * price, booking, legal, guarantee, safety or discrimination content, well within
 * the acknowledgement envelope — so the harvested guardrail clears it as `allow`.
 * The producer deliberately interpolates NO untrusted caller free-text into a
 * safety-critical reply, so its output cannot be steered into a commitment or a
 * prohibited claim. That the output is always a guardrail `allow` is pinned in the
 * unit tier (__tests__/receptionist/reply-producer.test.ts).
 *
 * SEPARATION OF POWERS. This module DRAFTS; it never ENFORCES. It does not import
 * the policy and names none of its decision functions — enforcement is reached
 * ONLY through the canonical service (server/services/receptionist.ts), the single
 * path pinned by __tests__/security/receptionist-enforcement-invariants. The
 * producer is likewise consumed ONLY by that service, pinned by
 * __tests__/security/receptionist-reply-audit-invariants.
 */

/** The context of one inbound enquiry the producer is asked to acknowledge. */
export type ReplyContext = {
  /** The channel the enquiry arrived on — selects the acknowledgement phrasing. */
  channel?: InboundChannel | null;
};

/**
 * A live voice call is acknowledged with a spoken-shaped phrase ("thanks for your
 * call"); every written channel (SMS, WhatsApp message, DMs, manual) gets the
 * message-shaped phrase. Both are guardrail `allow` by construction.
 */
const VOICE_ACKNOWLEDGEMENT =
  "Thanks for your call — a member of the team will call you back shortly.";
const MESSAGE_ACKNOWLEDGEMENT =
  "Thanks for your message — a member of the team will get back to you shortly.";

/** Channels that arrive as a live voice call rather than a written message. */
function isVoiceChannel(channel: InboundChannel | null | undefined): boolean {
  return channel === "phone" || channel === "whatsapp_call";
}

/**
 * Compose the deterministic acknowledgement for one inbound enquiry. Pure and
 * total: for any context it returns a bounded, commitment-free acknowledgement the
 * guardrail clears as `allow`. This is a DRAFT — it is still enforced and audited by
 * the canonical service before it could ever proceed.
 */
export function composeReceptionistReply(context: ReplyContext = {}): string {
  return isVoiceChannel(context.channel)
    ? VOICE_ACKNOWLEDGEMENT
    : MESSAGE_ACKNOWLEDGEMENT;
}

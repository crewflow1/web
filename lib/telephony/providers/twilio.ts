import "server-only";

/**
 * Voice Telephony (Wave 8) — the Twilio inbound-voice provider.
 *
 * The vendor half of the voice seam: VERIFY a signed inbound request and PARSE a
 * verified body into the neutral `NormalizedInboundCall`. It introduces no new
 * verification model — `verifyTwilioSignature` is REUSED VERBATIM from the SMS
 * adapter (lib/comms/providers/twilio.ts), which loads the SDK lazily, reads
 * TWILIO_AUTH_TOKEN at call time, and fails closed. Twilio voice webhooks are
 * `application/x-www-form-urlencoded`, signed over the exact URL + sorted params.
 *
 * No SDK is imported at module scope; the only SDK use is inside the reused
 * verifier's dynamic import. Parsing is pure and never throws.
 */

import { verifyTwilioSignature } from "@/lib/comms/providers/twilio";
import {
  isCallEventType,
  type CallEventType,
  type NormalizedInboundCall,
  type VoiceProvider,
} from "../types";

export { verifyTwilioSignature };

/**
 * Map Twilio's `CallStatus` vocabulary onto our neutral event types. Twilio
 * uses hyphens (`in-progress`, `no-answer`) and `queued` for the pre-ring state;
 * everything else is a direct rename. An unknown status → null (the caller
 * treats the payload as unusable rather than inventing a transition).
 */
export function mapTwilioCallStatus(raw: string | undefined | null): CallEventType | null {
  const s = (raw ?? "").trim().toLowerCase();
  switch (s) {
    case "queued":
    case "initiated":
      return "initiated";
    case "ringing":
      return "ringing";
    case "answered":
      return "answered";
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "no-answer":
    case "no_answer":
      return "no_answer";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return isCallEventType(s) ? s : null;
  }
}

/**
 * Parse one verified Twilio voice webhook (origination OR status callback) into
 * the neutral shape, or null when it is unusable. The origination POST carries
 * no explicit CallStatus in some configurations — it is treated as `initiated`.
 * The idempotency key is the mapped status (one audit row per (call, status)).
 */
export function parseTwilioVoiceWebhook(
  params: Record<string, string>,
): NormalizedInboundCall | null {
  const providerCallId = params.CallSid?.trim();
  if (!providerCallId) return null;

  const status = mapTwilioCallStatus(params.CallStatus) ?? "initiated";

  return {
    provider: "twilio",
    providerCallId,
    from: params.From?.trim() || null,
    to: params.To?.trim() || null,
    status,
    // Twilio sends no per-event id; the (call, status) pair is the natural
    // idempotency key, so the mapped status is the provider_event_id.
    providerEventId: status,
    occurredAt: new Date().toISOString(),
    raw: params as Record<string, unknown>,
  };
}

/**
 * Build the TwiML the origination route returns. Kept deliberately minimal and
 * deterministic — a fixed spoken acknowledgement. Any AI-generated spoken turn
 * is a separate, governed, tier-gated seam (lib/telephony/ai-turn.ts) that is
 * dark today; this is the fallback a caller always hears.
 */
export function buildInboundTwiml(message?: string): string {
  const say = message?.trim() || "Thank you for calling. Please leave a message after the tone.";
  const escaped = say
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escaped}</Say></Response>`;
}

/** The TwiML returned when a call cannot be attributed to an org (ack-drop). */
export function buildAckDropTwiml(): string {
  return buildInboundTwiml("Sorry, this number is not currently in service. Goodbye.");
}

export function createTwilioVoiceProvider(): VoiceProvider {
  return {
    id: "twilio",
    verify: (input) =>
      verifyTwilioSignature({ signature: input.signature, url: input.url, params: input.params }),
    parse: (input) => parseTwilioVoiceWebhook(input.params),
  };
}

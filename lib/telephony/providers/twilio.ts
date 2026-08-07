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
    // Twilio reports `CallDuration` (whole seconds) on the terminal `completed`
    // status callback and omits it otherwise. Parse to a non-negative integer;
    // leave undefined when absent or non-numeric so the completion writer never
    // overwrites an already-captured duration with a bad value.
    durationSec: parseCallDuration(params.CallDuration),
    occurredAt: new Date().toISOString(),
    raw: params as Record<string, unknown>,
  };
}

/**
 * Parse Twilio's `CallDuration` (a whole-seconds string on the completed status
 * callback) into a non-negative integer, or undefined when absent / unparseable.
 */
function parseCallDuration(raw: string | undefined | null): number | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** XML-escape a spoken string so a caller utterance can never break the TwiML. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The single conversational callback the <Gather> loop POSTs the caller's
 * SpeechResult to. It reuses the origination route's guard chain and drives the
 * governed AI spoken-turn seam. Kept relative so it is signed/reconstructed
 * against whatever public host Twilio reached (behind Vercel's proxy).
 */
export const TWILIO_VOICE_GATHER_ACTION = "/api/webhooks/twilio/voice/gather";

/**
 * Build a fixed, deterministic acknowledgement TwiML — a bare <Say> with no
 * <Gather>, so the call ENDS after it plays. Used for the ack-drop (unrouted)
 * and for the graceful "leave it with us" fallback when the AI turn is dark: a
 * conversational loop must never spin silently when nothing can answer.
 */
export function buildInboundTwiml(message?: string): string {
  const say = message?.trim() || "Thank you for calling. Please leave a message after the tone.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(say)}</Say></Response>`;
}

/**
 * Build a CONVERSATIONAL turn: SAY `prompt` while LISTENING (speech recognition)
 * and POST the transcript to the gather-callback route so the governed AI seam
 * can produce the next spoken turn. Nesting the greeting/turn inside <Gather> is
 * what makes the seam reachable — Twilio only delivers `SpeechResult` to a
 * <Gather action=…> URL. A `<Say>`+`<Hangup/>` branch AFTER the <Gather> handles
 * the caller who says nothing, so the call ends politely instead of hanging.
 */
export function buildGatherTwiml(opts?: {
  prompt?: string;
  noInput?: string;
  action?: string;
}): string {
  const prompt = opts?.prompt?.trim() || "Thank you for calling. How can I help you today?";
  const noInput =
    opts?.noInput?.trim() ||
    "Sorry, I didn't catch that. Please call back when you're ready. Goodbye.";
  const action = opts?.action?.trim() || TWILIO_VOICE_GATHER_ACTION;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Gather input="speech" action="${escapeXml(action)}" method="POST" speechTimeout="auto">` +
    `<Say>${escapeXml(prompt)}</Say>` +
    `</Gather>` +
    `<Say>${escapeXml(noInput)}</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
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

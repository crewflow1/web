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
 * The <Dial> action callback the staff-first flow POSTs the dial OUTCOME to
 * (DialCallStatus = completed / no-answer / busy / failed). Twilio ALWAYS
 * requests this URL after the staff leg finishes — answered or not — and the
 * call continues with the TwiML it returns, which is where the AI / message
 * fallback is decided. Kept relative so it is signed/reconstructed against
 * whatever public host Twilio reached (behind Vercel's proxy).
 */
export const TWILIO_VOICE_DIAL_STATUS_ACTION = "/api/webhooks/twilio/voice/dial-status";

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

/** A UK E.164 validator — the only number shape the <Dial> builder will emit. */
const DIAL_E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Build the STAFF-FIRST <Dial> TwiML: ring the org's own staff numbers (all at
 * once — multiple <Number> nouns in one <Dial> ring SIMULTANEOUSLY, first to
 * answer wins), for `timeoutSeconds`, then hand control to the dial-status action
 * which decides the AI / message fallback. The `callerId` MUST be a Twilio-owned
 * number — we pass the DIALED number (guaranteed owned), so staff reliably see
 * the business line. Optionally records from answer (PR 6 recording controls).
 *
 * Returns `null` when there is no valid staff number to ring, so the caller can
 * fall back to AI rather than emit an empty, hanging <Dial>. Every number + the
 * callerId is E.164-validated and XML-escaped; a greeting <Say> can precede the
 * dial so the caller is not met with silence while staff phones ring.
 */
export function buildDialTwiml(opts: {
  numbers: readonly string[];
  timeoutSeconds: number;
  callerId?: string | null;
  action?: string;
  greeting?: string | null;
  record?: boolean;
  recordingStatusCallback?: string | null;
}): string | null {
  const numbers = opts.numbers.filter((n) => typeof n === "string" && DIAL_E164.test(n));
  if (numbers.length === 0) return null;

  const timeout = Math.max(5, Math.min(120, Math.trunc(opts.timeoutSeconds) || 20));
  const action = opts.action?.trim() || TWILIO_VOICE_DIAL_STATUS_ACTION;
  const callerId =
    opts.callerId && DIAL_E164.test(opts.callerId) ? ` callerId="${escapeXml(opts.callerId)}"` : "";
  const record = opts.record ? ` record="record-from-answer-dual"` : "";
  const recordCb =
    opts.record && opts.recordingStatusCallback?.trim()
      ? ` recordingStatusCallback="${escapeXml(opts.recordingStatusCallback.trim())}" recordingStatusCallbackMethod="POST"`
      : "";
  const greeting = opts.greeting?.trim()
    ? `<Say>${escapeXml(opts.greeting.trim())}</Say>`
    : "";
  const numberNouns = numbers.map((n) => `<Number>${escapeXml(n)}</Number>`).join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    greeting +
    `<Dial action="${escapeXml(action)}" method="POST" timeout="${timeout}"${callerId}${record}${recordCb} answerOnBridge="true">` +
    numberNouns +
    `</Dial>` +
    `</Response>`
  );
}

export function createTwilioVoiceProvider(): VoiceProvider {
  return {
    id: "twilio",
    verify: (input) =>
      verifyTwilioSignature({ signature: input.signature, url: input.url, params: input.params }),
    parse: (input) => parseTwilioVoiceWebhook(input.params),
  };
}

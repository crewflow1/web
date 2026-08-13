import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import { buildAckDropTwiml, buildGatherTwiml, buildInboundTwiml } from "@/lib/telephony/providers/twilio";
import { maybeGenerateVoiceTurn, type VoiceTurnHistoryEntry } from "@/lib/telephony/ai-turn";
import { loadReceptionistProfile } from "@/lib/telephony/receptionist-profile";
import {
  countSpokenTurns,
  loadRecentSpokenTurns,
  persistSpokenTurn,
  recordInboundCall,
} from "@/server/services/telephony";

/**
 * Twilio inbound VOICE gather-callback — the conversational spoken-turn loop.
 *
 * The origination route greets the caller inside a <Gather input="speech"> whose
 * action is THIS route. Twilio transcribes the caller's utterance and POSTs it
 * here as `SpeechResult` — the ONLY place a transcript ever arrives, so this is
 * where the governed AI spoken-turn seam (maybeGenerateVoiceTurn) is actually
 * reachable with a non-empty transcript.
 *
 * It reuses the origination edge's guard chain VERBATIM, in the same order:
 *   1. maintenance 503 → 2. rate-limit → 3. DARK GATE 503 before ANY work →
 *   4. read the RAW body → 5. FAIL-CLOSED signature verify BEFORE parsing →
 *   6. normalise → 7. resolve the org from the DIALED number (never the body) →
 *   8. generate the governed turn from `SpeechResult` → 9. return TwiML.
 *
 * The turn TwiML SAYs the AI reply and NESTS a further <Gather> back to this
 * same route, continuing the conversation. When the turn is null (DARK: no tier
 * bound / blocked / deduped / provider error) we return a graceful deterministic
 * TwiML that ends the call politely — never an error, never a silent loop, never
 * a leak. Identical dark posture to before: a bound tier is still required.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TWIML_HEADERS = { "content-type": "text/xml; charset=utf-8" } as const;

/** The exact URL Twilio signed — reconstructed from forwarded headers. */
function callbackUrl(request: Request): string {
  const parsed = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? parsed.protocol.replace(/:$/, "");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? parsed.host;
  return `${proto}://${host}${parsed.pathname}${parsed.search}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  const rl = enforce(request, "twilio_voice_gather", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  // 3. THE DARK GATE — before any work. Flag off or no provider ⇒ 503.
  if (!isVoiceConfigured()) {
    return NextResponse.json(
      { ok: false, error: "not_enabled" },
      { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } },
    );
  }

  // 4. Raw body FIRST — the signature is over the exact params.
  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;

  const provider = getVoiceProvider();
  if (!provider) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  }

  // 5. FAIL-CLOSED signature verification BEFORE parsing or any side effect.
  const authentic = await provider.verify({
    signature: request.headers.get("x-twilio-signature"),
    url: callbackUrl(request),
    rawBody,
    params,
  });
  if (!authentic) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  // 6. Normalise the verified body. A gather callback with no usable identity is
  //    answered with the deterministic greeting rather than an error.
  const call = provider.parse({ rawBody, params });
  if (!call) {
    return new NextResponse(buildInboundTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // 7. Attribute the org from the DIALED number — never the caller-controlled body.
  const orgId = await resolveOrgForDialedNumber(call.to);
  if (!orgId) {
    // Ack-drop: no tenant work, polite TwiML.
    return new NextResponse(buildAckDropTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // 8. The caller's utterance, transcribed by Twilio's <Gather input="speech">.
  //    This is the transcript the governed seam short-circuits on when empty.
  const transcript = typeof call.raw.SpeechResult === "string" ? call.raw.SpeechResult : "";

  // 8a. Resolve THIS call's row (idempotent on CallSid — origination already
  //     created it) and load its prior spoken turns, so the turn has MEMORY of the
  //     conversation rather than being an amnesiac single shot. Best-effort: all
  //     persistence is wrapped so a DB error degrades the call to a graceful close
  //     instead of dropping it — and it runs AFTER the dark + signature gates above.
  // Per-org business identity (name/trade/hours) for the governed turn, as CONTEXT
  // data. Missing setup ⇒ null ⇒ the generic behaviour (safe default).
  const profile = await loadReceptionistProfile(orgId);

  let callId: string | null = null;
  let priorTurns: VoiceTurnHistoryEntry[] = [];
  let turnOrdinal = 0;
  try {
    const rec = await recordInboundCall(orgId, call);
    callId = rec.callId;
    priorTurns = await loadRecentSpokenTurns(orgId, callId);
    // Dedupe ordinal from the COMPLETE per-call spoken-turn count — NOT
    // priorTurns.length, which is bounded to the recent window and FREEZES at its
    // cap on a long call, colliding the governor dedupe key and dropping the caller.
    turnOrdinal = await countSpokenTurns(orgId, callId);
  } catch (e) {
    Sentry.captureException(e, {
      tags: { route: "webhooks/twilio/voice/gather", stage: "load" },
    });
    console.error("[twilio-voice-gather] call resolve / history load failed", e);
  }

  const spokenTurn = await maybeGenerateVoiceTurn({
    orgId,
    transcript,
    // Per-call dedupe identity: the resolved call row + this turn's ordinal, so the
    // governor's duplicate refusal is scoped to THIS call+turn (not the raw phrase).
    // The ordinal is the COMPLETE per-call count, so it strictly increases across
    // the whole call and a repeated short utterance past turn 20 never collides.
    callId,
    ordinal: turnOrdinal,
    business: profile,
    history: priorTurns,
  });

  // 8b. Persist the turn — the caller's SpeechResult + the reply — to the
  //     append-only call_events audit AND into the enquiry's raw_text, mirroring
  //     how SMS/WhatsApp persist. Best-effort: a persistence failure must not break
  //     the call, so we log and continue to the TwiML below.
  if (callId && (transcript.trim() || spokenTurn)) {
    try {
      await persistSpokenTurn({
        orgId,
        callId,
        providerCallId: call.providerCallId,
        transcript,
        reply: spokenTurn,
      });
    } catch (e) {
      Sentry.captureException(e, {
        tags: { route: "webhooks/twilio/voice/gather", stage: "persist" },
      });
      console.error("[twilio-voice-gather] spoken-turn persistence failed", e);
    }
  }

  // 9. A generated turn CONTINUES the loop (SAY the reply, then <Gather> again).
  //    A null turn (dark / no tier / blocked / deduped / error) degrades to a
  //    graceful, deterministic close — never an error, never a silent re-gather.
  const twiml = spokenTurn
    ? buildGatherTwiml({ prompt: spokenTurn })
    : buildInboundTwiml(
        "Thank you. We'll pass your message to the team and someone will call you back. Goodbye.",
      );
  return new NextResponse(twiml, { status: 200, headers: TWIML_HEADERS });
}

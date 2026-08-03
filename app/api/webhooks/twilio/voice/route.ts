import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import { buildAckDropTwiml, buildGatherTwiml, buildInboundTwiml } from "@/lib/telephony/providers/twilio";
import { appendCallEvent, recordInboundCall } from "@/server/services/telephony";
import { processInboundEnquiry } from "@/server/services/receptionist";
import { maybeGenerateVoiceTurn } from "@/lib/telephony/ai-turn";

/**
 * Twilio inbound VOICE webhook — the origination edge (Wave 8).
 *
 * The mandated flow, in order, is identical to the WhatsApp/SMS edges:
 *   1. maintenance 503 (retry-safe) → 2. rate-limit → 3. DARK GATE: 503 before
 *   ANY work when inbound voice is not configured → 4. read the RAW body →
 *   5. verify the Twilio signature FAIL-CLOSED, BEFORE parsing → 6. normalise →
 *   7. resolve the org from the DIALED number (never the body-claimed identity) →
 *   8. write calls + call_events on the admin client → 9. delegate to the
 *   UNCHANGED processInboundEnquiry (channel:"phone") → 10. return TwiML.
 *
 * An unrouted dialed number is ACK-DROPPED with a polite TwiML and NO tenant
 * write — an unattributable call must not touch tenant data.
 *
 * DARK by default: NEXT_PUBLIC_FEATURE_VOICE_INBOUND off (or no provider
 * credential) ⇒ step 3 returns 503 and nothing else runs.
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

  const rl = enforce(request, "twilio_voice_webhook", DEFAULT_LIMITS.api);
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

  // 6. Normalise the verified body.
  const call = provider.parse({ rawBody, params });
  if (!call) {
    return new NextResponse(buildInboundTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // 7. Attribute the org from the DIALED number — never the caller-controlled body.
  const orgId = await resolveOrgForDialedNumber(call.to);
  if (!orgId) {
    // Ack-drop: no tenant write, polite TwiML.
    return new NextResponse(buildAckDropTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  try {
    // 8. Persist origination + the first lifecycle event (admin client, org-pinned).
    const { callId } = await recordInboundCall(orgId, call);
    await appendCallEvent(orgId, callId, {
      type: call.status,
      providerEventId: call.providerEventId,
      payload: call.raw,
      occurredAt: call.occurredAt,
    });

    // 9. Delegate to the UNCHANGED ingestion core — same path as SMS/WhatsApp.
    //    Origination is the SINGLE delegation door (the status route never
    //    delegates). We delegate UNCONDITIONALLY rather than gating on the
    //    calls-row `created` flag: Twilio is at-least-once and unordered, so a
    //    status callback can create the calls row first, making origination see
    //    created:false — a `created`-gated skip would then DROP the enquiry
    //    entirely. Idempotency is owned downstream instead: `provider_message_id`
    //    (the CallSid) drives processInboundEnquiry's (org_id, provider_message_id)
    //    partial-unique dedup, so a redelivered origination folds into the same
    //    enquiry. Best-effort: a failure must not break the TwiML.
    try {
      await processInboundEnquiry({
        org_id: orgId,
        channel: "phone",
        caller: call.from,
        dedup_key: call.providerCallId,
        provider_message_id: call.providerCallId,
      });
    } catch (e) {
      Sentry.captureException(e, { tags: { route: "webhooks/twilio/voice", stage: "enquiry" } });
      console.error("[twilio-voice] enquiry delegation failed", e);
    }
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "webhooks/twilio/voice" } });
    console.error("[twilio-voice] call persistence failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }

  // 10. Return TwiML that OPENS the conversational loop. The greeting is wrapped
  //     in a <Gather input="speech"> whose action is the gather-callback route —
  //     that is what makes the AI spoken-turn seam reachable, because Twilio only
  //     delivers a `SpeechResult` transcript to a <Gather action=…> URL. The
  //     origination POST itself carries no transcript, so maybeGenerateVoiceTurn
  //     short-circuits (empty transcript, or dark: no tier bound) and we greet
  //     with the deterministic prompt while still listening. The caller's first
  //     utterance then lands on /voice/gather, where the governed turn is
  //     generated. Activation still requires binding the generative tier — the
  //     engineering (the loop) now exists, so activation is genuinely config-only.
  //     Never throws — buildGatherTwiml always returns a safe, listening greeting.
  const transcript = typeof call.raw.SpeechResult === "string" ? call.raw.SpeechResult : "";
  const spokenTurn = await maybeGenerateVoiceTurn({ orgId, transcript });
  const twiml = buildGatherTwiml({ prompt: spokenTurn ?? undefined });
  return new NextResponse(twiml, { status: 200, headers: TWIML_HEADERS });
}

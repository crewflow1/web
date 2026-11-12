import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import {
  buildAckDropTwiml,
  buildGatherTwiml,
  buildInboundTwiml,
} from "@/lib/telephony/providers/twilio";
import { loadAnsweringPolicy } from "@/lib/telephony/answering-config";
import { decideAnswering, type StaffOutcome } from "@/lib/telephony/answering-policy";
import {
  buildReceptionistGreeting,
  loadReceptionistProfile,
} from "@/lib/telephony/receptionist-profile";
import { appendCallEvent, recordInboundCall, updateCallAssociation } from "@/server/services/telephony";
import { processInboundEnquiry, processMissedCallTextback } from "@/server/services/receptionist";

/**
 * Twilio inbound-VOICE <Dial> ACTION callback — the STAFF-FIRST fallthrough
 * (Twilio receptionist PR 2).
 *
 * The origination route, when the org's structured answering policy says to ring
 * staff first, returns a `<Dial action=…>` to the company's own staff numbers.
 * Twilio ALWAYS requests THIS route after the staff leg finishes — answered or
 * not — carrying `DialCallStatus`. This is where the AI / take-a-message fallback
 * is decided, by re-running the SAME pure `decideAnswering` with the observed
 * staff outcome.
 *
 * It reuses the origination edge's guard chain VERBATIM, in the same order:
 *   1. maintenance 503 → 2. rate-limit → 3. DARK GATE 503 before ANY work →
 *   4. read the RAW body → 5. FAIL-CLOSED signature verify BEFORE parsing →
 *   6. normalise → 7. resolve the org from the DIALED number (never the body) →
 *   8. map DialCallStatus → decide → return TwiML.
 *
 * Outcomes:
 *   - staff ANSWERED  → the humans handled it; end the (already-bridged) call.
 *   - staff MISSED + AI answers (missed_only / both, or out-of-hours) → open the
 *     governed AI loop (greet inside a <Gather>), delegating the enquiry exactly
 *     as the origination AI path does.
 *   - TAKE A MESSAGE (out_of_hours mode, missed DURING open hours) → the AI stays
 *     out; fire the missed-call text-back engine and close politely.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TWIML_HEADERS = { "content-type": "text/xml; charset=utf-8" } as const;

/** TwiML that simply ends the call (staff handled it / caller gone). */
function buildHangupTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
}

/** The exact URL Twilio signed — reconstructed from forwarded headers. */
function callbackUrl(request: Request): string {
  const parsed = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? parsed.protocol.replace(/:$/, "");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? parsed.host;
  return `${proto}://${host}${parsed.pathname}${parsed.search}`;
}

/**
 * Map Twilio's `DialCallStatus` (the OUTCOME of the staff leg) onto the pure
 * policy's StaffOutcome vocabulary. `canceled` = the CALLER abandoned during the
 * ring — there is no one to answer, so it is handled before the decision (hangup).
 */
function mapDialStatus(raw: string | undefined | null): StaffOutcome | "caller_gone" {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "completed":
    case "answered":
      return "answered";
    case "no-answer":
    case "no_answer":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "caller_gone";
    default:
      // Unknown → treat as a miss so the caller is never dropped (fail-safe to capture).
      return "no_answer";
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  const rl = enforce(request, "twilio_voice_dial_status", DEFAULT_LIMITS.api);
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

  // 6. Normalise the verified body for the call IDENTITY (CallSid / From / To).
  const call = provider.parse({ rawBody, params });
  if (!call) {
    return new NextResponse(buildHangupTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // 7. Attribute the org from the DIALED number — never the caller-controlled body.
  const orgId = await resolveOrgForDialedNumber(call.to);
  if (!orgId) {
    return new NextResponse(buildAckDropTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // 8. The staff leg's outcome drives the decision.
  const outcome = mapDialStatus(params.DialCallStatus);

  // The caller hung up while staff rang — nothing to answer, end the call.
  if (outcome === "caller_gone") {
    return new NextResponse(buildHangupTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // Record the staff-leg outcome for the audit trail WITHOUT corrupting the
  // call's terminal lifecycle: a staff ANSWER advances the call to `answered`
  // (accurate + it correctly suppresses the status-route missed-call trigger); a
  // staff MISS is logged as a non-terminal `in_progress` note (the inbound call
  // is still live, now going to the AI / message path) so the REAL terminal, and
  // the missed-call decision, stay owned by the /voice/status callback.
  // Best-effort — a persistence failure must never break the TwiML.
  try {
    const { callId } = await recordInboundCall(orgId, call);
    await appendCallEvent(orgId, callId, {
      type: outcome === "answered" ? "answered" : "in_progress",
      providerEventId: `dial:${(params.DialCallStatus ?? "unknown").toLowerCase()}`,
      payload: { ...call.raw, _dial_outcome: outcome },
      occurredAt: call.occurredAt,
    });
  } catch (e) {
    Sentry.captureException(e, {
      tags: { route: "webhooks/twilio/voice/dial-status", stage: "record" },
    });
    console.error("[twilio-voice-dial-status] staff-leg event persistence failed", e);
  }

  const policy = await loadAnsweringPolicy(orgId);
  const decision = decideAnswering(policy.config, new Date(), outcome);

  // Staff answered — the humans handled it; end the bridged call.
  if (decision.action === "human_handled") {
    return new NextResponse(buildHangupTwiml(), { status: 200, headers: TWIML_HEADERS });
  }

  // out_of_hours mode, missed DURING open hours — the AI stays out, but the
  // caller is captured: fire the (idempotent, eligibility-gated) missed-call
  // text-back engine and close politely. This is the ONLY place the text-back
  // fires for this path, because the inbound call WAS answered (we play TwiML),
  // so the /voice/status terminal is `completed`, which the status-route trigger
  // deliberately excludes.
  if (decision.action === "take_message") {
    try {
      await processMissedCallTextback({
        org_id: orgId,
        provider_call_id: call.providerCallId,
        caller: call.from,
      });
    } catch (e) {
      Sentry.captureException(e, {
        tags: { route: "webhooks/twilio/voice/dial-status", stage: "take_message" },
      });
      console.error("[twilio-voice-dial-status] take-message text-back failed", e);
    }
    return new NextResponse(
      buildInboundTwiml(
        "Sorry we missed you. We'll pass your message to the team and someone will be in touch shortly. Goodbye.",
      ),
      { status: 200, headers: TWIML_HEADERS },
    );
  }

  // AI answers the missed call — open the governed loop, delegating the enquiry
  // exactly as the origination AI path does (it did NOT delegate when it chose to
  // ring staff first, so this is where the lead/enquiry is created for this call).
  // Best-effort: a delegation failure must not break the greeting TwiML.
  const profile = await loadReceptionistProfile(orgId);
  try {
    const { lead_id, conversation_id } = await processInboundEnquiry(
      {
        org_id: orgId,
        channel: "phone",
        caller: call.from,
        dedup_key: call.providerCallId,
        provider_message_id: call.providerCallId,
      },
      { textback: "defer" },
    );
    if (lead_id) {
      try {
        await updateCallAssociation(orgId, call.providerCallId, {
          leadId: lead_id,
          conversationId: conversation_id,
        });
      } catch (e) {
        Sentry.captureException(e, {
          tags: { route: "webhooks/twilio/voice/dial-status", stage: "link" },
        });
        console.error("[twilio-voice-dial-status] call-lead linkage failed", e);
      }
    }
  } catch (e) {
    Sentry.captureException(e, {
      tags: { route: "webhooks/twilio/voice/dial-status", stage: "enquiry" },
    });
    console.error("[twilio-voice-dial-status] enquiry delegation failed", e);
  }

  const greeting = policy.greeting ?? buildReceptionistGreeting(profile);
  return new NextResponse(buildGatherTwiml({ prompt: greeting }), {
    status: 200,
    headers: TWIML_HEADERS,
  });
}

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForProviderCall } from "@/lib/telephony/router";
import { updateCallCompletion } from "@/server/services/telephony";

/**
 * Twilio inbound-VOICE RECORDING-STATUS callback (Twilio receptionist PR 6).
 *
 * When call recording is enabled, Twilio posts the finished recording's URL here
 * (RecordingUrl / RecordingSid / RecordingStatus) on a SEPARATE callback from the
 * call status — and this callback carries only the CallSid, not the dialed number.
 *
 * Reuses the verbatim guard chain: maintenance 503 → rate-limit → DARK GATE 503 →
 * raw body → FAIL-CLOSED signature verify BEFORE parsing → resolve the org from
 * the CALL (CallSid), not a guess → persist the recording URL on the call row
 * (idempotent: a redelivered callback rewrites the same value). An unattributable
 * CallSid is acked with no tenant write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const rl = enforce(request, "twilio_voice_recording_status", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  if (!isVoiceConfigured()) {
    return NextResponse.json(
      { ok: false, error: "not_enabled" },
      { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } },
    );
  }

  const rawBody = await request.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<string, string>;

  const provider = getVoiceProvider();
  if (!provider) {
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  }

  // FAIL-CLOSED signature verification BEFORE parsing or any side effect.
  const authentic = await provider.verify({
    signature: request.headers.get("x-twilio-signature"),
    url: callbackUrl(request),
    rawBody,
    params,
  });
  if (!authentic) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const callSid = params.CallSid?.trim();
  const recordingUrl = params.RecordingUrl?.trim();
  if (!callSid || !recordingUrl) {
    // Nothing actionable — ack so Twilio does not retry-storm.
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Resolve the org from the CALL (the recording callback carries no dialed number).
  const orgId = await resolveOrgForProviderCall("twilio", callSid);
  if (!orgId) {
    return NextResponse.json({ ok: true, unrouted: true });
  }

  try {
    await updateCallCompletion(orgId, callSid, { recordingUrl });
    return NextResponse.json({ ok: true });
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "webhooks/twilio/voice/recording-status" } });
    console.error("[twilio-voice-recording-status] persist failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}

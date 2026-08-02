import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import { appendCallEvent, recordInboundCall } from "@/server/services/telephony";

/**
 * Twilio inbound-VOICE STATUS callback (Wave 8).
 *
 * The asynchronous half of the voice lifecycle. Twilio POSTs each transition
 * (ringing / answered / in-progress / completed / busy / failed / no-answer /
 * canceled) here, correlated by CallSid. Same mandated flow as the origination
 * edge: maintenance 503 → rate-limit → DARK GATE 503 → raw body → FAIL-CLOSED
 * signature verify BEFORE parse → org from the DIALED number → append the event
 * idempotently on (call_id, provider_event_id) and advance calls.status via the
 * pure reducer.
 *
 * A redelivered status is a benign idempotent no-op (the DB unique + the service
 * dedup). An unrouted number is acked with no tenant write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The exact URL Twilio signed — the configured public URL, else reconstructed. */
function callbackUrl(request: Request): string {
  const configured = process.env.TWILIO_VOICE_STATUS_CALLBACK_URL?.trim();
  if (configured) return configured;
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

  const rl = enforce(request, "twilio_voice_status", DEFAULT_LIMITS.api);
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

  const authentic = await provider.verify({
    signature: request.headers.get("x-twilio-signature"),
    url: callbackUrl(request),
    rawBody,
    params,
  });
  if (!authentic) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const call = provider.parse({ rawBody, params });
  if (!call) {
    return NextResponse.json({ ok: false, error: "unparseable" }, { status: 400 });
  }

  const orgId = await resolveOrgForDialedNumber(call.to);
  if (!orgId) {
    // Unattributable — ack without touching tenant data.
    return NextResponse.json({ ok: true, unrouted: true });
  }

  try {
    // Ensure the call row exists (a status callback can arrive before / instead
    // of an origination write); idempotent on (provider, provider_call_id).
    const { callId } = await recordInboundCall(orgId, call);
    const result = await appendCallEvent(orgId, callId, {
      type: call.status,
      providerEventId: call.providerEventId,
      payload: call.raw,
      occurredAt: call.occurredAt,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      status: result.status,
    });
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "webhooks/twilio/voice/status" } });
    console.error("[twilio-voice-status] event persistence failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}

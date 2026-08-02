import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import { appendCallEvent, recordInboundCall } from "@/server/services/telephony";
import { processInboundEnquiry } from "@/server/services/receptionist";

/**
 * Vapi inbound-VOICE webhook (Wave 8).
 *
 * The same mandated shape as the Twilio voice edges: maintenance 503 →
 * rate-limit → DARK GATE 503 before any work → read the RAW body → verify the
 * Vapi HMAC FAIL-CLOSED, BEFORE parsing → normalise → resolve the org from the
 * DIALED number (never the body identity) → record calls + append call_events
 * idempotently → delegate to the UNCHANGED processInboundEnquiry once per new
 * call. Vapi delivers status-update messages, so origination and status arrive
 * on this one door.
 *
 * DARK by default: flag off or no VAPI_WEBHOOK_SECRET ⇒ 503 and nothing runs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  const rl = enforce(request, "vapi_webhook", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  if (!isVoiceConfigured()) {
    return NextResponse.json(
      { ok: false, error: "not_enabled" },
      { status: 503, headers: { "retry-after": "300", "cache-control": "no-store" } },
    );
  }

  // Raw body FIRST — the HMAC is over the exact bytes.
  const rawBody = await request.text();

  const provider = getVoiceProvider();
  if (!provider || provider.id !== "vapi") {
    // Configured for a different provider — this door is not the active one.
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  }

  // FAIL-CLOSED HMAC verification BEFORE parsing.
  const authentic = await provider.verify({
    signature: request.headers.get("x-vapi-signature"),
    url: request.url,
    rawBody,
    params: {},
  });
  if (!authentic) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const call = provider.parse({ rawBody, params: {} });
  if (!call) {
    return NextResponse.json({ ok: false, error: "unparseable" }, { status: 400 });
  }

  const orgId = await resolveOrgForDialedNumber(call.to);
  if (!orgId) {
    return NextResponse.json({ ok: true, unrouted: true });
  }

  try {
    const { callId, created } = await recordInboundCall(orgId, call);
    const result = await appendCallEvent(orgId, callId, {
      type: call.status,
      providerEventId: call.providerEventId,
      payload: call.raw,
      occurredAt: call.occurredAt,
    });

    // Delegate to the ingestion core ONCE per call (on the row we created), so a
    // stream of status events for one call yields exactly one enquiry.
    if (created) {
      try {
        await processInboundEnquiry({
          org_id: orgId,
          channel: "phone",
          caller: call.from,
          dedup_key: call.providerCallId,
        });
      } catch (e) {
        Sentry.captureException(e, { tags: { route: "webhooks/vapi", stage: "enquiry" } });
        console.error("[vapi] enquiry delegation failed", e);
      }
    }

    return NextResponse.json({ ok: true, duplicate: result.duplicate, status: result.status });
  } catch (e) {
    Sentry.captureException(e, { tags: { route: "webhooks/vapi" } });
    console.error("[vapi] call persistence failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown_error" },
      { status: 500 },
    );
  }
}

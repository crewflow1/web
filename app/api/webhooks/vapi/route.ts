import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import {
  buildVapiAssistantConfig,
  buildVapiToolResults,
  extractVapiToolCalls,
  parseVapiConversation,
  readVapiMessageType,
} from "@/lib/telephony/providers/vapi";
import { maybeGenerateVoiceTurn } from "@/lib/telephony/ai-turn";
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
 * CONVERSATIONAL messages (`assistant-request`, `tool-calls`/`function-call`)
 * arrive on the SAME door and are handled AFTER the fail-closed HMAC verify and
 * BEFORE the lifecycle parse: an assistant-request is answered with the
 * receptionist's assistant/model/voice config (org-attributed by the dialed
 * number); a tool-call routes the caller's utterance through the SAME governed
 * spoken-turn seam (`maybeGenerateVoiceTurn`) as Twilio, degrading to a
 * deterministic acknowledgement when dark. No live provider call is ever made.
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

  // ── Conversational branches (post-verify, pre-lifecycle-parse) ──────────────
  // These are the spoken-turn loop for Vapi. Both are org-attributed by the
  // DIALED number and DARK-gated by the 503 above; neither touches tenant call
  // rows (that is the status lifecycle's job below).
  const messageType = readVapiMessageType(rawBody);

  if (messageType === "assistant-request") {
    // Serve the receptionist assistant/model/voice config for THIS org. Config
    // only — no generation, no live provider call. Unattributable ⇒ decline.
    const ctx = parseVapiConversation(rawBody);
    const orgId = ctx?.to ? await resolveOrgForDialedNumber(ctx.to) : null;
    if (!orgId) return NextResponse.json({ ok: true, unrouted: true });
    return NextResponse.json(buildVapiAssistantConfig());
  }

  if (messageType === "tool-calls" || messageType === "function-call") {
    // Route each tool call's utterance/query through the SAME governed seam as
    // Twilio. A null turn (dark / no tier / blocked / error) degrades to a fixed
    // acknowledgement — never an error, never a leak.
    const ctx = parseVapiConversation(rawBody);
    const toolCalls = extractVapiToolCalls(rawBody);
    const orgId = ctx?.to ? await resolveOrgForDialedNumber(ctx.to) : null;
    const ack = "Thank you. I've noted that and the team will follow up.";
    if (!orgId) {
      return NextResponse.json(
        buildVapiToolResults(toolCalls.map((t) => ({ toolCallId: t.id, result: ack }))),
      );
    }
    const results: Array<{ toolCallId: string | null; result: string }> = [];
    for (const t of toolCalls) {
      const query =
        (ctx?.transcript ?? "").trim() ||
        (typeof t.args.query === "string" ? t.args.query : "") ||
        (typeof t.args.message === "string" ? t.args.message : "");
      const turn = await maybeGenerateVoiceTurn({ orgId, transcript: query, context: t.name });
      results.push({ toolCallId: t.id, result: turn ?? ack });
    }
    return NextResponse.json(buildVapiToolResults(results));
  }

  // ── Lifecycle path (status-update / origination) ────────────────────────────
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

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import {
  buildOpenAiChatCompletion,
  buildOpenAiChatCompletionSse,
  parseVapiChatCompletion,
} from "@/lib/telephony/providers/vapi";
import { maybeGenerateVoiceTurn, type VoiceTurnHistoryEntry } from "@/lib/telephony/ai-turn";
import { loadRecentSpokenTurns, persistSpokenTurn, recordInboundCall } from "@/server/services/telephony";
import type { NormalizedInboundCall } from "@/lib/telephony/types";

/**
 * Vapi custom-llm `/chat/completions` endpoint (Wave 8, C30).
 *
 * Vapi's `custom-llm` model provider REQUIRES `model.url` — an OpenAI-compatible
 * streaming `/chat/completions` door it calls for every generated turn. This is
 * that door, and it is GOVERNED: the generated reply routes through the SAME
 * `maybeGenerateVoiceTurn` → `invokeWithGovernor` seam
 * (`receptionist.voice_turn` / `drafting`) as the Twilio gather + Vapi tool-call
 * paths — so activation is a config flip, not a governance bypass.
 *
 * It enforces the SAME guard chain, in the SAME order, as the sibling voice
 * doors: maintenance 503 → rate-limit → DARK GATE 503 before any work → read the
 * RAW body → FAIL-CLOSED HMAC verify (x-vapi-signature) BEFORE parsing → org by
 * DIALED number (never the body identity) → governed turn. When dark / blocked /
 * unrouted / null-turn it returns a DETERMINISTIC safe completion (a graceful
 * acknowledgement), NEVER ungoverned generation and NEVER a 500 that leaks.
 *
 * DARK by default: flag off or no VAPI_WEBHOOK_SECRET ⇒ 503 and nothing runs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The deterministic acknowledgement spoken when no governed turn is produced. */
const SAFE_ACK = "Thank you. I've noted that and the team will follow up.";

/** Return the reply as OpenAI SSE or JSON, per what Vapi asked for. Always 200. */
function completion(content: string, stream: boolean): NextResponse {
  if (stream) {
    return new NextResponse(buildOpenAiChatCompletionSse(content), {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }
  return NextResponse.json(buildOpenAiChatCompletion(content), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isMaintenanceMode()) {
    return NextResponse.json(
      { ok: false, maintenance: true, message: "Scheduled maintenance — retry shortly." },
      { status: 503, headers: { "retry-after": "120", "cache-control": "no-store" } },
    );
  }

  const rl = enforce(request, "vapi_chat_completions", DEFAULT_LIMITS.api);
  if (rl) return rl as unknown as NextResponse;

  // DARK GATE — before any work. Flag off or no provider ⇒ 503.
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
    return NextResponse.json({ ok: false, error: "not_enabled" }, { status: 503 });
  }

  // FAIL-CLOSED HMAC verification BEFORE parsing or any side effect. Reuses the
  // exact verifier the main Vapi door uses (VAPI_WEBHOOK_SECRET, constant-time).
  const authentic = await provider.verify({
    signature: request.headers.get("x-vapi-signature"),
    url: request.url,
    rawBody,
    params: {},
  });
  if (!authentic) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  // Parse the OpenAI-style body. Unparseable ⇒ a deterministic (non-streaming)
  // safe completion, never a 500 that leaks.
  const parsed = parseVapiChatCompletion(rawBody);
  if (!parsed) {
    return completion(SAFE_ACK, false);
  }
  const stream = parsed.stream;

  // Attribute the org from the DIALED number — never the caller-controlled body.
  const orgId = parsed.to ? await resolveOrgForDialedNumber(parsed.to) : null;
  if (!orgId) {
    // Unroutable ⇒ deterministic ack. No tenant work, no generation.
    return completion(SAFE_ACK, stream);
  }

  // Resolve THIS call's row (idempotent on the Vapi call id) and load its prior
  // turns as memory — the same substrate as the tool-call path. Best-effort: a DB
  // error degrades to the ack rather than dropping the call, and runs only AFTER
  // the dark + HMAC gates above.
  let callId: string | null = null;
  let priorTurns: VoiceTurnHistoryEntry[] = parsed.priorTurns;
  if (parsed.callId) {
    try {
      const normalized: NormalizedInboundCall = {
        provider: "vapi",
        providerCallId: parsed.callId,
        from: parsed.from,
        to: parsed.to,
        status: "in_progress",
        providerEventId: null,
        occurredAt: new Date().toISOString(),
        raw: {},
      };
      const rec = await recordInboundCall(orgId, normalized);
      callId = rec.callId;
      const loaded = await loadRecentSpokenTurns(orgId, callId);
      // Prefer the durable history when present; fall back to the body's messages.
      if (loaded.length > 0) priorTurns = loaded;
    } catch (e) {
      Sentry.captureException(e, { tags: { route: "webhooks/vapi/chat-completions", stage: "load" } });
      console.error("[vapi-chat-completions] call resolve / history load failed", e);
    }
  }

  const transcript = parsed.transcript.trim();

  // GOVERNED turn — the ONLY path to generated text. Dark / blocked / null ⇒ null,
  // which degrades to the deterministic ack below (never ungoverned generation).
  const turn = await maybeGenerateVoiceTurn({
    orgId,
    transcript,
    callId,
    ordinal: priorTurns.length,
    history: priorTurns,
  });

  // Persist the caller utterance + reply, correlated by the Vapi call id — even
  // when dark (reply null), so the enquiry still captures WHAT THE CALLER SAID.
  // Best-effort: a persistence failure must never break the call.
  if (callId && parsed.callId && (transcript || turn)) {
    try {
      await persistSpokenTurn({
        orgId,
        callId,
        providerCallId: parsed.callId,
        transcript,
        reply: turn,
        priorTurns,
      });
    } catch (e) {
      Sentry.captureException(e, { tags: { route: "webhooks/vapi/chat-completions", stage: "persist" } });
      console.error("[vapi-chat-completions] spoken-turn persistence failed", e);
    }
  }

  return completion(turn ?? SAFE_ACK, stream);
}

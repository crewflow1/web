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
  parseVapiEndOfCallReport,
  readVapiMessageType,
} from "@/lib/telephony/providers/vapi";
import { maybeGenerateVoiceTurn, type VoiceTurnHistoryEntry } from "@/lib/telephony/ai-turn";
import {
  buildReceptionistContext,
  buildReceptionistGreeting,
  loadReceptionistProfile,
  mapPreferredVoiceToVapiVoiceId,
} from "@/lib/telephony/receptionist-profile";
import {
  appendCallEvent,
  loadRecentSpokenTurns,
  persistSpokenTurn,
  recordInboundCall,
  updateCallAssociation,
  updateCallCompletion,
} from "@/server/services/telephony";
import {
  processInboundEnquiry,
  refreshVoiceExtractionFromTranscript,
} from "@/server/services/receptionist";
import type { NormalizedInboundCall } from "@/lib/telephony/types";

/**
 * Vapi inbound-VOICE webhook (Wave 8).
 *
 * The same mandated shape as the Twilio voice edges: maintenance 503 →
 * rate-limit → DARK GATE 503 before any work → read the RAW body → verify the
 * Vapi shared secret (X-Vapi-Secret) FAIL-CLOSED, BEFORE parsing → normalise →
 * resolve the org from the
 * DIALED number (never the body identity) → record calls + append call_events
 * idempotently → delegate to the UNCHANGED processInboundEnquiry once per new
 * call. Vapi delivers status-update messages, so origination and status arrive
 * on this one door.
 *
 * CONVERSATIONAL messages (`assistant-request`, `tool-calls`/`function-call`)
 * arrive on the SAME door and are handled AFTER the fail-closed verify and
 * BEFORE the lifecycle parse: an assistant-request is answered with the
 * receptionist's PER-ORG assistant/model/voice config (business name + greeting +
 * mapped voice, org-attributed by the dialed number); a tool-call routes the
 * caller's utterance through the SAME governed
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

  // FAIL-CLOSED verification BEFORE parsing. PRIMARY = the shared secret Vapi
  // sends (X-Vapi-Secret / Authorization: Bearer); x-vapi-signature is passed too
  // for the opt-in HMAC path (verifyVapiWebhook decides which applies).
  const authentic = await provider.verify({
    signature: request.headers.get("x-vapi-signature"),
    secret: request.headers.get("x-vapi-secret"),
    authorization: request.headers.get("authorization"),
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
    // Per-org identity: the org's business name → greeting/firstMessage, its
    // preferred_voice → voiceId, and its business identity as AI CONTEXT. A
    // missing setup row degrades to the generic anonymous config (safe default).
    const profile = await loadReceptionistProfile(orgId);
    return NextResponse.json(
      buildVapiAssistantConfig({
        firstMessage: buildReceptionistGreeting(profile),
        businessContext: buildReceptionistContext(profile),
        voiceId: mapPreferredVoiceToVapiVoiceId(profile?.preferredVoice),
      }),
    );
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

    // Per-org business identity for the governed turn (name/trade/hours), as
    // CONTEXT data. Missing setup ⇒ null ⇒ the generic behaviour (safe default).
    const profile = await loadReceptionistProfile(orgId);

    // Resolve THIS call's row (idempotent on the Vapi call id) and load its prior
    // spoken turns, so the governed seam has MEMORY of the conversation — the same
    // persistence substrate as Twilio. Best-effort: all persistence is wrapped so a
    // DB error degrades to the fixed ack rather than dropping the call, and it runs
    // AFTER the dark + HMAC gates above.
    let callId: string | null = null;
    let priorTurns: VoiceTurnHistoryEntry[] = [];
    if (ctx?.callId) {
      try {
        const normalized: NormalizedInboundCall = {
          provider: "vapi",
          providerCallId: ctx.callId,
          from: ctx.from,
          to: ctx.to,
          status: "in_progress",
          providerEventId: null,
          occurredAt: new Date().toISOString(),
          raw: {},
        };
        const rec = await recordInboundCall(orgId, normalized);
        callId = rec.callId;
        priorTurns = await loadRecentSpokenTurns(orgId, callId);
      } catch (e) {
        Sentry.captureException(e, { tags: { route: "webhooks/vapi", stage: "load" } });
        console.error("[vapi] call resolve / history load failed", e);
      }
    }

    const transcript = (ctx?.transcript ?? "").trim();
    const results: Array<{ toolCallId: string | null; result: string }> = [];
    let firstReply: string | null = null;
    for (const t of toolCalls) {
      const query =
        transcript ||
        (typeof t.args.query === "string" ? t.args.query : "") ||
        (typeof t.args.message === "string" ? t.args.message : "");
      const turn = await maybeGenerateVoiceTurn({
        orgId,
        transcript: query,
        // Per-call dedupe identity: the resolved call row + this turn's ordinal, so
        // two callers (or one caller repeating a short phrase) never collide on the
        // governor's transcript-hash duplicate refusal.
        callId,
        ordinal: priorTurns.length,
        context: t.name,
        business: profile,
        history: priorTurns,
      });
      if (firstReply === null && turn) firstReply = turn;
      results.push({ toolCallId: t.id, result: turn ?? ack });
    }

    // Persist the caller's utterance + the generated reply (transcript + call_events
    // audit), correlated by the Vapi call id — even when dark (reply null), so the
    // enquiry still captures WHAT THE CALLER SAID. Best-effort: never break the call.
    if (callId && ctx?.callId && (transcript || firstReply)) {
      try {
        await persistSpokenTurn({
          orgId,
          callId,
          providerCallId: ctx.callId,
          transcript,
          reply: firstReply,
        });
      } catch (e) {
        Sentry.captureException(e, { tags: { route: "webhooks/vapi", stage: "persist" } });
        console.error("[vapi] spoken-turn persistence failed", e);
      }
    }

    return NextResponse.json(buildVapiToolResults(results));
  }

  // ── Call-completion ENRICHMENT (end-of-call-report) ─────────────────────────
  // Vapi delivers the terminal report — recording, transcript (text + structured),
  // AI summary, duration and ended-at — on THIS same door. Same guard chain as
  // every branch above: the maintenance/rate-limit/DARK-503 and the FAIL-CLOSED
  // signature verify have already run; here we attribute the org from the DIALED
  // number (never the body identity) and enrich the calls row. The write is
  // org-pinned + matched on the Vapi call id and idempotent (a redelivered report
  // rewrites the same values). BEST-EFFORT: a persistence failure is logged loud
  // and degraded to 200 — never a 500 that would make Vapi retry-storm. The
  // transcript is stored purely as DATA (text/jsonb columns, never executed).
  if (messageType === "end-of-call-report") {
    const report = parseVapiEndOfCallReport(rawBody);
    if (!report) {
      return NextResponse.json({ ok: false, error: "unparseable" }, { status: 400 });
    }
    const orgId = report.to ? await resolveOrgForDialedNumber(report.to) : null;
    if (!orgId) return NextResponse.json({ ok: true, unrouted: true });
    try {
      // ── Terminal re-extraction (the empty-transcript fix) ────────────────────
      // The origination extraction ran at call START over an EMPTY transcript, so
      // the lead + enquiry carry the "no transcript captured" sentinel summary + null
      // triage. Now that the call has ended, re-run the SAME GOVERNED extraction over
      // the CAPTURED transcript (Vapi's own end-of-call transcript is the authoritative
      // record of what the caller said) and refresh the lead (ai_summary / urgency /
      // service / postcode) + enquiry (ai_summary / ai_confidence / job_type / urgency
      // / postcode / budget_gbp), org-pinned by (org_id, provider_message_id = the Vapi
      // call id). Empty transcript ⇒ a deliberate no-op (never overwrite the
      // origination summary with another empty extraction). No new / ungoverned model
      // call — extractFields goes through the SAME governor entry as origination.
      // Best-effort within the enclosing try (degrades to enriched:false, never 500).
      if (report.callId) {
        await refreshVoiceExtractionFromTranscript({
          orgId,
          providerCallId: report.callId,
          transcript: report.transcript ?? "",
        });
      }
      // Enrich the calls row. Vapi supplies its OWN structured transcript + analysis
      // summary on the terminal report; those remain the calls-row artifacts (the lead
      // + enquiry triage above is what the origination-empty defect actually broke).
      // The write is org-pinned, keyed on the Vapi call id and idempotent.
      await updateCallCompletion(orgId, report.callId!, {
        recordingUrl: report.recordingUrl,
        transcript: report.transcript,
        transcriptJson: report.transcriptJson,
        aiSummary: report.summary,
        durationSec: report.durationSec,
        endedAt: report.endedAt,
      });
      return NextResponse.json({ ok: true, enriched: true });
    } catch (e) {
      Sentry.captureException(e, { tags: { route: "webhooks/vapi", stage: "completion" } });
      console.error("[vapi] call-completion enrichment failed", e);
      return NextResponse.json({ ok: true, enriched: false });
    }
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
    const { callId } = await recordInboundCall(orgId, call);
    const result = await appendCallEvent(orgId, callId, {
      type: call.status,
      providerEventId: call.providerEventId,
      payload: call.raw,
      occurredAt: call.occurredAt,
    });

    // Delegate to the ingestion core UNCONDITIONALLY (same posture as the Twilio
    // origination edge). We do NOT gate on the calls-row `created` flag: a status
    // update — or the conversational tool-call branch above — can create the calls
    // row first, so a `created`-gated skip would DROP the enquiry entirely. Vapi is
    // at-least-once and unordered. Idempotency is owned downstream: the CallSid is
    // both the dedup_key and the provider_message_id, so processInboundEnquiry's
    // (org_id, provider_message_id) partial-unique dedup folds every redelivery
    // into the same enquiry. Best-effort: a failure must not break the response.
    {
      try {
        const { lead_id, conversation_id } = await processInboundEnquiry({
          org_id: orgId,
          channel: "phone",
          caller: call.from,
          dedup_key: call.providerCallId,
          // Correlate the enquiry to the call by CallSid, so the spoken-turn loop
          // can populate its raw_text (mirrors the Twilio origination edge).
          provider_message_id: call.providerCallId,
        });

        // LINK the calls row to the lead + conversation the enquiry resolved, so
        // the C41 duration/ended-at and C35c transcript/summary/recording
        // enrichment become reachable by the tenant-facing leads/[id] reader
        // (which filters `calls.lead_id = id`). Matched on the SAME
        // providerCallId recordInboundCall wrote above. Best-effort: a linkage
        // failure must NEVER break the webhook response.
        if (lead_id) {
          try {
            await updateCallAssociation(orgId, call.providerCallId, {
              leadId: lead_id,
              conversationId: conversation_id,
            });
          } catch (e) {
            Sentry.captureException(e, { tags: { route: "webhooks/vapi", stage: "link" } });
            console.error("[vapi] call-lead linkage failed", e);
          }
        }
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

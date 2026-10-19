import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { isMaintenanceMode } from "@/lib/maintenance";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";
import { getVoiceProvider, isVoiceConfigured } from "@/lib/telephony";
import { resolveOrgForDialedNumber } from "@/lib/telephony/router";
import {
  TERMINAL_CALL_EVENTS,
  UNANSWERED_TERMINAL_CALL_EVENTS,
  ANSWERED_CALL_STATUSES,
} from "@/lib/telephony/types";
import {
  appendCallEvent,
  composeCallTranscript,
  loadAllSpokenTurns,
  loadEnquirySummary,
  recordInboundCall,
  updateCallAssociation,
  updateCallCompletion,
} from "@/server/services/telephony";
import {
  processMissedCallTextback,
  refreshVoiceExtractionFromTranscript,
} from "@/server/services/receptionist";

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

    // ── MISSED-CALL TRIGGER (G-6) — the internal detector ──────────────────────
    // A call whose terminal status is UNANSWERED (no_answer / busy / failed)
    // was MISSED: nobody — human or the AI loop — spoke to the caller. This is
    // the one place the telephony layer can PROVE that, so this is where the
    // missed-call text-back engine is invoked, IN-PROCESS (never HTTP to our
    // own routes): processMissedCallTextback re-enters the same ingestion
    // idempotently on the CallSid (origination deferred its reply decision
    // here) and runs the ONE eligibility-gated reply wiring. Gates hold whole:
    // voice dark ⇒ this route 503'd above; missed-call flag dark ⇒ `flag_off`;
    // SMS provider dark ⇒ the dispatch records its honest refusal. DEDUPE: a
    // redelivered terminal callback is skipped here on the event-append
    // duplicate (provider_event_id is stable per status), and the per-(org,
    // CallSid) send claim inside the dispatch is the belt-and-braces — one
    // missed call can never text the caller twice. BEST-EFFORT: a trigger
    // failure is logged loud and degraded to a 200, never a 500 that would
    // retry-storm Twilio (the event append — the lifecycle write — succeeded).
    if (
      !result.duplicate &&
      (UNANSWERED_TERMINAL_CALL_EVENTS as readonly string[]).includes(call.status) &&
      // Never text a caller the AI (or a human) was already speaking to —
      // a mid-call failure is a dropped conversation, not a missed call.
      !(ANSWERED_CALL_STATUSES as readonly string[]).includes(result.priorStatus ?? "")
    ) {
      try {
        const missed = await processMissedCallTextback({
          org_id: orgId,
          provider_call_id: call.providerCallId,
          caller: call.from,
        });
        // LINK the calls row to the lead/conversation when the terminal arrived
        // FIRST (Twilio is unordered) and the ingestion above is what created
        // them — same reachability contract as the origination edge, matched on
        // the SAME providerCallId recordInboundCall wrote. Best-effort.
        if (missed.lead_id) {
          try {
            await updateCallAssociation(orgId, call.providerCallId, {
              leadId: missed.lead_id,
              conversationId: missed.conversation_id,
            });
          } catch (e) {
            Sentry.captureException(e, {
              tags: { route: "webhooks/twilio/voice/status", stage: "missed_call_link" },
            });
            console.error("[twilio-voice-status] missed-call linkage failed", e);
          }
        }
      } catch (e) {
        Sentry.captureException(e, {
          tags: { route: "webhooks/twilio/voice/status", stage: "missed_call" },
        });
        console.error("[twilio-voice-status] missed-call trigger failed", e);
      }
    }

    // ── Call-completion ENRICHMENT (terminal status callback) ─────────────────
    // Twilio delivers the call's total `CallDuration` on the TERMINAL status
    // callback (completed/busy/failed/no-answer/canceled). Mirroring the Vapi
    // end-of-call-report branch, we enrich the calls row exactly once, on the
    // terminal transition. Beyond duration_sec / ended_at (and recording_url when a
    // <Record> supplied one — legitimately null without it), Twilio NEVER sends a
    // transcript on this callback, so — unlike Vapi — the transcript would stay
    // blank on the tenant lead timeline even though the spoken-turn loop already
    // persisted every turn to call_events. We reconstruct it here: load this call's
    // COMPLETE persisted spoken turns (org-pinned, PAGED via loadAllSpokenTurns —
    // NOT the bounded recent-window used for prompt memory, which would drop the
    // END of any call past 20 turns) and fold them into calls.transcript via the
    // SAME composeCallTranscript helper the enquiry raw_text uses, keeping the
    // structured turns as transcript_json. ai_summary REUSES the GOVERNED summary
    // the receptionist extraction already wrote to the origination enquiry
    // (correlated by CallSid) — NO new / ungoverned model call is made here. The
    // write is org-pinned + keyed on the provider call id and inherently idempotent
    // (a redelivered completed callback rewrites the same values). BEST-EFFORT: a
    // persistence failure is logged loud and degraded to a 200 — never a 500 that
    // would make Twilio retry-storm the ack. Only the fields present are written
    // (empty transcript / absent summary pass `undefined`), so this never nulls
    // artifacts a prior report captured.
    if ((TERMINAL_CALL_EVENTS as readonly string[]).includes(call.status)) {
      try {
        const turns = await loadAllSpokenTurns(orgId, callId);
        const transcript = composeCallTranscript(turns);
        // The origination extraction ran at call START over an EMPTY transcript, so
        // the lead + enquiry carry the "no transcript captured" sentinel summary +
        // null triage. Now that the caller's words are available, re-run the SAME
        // GOVERNED extraction over the composed transcript and refresh the lead +
        // enquiry (no-op when the transcript is empty). loadEnquirySummary below then
        // folds the REFRESHED governed summary onto calls.ai_summary — no new /
        // ungoverned model call is made here.
        await refreshVoiceExtractionFromTranscript({
          orgId,
          providerCallId: call.providerCallId,
          transcript,
        });
        const aiSummary = await loadEnquirySummary(orgId, call.providerCallId);
        await updateCallCompletion(orgId, call.providerCallId, {
          durationSec: call.durationSec,
          endedAt: call.occurredAt,
          recordingUrl: params.RecordingUrl ?? undefined,
          transcript: transcript || undefined,
          transcriptJson: turns.length ? turns : undefined,
          aiSummary: aiSummary ?? undefined,
        });
      } catch (e) {
        Sentry.captureException(e, {
          tags: { route: "webhooks/twilio/voice/status", stage: "completion" },
        });
        console.error("[twilio-voice-status] call-completion enrichment failed", e);
      }
    }

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

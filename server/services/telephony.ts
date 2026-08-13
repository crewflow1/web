import "server-only";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  nextCallState,
  type CallStatus,
} from "@/lib/telephony/state-machine";
import type { CallEventType, NormalizedInboundCall } from "@/lib/telephony/types";
import { voiceInboundFeatureEnabled } from "@/lib/telephony/config";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";

/**
 * Voice Telephony (Wave 8) — the server-side persistence path.
 *
 * The ONLY writer of `calls` (origination) and `call_events` (append-only audit)
 * for inbound voice. Runs on the SERVICE-ROLE admin client (RLS-bypassing) — the
 * webhook has no signed-in user — so EVERY read and write pins `org_id`
 * explicitly (defence in depth: the admin client bypasses RLS, so the org filter
 * is the only tenant boundary left), and every Supabase `{ error }` is checked
 * loudly and reported to Sentry, mirroring whatsapp-webhook-handler.
 */

type AdminFrom = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  } & Promise<{ error: { message: string; code?: string } | null }>;
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  update: (row: unknown) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};

function table(name: string): AdminFrom {
  const admin = createAdminClient();
  return admin.from(name as never) as unknown as AdminFrom;
}

const isDup = (err: { message?: string; code?: string } | null): boolean =>
  err?.code === "23505" || (err?.message?.includes("duplicate") ?? false);

export type RecordInboundCallResult = {
  callId: string;
  /** False when this was a redelivery of a call we already have. */
  created: boolean;
};

/**
 * Record (or resolve) the `calls` row for an inbound call. Idempotent on
 * (provider, provider_call_id): a redelivered origination resolves to the same
 * row rather than creating a second. Pins org_id on both the insert and the
 * dedup lookup. Throws loudly on an unexpected DB error.
 */
export async function recordInboundCall(
  orgId: string,
  call: NormalizedInboundCall,
): Promise<RecordInboundCallResult> {
  const ins = await table("calls")
    .insert({
      org_id: orgId,
      direction: "inbound",
      status: call.status,
      provider: call.provider,
      provider_call_id: call.providerCallId,
      caller_number: call.from,
      receiver_number: call.to,
      started_at: call.occurredAt,
    })
    .select("id")
    .single();

  if (!ins.error && ins.data?.id) return { callId: ins.data.id, created: true };

  if (!isDup(ins.error)) {
    const message = ins.error?.message ?? "unknown insert error";
    Sentry.captureException(new Error(`recordInboundCall insert failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] recordInboundCall insert failed", {
      org_id: orgId,
      provider_call_id: call.providerCallId,
      message,
    });
    throw new Error(`recordInboundCall failed: ${message}`);
  }

  // Redelivery — resolve the existing row, org-pinned.
  const existing = await table("calls")
    .select("id")
    .eq("provider_call_id", call.providerCallId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (existing.error) {
    const message = existing.error.message;
    Sentry.captureException(new Error(`recordInboundCall lookup failed: ${message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`recordInboundCall lookup failed: ${message}`);
  }
  const id = existing.data?.id as string | undefined;
  if (!id) {
    // The unique collision was on a row belonging to ANOTHER org — never
    // attribute it here. Loud, and refuse rather than guess.
    console.error("[telephony] recordInboundCall: provider_call_id exists under a different org", {
      org_id: orgId,
      provider_call_id: call.providerCallId,
    });
    throw new Error("recordInboundCall: provider_call_id belongs to a different org");
  }
  return { callId: id, created: false };
}

export type AppendCallEventResult = {
  /** False when this exact (call, provider_event) was already recorded. */
  appended: boolean;
  duplicate: boolean;
  /** The call's status after applying the reducer (unchanged on a duplicate). */
  status: CallStatus | null;
};

/**
 * Append one call event (append-only) and advance `calls.status` via the pure
 * reducer. Idempotent on (call_id, provider_event_id): a redelivered event is a
 * benign no-op. Pins org_id on every statement.
 */
export async function appendCallEvent(
  orgId: string,
  callId: string,
  event: { type: CallEventType; providerEventId: string | null; payload: unknown; occurredAt: string },
): Promise<AppendCallEventResult> {
  const ins = await table("call_events").insert({
    call_id: callId,
    org_id: orgId,
    event_type: event.type,
    provider_event_id: event.providerEventId,
    payload: event.payload,
    occurred_at: event.occurredAt,
  });

  if (ins.error) {
    if (isDup(ins.error)) {
      return { appended: false, duplicate: true, status: null };
    }
    const message = ins.error.message;
    Sentry.captureException(new Error(`appendCallEvent insert failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] appendCallEvent insert failed", {
      org_id: orgId,
      call_id: callId,
      event_type: event.type,
      message,
    });
    throw new Error(`appendCallEvent failed: ${message}`);
  }

  // Advance calls.status through the pure reducer (terminal states are absorbing).
  const current = await table("calls")
    .select("status")
    .eq("id", callId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (current.error) {
    Sentry.captureException(new Error(`appendCallEvent status read failed: ${current.error.message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`appendCallEvent status read failed: ${current.error.message}`);
  }
  const currentStatus = (current.data?.status as CallStatus | undefined) ?? event.type;
  const nextStatus = nextCallState(currentStatus, event.type);
  if (nextStatus !== currentStatus) {
    const upd = await table("calls")
      .update({ status: nextStatus })
      .eq("id", callId)
      .eq("org_id", orgId);
    if (upd.error) {
      Sentry.captureException(new Error(`appendCallEvent status update failed: ${upd.error.message}`), {
        tags: { service: "telephony" },
      });
      throw new Error(`appendCallEvent status update failed: ${upd.error.message}`);
    }
  }
  return { appended: true, duplicate: false, status: nextStatus };
}

// =====================================================================
// SPOKEN-TURN PERSISTENCE — the conversational loop's durable memory.
//
// The C28 spoken-turn loop was hollow: it generated a reply per <Gather> callback
// and DISCARDED both the caller's transcript and the AI's reply, so every turn was
// amnesiac and the origination enquiry stayed body-less (a human saw "someone
// called from +44…" and nothing they said). These helpers close that hole using
// the EXISTING substrate — no new migration:
//   • each spoken turn is appended to the append-only `call_events` audit (the same
//     writer the lifecycle uses), carrying the caller's SpeechResult + the reply;
//   • the origination enquiry's `raw_text` is populated with the running transcript,
//     mirroring how SMS/WhatsApp populate `raw_text`, correlated by CallSid.
// `call_events.event_type` has no dedicated "turn" value (its CHECK is the call
// lifecycle vocabulary), so a turn is recorded under `in_progress` — the honest
// state for mid-call speech — and the payload marker below distinguishes a spoken
// turn from a plain status transition on read.
// =====================================================================

/** The lifecycle event a mid-call spoken turn is recorded under (see note above). */
const SPOKEN_TURN_EVENT_TYPE: CallEventType = "in_progress";
/** Payload discriminator: how a history read tells a spoken turn from a status event. */
const SPOKEN_TURN_KIND = "spoken_turn";

/** One caller utterance + the receptionist's reply, as persisted on a call. */
export type SpokenTurn = { transcript: string; reply: string | null };

/**
 * Render a list of spoken turns into the human-readable transcript stored on the
 * enquiry's `raw_text`. Caller and receptionist lines interleave in order; empty
 * lines are dropped. Pure.
 */
export function composeCallTranscript(turns: SpokenTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const said = (t.transcript ?? "").trim();
    const reply = (t.reply ?? "").trim();
    if (said) lines.push(`Caller: ${said}`);
    if (reply) lines.push(`Receptionist: ${reply}`);
  }
  return lines.join("\n");
}

// The minimal ordered-read shape for loading a call's prior spoken turns. Cast past
// the generated types (call_events is RLS:member-read and written service-role-only).
type SpokenTurnReadFilter = {
  eq: (k: string, v: unknown) => SpokenTurnReadFilter;
  order: (
    col: string,
    opts: { ascending: boolean },
  ) => {
    limit: (
      n: number,
    ) => Promise<{ data: Array<{ payload: unknown }> | null; error: { message: string } | null }>;
  };
};

// The minimal PAGED-read shape for the COMPLETE-transcript loader below. Chains
// `.eq × n → .order × n → .range(from,to)`, the fetchAllRows contract, cast past
// the generated types like the bounded reader above.
type SpokenTurnPagedFilter = {
  eq: (k: string, v: unknown) => SpokenTurnPagedFilter;
  order: (col: string, opts: { ascending: boolean }) => SpokenTurnPagedFilter;
  range: (
    from: number,
    to: number,
  ) => Promise<{ data: Array<{ payload: unknown }> | null; error: unknown }>;
};

/**
 * Parse the raw `call_events` payload rows into ordered {@link SpokenTurn}s,
 * dropping any lifecycle `in_progress` status event that lacks the spoken-turn
 * marker. Pure — shared by the bounded ({@link loadRecentSpokenTurns}) and the
 * complete ({@link loadAllSpokenTurns}) readers so both interpret the payload
 * identically.
 */
function parseSpokenTurnRows(rows: Array<{ payload: unknown }>): SpokenTurn[] {
  const turns: SpokenTurn[] = [];
  for (const row of rows) {
    const p = row.payload as { kind?: unknown; speech_result?: unknown; reply?: unknown } | null;
    if (!p || p.kind !== SPOKEN_TURN_KIND) continue;
    turns.push({
      transcript: typeof p.speech_result === "string" ? p.speech_result : "",
      reply: typeof p.reply === "string" ? p.reply : null,
    });
  }
  return turns;
}

/**
 * Load the RECENT prior spoken turns for a call, oldest-first, BOUNDED to the
 * latest `limit` (default 20) — the per-turn PROMPT MEMORY the governed turn seam
 * folds in so a turn can reason over the recent conversation, not just the latest
 * utterance. This bounded window is correct for the conversational loop (the
 * gather / vapi callbacks); it is DELIBERATELY NOT the full-transcript source —
 * for the complete call (persisted transcript + governed lead re-extraction) use
 * {@link loadAllSpokenTurns}, which pages every turn. Org-pinned (defence in depth
 * over the admin client). Filters to the spoken-turn payload marker, so lifecycle
 * `in_progress` status events are never mistaken for turns. Fails loud on a read
 * error (the caller decides whether to degrade); a missing/empty call yields no
 * turns.
 */
export async function loadRecentSpokenTurns(
  orgId: string,
  callId: string,
  limit = 20,
): Promise<SpokenTurn[]> {
  const admin = createAdminClient();
  const query = (admin.from("call_events" as never) as unknown as {
    select: (cols: string) => SpokenTurnReadFilter;
  }).select("payload");
  const { data, error } = await query
    .eq("org_id", orgId)
    .eq("call_id", callId)
    .eq("event_type", SPOKEN_TURN_EVENT_TYPE)
    .order("occurred_at", { ascending: true })
    .limit(Math.min(limit, 1000)); // F-1: provable cap; PostgREST clamps to 1000
  if (error) {
    Sentry.captureException(new Error(`loadRecentSpokenTurns failed: ${error.message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`loadRecentSpokenTurns failed: ${error.message}`);
  }
  return parseSpokenTurnRows(data ?? []);
}

/**
 * Load the COMPLETE set of spoken turns for a call, oldest-first — the
 * AUTHORITATIVE full-transcript source. Unlike {@link loadRecentSpokenTurns} (a
 * bounded recent-window for prompt memory), this PAGES every spoken turn via
 * `fetchAllRows`, so a call with >20 caller turns keeps its END — the callback
 * number, address and job specifics spoken late — instead of silently dropping
 * turns 21..n. This is what the Twilio terminal-status route composes into
 * `calls.transcript` and feeds to the GOVERNED lead re-extraction, and what the
 * per-turn raw_text fold uses, so neither ever truncates a long call.
 *
 * Org-pinned (defence in depth over the RLS-bypassing admin client). Ordered
 * `(occurred_at asc, id asc)` — a STABLE, UNIQUE total order (the `id` tiebreaker
 * is required by the fetchAllRows contract so no page can drop or repeat a turn
 * that shares an `occurred_at` at a page boundary). Filters to the spoken-turn
 * payload marker. Fails LOUD on a read error (throws) so a partial / empty read
 * can NEVER silently produce an empty transcript that then wipes a good governed
 * lead summary — the callers wrap this best-effort and skip the overwrite.
 */
export async function loadAllSpokenTurns(orgId: string, callId: string): Promise<SpokenTurn[]> {
  const admin = createAdminClient();
  const { data, error } = await fetchAllRows<{ payload: unknown }>(
    (from, to) =>
      (admin.from("call_events" as never) as unknown as {
        select: (cols: string) => SpokenTurnPagedFilter;
      })
        .select("payload")
        .eq("org_id", orgId)
        .eq("call_id", callId)
        .eq("event_type", SPOKEN_TURN_EVENT_TYPE)
        .order("occurred_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<PageResult<{ payload: unknown }>>,
  );
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    Sentry.captureException(new Error(`loadAllSpokenTurns failed: ${message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`loadAllSpokenTurns failed: ${message}`);
  }
  return parseSpokenTurnRows(data);
}

/**
 * Update the origination enquiry's `raw_text` with the running call transcript, so
 * the `inbound_enquiries` row has real content like an SMS/WhatsApp message instead
 * of an empty body. Correlated by (org_id, provider_message_id = CallSid) — the key
 * the origination enquiry was created under. Org-pinned; fails loud. An empty
 * transcript is a no-op; a CallSid with no matching enquiry updates zero rows (a
 * benign no-op, not an error).
 */
async function updateEnquiryTranscript(
  orgId: string,
  providerCallId: string,
  transcript: string,
): Promise<void> {
  if (!transcript.trim()) return;
  const admin = createAdminClient();
  const { error } = await (admin.from("inbound_enquiries" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  })
    .update({ raw_text: transcript })
    .eq("org_id", orgId)
    .eq("provider_message_id", providerCallId);
  if (error) {
    Sentry.captureException(new Error(`updateEnquiryTranscript failed: ${error.message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`updateEnquiryTranscript failed: ${error.message}`);
  }
}

/**
 * Persist ONE spoken turn: append it to the append-only `call_events` audit
 * (caller SpeechResult + generated reply) AND fold the WHOLE call into the
 * enquiry's `raw_text`. This is the single write door the webhook loops call after
 * generating a turn. Org-pinned throughout. THROWS on a write failure — the caller
 * wraps it best-effort so a persistence error degrades the call gracefully (log +
 * continue) rather than dropping it.
 *
 * ORDER MATTERS: the turn is appended to the audit FIRST (so the append-only
 * record is always captured even if the fold below fails), and the raw_text is
 * then composed from the COMPLETE persisted turn set via {@link loadAllSpokenTurns}
 * — NOT from a bounded recent-window handed in by the caller. The conversational
 * loops load only a recent-N window for prompt memory; folding raw_text from that
 * window dropped the END of any call past 20 turns (the callback number / address
 * spoken late). Re-reading the full set here keeps raw_text complete. If that read
 * fails it THROWS before the fold, so a partial read never overwrites `raw_text`.
 */
export async function persistSpokenTurn(args: {
  orgId: string;
  callId: string;
  providerCallId: string;
  transcript: string;
  reply: string | null;
}): Promise<void> {
  await appendCallEvent(args.orgId, args.callId, {
    type: SPOKEN_TURN_EVENT_TYPE,
    // No provider-supplied per-event id for a turn; NULLs are distinct under the
    // (call_id, provider_event_id) unique, so successive turns coexist.
    providerEventId: null,
    payload: {
      kind: SPOKEN_TURN_KIND,
      speech_result: args.transcript,
      reply: args.reply,
    },
    occurredAt: new Date().toISOString(),
  });
  // Fold the COMPLETE conversation (this turn is now persisted, so the full set
  // already includes it) into raw_text — never a bounded window.
  const allTurns = await loadAllSpokenTurns(args.orgId, args.callId);
  await updateEnquiryTranscript(
    args.orgId,
    args.providerCallId,
    composeCallTranscript(allTurns),
  );
}

// =====================================================================
// CALL-COMPLETION ENRICHMENT — populate a finished call's recording, transcript,
// AI summary, duration and ended-at from the provider's terminal report.
//
// The C35c gap: the conversational + lifecycle paths above record WHO called and
// (via spoken turns) WHAT they said mid-call, but the `calls` row's durable
// artifacts — recording_url / transcript / transcript_json / ai_summary /
// duration_sec / ended_at — were NEVER written, because Vapi's
// `end-of-call-report` event was unhandled. So on activation a completed call was
// never enriched. This is the single write door for that report. No migration:
// every column already exists on the baseline `calls` table.
// =====================================================================

/** The enrichment fields carried by a provider's call-completion report. */
export type CallCompletionFields = {
  recordingUrl?: string | null;
  transcript?: string | null;
  transcriptJson?: unknown | null;
  aiSummary?: string | null;
  durationSec?: number | null;
  endedAt?: string | null;
};

/**
 * Enrich the `calls` row for a COMPLETED call with its recording, transcript
 * (text + structured), AI summary, duration and ended-at. Matched on the provider
 * call id and ORG-PINNED (defence in depth over the RLS-bypassing admin client —
 * the org filter is the only tenant boundary left). Only the fields actually
 * present in the report are written, so a partial report never wipes data already
 * captured, and a REDELIVERED report simply rewrites the same values — the UPDATE
 * is inherently idempotent (no insert ⇒ no duplicate, no corruption). A call id
 * that matches no row updates zero rows (a benign no-op, not an error). The
 * transcript is stored purely as DATA — text/jsonb columns, never executed.
 *
 * THROWS LOUD on an unexpected DB error (Sentry + console.error), like its
 * sibling writers; the webhook wraps this best-effort so a persistence failure
 * degrades to a 200 rather than a 500 that would make the provider retry-storm.
 */
export async function updateCallCompletion(
  orgId: string,
  providerCallId: string,
  fields: CallCompletionFields,
): Promise<void> {
  // Build the patch from ONLY the fields present (non-undefined), so an absent
  // report field is left untouched rather than nulled.
  const row: Record<string, unknown> = {};
  if (fields.recordingUrl !== undefined) row.recording_url = fields.recordingUrl;
  if (fields.transcript !== undefined) row.transcript = fields.transcript;
  if (fields.transcriptJson !== undefined) row.transcript_json = fields.transcriptJson;
  if (fields.aiSummary !== undefined) row.ai_summary = fields.aiSummary;
  if (fields.durationSec !== undefined) row.duration_sec = fields.durationSec;
  if (fields.endedAt !== undefined) row.ended_at = fields.endedAt;

  // Nothing to write ⇒ no-op (never issue an empty UPDATE).
  if (Object.keys(row).length === 0) return;

  const upd = await table("calls")
    .update(row)
    .eq("provider_call_id", providerCallId)
    .eq("org_id", orgId);
  if (upd.error) {
    const message = upd.error.message;
    Sentry.captureException(new Error(`updateCallCompletion update failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] updateCallCompletion update failed", {
      org_id: orgId,
      provider_call_id: providerCallId,
      message,
    });
    throw new Error(`updateCallCompletion failed: ${message}`);
  }
}

// =====================================================================
// CALL ↔ LEAD LINKAGE — bind an inbound call's row to the lead + conversation
// its origination enquiry resolved to.
//
// The C42 gap: `recordInboundCall` writes the `calls` row with NULL
// `lead_id`/`conversation_id`, and `processInboundEnquiry` (which creates the
// lead) RETURNED the ids but no caller wrote them back — so the columns stayed
// NULL forever. That made BOTH the C41 duration_sec/ended_at AND the C35c
// transcript/ai_summary/recording_url enrichment write to a row NO tenant UI can
// read: the tenant-facing `leads/[id]` Calls section filters `calls.lead_id = id`,
// so with the link never written it is always empty. This is the single write
// door that closes the loop. No migration: `calls.lead_id`/`conversation_id` (and
// the lead FK) exist on the baseline table.
// =====================================================================

/** The association fields carried back from the origination enquiry. */
export type CallAssociationFields = {
  leadId?: string | null;
  conversationId?: string | null;
};

/**
 * Link the `calls` row for an inbound call to the lead + conversation its
 * origination enquiry resolved. Matched on the provider call id and ORG-PINNED
 * (defence in depth over the RLS-bypassing admin client — the org filter is the
 * only tenant boundary left). Only columns with a REAL value are written, so a
 * missing conversation never nulls an existing link and re-linkage is monotonic;
 * a redelivered origination simply rewrites the same ids — the UPDATE is
 * inherently idempotent (no insert ⇒ no duplicate). A call id that matches no row
 * updates zero rows (a benign no-op, not an error).
 *
 * THROWS LOUD on an unexpected DB error (Sentry + console.error), like its
 * sibling writers ({@link updateCallCompletion}); the webhook wraps this
 * best-effort so a linkage failure degrades gracefully rather than breaking the
 * webhook ack.
 */
export async function updateCallAssociation(
  orgId: string,
  providerCallId: string,
  fields: CallAssociationFields,
): Promise<void> {
  // Build the patch from ONLY the fields with a real value, so an absent
  // conversation id (or a bare re-link) never nulls a link already captured.
  const row: Record<string, unknown> = {};
  if (fields.leadId != null) row.lead_id = fields.leadId;
  if (fields.conversationId != null) row.conversation_id = fields.conversationId;

  // Nothing to write ⇒ no-op (never issue an empty UPDATE).
  if (Object.keys(row).length === 0) return;

  const upd = await table("calls")
    .update(row)
    .eq("provider_call_id", providerCallId)
    .eq("org_id", orgId);
  if (upd.error) {
    const message = upd.error.message;
    Sentry.captureException(new Error(`updateCallAssociation update failed: ${message}`), {
      tags: { service: "telephony" },
    });
    console.error("[telephony] updateCallAssociation update failed", {
      org_id: orgId,
      provider_call_id: providerCallId,
      message,
    });
    throw new Error(`updateCallAssociation failed: ${message}`);
  }
}

/**
 * Load the GOVERNED `ai_summary` the receptionist extraction already wrote to the
 * origination enquiry for a call, correlated by (org_id, provider_message_id =
 * CallSid) — the key the enquiry was created under. Returns a trimmed non-empty
 * summary, or null when none exists yet (a benign no-op, not an error). This lets
 * the completion-enrichment path fold an EXISTING governed summary onto the calls
 * row WITHOUT ever making a new / ungoverned model call — the summary was produced
 * once, through the governor, by processInboundEnquiry. Org-pinned (defence in
 * depth over the RLS-bypassing admin client). THROWS LOUD on an unexpected DB
 * error, like its sibling readers; the webhook wraps this best-effort.
 */
export async function loadEnquirySummary(
  orgId: string,
  providerCallId: string,
): Promise<string | null> {
  const res = await table("inbound_enquiries")
    .select("ai_summary")
    .eq("org_id", orgId)
    .eq("provider_message_id", providerCallId)
    .maybeSingle();
  if (res.error) {
    Sentry.captureException(new Error(`loadEnquirySummary failed: ${res.error.message}`), {
      tags: { service: "telephony" },
    });
    throw new Error(`loadEnquirySummary failed: ${res.error.message}`);
  }
  const summary = res.data?.ai_summary;
  return typeof summary === "string" && summary.trim() ? summary : null;
}

/** Feature flag: inbound voice is DARK unless explicitly enabled. */
export function isVoiceInboundLive(): boolean {
  return voiceInboundFeatureEnabled();
}

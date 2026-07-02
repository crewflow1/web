import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { isAiConfigured } from "@/lib/ai/safety";
import {
  evaluateReply,
  isAutoSendable,
  type GuardrailCategory,
  type GuardrailResult,
  type GuardrailVerdict,
} from "@/lib/receptionist/policy";
import { composeReceptionistReply } from "@/lib/receptionist/reply";
import { RECEPTIONIST_EMPLOYEE_SLUG } from "@/lib/receptionist/types";
import { getSmsProvider, smsCostUsd } from "@/lib/comms";
import { toE164 } from "@/lib/phone";
import type { NotificationCreate } from "@/lib/notifications/types";
import type {
  InboundChannel,
  InboundEnquiryInput,
  InboundExtraction,
  InboundUrgency,
} from "@/lib/receptionist/types";

// =====================================================================
// THE CANONICAL RECEPTIONIST REPLY GATE (CEO Directive #018, R3).
// =====================================================================

/**
 * The verdict of the single reply-safety enforcement chokepoint: whether an
 * AI-drafted customer reply may proceed, and why.
 */
export type ReceptionistReplyDecision = {
  /**
   * DENY BY DEFAULT. `true` ONLY when the guardrail returns `allow` (the §9 A1
   * bounded-acknowledgement exception). A `review`, a `block`, an empty draft —
   * anything that is not a clean `allow` — is `false`: it may NOT auto-proceed.
   */
  allowed: boolean;
  /** The harvested guardrail's verdict — `allow` | `review` | `block`. */
  verdict: GuardrailVerdict;
  /** The concern classes the guardrail detected, in canonical order. */
  categories: GuardrailCategory[];
  /** The human-readable justification for the verdict. */
  reason: string;
  /** The auto-sendable remainder when the policy offers one, else `null`. */
  safeText: string | null;
  /** The full guardrail result, carried through intact for audit / inspection. */
  result: GuardrailResult;
};

/**
 * Enforce the canonical receptionist policy over one AI-drafted customer reply —
 * the SINGLE, load-bearing chokepoint through which every AI-generated
 * customer-facing reply (Voice, SMS, WhatsApp, Email, Customer Portal, and any
 * future channel) must pass before it can proceed to a send.
 *
 * It DELEGATES the verdict to the harvested guardrail
 * ({@link import("@/lib/receptionist/policy").evaluateReply}) — it neither
 * re-implements nor weakens a single rule — and applies the enforcement
 * decision: deny by default. Only a policy `allow` clears (`allowed === true`);
 * a commitment held for a human (`review`), a refused prohibition (`block`), or
 * an empty draft does not.
 *
 * This seam is the SOLE server-side caller of the policy, a fact pinned as a
 * matter of SOURCE by `__tests__/security/receptionist-enforcement-invariants`:
 * there is exactly one enforcement path and no module may bypass it. It DECIDES;
 * it does not transmit, persist, or produce a reply — the reply producer, the
 * `ai_reply_audits` ledger, and the outbound send seams are deferred to later
 * increments, and are structurally forced through this gate when they land.
 */
export function enforceReceptionistReply(draft: string): ReceptionistReplyDecision {
  const result = evaluateReply(draft);
  return {
    allowed: isAutoSendable(result),
    verdict: result.verdict,
    categories: result.categories,
    reason: result.reason,
    safeText: result.safeText,
    result,
  };
}

// =====================================================================
// THE CANONICAL REPLY PRODUCTION & AUDIT PIPELINE (CEO Directive #018, R4).
// =====================================================================

/**
 * The anchors that thread one attempted reply to the organisation, conversation
 * and customer it concerns — captured on every audit record so a reply is
 * traceable end to end.
 */
export type ReplyAuditContext = {
  /** The organisation the reply is drafted on behalf of. */
  org_id: string;
  /** The inbound channel the reply answers. */
  channel: InboundChannel;
  /** The conversation — the originating `inbound_enquiries.id`, if known. */
  enquiry_id?: string | null;
  /** The customer — the `leads.id`, if a lead exists. */
  lead_id?: string | null;
  /** The caller identifier (phone / handle / email), if known. */
  customer_ref?: string | null;
  /** The end-to-end trace id; a fresh one is minted when omitted. */
  correlation_id?: string | null;
  /** Free-form execution metadata (producer path, dedup key, …). */
  metadata?: Record<string, unknown>;
};

/** The outcome of one Draft → Enforce → Audit pass. */
export type ReceptionistReplyOutcome = {
  /** The id of the MANDATORY, append-only audit record this attempt produced. */
  audit_id: string;
  /** The trace this attempt was recorded under. */
  correlation_id: string;
  /** The draft that was enforced and audited, verbatim. */
  draft: string;
  /** The enforcement decision, from the R3 seam. */
  decision: ReceptionistReplyDecision;
};

// `record_ai_reply_audit` is a service-role-only SECURITY DEFINER primitive and is
// not in the generated Database types — cast past the typed client (the same
// `as unknown as` convention as the HQ Event Spine's `emitEvent`).
type RecordReplyAuditRpc = (
  fn: "record_ai_reply_audit",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Enforce the canonical policy over one AI-drafted reply AND record the MANDATORY,
 * append-only audit of the attempt — the SINGLE chokepoint through which every
 * attempted reply passes on its way out of the pipeline.
 *
 *   1. ENFORCE — the verdict is taken by the R3 seam {@link enforceReceptionistReply}
 *      (which delegates to the harvested guardrail): deny by default.
 *   2. AUDIT — the attempt is written to `ai_reply_audits` through the
 *      service-role-only `record_ai_reply_audit` primitive, capturing the
 *      organisation, conversation, customer, AI employee, the draft, the full
 *      enforcement decision (verdict / allowed / categories / reason / safe text),
 *      the correlation id and execution metadata.
 *
 * The audit is MANDATORY. Unlike the best-effort event spine (which never throws)
 * and the error-swallowing admin activity log, a failed audit write THROWS here —
 * so a reply whose attempt could not be recorded does NOT proceed. There is no
 * configuration, and no branch, by which a reply leaves this function without a
 * durable audit record.
 */
export async function enforceAndAuditReply(
  input: ReplyAuditContext & { draft: string },
): Promise<ReceptionistReplyOutcome> {
  const decision = enforceReceptionistReply(input.draft);
  const correlationId = input.correlation_id ?? crypto.randomUUID();

  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as RecordReplyAuditRpc;
  const { data: auditId, error } = await rpc("record_ai_reply_audit", {
    p_org_id: input.org_id,
    p_employee_slug: RECEPTIONIST_EMPLOYEE_SLUG,
    p_channel: input.channel,
    p_correlation_id: correlationId,
    p_draft: input.draft,
    p_verdict: decision.verdict,
    p_allowed: decision.allowed,
    p_reason: decision.reason,
    p_categories: decision.categories,
    p_safe_text: decision.safeText,
    p_enquiry_id: input.enquiry_id ?? null,
    p_lead_id: input.lead_id ?? null,
    p_customer_ref: input.customer_ref ?? null,
    p_metadata: input.metadata ?? {},
  });

  // MANDATORY, not best-effort, not configurable: a reply whose attempt cannot be
  // recorded must NOT proceed. Fail loudly — never swallow, never continue unaudited.
  if (error || !auditId) {
    throw new Error(
      "ai_reply_audits write failed — a receptionist reply may not proceed unaudited: " +
        (error?.message ?? "no audit id returned"),
    );
  }

  return {
    audit_id: auditId,
    correlation_id: correlationId,
    draft: input.draft,
    decision,
  };
}

/**
 * The full canonical pipeline: Draft → Enforce → Audit. Composes the deterministic
 * acknowledgement ({@link composeReceptionistReply}) for the enquiry's channel and
 * hands it to {@link enforceAndAuditReply}, so the produced draft is enforced by the
 * R3 seam and its attempt is audited — with no path that produces a reply without
 * both. This is INTERNAL only: the outcome is a decision plus its audit record,
 * never a customer send (transport is a later increment, deliberately absent here).
 */
export async function produceAndEnforceReply(
  input: ReplyAuditContext,
): Promise<ReceptionistReplyOutcome> {
  const draft = composeReceptionistReply({ channel: input.channel });
  return enforceAndAuditReply({
    ...input,
    draft,
    metadata: { ...(input.metadata ?? {}), producer: "deterministic_acknowledgement" },
  });
}

// =====================================================================
// THE FIRST OUTBOUND TRANSPORT (CEO Directive #018, R5).
//
// R4 closed the INTERNAL loop — Draft → Enforce → Audit. R5 carries an enforced,
// audited, AUTO-SENDABLE reply out through exactly ONE transport: SMS (missed-call
// text-back), over the reused lib/comms provider seam. The law the directive sets is
// absolute and is enforced here AND in the database (ai_reply_transports_guard):
//
//   "There must be no execution path capable of reaching a transport adapter without
//    first passing through both the canonical enforcement seam and the mandatory
//    audit ledger."
//
// So the ONLY way to a provider is `dispatchReply` → `enforceAndAuditReply` (the R4
// mandatory chokepoint) → the `decision.allowed` gate → `transportReply`. A reply
// that is not a clean `allow` is audited and STOPS; it never reaches a provider. And
// every transport OUTCOME — a clean send, an undialable destination, an absent
// provider, a provider that threw — is itself recorded in the append-only
// `ai_reply_transports` ledger through the mandatory, throw-on-failure
// `record_ai_reply_transport` primitive. Failed attempts are as fully recorded as
// successful ones.
// =====================================================================

/** The outbound transport channel R5 ships. The DB CHECK pins the same single value. */
const RECEPTIONIST_TRANSPORT_CHANNEL = "sms" as const;

/** The outcome of the outbound TRANSPORT stage for one reply. */
export type TransportResult = {
  /** Whether an attempt actually reached the transport stage (false when the reply was held/refused, or a duplicate short-circuited). */
  attempted: boolean;
  /** True when a prior SENT transport for the same dedup key short-circuited this send (no new audit, no new send). */
  duplicate: boolean;
  /** The append-only `ai_reply_transports` record id, when one was written (or the pre-existing SENT row on a duplicate). */
  transport_id: string | null;
  /** `sent` — a provider accepted it; `failed` — an attempt was made and recorded failed; `skipped` — no attempt (not auto-sendable / duplicate). */
  status: "sent" | "failed" | "skipped";
  /** The provider's message id on a clean send, else null. */
  provider_message_id: string | null;
  /** Why a failed/skipped transport ended where it did (no_provider / invalid_destination / provider_error / not_auto_sendable / duplicate), else null. */
  failure_reason: string | null;
};

/** The outcome of the full canonical dispatch: Draft → Enforce → Audit → Transport. */
export type ReceptionistDispatchOutcome = {
  /** The audit id, or null when a duplicate short-circuited before any audit/send. */
  audit_id: string | null;
  /** The trace, or null on a pre-audit duplicate short-circuit. */
  correlation_id: string | null;
  /** The enforced + audited draft, or null on a pre-audit duplicate short-circuit. */
  draft: string | null;
  /** The enforcement decision, or null on a pre-audit duplicate short-circuit. */
  decision: ReceptionistReplyDecision | null;
  /** The transport stage outcome. */
  transport: TransportResult;
};

// `record_ai_reply_transport` is a service-role-only SECURITY DEFINER primitive and
// is not in the generated Database types — cast past the typed client, the same
// `as unknown as` convention as `record_ai_reply_audit` above.
type RecordReplyTransportRpc = (
  fn: "record_ai_reply_transport",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

// The minimal read shape for the dedup probe — a chainable filter that terminates in
// the awaited result. Cast past the generated types (ai_reply_transports is RLS:hq
// and not in the typed client's row map).
type TransportProbeFilter = {
  eq: (column: string, value: unknown) => TransportProbeFilter;
  limit: (count: number) => Promise<{ data: { id: string }[] | null }>;
};
type TransportProbe = {
  select: (cols: string) => TransportProbeFilter;
};

/**
 * The idempotency key for one dispatch. Prefers an explicit `metadata.dedup_key`
 * (a channel's own message id), else falls back to the conversation (`enquiry_id`)
 * so a single inbound event yields at most one successful outbound. Null → no dedup
 * key, so the caller opts out of the short-circuit (the DB still allows the send).
 */
function transportDedupKey(input: ReplyAuditContext): string | null {
  const fromMeta = input.metadata?.dedup_key;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim();
  return input.enquiry_id ?? null;
}

/**
 * File one transport attempt into the append-only `ai_reply_transports` ledger via
 * the service-role-only `record_ai_reply_transport` primitive. MANDATORY: like the
 * audit write, a transport that cannot be recorded THROWS — no send is acknowledged
 * without its durable record, and the DB's allowed-audit gate runs inside this write.
 */
async function recordTransport(args: {
  reply_audit_id: string;
  org_id: string;
  channel: typeof RECEPTIONIST_TRANSPORT_CHANNEL;
  to_ref: string;
  status: "sent" | "failed";
  correlation_id: string;
  provider?: string | null;
  provider_message_id?: string | null;
  failure_reason?: string | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
  dedup_key?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as RecordReplyTransportRpc;
  const { data: transportId, error } = await rpc("record_ai_reply_transport", {
    p_reply_audit_id: args.reply_audit_id,
    p_org_id: args.org_id,
    p_employee_slug: RECEPTIONIST_EMPLOYEE_SLUG,
    p_channel: args.channel,
    p_to_ref: args.to_ref,
    p_status: args.status,
    p_correlation_id: args.correlation_id,
    p_provider: args.provider ?? null,
    p_provider_message_id: args.provider_message_id ?? null,
    p_failure_reason: args.failure_reason ?? null,
    p_cost_usd: args.cost_usd ?? null,
    p_latency_ms: args.latency_ms ?? null,
    p_attempt: 1,
    p_dedup_key: args.dedup_key ?? null,
    p_metadata: args.metadata ?? {},
  });

  // MANDATORY, not best-effort: a transport attempt that cannot be recorded must fail
  // loudly, exactly as the audit write does. Never swallow, never acknowledge unrecorded.
  if (error || !transportId) {
    throw new Error(
      "ai_reply_transports write failed — a receptionist transport may not be acknowledged unrecorded: " +
        (error?.message ?? "no transport id returned"),
    );
  }
  return transportId;
}

/**
 * The NO-DUPLICATE read: is there already a SENT transport for this org + dedup key?
 * Returns its id when one exists. The partial unique index `(dedup_key) where
 * status='sent'` is the database backstop; this read is the application guard that
 * stops a second attempt from ever reaching a provider.
 */
async function findSentTransport(orgId: string, dedupKey: string): Promise<string | null> {
  const admin = createAdminClient();
  const probe = admin.from("ai_reply_transports" as never) as unknown as TransportProbe;
  const { data } = await probe
    .select("id")
    .eq("org_id", orgId)
    .eq("dedup_key", dedupKey)
    .eq("status", "sent")
    .limit(1);
  const rows = (data as { id: string }[] | null) ?? [];
  return rows[0]?.id ?? null;
}

/**
 * Carry ONE enforced, audited, auto-sendable reply out over the SMS seam, recording
 * the outcome — success OR failure — in the append-only ledger. Every branch records:
 *   • an undialable destination → `failed`/invalid_destination (never reached a provider);
 *   • no configured provider    → `failed`/no_provider (the graceful-degradation path CI runs);
 *   • the provider threw         → `failed`/provider_error;
 *   • the provider accepted      → `sent` with its message id, cost and latency.
 * It is called ONLY from `dispatchReply`, and only after the `decision.allowed` gate.
 */
async function transportReply(args: {
  reply_audit_id: string;
  org_id: string;
  correlation_id: string;
  destination: string | null;
  body: string;
  dedup_key: string | null;
}): Promise<TransportResult> {
  const baseMeta: Record<string, unknown> = { producer: "missed_call_text_back" };
  const e164 = toE164(args.destination);

  // (a) Undialable destination — a real attempt that never reaches a provider.
  if (!e164) {
    const transportId = await recordTransport({
      reply_audit_id: args.reply_audit_id,
      org_id: args.org_id,
      channel: RECEPTIONIST_TRANSPORT_CHANNEL,
      to_ref: args.destination ?? "",
      status: "failed",
      correlation_id: args.correlation_id,
      provider: null,
      failure_reason: "invalid_destination",
      dedup_key: args.dedup_key,
      metadata: baseMeta,
    });
    return {
      attempted: true,
      duplicate: false,
      transport_id: transportId,
      status: "failed",
      provider_message_id: null,
      failure_reason: "invalid_destination",
    };
  }

  // (b) No configured provider — graceful degradation. The seam returns null; we record
  //     a terminal failed/no_provider attempt and SEND NOTHING. This is the CI path.
  const provider = getSmsProvider();
  if (!provider) {
    const transportId = await recordTransport({
      reply_audit_id: args.reply_audit_id,
      org_id: args.org_id,
      channel: RECEPTIONIST_TRANSPORT_CHANNEL,
      to_ref: e164,
      status: "failed",
      correlation_id: args.correlation_id,
      provider: null,
      failure_reason: "no_provider",
      dedup_key: args.dedup_key,
      metadata: baseMeta,
    });
    return {
      attempted: true,
      duplicate: false,
      transport_id: transportId,
      status: "failed",
      provider_message_id: null,
      failure_reason: "no_provider",
    };
  }

  // (c) A real send. The seam resolves with the provider's acceptance or THROWS; either
  //     way the attempt is recorded (sent with the message id, or failed/provider_error).
  const startedAt = Date.now();
  try {
    const acceptance = await provider.send({ to: e164, body: args.body });
    const transportId = await recordTransport({
      reply_audit_id: args.reply_audit_id,
      org_id: args.org_id,
      channel: RECEPTIONIST_TRANSPORT_CHANNEL,
      to_ref: e164,
      status: "sent",
      correlation_id: args.correlation_id,
      provider: provider.info.provider,
      provider_message_id: acceptance.providerMessageId,
      cost_usd: smsCostUsd(provider.info),
      latency_ms: Date.now() - startedAt,
      dedup_key: args.dedup_key,
      metadata: baseMeta,
    });
    return {
      attempted: true,
      duplicate: false,
      transport_id: transportId,
      status: "sent",
      provider_message_id: acceptance.providerMessageId,
      failure_reason: null,
    };
  } catch (err) {
    const transportId = await recordTransport({
      reply_audit_id: args.reply_audit_id,
      org_id: args.org_id,
      channel: RECEPTIONIST_TRANSPORT_CHANNEL,
      to_ref: e164,
      status: "failed",
      correlation_id: args.correlation_id,
      provider: provider.info.provider,
      failure_reason: "provider_error",
      latency_ms: Date.now() - startedAt,
      dedup_key: args.dedup_key,
      metadata: { ...baseMeta, error: err instanceof Error ? err.message : String(err) },
    });
    return {
      attempted: true,
      duplicate: false,
      transport_id: transportId,
      status: "failed",
      provider_message_id: null,
      failure_reason: "provider_error",
    };
  }
}

/**
 * Draft → Enforce → Audit → Transport for a reply whose draft is already in hand.
 * ENFORCE + AUDIT run first ({@link enforceAndAuditReply}, the R4 mandatory
 * chokepoint), so the attempt is durably audited BEFORE any transport is considered.
 * Then the deny-by-default gate: only a clean `allow` (`decision.allowed`) is carried
 * to {@link transportReply}; a `review`, `block`, or empty draft is audited and STOPS
 * — it never reaches a provider. This is a CALLABLE PRIMITIVE: nothing invokes it on a
 * timer. The auto-sendable remainder (`safeText`) rides the wire when present, else the
 * draft itself.
 */
export async function dispatchReply(
  input: ReplyAuditContext & { draft: string; destination?: string | null },
): Promise<ReceptionistDispatchOutcome> {
  const outcome = await enforceAndAuditReply(input);

  // Deny by default. A held/refused/empty reply is audited (above) and goes no further.
  if (!outcome.decision.allowed) {
    return {
      audit_id: outcome.audit_id,
      correlation_id: outcome.correlation_id,
      draft: outcome.draft,
      decision: outcome.decision,
      transport: {
        attempted: false,
        duplicate: false,
        transport_id: null,
        status: "skipped",
        provider_message_id: null,
        failure_reason: "not_auto_sendable",
      },
    };
  }

  const transport = await transportReply({
    reply_audit_id: outcome.audit_id,
    org_id: input.org_id,
    correlation_id: outcome.correlation_id,
    destination: input.destination ?? input.customer_ref ?? null,
    body: outcome.decision.safeText ?? outcome.draft,
    dedup_key: transportDedupKey(input),
  });

  return {
    audit_id: outcome.audit_id,
    correlation_id: outcome.correlation_id,
    draft: outcome.draft,
    decision: outcome.decision,
    transport,
  };
}

/**
 * The full canonical outbound path for the receptionist: compose the deterministic
 * acknowledgement, then run it through {@link dispatchReply} (Enforce → Audit →
 * Transport). Guarded at the very top by the NO-DUPLICATE short-circuit: if a message
 * for this idempotency key has already gone out (a SENT transport exists), it returns
 * immediately WITHOUT composing, enforcing, auditing, or sending again. A CALLABLE
 * PRIMITIVE — the inbound webhook does NOT invoke it automatically in R5 (auto-wiring
 * behind the missed-call-text-back flag is the R6 recommendation).
 */
export async function dispatchReceptionistReply(
  input: ReplyAuditContext & { destination?: string | null },
): Promise<ReceptionistDispatchOutcome> {
  const dedupKey = transportDedupKey(input);
  if (dedupKey) {
    const existing = await findSentTransport(input.org_id, dedupKey);
    if (existing) {
      return {
        audit_id: null,
        correlation_id: null,
        draft: null,
        decision: null,
        transport: {
          attempted: false,
          duplicate: true,
          transport_id: existing,
          status: "skipped",
          provider_message_id: null,
          failure_reason: "duplicate",
        },
      };
    }
  }

  const draft = composeReceptionistReply({ channel: input.channel });
  return dispatchReply({
    ...input,
    draft,
    metadata: { ...(input.metadata ?? {}), producer: "deterministic_acknowledgement" },
  });
}

/**
 * Phase A — AI Receptionist processor.
 *
 * The single entry-point every channel adapter (phone webhook, SMS
 * webhook, WhatsApp Business, Instagram DM, Facebook DM) feeds.
 *
 *   1. INSERT raw row into `inbound_enquiries` (status='received').
 *   2. If AI is configured: extract structured fields from raw_text.
 *      Otherwise: deterministic fallback (keyword urgency, postcode
 *      regex, no AI summary).
 *   3. Create a `leads` row (status='new', source=channel).
 *   4. Update the enquiry: status='qualified', link lead_id, store
 *      extraction artefacts.
 *   5. Emit notifications (customer-audience for the org owner,
 *      audit log entry, automation dispatch).
 *
 * AI safety: this service runs on the SERVER. AI never books,
 * schedules, prices, or commits work — the owner is notified and
 * decides. The extraction is read-only output stored alongside the
 * raw transcript so the owner can verify.
 *
 * Idempotency: channels can replay webhooks. Callers may pass a
 * `dedup_key` (e.g. WhatsApp message_id) via the audit metadata;
 * the dispatcher's correlation_id handles the automation side.
 */

export async function processInboundEnquiry(
  input: InboundEnquiryInput,
): Promise<{ enquiry_id: string; lead_id: string | null }> {
  const admin = createAdminClient();

  // Step 1 — record raw enquiry.
  const { data: enquiryRow, error: insErr } = await (
    admin.from("inbound_enquiries" as never) as unknown as {
      insert: (row: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: { id: string } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .insert({
      org_id: input.org_id,
      channel: input.channel,
      raw_text: input.raw_text ?? null,
      caller: input.caller ?? null,
      status: "received",
    })
    .select("id")
    .single();
  if (insErr || !enquiryRow?.id) {
    throw new Error(`inbound_enquiries insert failed: ${insErr?.message ?? "no id"}`);
  }
  const enquiryId = enquiryRow.id;

  // Step 2 — AI extraction (or deterministic fallback).
  const extraction = await extractFields(input.raw_text ?? "");

  // Step 3 — create the lead. We do NOT create a customer row yet
  // (the directive's "AI NEVER commits work" rule). The owner can
  // promote the lead to a customer manually.
  let leadId: string | null = null;
  try {
    const { data: leadRow } = await admin
      .from("leads")
      .insert({
        org_id: input.org_id,
        source: input.channel,
        status: "new",
        service: extraction.job_type,
        urgency: extraction.urgency,
        postcode: extraction.postcode,
        ai_summary: extraction.summary,
      })
      .select("id")
      .single();
    leadId = (leadRow as { id?: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[receptionist] lead insert failed", e);
  }

  // Step 4 — update enquiry with extraction + lead link.
  await (admin.from("inbound_enquiries" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  })
    .update({
      status: leadId ? "qualified" : "processed",
      processed_at: new Date().toISOString(),
      ai_summary: extraction.summary,
      ai_confidence: extraction.confidence,
      job_type: extraction.job_type,
      urgency: extraction.urgency,
      postcode: extraction.postcode,
      budget_gbp: extraction.budget_gbp,
      lead_id: leadId,
    })
    .eq("id", enquiryId);

  // Step 5 — notify + audit + automation.
  if (leadId) {
    const note: NotificationCreate = {
      org_id: input.org_id,
      user_id: null,
      audience: "customer",
      type: "receptionist.lead_created",
      category: "system",
      priority: extraction.urgency === "urgent" ? "urgent" : "high",
      title: `New ${input.channel.replace("_", " ")} enquiry`,
      body: extraction.summary.slice(0, 280),
      action_url: `/leads/${leadId}`,
      source_module: "receptionist",
      source_id: leadId,
      metadata: {
        channel: input.channel,
        caller: input.caller,
        confidence: extraction.confidence,
      },
    };
    await emitNotifications([note]).catch((e) =>
      console.error("[receptionist] notify failed", e),
    );

    await recordAdminActivity({
      actorId: null,
      actorEmail: input.caller ?? null,
      action: "receptionist.enquiry_qualified",
      targetTable: "leads",
      targetId: leadId,
      metadata: {
        org_id: input.org_id,
        channel: input.channel,
        confidence: extraction.confidence,
        ai_used: isAiConfigured(),
      },
    });

    await dispatchAutomation({
      type: "support.ticket.created", // closest existing event id; new lead trigger could land later
      org_id: input.org_id,
      source_table: "leads",
      source_id: leadId,
      payload: { channel: input.channel, summary: extraction.summary },
    }).catch((e) => console.error("[receptionist] automation failed", e));
  }

  return { enquiry_id: enquiryId, lead_id: leadId };
}

// ---------------------------------------------------------------------
// Extraction — AI or deterministic
// ---------------------------------------------------------------------

async function extractFields(rawText: string): Promise<InboundExtraction> {
  // No AI key → deterministic fallback (keyword urgency + postcode
  // regex). Always returns SOMETHING so the lead still creates.
  if (!isAiConfigured() || !rawText.trim()) {
    return deterministicExtract(rawText);
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const msg = await client.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system: [
          "You are CrewFlow Receptionist, processing an inbound enquiry for a UK construction firm.",
          "Read the transcript / message and return ONE JSON object only:",
          '{ "summary": "...", "confidence": 0-100, "job_type": "...", "urgency": "low"|"medium"|"high"|"urgent"|null, "postcode": "..."|null, "budget_gbp": number|null }',
          "Rules:",
          "- summary: 1-2 sentences, plain prose, no markdown",
          "- confidence: how reliable the extraction is (high if explicit, low if guessed)",
          "- urgency: 'urgent' if customer mentioned emergency/leak/flood/no-heat, else infer",
          "- DO NOT invent budget. If unstated, return null.",
          "- DO NOT promise prices or book appointments.",
          "- postcode: UK format only (e.g. SW1A 1AA), null if not present",
        ].join("\n"),
        messages: [{ role: "user", content: rawText }],
      },
      { signal: AbortSignal.timeout(10_000) },
    );
    const block = msg.content[0];
    if (block?.type === "text") {
      const raw = extractJson(block.text);
      if (raw && typeof raw === "object") {
        return normaliseExtraction(raw as Record<string, unknown>);
      }
    }
  } catch (e) {
    console.error("[receptionist] LLM extraction failed", e);
  }
  return deterministicExtract(rawText);
}

function deterministicExtract(raw: string): InboundExtraction {
  const text = raw.toLowerCase();
  const urgent =
    /\b(emergency|urgent|asap|leak|flood|no heat|burst|broken)\b/.test(text);
  const postcodeMatch =
    raw.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i)?.[0] ?? null;
  return {
    summary:
      raw.trim().length > 0
        ? raw.trim().slice(0, 280)
        : "New enquiry — no transcript captured.",
    confidence: 30,
    job_type: null,
    urgency: urgent ? "urgent" : null,
    postcode: postcodeMatch ? postcodeMatch.toUpperCase().replace(/\s+/g, " ").trim() : null,
    budget_gbp: null,
  };
}

function normaliseExtraction(raw: Record<string, unknown>): InboundExtraction {
  const urgencyRaw =
    typeof raw.urgency === "string" ? raw.urgency.toLowerCase() : null;
  const urgency: InboundUrgency | null =
    urgencyRaw === "low" ||
    urgencyRaw === "medium" ||
    urgencyRaw === "high" ||
    urgencyRaw === "urgent"
      ? (urgencyRaw as InboundUrgency)
      : null;
  return {
    summary: String(raw.summary ?? "").trim() || "AI returned no summary.",
    confidence: clampConfidence(raw.confidence),
    job_type: typeof raw.job_type === "string" ? raw.job_type : null,
    urgency,
    postcode: typeof raw.postcode === "string" ? raw.postcode : null,
    budget_gbp:
      typeof raw.budget_gbp === "number" && Number.isFinite(raw.budget_gbp)
        ? raw.budget_gbp
        : null,
  };
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

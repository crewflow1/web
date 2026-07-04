import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { isAiConfigured } from "@/lib/ai/safety";
import {
  evaluateReply,
  isAutoSendable,
  clearForHumanSend,
  type GuardrailCategory,
  type GuardrailResult,
  type GuardrailVerdict,
} from "@/lib/receptionist/policy";
import {
  generateReplyDraft,
  type GeneratedReplyDraft,
} from "@/server/services/receptionist-draft";
import { RECEPTIONIST_EMPLOYEE_SLUG } from "@/lib/receptionist/types";
import {
  resolveConversation,
  appendConversationMessage,
} from "@/server/services/receptionist-conversations";
import {
  getConversationTurnContext,
  type ConversationContext,
} from "@/server/services/receptionist-conversation-context";
import {
  INITIAL_CONVERSATION_STATE,
  coerceConversationState,
  classifyTurn,
  planConversationTransition,
  type ConversationState,
  type ConversationTransitionPlan,
  type TurnRouting,
} from "@/lib/receptionist/runtime";
import {
  INITIAL_CONVERSATION_INTENT,
  coerceConversationIntent,
  resolveIntent,
  planIntentProgression,
  type ConversationIntent,
  type IntentTransitionPlan,
} from "@/lib/receptionist/conversation-intent";
import {
  INITIAL_CONVERSATION_GOAL,
  coerceConversationGoal,
  resolveGoal,
  planGoalProgression,
  type ConversationGoal,
  type GoalTransitionPlan,
} from "@/lib/receptionist/conversation-goal";
import {
  EMPTY_INFORMATION,
  coerceConversationInformation,
  extractInformation,
  planInformationUpdate,
  type ConversationInformation,
  type InformationUpdate,
} from "@/lib/receptionist/conversation-information";
import { detectGap, type ConversationGap } from "@/lib/receptionist/conversation-gap";
import {
  resolveStrategy,
  type StrategyDecision,
} from "@/lib/receptionist/conversation-strategy";
import {
  planPrompt,
  type ConversationPromptPlan,
} from "@/lib/receptionist/conversation-prompt";
import {
  buildResponseSpec,
  type ResponseSpecification,
} from "@/lib/receptionist/conversation-response";
import { getSmsProvider, smsCostUsd } from "@/lib/comms";
import type { SmsDeliveryReceipt, SmsDeliveryStatus } from "@/lib/comms";
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
  /**
   * The persistent conversation this reply belongs to (R10 substrate). Threaded to the R13 draft
   * generator so it can fetch the canonical R12 context to reason over; null (no contact ⇒ no
   * thread) drafts the deterministic acknowledgement. Not persisted to the audit ledger.
   */
  conversation_id?: string | null;
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
/**
 * The MANDATORY audit write — file ONE row into the append-only `ai_reply_audits` ledger through
 * the service-role-only `record_ai_reply_audit` primitive, and THROW if it cannot be recorded.
 * This is the SINGLE place the audit RPC is invoked: both the autonomous chokepoint
 * ({@link enforceAndAuditReply}) and the human-reviewed send seam
 * ({@link dispatchHumanReviewedReply}) file their attempt here, so there is exactly one audit of
 * record and one throw-on-failure contract. Persists the conversation link (R14) so a held reply
 * can be threaded to its conversation by the review inbox. Returns the new audit id.
 */
async function writeReplyAudit(params: {
  org_id: string;
  channel: InboundChannel;
  correlation_id: string;
  draft: string;
  verdict: GuardrailVerdict;
  allowed: boolean;
  reason: string;
  categories: readonly GuardrailCategory[];
  safe_text: string | null;
  enquiry_id?: string | null;
  lead_id?: string | null;
  customer_ref?: string | null;
  conversation_id?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as RecordReplyAuditRpc;
  const { data: auditId, error } = await rpc("record_ai_reply_audit", {
    p_org_id: params.org_id,
    p_employee_slug: RECEPTIONIST_EMPLOYEE_SLUG,
    p_channel: params.channel,
    p_correlation_id: params.correlation_id,
    p_draft: params.draft,
    p_verdict: params.verdict,
    p_allowed: params.allowed,
    p_reason: params.reason,
    p_categories: params.categories,
    p_safe_text: params.safe_text,
    p_enquiry_id: params.enquiry_id ?? null,
    p_lead_id: params.lead_id ?? null,
    p_customer_ref: params.customer_ref ?? null,
    p_conversation_id: params.conversation_id ?? null,
    p_metadata: params.metadata ?? {},
  });

  // MANDATORY, not best-effort, not configurable: a reply whose attempt cannot be
  // recorded must NOT proceed. Fail loudly — never swallow, never continue unaudited.
  if (error || !auditId) {
    throw new Error(
      "ai_reply_audits write failed — a receptionist reply may not proceed unaudited: " +
        (error?.message ?? "no audit id returned"),
    );
  }
  return auditId;
}

export async function enforceAndAuditReply(
  input: ReplyAuditContext & { draft: string },
): Promise<ReceptionistReplyOutcome> {
  const decision = enforceReceptionistReply(input.draft);
  const correlationId = input.correlation_id ?? crypto.randomUUID();

  const auditId = await writeReplyAudit({
    org_id: input.org_id,
    channel: input.channel,
    correlation_id: correlationId,
    draft: input.draft,
    verdict: decision.verdict,
    allowed: decision.allowed,
    reason: decision.reason,
    categories: decision.categories,
    safe_text: decision.safeText,
    enquiry_id: input.enquiry_id,
    lead_id: input.lead_id,
    customer_ref: input.customer_ref,
    conversation_id: input.conversation_id,
    metadata: input.metadata,
  });

  return {
    audit_id: auditId,
    correlation_id: correlationId,
    draft: input.draft,
    decision,
  };
}

/**
 * Fold one generated draft's provenance into audit metadata — the producer path, the model, the
 * fallback reason (why the deterministic leg ran, or null), and the deterministic cost/token/latency
 * accounting. Merged OVER the caller's metadata so a dedup key or call id is preserved. This records
 * HOW the draft was produced; it changes nothing about how it is enforced or audited.
 */
function draftProvenance(
  incoming: Record<string, unknown> | undefined,
  gen: GeneratedReplyDraft,
): Record<string, unknown> {
  return {
    ...(incoming ?? {}),
    producer: gen.producer,
    model: gen.model,
    fallback_reason: gen.fallback_reason,
    input_tokens: gen.input_tokens,
    output_tokens: gen.output_tokens,
    cost_usd: gen.cost_usd,
    latency_ms: gen.latency_ms,
  };
}

/**
 * The full canonical pipeline: Draft → Enforce → Audit. GENERATES the draft through the R13
 * conversation-aware generator ({@link generateReplyDraft}) — which consumes ONLY the canonical R12
 * context and reaches the model ONLY through the existing abstraction, degrading to the deterministic
 * acknowledgement when there is no provider / no conversation / no context — then hands the draft to
 * {@link enforceAndAuditReply}, so it is enforced by the R3 seam and its attempt is audited, with no
 * path that produces a reply without both. This is INTERNAL only: the outcome is a decision plus its
 * audit record, never a customer send (transport is `dispatchReceptionistReply`, deliberately absent
 * here).
 */
export async function produceAndEnforceReply(
  input: ReplyAuditContext,
): Promise<ReceptionistReplyOutcome> {
  const gen = await generateReplyDraft({
    org_id: input.org_id,
    channel: input.channel,
    conversation_id: input.conversation_id ?? null,
  });
  return enforceAndAuditReply({
    ...input,
    draft: gen.draft,
    metadata: draftProvenance(input.metadata, gen),
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
  /** Transport provenance label. Defaults to the R6 missed-call path; the R14 human-reviewed send
   *  passes its own so the transport row names the seam that produced it. */
  producer?: string;
}): Promise<TransportResult> {
  const baseMeta: Record<string, unknown> = {
    producer: args.producer ?? "missed_call_text_back",
  };
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
      // Record the provider's synchronous acceptance status against the message id
      // when it reports one (Directive #018 R6, "record provider outcomes where
      // supported"). The async terminal receipt is a later increment.
      metadata: acceptance.status
        ? { ...baseMeta, provider_status: acceptance.status }
        : baseMeta,
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
 * The full canonical outbound path for the receptionist: GENERATE the draft through the R13
 * conversation-aware generator ({@link generateReplyDraft}), then run it through {@link dispatchReply}
 * (Enforce → Audit → Transport). Guarded at the very top by the NO-DUPLICATE short-circuit: if a
 * message for this idempotency key has already gone out (a SENT transport exists), it returns
 * immediately WITHOUT generating, enforcing, auditing, or sending again. A CALLABLE PRIMITIVE — the
 * inbound webhook invokes it only behind the default-OFF missed-call-text-back flag (R6). The
 * generator consumes ONLY the canonical R12 context and reaches the model ONLY through the existing
 * abstraction; when no provider / no conversation / no context is available it degrades to the
 * deterministic acknowledgement, so this path is byte-for-byte its pre-R13 self in CI.
 *
 * The optional `context` is the canonical R12 context ALREADY ASSEMBLED by the caller (R16): the
 * runtime assembles it ONCE per turn and threads it here, and it is handed to the generator verbatim
 * IN PLACE OF a second fetch. Omitted (a standalone caller), the generator fetches its own — the
 * pre-R16 behaviour, unchanged. It re-shapes nothing else: enforcement, audit, transport and the
 * no-duplicate short-circuit are identical whether or not a context is threaded.
 */
export async function dispatchReceptionistReply(
  input: ReplyAuditContext & { destination?: string | null },
  context?: ConversationContext | null,
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

  const gen = await generateReplyDraft({
    org_id: input.org_id,
    channel: input.channel,
    conversation_id: input.conversation_id ?? null,
    context,
  });
  return dispatchReply({
    ...input,
    draft: gen.draft,
    metadata: draftProvenance(input.metadata, gen),
  });
}

// =====================================================================
// THE MULTI-TURN CONVERSATION RUNTIME — THE SINGLE ORCHESTRATION LAYER
// (CEO Directive #018, R15: MULTI-TURN CONVERSATION RUNTIME).
//
// R1–R14 built a ONE-SHOT responder: `dispatchReceptionistReply` above is a single, self-contained
// Generate → Enforce → Audit → Transport dispatch with no notion of a TURN or a continuing dialogue.
// R15 makes the receptionist a CONVERSATION RUNTIME: `runConversationTurn` is the ONE orchestration
// layer through which every AI conversation turn flows. For an inbound reply it performs the nine
// canonical steps IN ORDER — and it RE-USES every existing layer, recreating none:
//
//   1. RESOLVE the existing conversation — the R10 substrate id threaded in by the caller.
//   2. RECONSTRUCT the canonical timeline — through the R12 seam `getConversationTurnContext`, which
//                                          reconstructs via the R11 read model. Never independently.
//   3. ASSEMBLE the canonical context    — that SAME seam call folds the pure R12 assembler EXACTLY
//                                          ONCE and returns the summary alongside; the runtime threads
//                                          the assembled context DOWN and never re-assembles.
//   4. DETERMINE the current state       — `coerceConversationState` over that SAME summary's
//                                          `runtime_state` (the R15 marker) — from the one reconstruction.
//   5. GENERATE the next draft           — inside `dispatchReceptionistReply`, the R13 generator, from
//                                          the context THREADED in at step 3 (no second fetch).
//   6. POLICY                            — inside `dispatchReceptionistReply`, the R3 seam.
//   7. AUDIT                             — inside `dispatchReceptionistReply`, the R4 ledger.
//   8. ROUTE (allow→transport, review→Reply Review Inbox, block→blocked flow) — UNCHANGED, all inside
//                                          `dispatchReceptionistReply` / `dispatchReply`.
//   9. GOVERN the progression          — the R17 FORMAL STATE MACHINE in lib/receptionist/runtime.ts
//                                          (`planConversationTransition`) validates the (prior →
//                                          outcome) edge and the runtime persists a validated `advance`
//                                          through the org-scoped writer below.
//
// IT ADDS NO SECOND ENFORCEMENT, GENERATION, OR TRANSPORT PATH. Steps 5–8 are delegated WHOLE to
// `dispatchReceptionistReply` — the runtime NEVER re-drafts, re-enforces, re-audits or re-sends; it
// ORCHESTRATES the canonical pipeline and then GOVERNS the ownership marker's progression. AND IT ADDS
// NO SECOND RECONSTRUCTION OR ASSEMBLY (R16): steps 2–3 reconstruct and assemble the context ONCE, and
// the runtime threads that SAME object into the dispatch, so the R13 generator drafts from it without
// a second fetch. R17 makes step 9 the SINGLE PROGRESSION AUTHORITY: every persisted advance passes the
// state machine's declared-edge validation, and an illegal edge is REFUSED — but the machine derives
// the transition from the coarse (prior state, turn OUTCOME) ALONE, never from message content, so it
// still never GATES a turn on the state (slot filling and intent progression stay EXPLICIT R17
// non-goals). DETERMINISTIC: the same conversation and the same dispatch outcome always plan the same
// transition and advance to the same state.
// =====================================================================

// `set_receptionist_conversation_runtime_state` is a service-role-only SECURITY DEFINER primitive
// (migration 20260822000000) and is not in the generated Database types — cast past the typed client,
// the same `as unknown as` convention as `record_ai_reply_audit` / `record_ai_reply_transport` above.
type SetRuntimeStateRpc = (
  fn: "set_receptionist_conversation_runtime_state",
  args: Record<string, unknown>,
) => Promise<{ error: { message: string } | null }>;

/**
 * Persist a conversation's ADVANCED runtime state through the SINGLE validated, org-scoped writer
 * (the R15 SECURITY DEFINER function). Throw-on-failure, like the audit and transport writes: the
 * runtime never silently corrupts the marker. Org-scoped in-DDL, so a caller can only ever advance
 * its OWN conversation. Idempotent — persisting the same state is a no-op update.
 */
async function setConversationRuntimeState(args: {
  conversation_id: string;
  org_id: string;
  runtime_state: ConversationState;
}): Promise<void> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as SetRuntimeStateRpc;
  const { error } = await rpc("set_receptionist_conversation_runtime_state", {
    p_conversation_id: args.conversation_id,
    p_org_id: args.org_id,
    p_runtime_state: args.runtime_state,
  });
  if (error) {
    throw new Error(
      "set_receptionist_conversation_runtime_state failed: " + error.message,
    );
  }
}

// `set_receptionist_conversation_intent` is a service-role-only SECURITY DEFINER primitive (migration
// 20260823000000) and is not in the generated Database types — cast past the typed client, the same
// `as unknown as` convention as `set_receptionist_conversation_runtime_state` above.
type SetIntentRpc = (
  fn: "set_receptionist_conversation_intent",
  args: Record<string, unknown>,
) => Promise<{ error: { message: string } | null }>;

/**
 * Persist a conversation's ADVANCED intent through the SINGLE validated, org-scoped writer (the R18
 * SECURITY DEFINER function). Throw-on-failure, exactly like the runtime-state writer; the caller
 * catches and swallows so a bookkeeping write never gates the turn. Org-scoped in-DDL, so a caller can
 * only ever advance its OWN conversation. Idempotent — persisting the same intent is a no-op update.
 */
async function setConversationIntent(args: {
  conversation_id: string;
  org_id: string;
  intent: ConversationIntent;
}): Promise<void> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as SetIntentRpc;
  const { error } = await rpc("set_receptionist_conversation_intent", {
    p_conversation_id: args.conversation_id,
    p_org_id: args.org_id,
    p_intent: args.intent,
  });
  if (error) {
    throw new Error("set_receptionist_conversation_intent failed: " + error.message);
  }
}

// `set_receptionist_conversation_goal` is a service-role-only SECURITY DEFINER primitive (migration
// 20260824000000) and is not in the generated Database types — cast past the typed client, the same
// `as unknown as` convention as the runtime-state / intent writers above.
type SetGoalRpc = (
  fn: "set_receptionist_conversation_goal",
  args: Record<string, unknown>,
) => Promise<{ error: { message: string } | null }>;

/**
 * Persist a conversation's ADVANCED goal through the SINGLE validated, org-scoped writer (the R19 SECURITY
 * DEFINER function). Throw-on-failure, exactly like the runtime-state and intent writers; the caller
 * catches and swallows so a bookkeeping write never gates the turn. Org-scoped in-DDL, so a caller can only
 * ever advance its OWN conversation. Idempotent — persisting the same goal is a no-op update.
 */
async function setConversationGoal(args: {
  conversation_id: string;
  org_id: string;
  goal: ConversationGoal;
}): Promise<void> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as SetGoalRpc;
  const { error } = await rpc("set_receptionist_conversation_goal", {
    p_conversation_id: args.conversation_id,
    p_org_id: args.org_id,
    p_goal: args.goal,
  });
  if (error) {
    throw new Error("set_receptionist_conversation_goal failed: " + error.message);
  }
}

// `set_receptionist_conversation_information` is a service-role-only SECURITY DEFINER primitive (migration
// 20260825000000) and is not in the generated Database types — cast past the typed client, the same
// `as unknown as` convention as the runtime-state / intent / goal writers above.
type SetInformationRpc = (
  fn: "set_receptionist_conversation_information",
  args: Record<string, unknown>,
) => Promise<{ error: { message: string } | null }>;

/**
 * Persist a conversation's UPDATED information through the SINGLE validated, org-scoped writer (the R20
 * SECURITY DEFINER function). Throw-on-failure, exactly like the runtime-state / intent / goal writers; the
 * caller catches and swallows so a bookkeeping write never gates the turn. Org-scoped in-DDL, so a caller
 * can only ever advance its OWN conversation. The DDL validates the SHAPE (a jsonb object of in-vocabulary
 * keys → string values); the pure engine already guarantees that shape, so this is defence-in-depth.
 * Idempotent — persisting the same information is a no-op update.
 */
async function setConversationInformation(args: {
  conversation_id: string;
  org_id: string;
  information: ConversationInformation;
}): Promise<void> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as SetInformationRpc;
  const { error } = await rpc("set_receptionist_conversation_information", {
    p_conversation_id: args.conversation_id,
    p_org_id: args.org_id,
    p_information: args.information,
  });
  if (error) {
    throw new Error("set_receptionist_conversation_information failed: " + error.message);
  }
}

/**
 * The observable outcome of one conversation turn the runtime folded — the prior and next runtime
 * state, how the turn ROUTED (the pure classification), whether the state actually advanced, the R18
 * conversational intent it resolved and advanced, the canonical context boundaries the runtime
 * assembled, and the full underlying dispatch outcome. A pure record of what the ONE orchestration
 * layer did; it carries no new enforcement surface.
 */
export type ConversationTurnResult = {
  /** The conversation this turn ran on, or null when the caller supplied no conversation id. */
  conversation_id: string | null;
  /** The runtime state BEFORE the turn (the persisted marker, coerced deny-unknown). */
  prior_state: ConversationState;
  /** How the turn resolved — the pure classification of its dispatch facts. */
  routing: TurnRouting;
  /** The runtime state AFTER the turn (equals prior_state on a `noop`). */
  next_state: ConversationState;
  /**
   * The GOVERNED transition the R17 state machine planned for this turn — an `advance` (a validated
   * change that was persisted), an `unchanged` self-loop, or a `rejected` illegal edge (refused, never
   * persisted). The auditable record of how the single progression authority resolved the turn.
   */
  transition: ConversationTransitionPlan;
  /** True when the persisted state actually changed (a durable advance was written). */
  state_advanced: boolean;
  /** The conversational intent BEFORE the turn (the persisted marker, coerced deny-unknown) (R18). */
  prior_intent: ConversationIntent;
  /** The intent the R18 engine RESOLVED from this turn's context (the customer's latest message). */
  resolved_intent: ConversationIntent;
  /** The conversational intent AFTER the turn (equals prior_intent when the resolution had no signal). */
  next_intent: ConversationIntent;
  /**
   * The GOVERNED intent progression the R18 engine planned for this turn — an `advance` (a validated
   * change that was persisted), an `unchanged` self-loop, or a `rejected` illegal edge (refused, never
   * persisted). The auditable record of how the single intent authority resolved the turn.
   */
  intent_transition: IntentTransitionPlan;
  /** True when the persisted intent actually changed (a durable advance was written). */
  intent_advanced: boolean;
  /** The conversational goal BEFORE the turn (the persisted marker, coerced deny-unknown) (R19). */
  prior_goal: ConversationGoal;
  /** The goal the R19 engine RESOLVED from this turn — the objective the resolved intent elevates to. */
  resolved_goal: ConversationGoal;
  /** The conversational goal AFTER the turn (equals prior_goal when the resolution had no objective). */
  next_goal: ConversationGoal;
  /**
   * The GOVERNED goal progression the R19 engine planned for this turn — an `advance` (a validated change
   * that was persisted), an `unchanged` self-loop, or a `rejected` illegal edge (refused, never persisted).
   * The auditable record of how the single goal authority resolved the turn.
   */
  goal_transition: GoalTransitionPlan;
  /** True when the persisted goal actually changed (a durable advance was written). */
  goal_advanced: boolean;
  /** The structured information the conversation held BEFORE the turn (the persisted record, coerced
   *  deny-unknown) (R20). */
  prior_information: ConversationInformation;
  /** The information the R20 engine EXTRACTED from this turn's context for the current goal's fields — a
   *  fresh record of ONLY what this context provides, before it is folded onto the prior. */
  extracted_information: ConversationInformation;
  /** The structured information the conversation holds AFTER the turn (prior folded with extracted; equals
   *  prior_information when the turn extracted nothing new). */
  next_information: ConversationInformation;
  /**
   * The GOVERNED information update the R20 engine planned for this turn — an `updated` (new or changed
   * fields that were persisted, with `added` naming them) or an `unchanged` (nothing new). The auditable
   * record of how the single information authority resolved the turn.
   */
  information_update: InformationUpdate;
  /** True when the persisted information actually changed (a durable update was written). */
  information_updated: boolean;
  /**
   * The conversational GAP the R21 engine DERIVED for this turn — computed from the goal of record
   * (`next_goal`) and the information of record (`next_information`), never persisted. Names what the
   * objective is still MISSING (priority-ordered), the single `nextRequired` field, whether the objective
   * is `satisfied`, and whether another turn is `turnRequired`. A pure projection of goal + information: it
   * moves no marker and executes no action (the engine identifies missing information ONLY).
   */
  gap: ConversationGap;
  /**
   * The conversational STRATEGY the R22 engine DERIVED for this turn — computed from the gap alone
   * (lib/receptionist/conversation-strategy.ts), never persisted. Names the next conversational ACTION
   * (`strategy`), the single field it TARGETS (non-null only for a slot-filling `request_information` move),
   * and whether it `expectsReply`. A pure projection of the gap: it DECIDES the next move but executes no
   * business action (the engine determines conversational actions ONLY).
   */
  strategy: StrategyDecision;
  /**
   * The conversational PROMPT PLAN the R23 engine DERIVED for this turn — computed from the strategy alone
   * (lib/receptionist/conversation-prompt.ts), never persisted. Names the next conversational ACT to perform
   * (`act`), the single field it TARGETS (non-null only for a slot-filling `ask`), the deterministic FOCUS
   * directive that guides the downstream draft (`focus`, never customer-facing prose), and whether it
   * `expectsReply`. A pure projection of the strategy decision: it PLANS the next prompt but executes no
   * business action and writes no words (the engine plans conversational prompts ONLY).
   */
  prompt_plan: ConversationPromptPlan;
  /**
   * The model-ready RESPONSE SPECIFICATION the R24 engine DERIVED for this turn — computed from the prompt plan
   * alone (lib/receptionist/conversation-response.ts), never persisted. Names the response OBJECTIVE
   * (`objective`), the single field it SOLICITS (non-null only for a `gather`), the model-ready DIRECTIVE that
   * tells the downstream draft HOW to be produced (`directive`, never customer-facing prose), whether it
   * `awaitsReply`, and the invariant `guardrails` the produced response must honour. A pure projection of the
   * prompt plan: it PREPARES how the response should be produced but generates no words and executes no
   * business action (the engine prepares responses ONLY).
   */
  response_spec: ResponseSpecification;
  /** The canonical R12 context boundaries the runtime assembled, or null when there was no timeline. */
  context: { total_message_count: number; included_message_count: number } | null;
  /** The full canonical dispatch outcome (Generate → Enforce → Audit → Transport), verbatim. */
  dispatch: ReceptionistDispatchOutcome;
};

/**
 * Run ONE conversation turn — THE single orchestration entry point for an AI receptionist reply.
 *
 * Performs the nine canonical steps in order (see the section header): RESOLVE the conversation, LOAD
 * its timeline, ASSEMBLE its context, DETERMINE its current state, then GENERATE → POLICY → AUDIT →
 * ROUTE by delegating WHOLE to {@link dispatchReceptionistReply} (so there is exactly one enforcement,
 * generation and transport path), and finally GOVERN the runtime-state marker's progression through the
 * R17 formal state machine ({@link planConversationTransition} in lib/receptionist/runtime.ts) — the
 * single authority that validates every persisted advance. Steps 1–4 are best-effort OBSERVATION that never gate the turn:
 * a missing conversation simply leaves the state at its initial value and the context null; the
 * dispatch still runs. The state advance and the outbound timeline append are best-effort side-effects
 * — a failure is logged and swallowed so a durable, audited reply is never undone by a bookkeeping
 * write. DETERMINISTIC: the same conversation and the same dispatch outcome always yield the same
 * routing and the same next state.
 */
export async function runConversationTurn(
  input: ReplyAuditContext & { destination?: string | null },
): Promise<ConversationTurnResult> {
  const conversationId = input.conversation_id ?? null;

  // Steps 1–4 — RESOLVE the conversation (the R10 substrate id threaded in by the caller), then
  // RECONSTRUCT + ASSEMBLE its canonical context EXACTLY ONCE through the R12 SEAM
  // (`getConversationTurnContext` — the SINGLE server-side reconstruct-and-assemble path, which
  // reconstructs via the R11 read model, folds the pure R12 assembler, and returns the summary
  // alongside), and DETERMINE its current state from that SAME summary's persisted R15 marker (coerced
  // deny-unknown) — NO second read. Pure OBSERVATION: it never gates the turn — an absent conversation
  // leaves the initial state + null boundaries, and the dispatch still runs. `assembledContext` is the
  // ONE canonical context; it is threaded into the dispatch below, so the whole turn assembles once.
  let priorState: ConversationState = INITIAL_CONVERSATION_STATE;
  let priorIntent: ConversationIntent = INITIAL_CONVERSATION_INTENT;
  let priorGoal: ConversationGoal = INITIAL_CONVERSATION_GOAL;
  let priorInformation: ConversationInformation = EMPTY_INFORMATION;
  let context: ConversationTurnResult["context"] = null;
  let assembledContext: ConversationContext | null = null;
  if (conversationId) {
    const turnContext = await getConversationTurnContext({
      org_id: input.org_id,
      conversation_id: conversationId,
    });
    if (turnContext) {
      assembledContext = turnContext.context;
      context = {
        total_message_count: turnContext.context.boundaries.total_message_count,
        included_message_count: turnContext.context.boundaries.included_message_count,
      };
      priorState = coerceConversationState(turnContext.summary.runtime_state);
      priorIntent = coerceConversationIntent(turnContext.summary.intent);
      priorGoal = coerceConversationGoal(turnContext.summary.goal);
      priorInformation = coerceConversationInformation(turnContext.summary.information);
    }
  }

  // Steps 4–6 — RESOLVE the conversational intent, VALIDATE its progression, and UPDATE it, through the
  // R18 CONVERSATION INTENT ENGINE (lib/receptionist/conversation-intent.ts) — ON TOP of the R17 state
  // machine and BEFORE the draft. The engine is the SINGLE authority over conversational intent: it
  // RESOLVES the current intent DETERMINISTICALLY from the ONE assembled context (the customer's latest
  // message — no model, no second read), then PLANS the (prior → resolved) progression through its
  // formal transition rules. Progression is MONOTONIC — a concrete intent never regresses to `unknown`,
  // exactly as the state machine never regresses to `awaiting_ai` — and because the turn fold's image is
  // exactly the legal-edge relation, a real turn only ever yields an `advance` or an `unchanged`; a
  // `rejected` edge is impossible here and, if it somehow arose, is refused and recorded, NEVER
  // persisted. Only a validated `advance` is written, through the single org-scoped writer. The engine
  // NEVER moves the ownership marker, so intent progression can never bypass the state machine. Best-
  // effort OBSERVATION: a failed intent write is logged and swallowed — it never gates the turn or
  // blocks the reply below (intent reflects the INBOUND, a fact independent of the outbound).
  const resolvedIntent = resolveIntent(assembledContext);
  const intentTransition = planIntentProgression(priorIntent, resolvedIntent);
  let intentAdvanced = false;
  if (conversationId && intentTransition.kind === "advance") {
    try {
      await setConversationIntent({
        org_id: input.org_id,
        conversation_id: conversationId,
        intent: intentTransition.to,
      });
      intentAdvanced = true;
    } catch (e) {
      console.error("[receptionist] conversation intent advance failed", e);
    }
  } else if (conversationId && intentTransition.kind === "rejected") {
    // The engine refused an edge outside its declared relation — record the governance event; the
    // marker is left untouched. (Unreachable for a real turn: the fold's image is the legal-edge
    // relation, so a turn only ever yields `advance` or `unchanged`. The guard makes that law explicit.)
    console.error("[receptionist] conversation intent transition REJECTED — illegal edge refused", {
      from: intentTransition.from,
      to: intentTransition.to,
      reason: intentTransition.reason,
    });
  }
  const nextIntent: ConversationIntent =
    intentTransition.kind === "advance" ? intentTransition.to : priorIntent;

  // Steps 5–7 (R19) — RESOLVE the conversational GOAL, VALIDATE its progression, and UPDATE it, through the
  // R19 CONVERSATION GOAL ENGINE (lib/receptionist/conversation-goal.ts) — ON TOP of the R18 intent engine
  // and STILL BEFORE the draft. The engine is the SINGLE authority over the conversational OBJECTIVE: it
  // RESOLVES the current goal DETERMINISTICALLY by ELEVATING the intent the R18 engine JUST resolved (its
  // sole input — the context's canonical projection; it never re-reads or re-classifies the context, so it
  // DUPLICATES no intent resolution and no context assembly), then PLANS the (prior → resolved) progression
  // through its OWN formal transition rules. Progression is MONOTONIC — a concrete goal never regresses to
  // `undetermined`, exactly as intent never regresses to `unknown` and state never to `awaiting_ai` — and
  // because the turn fold's image is exactly the legal-edge relation, a real turn only ever yields an
  // `advance` or an `unchanged`; a `rejected` edge is impossible here and, if it somehow arose, is refused
  // and recorded, NEVER persisted. Only a validated `advance` is written, through the engine's OWN
  // org-scoped writer. The engine NEVER moves the ownership marker OR the intent marker — the goal is a
  // THIRD independent observation — so goal progression can never bypass the state machine or the intent
  // engine. Best-effort OBSERVATION: a failed goal write is logged and swallowed — it never gates the turn
  // or blocks the reply below.
  const resolvedGoal = resolveGoal(resolvedIntent);
  const goalTransition = planGoalProgression(priorGoal, resolvedGoal);
  let goalAdvanced = false;
  if (conversationId && goalTransition.kind === "advance") {
    try {
      await setConversationGoal({
        org_id: input.org_id,
        conversation_id: conversationId,
        goal: goalTransition.to,
      });
      goalAdvanced = true;
    } catch (e) {
      console.error("[receptionist] conversation goal advance failed", e);
    }
  } else if (conversationId && goalTransition.kind === "rejected") {
    // The engine refused an edge outside its declared relation — record the governance event; the marker is
    // left untouched. (Unreachable for a real turn: the fold's image is the legal-edge relation, so a turn
    // only ever yields `advance` or `unchanged`. The guard makes that law explicit.)
    console.error("[receptionist] conversation goal transition REJECTED — illegal edge refused", {
      from: goalTransition.from,
      to: goalTransition.to,
      reason: goalTransition.reason,
    });
  }
  const nextGoal: ConversationGoal =
    goalTransition.kind === "advance" ? goalTransition.to : priorGoal;

  // Steps 6–8 (R20) — EXTRACT the structured information the current goal needs, VALIDATE it, and PERSIST
  // what is new, through the R20 CONVERSATION INFORMATION ENGINE (lib/receptionist/conversation-information.ts)
  // — ON TOP of the R19 goal engine and STILL BEFORE the draft. The engine is the SINGLE authority over
  // structured conversational information: keyed on the goal the R19 engine JUST resolved (`nextGoal`, the
  // goal state of record after this turn), it EXTRACTS the fields that goal needs by SCANNING the ONE
  // assembled context (the customer's own messages — no model, no second read, so it DUPLICATES no context
  // assembly, no intent resolution and no goal resolution), VALIDATES each candidate as it extracts (an
  // extractor yields a value ONLY when it is well-formed — extraction and validation are one pass), then
  // PLANS the (prior → extracted) merge through its OWN fold. Accumulation is MONOTONIC — a known field is
  // never dropped or overwritten by a later empty turn, exactly as goal never regresses to `undetermined` —
  // so a real turn only ever yields an `updated` (naming the `added` fields) or an `unchanged`. Only an
  // `updated` is written, through the engine's OWN org-scoped writer. The engine NEVER moves the ownership
  // marker, the intent marker OR the goal marker — information is a FOURTH independent observation — and it
  // EXTRACTS ONLY: it executes no booking, no scheduling, no memory retrieval (all explicit R20 non-goals).
  // Best-effort OBSERVATION: a failed information write is logged and swallowed — it never gates the turn or
  // blocks the reply below.
  const extractedInformation: ConversationInformation = assembledContext
    ? extractInformation(assembledContext, nextGoal)
    : EMPTY_INFORMATION;
  const informationUpdate = planInformationUpdate(priorInformation, extractedInformation);
  let informationUpdated = false;
  if (conversationId && informationUpdate.kind === "updated") {
    try {
      await setConversationInformation({
        org_id: input.org_id,
        conversation_id: conversationId,
        information: informationUpdate.information,
      });
      informationUpdated = true;
    } catch (e) {
      console.error("[receptionist] conversation information update failed", e);
    }
  }
  const nextInformation: ConversationInformation = informationUpdate.information;

  // Step (R21) — DERIVE the conversational GAP through the R21 CONVERSATION GAP ENGINE
  // (lib/receptionist/conversation-gap.ts) — ON TOP of the R19 goal engine and the R20 information engine,
  // and STILL BEFORE the draft. The gap is the SINGLE authority over conversational completeness: from the
  // goal of record (`nextGoal`, what the R19 engine JUST resolved) and the information of record
  // (`nextInformation`, what the R20 engine JUST accumulated) it computes — by pure, deterministic set
  // arithmetic, NO model, NO second read — what the objective is still MISSING (priority-ordered), the single
  // highest-priority `nextRequired` field, whether the objective is `satisfied`, and whether another turn is
  // `turnRequired`. It REUSES R20's completeness surface (it forks no "what's missing" logic) and DUPLICATES
  // no context assembly, intent/goal resolution or information extraction. It PERSISTS NOTHING — the gap adds
  // no column and no writer; it is a fresh projection of the two already-persisted observations (goal +
  // information), surfaced on the turn result and re-derived on every read, so it can never drift. It moves
  // NO marker and executes NO business action: it identifies missing information ONLY (booking, scheduling
  // and slot-fill prompting are explicit R21 non-goals a future capability performs by CONSUMING this gap).
  const gap = detectGap(nextGoal, nextInformation);

  // Step (R22) — DERIVE the conversational STRATEGY through the R22 CONVERSATION STRATEGY ENGINE
  // (lib/receptionist/conversation-strategy.ts) — ON TOP of the R21 gap engine, and STILL BEFORE the draft.
  // The strategy is the SINGLE authority over conversational PLANNING: from the gap ALONE (`gap`, what the
  // R21 engine JUST derived) it decides — by a pure, deterministic ordered rule table, NO model, NO second
  // read — the next conversational ACTION (acknowledge, request_information, provide_answer,
  // escalate_to_human, progress_goal), the single field that action TARGETS (the gap's `nextRequired` for a
  // slot-filling request, else null), and whether it `expectsReply`. It REUSES the gap's completeness view
  // (it forks no "what's missing" logic) and DUPLICATES no context assembly, intent/goal resolution,
  // information extraction or gap detection. It PERSISTS NOTHING — the strategy adds no column and no writer;
  // it is a fresh projection of the already-derived gap, surfaced on the turn result and re-derived on every
  // read, so it can never drift. It DECIDES the next move but executes NO business action: booking,
  // scheduling and slot-fill prompting are explicit R22 non-goals a future capability performs by CONSUMING
  // this decision. Slot filling is the FIRST strategy expressed here, not the engine's purpose.
  const strategy = resolveStrategy(gap);

  // Step (R23) — PLAN the next conversational PROMPT through the R23 CONVERSATION PROMPT PLANNER
  // (lib/receptionist/conversation-prompt.ts) — ON TOP of the R22 strategy engine, and STILL BEFORE the draft.
  // The planner is the SINGLE authority over conversational PROMPT PLANNING: from the strategy decision ALONE
  // (`strategy`, what the R22 engine JUST derived) it plans — by pure, deterministic mapping tables, NO model,
  // NO second read — the next conversational ACT (greet, ask, answer, handoff, proceed), the single field that
  // act TARGETS (the decision's target for a slot-filling `ask`, else null), the deterministic FOCUS directive
  // that guides the draft (never customer-facing prose), and whether it `expectsReply` (carried from the
  // decision). It REUSES the strategy decision (it forks no strategy logic) and DUPLICATES no context
  // assembly, intent/goal resolution, information extraction, gap detection or strategy resolution. It
  // PERSISTS NOTHING — the plan adds no column and no writer; it is a fresh projection of the already-derived
  // strategy, surfaced on the turn result and re-derived on every read, so it can never drift. It PLANS the
  // next prompt but writes no words and executes NO business action: prose generation is the draft step below,
  // and booking, scheduling and CRM writes are explicit R23 non-goals a future capability performs by
  // CONSUMING this plan. Slot filling is the FIRST planner expressed here, not the engine's purpose.
  const promptPlan = planPrompt(strategy);

  // Step (R24) — PREPARE the model-ready RESPONSE SPECIFICATION through the R24 CONVERSATION RESPONSE ENGINE
  // (lib/receptionist/conversation-response.ts) — ON TOP of the R23 prompt planner, and STILL BEFORE the draft.
  // The engine is the SINGLE authority over RESPONSE PREPARATION: from the prompt plan ALONE (`promptPlan`, what
  // the R23 engine JUST derived) it prepares — by pure, deterministic mapping tables, NO model, NO second read —
  // the response OBJECTIVE (welcome, gather, inform, transfer, confirm), the single field the response SOLICITS
  // (the plan's target for a `gather`, else null), the model-ready DIRECTIVE that tells the draft HOW to be
  // produced (never customer-facing prose), whether it `awaitsReply` (carried from the plan), and the invariant
  // GUARDRAILS the produced response must honour. It REUSES the prompt plan (it forks no planning logic) and
  // DUPLICATES no context assembly, intent/goal resolution, information extraction, gap detection, strategy
  // resolution or prompt planning. It PERSISTS NOTHING — the spec adds no column and no writer; it is a fresh
  // projection of the already-derived plan, surfaced on the turn result and re-derived on every read, so it can
  // never drift. It PREPARES how the response should be produced but writes no words and executes NO business
  // action: prose generation is the draft step below (unchanged — the spec is exposed, not yet consumed here),
  // and booking, scheduling and CRM writes are explicit R24 non-goals a future capability performs by CONSUMING
  // this spec. Prompt execution is the FIRST response prepared here, not the engine's purpose.
  const responseSpec = buildResponseSpec(promptPlan);

  // Steps 7–8 — GENERATE → POLICY → AUDIT → ROUTE, delegated WHOLE to the ONE canonical dispatch. The
  // runtime adds no second path here: `dispatchReceptionistReply` generates the draft (R13) — from the
  // ONE `assembledContext` threaded in, not a second fetch — enforces the policy (R3), writes the
  // mandatory audit (R4), and routes the outcome (allow→transport, review→held for the Reply Review
  // Inbox, block→refused) exactly as it always has. The `input` is passed verbatim; the threaded
  // context re-shapes nothing — it only spares the generator a duplicate reconstruction.
  const dispatch = await dispatchReceptionistReply(input, assembledContext);

  // Step 9 — GOVERN the conversation's progression through the R17 FORMAL STATE MACHINE. Classify the
  // turn from its dispatch facts (the turn OUTCOME/event), then PLAN the transition: the state machine
  // folds the outcome to a target state and VALIDATES the (prior → target) edge against its declared
  // relation. Persist ONLY a validated `advance`, through the single org-scoped writer; an `unchanged`
  // self-loop writes nothing, and a `rejected` illegal edge is REFUSED and recorded (never persisted).
  // The machine is the single authority over progression, yet it derives the transition from the
  // coarse (prior state, outcome) ALONE — never from message content — so it governs the marker without
  // gating the turn (intent progression and slot filling stay non-goals). Best-effort: a failed advance
  // is logged, never thrown — a durable, audited reply is never undone by a bookkeeping write.
  const routing = classifyTurn({
    verdict: dispatch.decision?.verdict ?? null,
    duplicate: dispatch.transport.duplicate,
    auditProduced: dispatch.audit_id !== null,
  });
  const transition = planConversationTransition(priorState, routing);
  let stateAdvanced = false;
  if (conversationId && transition.kind === "advance") {
    try {
      await setConversationRuntimeState({
        org_id: input.org_id,
        conversation_id: conversationId,
        runtime_state: transition.to,
      });
      stateAdvanced = true;
    } catch (e) {
      console.error("[receptionist] runtime state advance failed", e);
    }
  } else if (conversationId && transition.kind === "rejected") {
    // The state machine refused an edge outside its declared relation — record the governance event;
    // the marker is left untouched. (Unreachable for a real turn: the fold's image is the legal-edge
    // relation, so a turn only ever yields `advance` or `unchanged`. The guard makes that law explicit.)
    console.error("[receptionist] runtime state transition REJECTED — illegal edge refused", {
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
    });
  }
  const nextState: ConversationState =
    transition.kind === "advance" ? transition.to : priorState;

  // Thread the OUTBOUND reply onto the same conversation timeline — but ONLY when a reply was actually
  // produced and audited (an `audit_id` exists). The entry REFERENCES that `ai_reply_audits` row (its
  // draft + decision IS the content; no copy), keeping exactly one source of truth. A duplicate /
  // no-audit dispatch threads nothing. Best-effort, like every substrate write. (Relocated here from
  // `processInboundEnquiry` so the runtime OWNS the outbound append.)
  if (conversationId && dispatch.audit_id) {
    try {
      await appendConversationMessage({
        conversation_id: conversationId,
        org_id: input.org_id,
        direction: "outbound",
        channel: input.channel,
        audit_id: dispatch.audit_id,
      });
    } catch (e) {
      console.error("[receptionist] outbound message append failed", e);
    }
  }

  return {
    conversation_id: conversationId,
    prior_state: priorState,
    routing,
    next_state: nextState,
    transition,
    state_advanced: stateAdvanced,
    prior_intent: priorIntent,
    resolved_intent: resolvedIntent,
    next_intent: nextIntent,
    intent_transition: intentTransition,
    intent_advanced: intentAdvanced,
    prior_goal: priorGoal,
    resolved_goal: resolvedGoal,
    next_goal: nextGoal,
    goal_transition: goalTransition,
    goal_advanced: goalAdvanced,
    prior_information: priorInformation,
    extracted_information: extractedInformation,
    next_information: nextInformation,
    information_update: informationUpdate,
    information_updated: informationUpdated,
    gap,
    strategy,
    prompt_plan: promptPlan,
    response_spec: responseSpec,
    context,
    dispatch,
  };
}

// =====================================================================
// THE HUMAN-REVIEWED SEND SEAM (CEO Directive #018, R14).
//
// R3's policy has three verdicts; R5/R6 built the outbound path for exactly ONE — the
// auto-sendable `allow`. The other actionable verdict, `review` ("the AI drafts, a HUMAN sends"),
// had no send path: a review reply was drafted, enforced and audited, then STOPPED at the
// deny-by-default gate in `dispatchReply`. This seam is that missing path — and it is NOT a second
// pipeline. It REUSES the same chain: the mandatory audit writer ({@link writeReplyAudit}), the same
// append-only `ai_reply_transports` ledger via {@link transportReply}, and the same unbypassable DB
// transport gate (which admits a transport ONLY for an `allowed = true` audit).
//
// THE HUMAN IS THE ENFORCEMENT AUTHORITY FOR `review`. A `review` verdict means the automatic
// guardrail declined to auto-send and deferred to a human. When a human reviews a held reply and
// chooses to send, THEY clear it — so the send is filed as an `allow` audit (the only class the DB
// gate will carry), with full provenance: the ORIGINAL automatic verdict, the held reply it
// resolves, and the reviewer. No information is lost — this audit's metadata and the resolution
// ledger jointly record that a human, not the classifier, authorised the send.
//
// THE ABSOLUTE `block` PROHIBITION REMAINS UNBYPASSABLE. A `block` is "never safe to send, not even
// by a human". So this seam RE-EVALUATES the policy over the (possibly edited) text and, if it is a
// `block`, records the refused attempt (mandatory audit, verdict='block', allowed=false) and
// transports NOTHING. A human can edit a review or send it verbatim, but can never push a prohibited
// claim through this door.
// =====================================================================

/** The producer label stamped on the audit + transport of a human-reviewed send. */
export const HUMAN_REVIEWED_PRODUCER = "human_reviewed_send";

/** The failure_reason recorded when a human-reviewed send is refused because the text is a `block`. */
export const HUMAN_REVIEWED_BLOCKED_REASON = "blocked_prohibited";

/** The inputs the human-reviewed send seam needs beyond the shared reply context. */
export type HumanReviewedSendInput = ReplyAuditContext & {
  /** The text the human is sending — the proposed draft as-is, or an edited version. */
  draft: string;
  /** The held reply this send resolves — the review-verdict `ai_reply_audits` id (provenance). */
  review_audit_id: string;
  /** The HQ user id that authorised the send (provenance; recorded in the audit metadata). */
  reviewed_by: string;
  /** Where the reply is sent (resolved to E.164 downstream); falls back to `customer_ref`. */
  destination?: string | null;
};

/**
 * Send ONE human-reviewed reply out through the canonical Enforce → Audit → Transport chain.
 *
 * Policy is STILL evaluated: the (possibly edited) text is classified by the R3 seam. A `block` is
 * refused absolutely — audited (mandatory) and never transported. Otherwise the human is the
 * authority that clears the `review`, so the send is filed as an ALLOWED audit (with provenance: the
 * automatic verdict, the held reply, the reviewer) and carried by {@link transportReply} — the SAME
 * transport seam, ledger and DB gate the autonomous path uses. Returns the standard dispatch outcome
 * so callers observe the audit id, the decision, and the transport result uniformly. It writes NO
 * resolution row — recording the human decision is the orchestrating service's job.
 */
export async function dispatchHumanReviewedReply(
  input: HumanReviewedSendInput,
): Promise<ReceptionistDispatchOutcome> {
  // (1) POLICY IS STILL EVALUATED — classify the human's text (to enforce the absolute block).
  const classification = enforceReceptionistReply(input.draft);
  const correlationId = input.correlation_id ?? crypto.randomUUID();
  const automaticVerdict = classification.verdict;

  const baseMeta: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    producer: HUMAN_REVIEWED_PRODUCER,
    reviewed_by: input.reviewed_by,
    review_audit_id: input.review_audit_id,
    automatic_verdict: automaticVerdict,
  };

  // (2) ABSOLUTE PROHIBITION: a `block` is never sendable, not even by a human. Record the refused
  //     attempt (mandatory audit, deny-by-default) and transport nothing.
  if (automaticVerdict === "block") {
    const auditId = await writeReplyAudit({
      org_id: input.org_id,
      channel: input.channel,
      correlation_id: correlationId,
      draft: input.draft,
      verdict: "block",
      allowed: false,
      reason: classification.reason,
      categories: classification.categories,
      safe_text: classification.safeText,
      enquiry_id: input.enquiry_id,
      lead_id: input.lead_id,
      customer_ref: input.customer_ref,
      conversation_id: input.conversation_id,
      metadata: baseMeta,
    });
    return {
      audit_id: auditId,
      correlation_id: correlationId,
      draft: input.draft,
      decision: classification,
      transport: {
        attempted: false,
        duplicate: false,
        transport_id: null,
        status: "skipped",
        provider_message_id: null,
        failure_reason: HUMAN_REVIEWED_BLOCKED_REASON,
      },
    };
  }

  // (3) The human CLEARS the `review` (or the text is already an `allow`). Fold the automatic
  //     verdict under HUMAN REVIEW AUTHORITY (the reviewer is the §9 A4 enforcement authority) and
  //     read the send decision back through the SAME `isAutoSendable` predicate the autonomous path
  //     uses — so `allowed` is DERIVED here, never asserted (deny-by-default is unbroken; the block
  //     above already refused the one verdict human authority cannot clear). File the resulting
  //     ALLOWED audit — the only class the DB transport gate carries — with full provenance; the
  //     raw guardrail evidence is preserved in `decision.result` for inspection.
  const cleared = clearForHumanSend(classification.result);
  const sendAllowed = isAutoSendable(cleared);
  const auditId = await writeReplyAudit({
    org_id: input.org_id,
    channel: input.channel,
    correlation_id: correlationId,
    draft: input.draft,
    verdict: cleared.verdict,
    allowed: sendAllowed,
    reason: cleared.reason,
    categories: cleared.categories,
    // The whole draft is the sent text on a human-approved send (not an acknowledgement remainder).
    safe_text: cleared.safeText,
    enquiry_id: input.enquiry_id,
    lead_id: input.lead_id,
    customer_ref: input.customer_ref,
    conversation_id: input.conversation_id,
    metadata: baseMeta,
  });

  // (4) TRANSPORT — the SAME seam, ledger and DB gate the autonomous path uses. The idempotency key
  //     is the held reply itself, so the partial-unique `(dedup_key) where status='sent'` index is
  //     the database backstop against a double human send of the same held reply (belt to the
  //     resolution ledger's UNIQUE(review_audit_id) braces).
  const transport = await transportReply({
    reply_audit_id: auditId,
    org_id: input.org_id,
    correlation_id: correlationId,
    destination: input.destination ?? input.customer_ref ?? null,
    body: input.draft,
    dedup_key: input.review_audit_id,
    producer: HUMAN_REVIEWED_PRODUCER,
  });

  return {
    audit_id: auditId,
    correlation_id: correlationId,
    draft: input.draft,
    decision: {
      allowed: sendAllowed,
      verdict: cleared.verdict,
      categories: cleared.categories,
      reason: cleared.reason,
      safeText: cleared.safeText,
      result: cleared,
    },
    transport,
  };
}

// =====================================================================
// CONTROLLED LIVE EXECUTION (CEO Directive #018, R6).
//
// R5 built the ONE outbound pipeline (Compose → Enforce → Audit → Transport) and proved
// it end to end, but left it a CALLABLE PRIMITIVE — nothing triggered it from a real
// inbound event. R6 arms exactly ONE real customer-facing behaviour, the missed-call SMS
// text-back, behind a feature flag that DEFAULTS OFF, and wires it into the existing
// inbound processor. It introduces NO new execution path: the live send REUSES
// `dispatchReceptionistReply` verbatim, so every customer message still flows Draft →
// Canonical Enforcement → Mandatory Audit → Transport Ledger → Provider — no exceptions,
// no parallel path, no bypass.
// =====================================================================

/**
 * Is the missed-call SMS text-back cleared for LIVE execution?
 *
 * The single runtime gate for R6's controlled activation. Reads
 * `NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK` — schema-validated to "true" | "false" with
 * DEFAULT "false" at boot by lib/env.ts — at CALL TIME (the same convention this service
 * already uses for `process.env.ANTHROPIC_API_KEY`), so the switch is a genuine runtime
 * toggle rather than a value frozen at import. Unset or "false" ⇒ OFF ⇒ the inbound flow
 * is byte-for-byte its pre-R6 self and NO outbound SMS is attempted; only an explicit
 * "true" arms the canonical dispatch.
 */
export function isMissedCallTextbackLive(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK === "true";
}

/**
 * The outcome of the (flag-gated) missed-call text-back side-effect, surfaced on the
 * inbound result so a caller — or a test — can see whether the live path ran and why.
 * `attempted:false` names the reason it stayed inert; `attempted:true` carries either the
 * full canonical dispatch outcome or the error that was swallowed to protect ingestion.
 */
export type MissedCallTextbackResult =
  | { attempted: false; reason: "flag_off" | "unsupported_channel" | "no_destination" }
  | { attempted: true; dispatch: ReceptionistDispatchOutcome }
  | { attempted: true; error: string };

/**
 * The R6 wiring: when armed, text a MISSED CALL back through the ONE canonical pipeline.
 *
 * Three gates, in order, decide whether a send is even considered — each a plain early
 * return, never a throw:
 *   1. the live-execution FLAG (default OFF) — off ⇒ `flag_off`, nothing happens;
 *   2. the CHANNEL — R6 activates ONLY the missed-call (phone) text-back; every other
 *      inbound channel is an explicit non-goal and stays unchanged (`unsupported_channel`);
 *   3. a DESTINATION — a text-back needs a number to answer (`no_destination`).
 *
 * Past the gates it delegates to {@link runConversationTurn} — the R15 CONVERSATION RUNTIME,
 * the single orchestration layer, which resolves the conversation, loads its timeline, assembles
 * its context, determines its state, then runs the SAME canonical pipeline R5 shipped WHOLE through
 * {@link dispatchReceptionistReply} (compose the acknowledgement, enforce the policy, write the
 * mandatory audit, run the deny-by-default gate, file the transport, short-circuit a duplicate),
 * and finally advances the runtime-state marker. It adds NO new door to a provider. The whole
 * delegation is wrapped so an outbound failure can NEVER corrupt inbound ingestion: the enquiry and
 * lead are already durably recorded, so a throw here is logged, captured on the result, and swallowed.
 */
async function maybeTextBackMissedCall(input: {
  org_id: string;
  channel: InboundChannel;
  conversation_id: string | null;
  enquiry_id: string;
  lead_id: string | null;
  caller: string | null;
  dedup_key: string | null;
}): Promise<MissedCallTextbackResult> {
  if (!isMissedCallTextbackLive()) return { attempted: false, reason: "flag_off" };
  if (input.channel !== "phone") return { attempted: false, reason: "unsupported_channel" };
  const destination = input.caller?.trim();
  if (!destination) return { attempted: false, reason: "no_destination" };

  try {
    // Route through the R15 CONVERSATION RUNTIME — the single orchestration layer. It resolves this
    // conversation, loads its timeline, assembles its context, determines its state, then delegates
    // GENERATE → POLICY → AUDIT → ROUTE WHOLE to `dispatchReceptionistReply` (the SAME canonical
    // pipeline R5/R6 shipped — no new door to a provider), and finally advances the runtime-state
    // marker. We surface only the underlying dispatch so this result's shape is unchanged.
    const turn = await runConversationTurn({
      org_id: input.org_id,
      channel: input.channel, // "phone" → the voice-shaped acknowledgement, carried over SMS
      // The R13 generator reasons over this conversation's canonical R12 context (which already
      // includes the just-threaded inbound turn); absent, it drafts the deterministic acknowledgement.
      conversation_id: input.conversation_id,
      enquiry_id: input.enquiry_id,
      lead_id: input.lead_id,
      customer_ref: destination,
      // A stable per-call id (CallSid) dedupes webhook replays; absent, the dispatch
      // falls back to the enquiry id for idempotency.
      metadata: input.dedup_key ? { dedup_key: input.dedup_key } : {},
    });
    return { attempted: true, dispatch: turn.dispatch };
  } catch (err) {
    // NEVER let an outbound failure fail the inbound event — ingestion is already durable.
    console.error("[receptionist] missed-call text-back failed", err);
    return { attempted: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Phase A — AI Receptionist processor.
 *
 * The single entry-point every channel adapter (phone webhook, SMS
 * webhook, WhatsApp Business, Instagram DM, Facebook DM) feeds.
 *
 *   0. RESOLVE the persistent conversation this contact belongs to and
 *      thread the inbound + any outbound message onto its timeline
 *      (Directive #018 R10 substrate). BEST-EFFORT — sits beneath the
 *      pipeline, never disturbs ingestion or the deterministic reply.
 *   1. INSERT raw row into `inbound_enquiries` (status='received'),
 *      linked to the resolved conversation.
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
): Promise<{
  enquiry_id: string;
  lead_id: string | null;
  conversation_id: string | null;
  textback: MissedCallTextbackResult;
}> {
  const admin = createAdminClient();

  // Step 0 — CONVERSATION SUBSTRATE (CEO Directive #018, R10). Resolve (or create) the
  // persistent conversation this contact belongs to BEFORE the enquiry is recorded, so the
  // raw row can be linked to its thread on insert. A repeat contact on the same channel folds
  // into the SAME conversation; an absent identifier resolves to null (no contact ⇒ no thread).
  // BEST-EFFORT: the substrate sits BENEATH the pipeline as shared infrastructure — a resolve
  // failure is logged and swallowed so it can NEVER disturb the durable ingestion contract or
  // change one byte of the deterministic reply behaviour.
  let conversationId: string | null = null;
  try {
    conversationId = await resolveConversation({
      org_id: input.org_id,
      channel: input.channel,
      contact_ref: input.caller,
    });
  } catch (e) {
    console.error("[receptionist] conversation resolve failed", e);
  }

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
      conversation_id: conversationId,
    })
    .select("id")
    .single();
  if (insErr || !enquiryRow?.id) {
    throw new Error(`inbound_enquiries insert failed: ${insErr?.message ?? "no id"}`);
  }
  const enquiryId = enquiryRow.id;

  // Thread the inbound message onto the conversation timeline — an entry that REFERENCES the
  // enquiry just recorded (its raw_text IS the content; no copy). Best-effort, exactly as the
  // resolve above: a threading failure is logged and swallowed, never surfaced to ingestion.
  if (conversationId) {
    try {
      await appendConversationMessage({
        conversation_id: conversationId,
        org_id: input.org_id,
        direction: "inbound",
        channel: input.channel,
        enquiry_id: enquiryId,
      });
    } catch (e) {
      console.error("[receptionist] inbound message append failed", e);
    }
  }

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

  // Step 6 — CONTROLLED LIVE EXECUTION (CEO Directive #018, R6). Behind the default-OFF
  // NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK flag, a MISSED CALL (channel 'phone') with a
  // caller to answer is texted back through the ONE canonical outbound pipeline. Placed
  // AFTER — and independent of — lead creation: the missed CALL is the trigger, so a
  // caller is acknowledged even if extraction produced no lead. It NEVER throws, so it
  // cannot disturb the ingestion contract above; with the flag OFF it is wholly inert.
  const textback = await maybeTextBackMissedCall({
    org_id: input.org_id,
    channel: input.channel,
    conversation_id: conversationId,
    enquiry_id: enquiryId,
    lead_id: leadId,
    caller: input.caller ?? null,
    dedup_key: input.dedup_key ?? null,
  });

  // The OUTBOUND reply is threaded onto the conversation timeline by the R15 CONVERSATION RUNTIME
  // ({@link runConversationTurn}), which `maybeTextBackMissedCall` now delegates to — so the runtime
  // OWNS the outbound append (alongside advancing the runtime-state marker), keeping the whole turn
  // in the single orchestration layer. There is no append here: the inbound processor threads only
  // the INBOUND turn (step 0 above) and hands the turn to the runtime.

  return { enquiry_id: enquiryId, lead_id: leadId, conversation_id: conversationId, textback };
}

// =====================================================================
// ASYNC DELIVERY RECEIPTS (CEO Directive #018, R7).
//
// R5/R6 recorded the provider's SYNCHRONOUS acceptance (`sent` + the acceptance
// status). Acceptance is not delivery: "There must never be an unknown final state
// once the provider has reported it." R7 completes the lifecycle by ingesting the
// provider's ASYNCHRONOUS terminal status over an authenticated status-callback
// webhook and recording it — WITHOUT mutating the append-only transport row.
//
// The transport ledger is hard append-only, so a delivery status is recorded as a
// NEW, correlated receipt row (`ai_reply_delivery_receipts`), never an in-place edit.
// The delivery lifecycle of a message is the transport PLUS its ordered receipts. This
// is the ONE persistence path for a receipt: it reuses the same service-role-only
// SECURITY DEFINER + throw-on-failure discipline as the audit and transport writes,
// introduces NO new transport and NO new provider send, and does NOT touch the
// best-effort event spine — the append-only ledger IS the audit of record (the R4
// separation), so a receipt row is itself the durable delivery event.
// =====================================================================

// `record_ai_reply_delivery_receipt` is a service-role-only SECURITY DEFINER primitive
// that RETURNS A TABLE (one outcome row), and is not in the generated Database types —
// cast past the typed client, the same `as unknown as` convention as the audit and
// transport writes above.
type DeliveryReceiptRpcRow = {
  receipt_id: string | null;
  transport_id: string | null;
  reply_audit_id: string | null;
  org_id: string | null;
  is_terminal: boolean | null;
  was_duplicate: boolean;
  transport_found: boolean;
};
type RecordDeliveryReceiptRpc = (
  fn: "record_ai_reply_delivery_receipt",
  args: Record<string, unknown>,
) => Promise<{ data: DeliveryReceiptRpcRow[] | null; error: { message: string } | null }>;

/**
 * The outcome of ingesting one async delivery receipt.
 *   • `recorded:false`/`unknown_message` — the provider message id correlates to no
 *     SENT transport this ledger ever produced; NOTHING was recorded (the webhook
 *     rejects an unknown identifier).
 *   • `recorded:true` — a receipt exists for this (message id, status). `duplicate`
 *     is true when a prior identical callback had already recorded it (idempotent
 *     no-op); `terminal` marks a final delivery state.
 */
export type SmsDeliveryReceiptResult =
  | { recorded: false; reason: "unknown_message" }
  | {
      recorded: true;
      duplicate: boolean;
      receipt_id: string;
      transport_id: string;
      reply_audit_id: string;
      org_id: string;
      status: SmsDeliveryStatus;
      terminal: boolean;
    };

/**
 * Correlate one provider delivery receipt to the transport it belongs to and record
 * it — the SINGLE server-side persistence path for R7, called ONLY by the
 * authenticated Twilio status-callback route.
 *
 * It delegates the whole TRANSPORT LOOKUP → CORRELATION → IDEMPOTENT APPEND to the
 * service-role-only `record_ai_reply_delivery_receipt` primitive, which resolves the
 * SENT transport by the provider message id, copies the org / audit / employee /
 * channel / provider FROM that authoritative row (never trusting the caller), and
 * inserts a new receipt `on conflict (provider_message_id, status) do nothing`. So an
 * unknown message id records nothing (returns `unknown_message`), and a duplicate
 * callback is an idempotent no-op that returns the existing receipt.
 *
 * MANDATORY, throw-on-failure, exactly like the audit and transport writes: a receipt
 * whose write ERRORED is a loud failure the webhook surfaces (so the provider retries),
 * never a swallowed no-op. A "no transport found" is NOT an error — it is a recorded
 * decision the route answers cleanly.
 */
export async function recordSmsDeliveryReceipt(
  receipt: SmsDeliveryReceipt,
): Promise<SmsDeliveryReceiptResult> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as RecordDeliveryReceiptRpc;
  const { data, error } = await rpc("record_ai_reply_delivery_receipt", {
    p_provider_message_id: receipt.providerMessageId,
    p_status: receipt.status,
    p_provider_status: receipt.providerStatus ?? null,
    p_error_code: receipt.errorCode ?? null,
    p_metadata: {},
  });

  if (error) {
    throw new Error(
      "ai_reply_delivery_receipts write failed — a delivery receipt could not be recorded: " +
        error.message,
    );
  }

  const row = data?.[0];
  if (!row || !row.transport_found || !row.receipt_id) {
    return { recorded: false, reason: "unknown_message" };
  }

  return {
    recorded: true,
    duplicate: row.was_duplicate,
    receipt_id: row.receipt_id,
    transport_id: row.transport_id as string,
    reply_audit_id: row.reply_audit_id as string,
    org_id: row.org_id as string,
    status: receipt.status,
    terminal: Boolean(row.is_terminal),
  };
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

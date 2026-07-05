import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  reconstructConversation,
  type ReconstructedConversation,
} from "@/server/services/receptionist-conversation-reads";
import {
  dispatchHumanReviewedReply,
  HUMAN_REVIEWED_BLOCKED_REASON,
  type ReceptionistDispatchOutcome,
} from "@/server/services/receptionist";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import type { InboundChannel } from "@/lib/receptionist/types";

// =====================================================================
// THE REPLY REVIEW INBOX — HUMAN HANDOFF ORCHESTRATION (CEO Directive #018, R14).
//
// R3's policy defers every `review` reply to a human ("the AI drafts, a HUMAN sends"). R4 already
// files that held reply as an `ai_reply_audits` row (verdict='review', allowed=false). This module
// is the operational half that lets a human ACT on it. It is the CANONICAL CONSUMER of the
// conversation engine: to review a held reply it reconstructs the whole conversation through R11's
// `reconstructConversation` (it does NOT re-implement reconstruction, and does NOT assemble context
// itself) and it sends through the R14 `dispatchHumanReviewedReply` seam, which REUSES the canonical
// Enforce → Audit → Transport chain. It opens NO new store of message content and NO second send
// path.
//
// Its four powers, each auditable:
//   • READ    — project the held replies (the review queue) and reconstruct one for review.
//   • OWN      — claim / release a conversation (assignment) through the SECURITY DEFINER writer.
//   • SEND     — dispatch a human-reviewed reply through the existing pipeline, then record the
//                human decision in the append-only resolution ledger (sent + the audit it produced).
//   • DISMISS  — record the human decision to NOT send (resolution ledger; no transport).
//
// Every write goes through a service-role-only SECURITY DEFINER primitive (the queue view, the
// assignment writer, the resolution writer) cast past the generated types with the same
// `as unknown as` convention the reply ledgers use. Reads are org-scoped where an org is known;
// the HQ inbox is deliberately cross-tenant (like the R9 delivery monitor), so `listReviewQueue`
// accepts an OPTIONAL org filter and every mutation re-derives the org from the held reply itself.
// =====================================================================

/** One row of the `receptionist_review_queue` view — a held reply with its conversation + ownership
 *  + resolution state resolved. The resolution_* fields are NULL while the reply is still pending. */
export type ReviewQueueItem = {
  review_audit_id: string;
  org_id: string;
  employee_slug: string;
  channel: string;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
  correlation_id: string;
  draft: string;
  categories: string[] | null;
  reason: string;
  safe_text: string | null;
  metadata: Record<string, unknown> | null;
  held_at: string;
  // Conversation + contact identity (resolved from the audit's conversation link).
  conversation_id: string | null;
  contact_ref: string | null;
  contact_name: string | null;
  conversation_status: string | null;
  message_count: number | null;
  last_message_at: string | null;
  // Ownership stamp.
  assignee_id: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  // Resolution state — NULL ⇒ still pending.
  resolution_id: string | null;
  resolution: "sent" | "dismissed" | null;
  sent_audit_id: string | null;
  resolution_edited: boolean | null;
  resolved_by: string | null;
  resolved_by_email: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
};

/** A held reply reconstructed for review — the queue row plus the full conversation timeline (via
 *  the R11 read model). `conversation` is null for a held reply with no threaded conversation. */
export type ReviewItemDetail = {
  item: ReviewQueueItem;
  conversation: ReconstructedConversation | null;
};

/** The outcome of a human SEND action on a held reply. */
export type ReviewSendResult =
  | { ok: true; edited: boolean; outcome: ReceptionistDispatchOutcome }
  | {
      ok: false;
      reason: "not_found" | "already_resolved" | "blocked";
      outcome?: ReceptionistDispatchOutcome;
    };

/** The outcome of a human DISMISS action on a held reply. */
export type ReviewDismissResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_resolved" };

const QUEUE_COLUMNS =
  "review_audit_id, org_id, employee_slug, channel, enquiry_id, lead_id, customer_ref, " +
  "correlation_id, draft, categories, reason, safe_text, metadata, held_at, conversation_id, " +
  "contact_ref, contact_name, conversation_status, message_count, last_message_at, " +
  "assignee_id, assigned_at, assigned_by, resolution_id, resolution, sent_audit_id, " +
  "resolution_edited, resolved_by, resolved_by_email, resolution_note, resolved_at";

// The queue view is a service-role-only internal (not in the generated Database types) — cast past
// the typed client to the minimal chainable surface these reads use, the same convention the R9
// delivery surface and the R11 read model use. The builder is a thenable, so `await` yields the
// { data, error } envelope.
type ReadResult<Row> = { data: Row[] | null; error: { message: string } | null };
interface ReadQuery<Row> extends PromiseLike<ReadResult<Row>> {
  select(columns: string): ReadQuery<Row>;
  eq(column: string, value: string): ReadQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): ReadQuery<Row>;
  limit(count: number): ReadQuery<Row>;
}

function queueView(): ReadQuery<ReviewQueueItem> {
  const admin = createAdminClient();
  return admin.from(
    "receptionist_review_queue" as never,
  ) as unknown as ReadQuery<ReviewQueueItem>;
}

// The two SECURITY DEFINER writers are service-role-only and not in the generated types — cast past
// the typed client, the same `as unknown as` convention as `record_ai_reply_*`.
type AssignConversationRpc = (
  fn: "assign_receptionist_conversation",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;
type RecordResolutionRpc = (
  fn: "record_receptionist_review_resolution",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** True when a queue item is still awaiting a human decision (the single pending predicate, shared
 *  by the inbox UI and any consumer so "pending" is defined in exactly one place). */
export function isPendingReview(item: ReviewQueueItem): boolean {
  return item.resolution_id === null;
}

/**
 * The review queue — held replies newest-first. Optionally org-scoped; omit `org_id` for the
 * cross-tenant HQ inbox (like the R9 delivery monitor). Returns every held reply (pending AND
 * resolved) so a caller can bucket them; capped by `limit` (default 500). Read-only projection.
 */
export async function listReviewQueue(input?: {
  org_id?: string;
  limit?: number;
}): Promise<ReviewQueueItem[]> {
  const limit = input?.limit ?? 500;
  let q = queueView().select(QUEUE_COLUMNS);
  if (input?.org_id) q = q.eq("org_id", input.org_id);
  const { data, error } = await q.order("held_at", { ascending: false }).limit(limit);
  if (error) {
    throw new Error("receptionist_review_queue read failed: " + error.message);
  }
  return data ?? [];
}

/** One held reply's queue row by its review-audit id, or null if it does not exist. Optionally
 *  org-scoped. The single-row primitive the detail loader + the mutations build on. */
export async function getReviewQueueItem(input: {
  review_audit_id: string;
  org_id?: string;
}): Promise<ReviewQueueItem | null> {
  let q = queueView().select(QUEUE_COLUMNS).eq("review_audit_id", input.review_audit_id);
  if (input.org_id) q = q.eq("org_id", input.org_id);
  const { data, error } = await q.limit(1);
  if (error) {
    throw new Error("receptionist_review_queue read failed: " + error.message);
  }
  return data?.[0] ?? null;
}

/**
 * Reconstruct a held reply FOR REVIEW — its queue row plus the FULL conversation timeline. THE
 * canonical-consumer entry point: it reconstructs the conversation through R11's
 * `reconstructConversation` (org-scoped by the held reply's own org), never re-implementing
 * reconstruction. Returns null when the held reply does not exist; `conversation` is null when the
 * held reply has no threaded conversation (a contactless enquiry).
 */
export async function getReviewItem(input: {
  review_audit_id: string;
  org_id?: string;
}): Promise<ReviewItemDetail | null> {
  const item = await getReviewQueueItem(input);
  if (!item) return null;

  const conversation = item.conversation_id
    ? await reconstructConversation({
        org_id: item.org_id,
        conversation_id: item.conversation_id,
      })
    : null;

  return { item, conversation };
}

/**
 * Claim (or reassign) a conversation for a human. Org-scoped through the SECURITY DEFINER writer:
 * a caller can only ever assign a conversation in the org it names. Returns true when a row
 * matched (the assignment took), false when no such conversation exists in that org.
 */
export async function claimReviewConversation(input: {
  conversation_id: string;
  org_id: string;
  assignee_id: string;
  assigned_by: string;
}): Promise<boolean> {
  return assignConversation({
    conversation_id: input.conversation_id,
    org_id: input.org_id,
    assignee_id: input.assignee_id,
    assigned_by: input.assigned_by,
  });
}

/** Release a conversation (clear its ownership stamp). Returns true when a row matched. */
export async function releaseReviewConversation(input: {
  conversation_id: string;
  org_id: string;
}): Promise<boolean> {
  return assignConversation({
    conversation_id: input.conversation_id,
    org_id: input.org_id,
    assignee_id: null,
    assigned_by: null,
  });
}

async function assignConversation(input: {
  conversation_id: string;
  org_id: string;
  assignee_id: string | null;
  assigned_by: string | null;
}): Promise<boolean> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as AssignConversationRpc;
  const { data, error } = await rpc("assign_receptionist_conversation", {
    p_conversation_id: input.conversation_id,
    p_org_id: input.org_id,
    p_assignee_id: input.assignee_id,
    p_assigned_by: input.assigned_by,
  });
  if (error) {
    throw new Error("assign_receptionist_conversation failed: " + error.message);
  }
  return data !== null;
}

/**
 * SEND a human-reviewed reply. The `text` is the proposed draft as-is, or an edited version. Runs
 * the canonical Enforce → Audit → Transport chain via {@link dispatchHumanReviewedReply} (policy is
 * STILL evaluated; an absolute `block` is refused and NOT resolved), then records the human decision
 * in the append-only resolution ledger. Returns a discriminated result the action layer surfaces.
 */
export async function resolveReviewSend(input: {
  review_audit_id: string;
  text: string;
  reviewed_by: string;
  reviewed_by_email?: string | null;
}): Promise<ReviewSendResult> {
  const item = await getReviewQueueItem({ review_audit_id: input.review_audit_id });
  if (!item) return { ok: false, reason: "not_found" };
  if (!isPendingReview(item)) return { ok: false, reason: "already_resolved" };

  const edited = normalise(input.text) !== normalise(item.draft);

  // The canonical pipeline. A block is audited + refused inside here; it never transports.
  const outcome = await dispatchHumanReviewedReply({
    org_id: item.org_id,
    channel: item.channel as InboundChannel,
    conversation_id: item.conversation_id,
    enquiry_id: item.enquiry_id,
    lead_id: item.lead_id,
    customer_ref: item.customer_ref,
    destination: item.customer_ref,
    draft: input.text,
    review_audit_id: item.review_audit_id,
    reviewed_by: input.reviewed_by,
  });

  // A prohibited (block) reply is refused, not resolved — the item stays pending (it can only be
  // dismissed, never sent). The refusal is fully audited by the seam above.
  if (outcome.transport.failure_reason === HUMAN_REVIEWED_BLOCKED_REASON) {
    return { ok: false, reason: "blocked", outcome };
  }

  const resolutionId = await recordReviewResolution({
    org_id: item.org_id,
    review_audit_id: item.review_audit_id,
    resolution: "sent",
    resolved_by: input.reviewed_by,
    conversation_id: item.conversation_id,
    sent_audit_id: outcome.audit_id,
    edited,
    resolved_by_email: input.reviewed_by_email ?? null,
    note: null,
  });

  // A NULL id means a concurrent reviewer resolved this held reply first. The transport dedup index
  // (dedup_key = review_audit_id, where status='sent') has already prevented a duplicate send.
  if (resolutionId === null) return { ok: false, reason: "already_resolved", outcome };

  // R30 — FULFIL. The human has now APPROVED this held reply (a durable `sent` resolution above). If the reply
  // was a held BOOKING confirmation, that grant authorises the R30 CONVERSATION FULFILMENT ENGINE to CARRY OUT
  // the approved internal business operation — materialise the booking as ONE idempotent, append-only record
  // (server/services/receptionist-fulfilment.ts). This is the SOLE caller of the Fulfilment Engine, and it fires
  // ONLY here — strictly downstream of a human's `sent` resolution — so Human Review can NEVER be bypassed by
  // construction. The Authorisation Engine stays authoritative (the runtime folds the grant through R29's own
  // `deriveAuthorisationState`), and the write is IDEMPOTENT (a repeat send performs the booking at most once via
  // UNIQUE(authorisation_id)). BEST-EFFORT: the runtime logs and returns null on any failure, and a non-booking
  // reply resolves to no fulfilment — a durable, human-approved confirmation reply is never undone by this write.
  // A sent reply always produces an audit; the guard both satisfies the fulfilment's NOT NULL provenance
  // (`sent_audit_id`) and makes the "no audit ⇒ nothing to fulfil" case explicit.
  if (outcome.audit_id !== null) {
    await fulfilApprovedBooking({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });

    // R31 — VERIFY. STRICTLY AFTER the R30 fulfilment above (the write is awaited and committed first), the R31
    // CONVERSATION VERIFICATION ENGINE independently RECONCILES the fulfilment R30 decided against the record it
    // filed (server/services/receptionist-verification.ts) and records an auditable INTEGRITY verdict — `consistent`
    // when the record matches, `missing` when the approved operation went unrecorded (R30's best-effort gap made
    // observable), `inconsistent` when the record diverges. It VERIFIES work; it performs NO business action. This
    // is the SOLE caller of the Verification Engine, and it fires ONLY here — downstream of the SAME human grant, so
    // Human Review can NEVER be bypassed by construction. The Fulfilment and Authorisation Engines stay
    // authoritative (the runtime re-derives the expected fulfilment through R30's own `resolveFulfilment` and folds
    // the grant through R29's own `deriveAuthorisationState`), and the write is IDEMPOTENT (a repeat verifies at
    // most once via UNIQUE(authorisation_id)). BEST-EFFORT: the runtime logs and returns null on any failure, and a
    // non-booking reply verifies nothing — a durable, human-approved confirmation reply, and the booking R30 already
    // performed, are never undone by this verification write.
    await verifyApprovedFulfilment({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });

    // R32 — DETERMINE RECOVERY. STRICTLY AFTER the R31 verification above (that write is awaited and committed
    // first), the R32 CONVERSATION RECOVERY ENGINE reads R31's RECORDED verification verdict and CLASSIFIES it into
    // the recovery it warrants (server/services/receptionist-recovery.ts) — `none` when the verification was
    // `consistent` (no recovery required), `reinstate` when it was `missing`, `reconcile` when it was `inconsistent`
    // — recording an auditable RECOVERY disposition. It DETERMINES recovery; it EXECUTES no recovery action (it
    // re-books nothing, retries nothing, schedules nothing). This is the SOLE caller of the Recovery Engine, and it
    // fires ONLY here — downstream of the SAME human grant AND the recorded verification, so Human Review can NEVER be
    // bypassed by construction. The Verification Engine stays authoritative (the runtime consumes R31's RECORDED
    // decision through R32's own `resolveRecovery`, never re-verifying), and the write is IDEMPOTENT (a repeat
    // determines recovery at most once via UNIQUE(authorisation_id)). BEST-EFFORT: the runtime logs and returns null
    // on any failure, and a reply with no recorded verification recovers nothing — a durable, human-approved
    // confirmation reply, and the booking R30 performed, and the verdict R31 recorded, are never undone by this write.
    await recoverVerifiedFulfilment({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });

    // R33 — DETERMINE RESOLUTION. STRICTLY AFTER the R32 recovery above (that write is awaited and committed first),
    // the R33 CONVERSATION RESOLUTION ENGINE reads R32's RECORDED recovery disposition and CLASSIFIES it into the
    // conversation-completion state it implies (server/services/receptionist-resolution.ts) — `terminal` when the
    // recovery was `none` (the conversation is fully resolved, no further intervention), `recoverable` when it was
    // `reinstate` (a clear recovery path exists), `unresolved` when it was `reconcile` (the record is ambiguous) —
    // recording an auditable RESOLUTION state and whether further intervention is required. It DETERMINES completion;
    // it EXECUTES no recovery or business action (it re-books nothing, reconciles nothing, retries nothing, schedules
    // nothing). This is the SOLE caller of the Resolution Engine, and it fires ONLY here — downstream of the SAME
    // human grant AND the recorded recovery, so Human Review can NEVER be bypassed by construction. The Recovery
    // Engine stays authoritative (the runtime consumes R32's RECORDED decision through R33's own
    // `resolveConversationResolution`, never re-recovering), and the write is IDEMPOTENT (a repeat determines
    // resolution at most once via UNIQUE(recovery_id)). BEST-EFFORT: the runtime logs and returns null on any failure,
    // and a reply with no recorded recovery resolves nothing — a durable, human-approved confirmation reply, and the
    // booking R30 performed, the verdict R31 recorded and the recovery R32 determined, are never undone by this write.
    await resolveConversationCompletion({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });

    // R34 — GOVERN LIFECYCLE. STRICTLY AFTER the R33 resolution above (that write is awaited and committed first),
    // the R34 CONVERSATION LIFECYCLE ENGINE reads R33's RECORDED resolution state and GOVERNS the conversation into
    // the lifecycle transition and state it warrants (server/services/receptionist-lifecycle.ts) — `close`→`closed`
    // when the resolution was `terminal` (the conversation is done), `retain`→`retained` when it was `recoverable`
    // (a recovery path is open, keep the conversation live), `escalate`→`escalated` when it was `unresolved` (the
    // record is ambiguous, hand it to a human) — recording an auditable LIFECYCLE decision and whether the
    // conversation is closed or ongoing. It GOVERNS the conversation lifecycle; it EXECUTES no business action (it
    // re-books nothing, retries nothing, schedules nothing, promotes no customer, fulfils no quote). This is the SOLE
    // caller of the Lifecycle Engine, and it fires ONLY here — downstream of the SAME human grant AND the recorded
    // resolution, so Human Review can NEVER be bypassed by construction. The Resolution Engine stays authoritative
    // (the runtime consumes R33's RECORDED decision through R34's own `resolveConversationLifecycle`, never
    // re-resolving), and the write is IDEMPOTENT (a repeat governs the lifecycle at most once via
    // UNIQUE(resolution_id)). BEST-EFFORT: the runtime logs and returns null on any failure, and a reply with no
    // recorded resolution governs nothing — a durable, human-approved confirmation reply, the booking R30 performed,
    // the verdict R31 recorded, the recovery R32 determined and the resolution R33 decided are never undone by this
    // write.
    await governConversationLifecycle({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });

    // R35 — ORCHESTRATE THE RESPONSE. STRICTLY AFTER the R34 lifecycle above (that write is awaited and committed
    // first), the R35 CONVERSATION ORCHESTRATION ENGINE reads R34's RECORDED lifecycle state and ROUTES it to the
    // platform capability that should RESPOND (server/services/receptionist-orchestration.ts) — `conclude`→
    // `conversation_conclusion` when the lifecycle was `closed` (the conversation is done, route it to conclusion),
    // `recover`→`recovery_handling` when it was `retained` (a recovery path is open, route it to recovery handling),
    // `escalate`→`human_attention` when it was `escalated` (the record is ambiguous, route it to human attention) —
    // recording an auditable ORCHESTRATION decision and whether the conversation's orchestration is concluded or an
    // active capability response is routed. It ROUTES work; it EXECUTES no work (it concludes nothing, recovers
    // nothing, escalates nothing, enqueues nothing, notifies no one, retries nothing, schedules nothing). This is the
    // SOLE caller of the Orchestration Engine, and it fires ONLY here — downstream of the SAME human grant AND the
    // recorded lifecycle, so Human Review can NEVER be bypassed by construction. The Lifecycle Engine stays
    // authoritative (the runtime consumes R34's RECORDED decision through R35's own `resolveConversationOrchestration`,
    // never re-governing), and the write is IDEMPOTENT (a repeat orchestrates at most once via UNIQUE(lifecycle_id)).
    // BEST-EFFORT: the runtime logs and returns null on any failure, and a reply with no recorded lifecycle
    // orchestrates nothing — a durable, human-approved confirmation reply, the booking R30 performed, the verdict R31
    // recorded, the recovery R32 determined, the resolution R33 decided and the lifecycle R34 governed are never undone
    // by this write.
    await orchestrateConversationLifecycle({
      org_id: item.org_id,
      review_audit_id: item.review_audit_id,
      sent_audit_id: outcome.audit_id,
      review_resolution_id: resolutionId,
    });
  }

  return { ok: true, edited, outcome };
}

/**
 * DISMISS a held reply — record the human decision to NOT send. No transport, no new reply audit;
 * only the append-only resolution ledger entry. Returns a discriminated result.
 */
export async function resolveReviewDismiss(input: {
  review_audit_id: string;
  reviewed_by: string;
  reviewed_by_email?: string | null;
  note?: string | null;
}): Promise<ReviewDismissResult> {
  const item = await getReviewQueueItem({ review_audit_id: input.review_audit_id });
  if (!item) return { ok: false, reason: "not_found" };
  if (!isPendingReview(item)) return { ok: false, reason: "already_resolved" };

  const resolutionId = await recordReviewResolution({
    org_id: item.org_id,
    review_audit_id: item.review_audit_id,
    resolution: "dismissed",
    resolved_by: input.reviewed_by,
    conversation_id: item.conversation_id,
    sent_audit_id: null,
    edited: false,
    resolved_by_email: input.reviewed_by_email ?? null,
    note: input.note ?? null,
  });

  if (resolutionId === null) return { ok: false, reason: "already_resolved" };
  return { ok: true };
}

async function recordReviewResolution(input: {
  org_id: string;
  review_audit_id: string;
  resolution: "sent" | "dismissed";
  resolved_by: string;
  conversation_id: string | null;
  sent_audit_id: string | null;
  edited: boolean;
  resolved_by_email: string | null;
  note: string | null;
}): Promise<string | null> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as RecordResolutionRpc;
  const { data, error } = await rpc("record_receptionist_review_resolution", {
    p_org_id: input.org_id,
    p_review_audit_id: input.review_audit_id,
    p_resolution: input.resolution,
    p_resolved_by: input.resolved_by,
    p_conversation_id: input.conversation_id,
    p_sent_audit_id: input.sent_audit_id,
    p_edited: input.edited,
    p_resolved_by_email: input.resolved_by_email,
    p_note: input.note,
  });
  if (error) {
    throw new Error("record_receptionist_review_resolution failed: " + error.message);
  }
  return data;
}

/** Normalise a draft for the edited comparison — trim + collapse trailing whitespace only, so an
 *  incidental leading/trailing space is not counted as an edit but a genuine change is. */
function normalise(text: string): string {
  return text.trim();
}

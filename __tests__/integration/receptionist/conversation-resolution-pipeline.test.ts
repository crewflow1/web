import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Resolution pipeline — real-Postgres proof of the AI Receptionist Programme R33
 * (CONVERSATION RESOLUTION ENGINE), the THIRD layer that does not perform: given an APPROVED, PERFORMED, VERIFIED,
 * RECOVERED fulfilment it reads R32's RECORDED recovery disposition and CLASSIFIES it into the conversation-completion
 * state it implies — `terminal` (none, fully resolved), `recoverable` (reinstate, a clear recovery path),
 * `unresolved` (reconcile, an ambiguous record) — filing an auditable RESOLUTION. It DETERMINES completion; it
 * EXECUTES no recovery or business action.
 *
 * The unit tier proves the pure core resolves a resolution DECISION deterministically, DEFERS when R32 rendered no
 * decision, folds the recovery classification to its state, and keeps `terminal` / `intervention_required` coherent;
 * the security tier proves, as SOURCE, that the ledger is append-only, service-role-only, approved-only, state-coherent,
 * terminal-coherent, intervention-coherent and idempotent, that the Recovery (R32), Verification (R31) and Fulfilment
 * (R30) Engines stay authoritative, that Human Review can never be bypassed, and that no duplicate resolution logic
 * exists. This tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME actually reads R32's
 * RECORDED recovery behind a held reply, reconstructs the recovery decision, classifies it against a live database,
 * exactly one idempotent resolution row is really filed with the right state, and the migration's storage / RLS /
 * append-only guard / privilege model / vocabulary CHECKs / the APPROVED-ONLY CHECK / the DETERMINISTIC FOLD CHECK /
 * the STATE FOLD CHECK / the FULFILMENT-COHERENCE CHECK / and — the R33 keystone — the TERMINAL and INTERVENTION
 * COHERENCE CHECKs all hold in Postgres. The load-bearing R33 claims are proven here:
 *
 *   • THE RUNTIME DETERMINES `terminal` FOR A `none` RECOVERY — driven through the real `resolveConversationCompletion`
 *     (not the RPC directly), after the real R30 `fulfilApprovedBooking` performed the booking, the real R31
 *     `verifyApprovedFulfilment` recorded a `consistent` verdict and the real R32 `recoverVerifiedFulfilment`
 *     determined a `none` recovery: it reads the recorded recovery, classifies it, and files EXACTLY ONE resolution
 *     row — threaded to the recovery it was determined from, the authorisation, the verification, the fulfilment, the
 *     held reply, the sent reply and the human's resolution — with `resolution_state` = 'terminal', `terminal` = true,
 *     `intervention_required` = false, `recovery_classification` = 'none', `approval_state` = 'approved' and `status` =
 *     'determined'.
 *   • THE RUNTIME DETERMINES `recoverable` FOR A `reinstate` RECOVERY — when R32 determined a `reinstate` recovery (the
 *     approved operation went unrecorded), the runtime files a resolution with `resolution_state` = 'recoverable',
 *     `terminal` = false, `intervention_required` = true and `fulfilment_id` NULL. The clear recovery path is an
 *     observable, auditable state — the whole point of the engine.
 *   • THE RUNTIME DETERMINES `unresolved` FOR A `reconcile` RECOVERY — when R32 determined a `reconcile` recovery (a
 *     divergent record), the runtime files a resolution with `resolution_state` = 'unresolved', `terminal` = false,
 *     `intervention_required` = true and `fulfilment_id` set. The ambiguity is caught, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is never fulfilled, so
 *     never verified, so never recovered, so the resolution-context reader finds NO recovery and the runtime resolves
 *     NOTHING.
 *   • A NON-RECOVERED REPLY RESOLVES NOTHING — when there is no recorded recovery behind the held reply (the common
 *     case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same determined recovery resolves AT MOST ONCE: the second call returns the
 *     SAME resolution id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved'. There is no path to determining completion for un-approved work.
 *   • THE COMPLETION FLAGS ARE COHERENT WITH THE STATE (the R33 keystone) — the write primitive and column CHECKs
 *     REJECT a `terminal` or `intervention_required` that contradicts the state (terminal iff state = terminal;
 *     intervention iff state <> terminal).
 *   • THE STATE IS THE DETERMINISTIC FOLD OF THE RECOVERY — the write primitive and a column CHECK REJECT a state that
 *     contradicts the source recovery classification (none→terminal, reinstate→recoverable, reconcile→unresolved).
 *   • THE FULFILMENT PRESENCE IS COHERENT WITH THE CLASSIFICATION (inherited transitively) — a `reinstate` resolution
 *     carrying a `fulfilment_id`, or a `none`/`reconcile` resolution carrying none, is rejected.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or
 *     call the resolution-context reader.
 *   • THE VOCABULARY, THE FOLDS AND THE FIELD SHAPES ARE PINNED — a resolution type/outcome/state/classification
 *     outside its set, a malformed expected booking field, a missing job type, an absent recovery or Human Review
 *     provenance id, or a status other than 'determined' is rejected.
 *   • THE READER CENTRES ON THE RECOVERY LEDGER — it returns the RECORDED recovery behind a held reply (the input the
 *     runtime classifies), and returns nothing when no recovery was recorded.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All five receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications, R32 recoveries, R33 resolutions) are append-only (even service_role cannot DELETE), so these tests
 * intentionally leave their rows behind — harmless in the ephemeral CI database, and proving exactly that is one of the
 * tests below. Rows are addressed by a per-call recovery id so each assertion sees only its own writes. No FK'd tenant
 * rows are created, so no teardown is required.
 */

// receptionist_conversation_resolutions / record_receptionist_conversation_resolution /
// find_receptionist_resolution_context are service-role-only internals, NOT in the generated Database types. Cast to
// the minimal surface this suite exercises (the same `as unknown as` convention the recovery / verification suites use)
// rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type ResolutionTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ResolutionClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ResolutionTable;
};

const TABLE = "receptionist_conversation_resolutions";
const RPC = "record_receptionist_conversation_resolution";
const READER = "find_receptionist_resolution_context";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): ResolutionClient => serviceClient() as unknown as ResolutionClient;
const anon = (): ResolutionClient => anonClient() as unknown as ResolutionClient;

// The columns every assertion below reads back — the full captured resolution record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "recovery_id, authorisation_id, verification_id, fulfilment_id, review_audit_id, sent_audit_id, review_resolution_id, " +
  "resolution_type, resolution_outcome, resolution_state, terminal, intervention_required, recovery_classification, " +
  "approval_state, job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a `terminal` resolve_booking_recovery (a `none` recovery) — spread and overridden per case.
// `terminal` requires terminal=true, intervention=false and, via the state fold, recovery_classification='none', which
// via the fulfilment-coherence CHECK requires a non-null fulfilment_id — so the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_recovery_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_id: crypto.randomUUID(),
  p_resolution_type: "resolve_booking_recovery",
  p_resolution_outcome: "conversation_resolution_determined",
  p_resolution_state: "terminal",
  p_terminal: true,
  p_intervention_required: false,
  p_recovery_classification: "none",
  p_approval_state: "approved",
  p_correlation_id: crypto.randomUUID(),
  p_review_audit_id: crypto.randomUUID(),
  p_sent_audit_id: crypto.randomUUID(),
  p_review_resolution_id: crypto.randomUUID(),
  p_fulfilment_id: crypto.randomUUID(),
  p_job_type: JOB,
  p_postcode: POSTCODE,
  p_phone_number: PHONE,
});

// A valid RPC payload for a `recoverable` resolution (a `reinstate` recovery) — terminal=false, intervention=true,
// state='recoverable', fulfilment_id NULL (the fulfilment-coherence CHECK). Used for the coherence NEGATIVE cases that
// must start coherent.
const recoverableRpcArgs = () => ({
  ...validRpcArgs(),
  p_resolution_state: "recoverable",
  p_terminal: false,
  p_intervention_required: true,
  p_recovery_classification: "reinstate",
  p_fulfilment_id: null as string | null,
});

// A valid direct-insert row (every NOT NULL column present, every field well-formed, all folds coherent) — used ONLY
// for the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  recovery_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  verification_id: crypto.randomUUID(),
  fulfilment_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  resolution_type: "resolve_booking_recovery",
  resolution_outcome: "conversation_resolution_determined",
  resolution_state: "terminal",
  terminal: true,
  intervention_required: false,
  recovery_classification: "none",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the state + flags ALWAYS match the deterministic
 * fold of the eligibility they are recorded with. `allow`+live ⇒ pending (fulfillable, so verifiable, so recoverable,
 * so resolvable); `block` ⇒ foreclosed (never fulfillable, so never verifiable, so never recoverable, so never
 * resolvable).
 */
function authorise(verdict: GuardrailVerdict, live: boolean): ApproveBookingAuthorisation {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  const a = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(a)) throw new Error("test setup: expected a decided authorisation");
  return a;
}

/** Read every resolution row filed for one recovery id, as service_role (ground truth). */
function rowsForRecovery(recoveryId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("recovery_id", recoveryId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error
 *  or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration(
  "Conversation Resolution pipeline · receptionist_conversation_resolutions (R33)",
  () => {
    it("resolveConversationCompletion determines `terminal` for a `none` recovery — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed a PENDING approve_booking authorisation, PERFORM the R30 fulfilment, VERIFY it (consistent), then RECOVER
      // it (none) — the full R29→R30→R31→R32 chain, so the recorded recovery the Resolution Engine reads is genuine.
      const orgId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const enquiryId = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      const actionId = crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();

      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: conversationId,
        enquiry_id: enquiryId,
        lead_id: leadId,
        customer_ref: CALLER,
        correlation_id: correlationId,
        action_id: actionId,
        execution_id: executionId,
        review_audit_id: reviewAuditId,
        decision: authorise("allow", true),
        metadata: { strategy: "progress_goal", goal: "arrange_booking" },
      });
      expect(seeded, "the R29 seed authorisation was filed").not.toBeNull();
      expect(seeded?.state).toBe("pending");

      const fulfilled = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(fulfilled, "R30 performed the approved booking").not.toBeNull();

      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(verified?.integrity).toBe("consistent");

      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(recovered, "R32 determined the recovery").not.toBeNull();
      expect(recovered?.recovery_classification).toBe("none");

      // THE RESOLUTION — the runtime reads R32's recorded recovery, classifies the `none` disposition, and records the
      // completion state. `none` ⇒ `terminal`, terminal=true, intervention_required=false.
      const sentAuditId = crypto.randomUUID();
      const resolutionId = crypto.randomUUID();
      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: resolutionId,
      });
      expect(resolved, "the recovered conversation's resolution was determined").not.toBeNull();
      expect(resolved?.resolution_type).toBe("resolve_booking_recovery");
      expect(resolved?.resolution_outcome).toBe("conversation_resolution_determined");
      expect(resolved?.resolution_state).toBe("terminal");
      expect(resolved?.terminal).toBe(true);
      expect(resolved?.intervention_required).toBe(false);

      // EXACTLY ONE row — not zero, not two.
      const read = await rowsForRecovery(recovered?.recovery_id as string);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(resolved?.resolution_id);
      // The determined state is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.recovery_id).toBe(recovered?.recovery_id); // the recovery it was determined from (R33's anchor + idempotency key)
      expect(row.verification_id).toBe(verified?.verification_id); // the verification the recovery classified
      expect(row.authorisation_id).toBe(seeded?.authorisation_id); // the authorisation the recovery traced
      expect(row.fulfilment_id).toBe(fulfilled?.fulfilment_id); // the fulfilment the verification reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      // The anchors threaded THROUGH the recorded recovery the reader resolved.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was determined, the state, the flags, the source classification, and the EXPECTED booking payload.
      expect(row.resolution_type).toBe("resolve_booking_recovery");
      expect(row.resolution_outcome).toBe("conversation_resolution_determined");
      expect(row.resolution_state).toBe("terminal");
      expect(row.terminal).toBe(true);
      expect(row.intervention_required).toBe(false);
      expect(row.recovery_classification).toBe("none");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + DETERMINED BY CONSTRUCTION — the grant that authorised the operation, and the determined status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("determined");
    });

    it("determines `recoverable` for a `reinstate` recovery (the operation went unrecorded)", async () => {
      // Seed a PENDING approve_booking, DO NOT perform R30 — R31 verifies `missing`, R32 recovers `reinstate`. The
      // Resolution Engine reads that disposition and classifies it `recoverable` with fulfilment_id NULL.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewAuditId,
        decision: authorise("allow", true),
      });
      expect(seeded?.state).toBe("pending");

      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(verified?.integrity).toBe("missing");

      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(recovered?.recovery_classification).toBe("reinstate");

      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved, "a reinstate recovery is recoverable").not.toBeNull();
      expect(resolved?.resolution_state).toBe("recoverable");
      expect(resolved?.terminal).toBe(false);
      expect(resolved?.intervention_required).toBe(true);

      const read = await rowsForRecovery(recovered?.recovery_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.resolution_state).toBe("recoverable");
      expect(row.terminal).toBe(false);
      expect(row.intervention_required).toBe(true);
      expect(row.recovery_classification).toBe("reinstate");
      // The coherence invariant, observed end-to-end: a `reinstate` disposition carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.recovery_id).toBe(recovered?.recovery_id);
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("determined");
    });

    it("determines `unresolved` for a `reconcile` recovery (the record diverges from the decision)", async () => {
      // Seed a PENDING approve_booking for JOB=plumbing, file a DIVERGENT R30 fulfilment (a different trade), so R31
      // verifies `inconsistent` and R32 recovers `reconcile`. The Resolution Engine classifies it `unresolved`.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewAuditId,
        decision: authorise("allow", true),
      });
      expect(seeded?.state).toBe("pending");

      // A DIVERGENT recorded fulfilment — filed directly through R30's write primitive, joined to the authorisation by
      // its id, but for a different trade than the authorisation carries.
      const divergent = await svc().rpc<string>("record_receptionist_conversation_fulfilment", {
        p_org_id: orgId,
        p_authorisation_id: seeded?.authorisation_id,
        p_fulfilment_type: "fulfil_booking",
        p_fulfilment_outcome: "booking_recorded",
        p_approval_state: "approved",
        p_correlation_id: crypto.randomUUID(),
        p_review_audit_id: reviewAuditId,
        p_sent_audit_id: crypto.randomUUID(),
        p_review_resolution_id: crypto.randomUUID(),
        p_job_type: "electrical", // DIVERGENT — the authorisation is for plumbing
        p_postcode: POSTCODE,
        p_phone_number: PHONE,
      });
      expect(divergent.error, divergent.error?.message).toBeNull();

      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(verified?.integrity).toBe("inconsistent");

      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(recovered?.recovery_classification).toBe("reconcile");

      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved, "a reconcile recovery is unresolved").not.toBeNull();
      expect(resolved?.resolution_state).toBe("unresolved");
      expect(resolved?.terminal).toBe(false);
      expect(resolved?.intervention_required).toBe(true);

      const read = await rowsForRecovery(recovered?.recovery_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.resolution_state).toBe("unresolved");
      expect(row.terminal).toBe(false);
      expect(row.intervention_required).toBe(true);
      expect(row.recovery_classification).toBe("reconcile");
      // A divergence is still resolved against a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).toBe(divergent.data);
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never recovered, so never resolved", async () => {
      // A policy-/org-blocked booking folds to FORECLOSED at R29 → never fulfilled → never verified → never recovered →
      // the resolution-context reader finds no recovery → the runtime resolves NOTHING.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewAuditId,
        decision: authorise("block", true),
      });
      expect(seeded?.state).toBe("foreclosed");

      // (Even if a send fired the whole chain, nothing recovers — so nothing resolves.)
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const result = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never resolved").toBeNull();
    });

    it("a NON-RECOVERED reply resolves nothing — no recorded recovery behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No recovery was recorded, so
      // the runtime returns null and files no row.
      const result = await resolveConversationCompletion({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no recovery behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same determined recovery resolves AT MOST ONCE", async () => {
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewAuditId,
        decision: authorise("allow", true),
      });
      expect(seeded?.state).toBe("pending");
      // Record the verification + recovery once (as `missing`/`reinstate`; the disposition is immaterial to idempotency).
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(recovered).not.toBeNull();

      const first = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME recovery.
      const second = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call resolved nothing; ON CONFLICT (recovery_id) returned the existing row.
      expect(second?.resolution_id).toBe(first?.resolution_id);

      const read = await rowsForRecovery(recovered?.recovery_id as string);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.resolution_id);
    });

    it("the write primitive files a resolution and is idempotent on the recovery id (direct RPC)", async () => {
      const recoveryId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: recoveryId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the resolution id").toBeTruthy();

      // A repeat with the SAME recovery id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_recovery_id: recoveryId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc()
        .from(TABLE)
        .select("id, approval_state, status, resolution_state, terminal, intervention_required")
        .eq("recovery_id", recoveryId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("determined");
      expect(read.data?.[0]?.resolution_state).toBe("terminal");
      expect(read.data?.[0]?.terminal).toBe(true);
      expect(read.data?.[0]?.intervention_required).toBe(false);
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited transitively from R32 → R31 → R30: a resolution can ONLY exist for an approved authorisation.
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }
      const insertUnapproved = await svc().from(TABLE).insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved resolution, even for service_role",
      ).not.toBeNull();
    });

    it("THE KEYSTONE — terminal/intervention flags are coherent with the state (RPC and CHECK)", async () => {
      // A `terminal` state claiming NOT terminal is rejected by the RPC's terminal-coherence validation…
      const terminalButNotTerminal = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_terminal: false });
      expect(terminalButNotTerminal.error, "a `terminal` state claiming terminal=false must be rejected").not.toBeNull();

      // …and a `recoverable` state claiming terminal is rejected too.
      const recoverableButTerminal = await svc().rpc<string>(RPC, { ...recoverableRpcArgs(), p_terminal: true });
      expect(recoverableButTerminal.error, "a `recoverable` state claiming terminal=true must be rejected").not.toBeNull();

      // A `terminal` state claiming intervention IS required is rejected…
      const terminalButIntervention = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_intervention_required: true,
      });
      expect(
        terminalButIntervention.error,
        "a `terminal` state claiming intervention required must be rejected",
      ).not.toBeNull();

      // …and a `recoverable` state claiming intervention is NOT required is rejected.
      const recoverableButNoIntervention = await svc().rpc<string>(RPC, {
        ...recoverableRpcArgs(),
        p_intervention_required: false,
      });
      expect(
        recoverableButNoIntervention.error,
        "a `recoverable` state claiming no intervention required must be rejected",
      ).not.toBeNull();

      // The column CHECKs enforce the same equivalences on a direct service_role insert.
      const insertBadTerminal = await svc().from(TABLE).insert({ ...validInsertRow(), terminal: false });
      expect(
        insertBadTerminal.error,
        "the terminal-coherence CHECK rejects terminal=false on a `terminal` state, even for service_role",
      ).not.toBeNull();
      const insertBadIntervention = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), intervention_required: true });
      expect(
        insertBadIntervention.error,
        "the intervention-coherence CHECK rejects intervention=true on a `terminal` state, even for service_role",
      ).not.toBeNull();
    });

    it("THE STATE is the deterministic fold of the recovery classification (RPC and CHECK)", async () => {
      // `none` folds to `terminal` ONLY — a `none` classification with state `recoverable` is rejected (terminal +
      // intervention kept coherent with the wrong state so ONLY the fold is violated)…
      const noneRecoverable = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_resolution_state: "recoverable",
        p_terminal: false,
        p_intervention_required: true,
      });
      expect(noneRecoverable.error, "none must fold to terminal, not recoverable").not.toBeNull();

      // …and a `reinstate` classification with state `terminal` is rejected (flags + fulfilment kept coherent).
      const reinstateTerminal = await svc().rpc<string>(RPC, {
        ...recoverableRpcArgs(),
        p_resolution_state: "terminal",
        p_terminal: true,
        p_intervention_required: false,
      });
      expect(reinstateTerminal.error, "reinstate must fold to recoverable, not terminal").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), resolution_state: "unresolved", terminal: false, intervention_required: true });
      expect(
        insertBadFold.error,
        "the state-fold CHECK rejects none + unresolved, even for service_role",
      ).not.toBeNull();
    });

    it("THE FULFILMENT PRESENCE is coherent with the classification (inherited) — reinstate iff no fulfilment_id (RPC and CHECK)", async () => {
      // A `reinstate` resolution carrying a fulfilment_id is rejected…
      const reinstateWithFulfilment = await svc().rpc<string>(RPC, {
        ...recoverableRpcArgs(),
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(
        reinstateWithFulfilment.error,
        "a `reinstate` resolution carrying a fulfilment_id must be rejected",
      ).not.toBeNull();

      // …and a `none` resolution with NO fulfilment_id is rejected.
      const noneWithoutFulfilment = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_fulfilment_id: null });
      expect(
        noneWithoutFulfilment.error,
        "a `none` resolution with no fulfilment_id must be rejected",
      ).not.toBeNull();

      // A COHERENT `recoverable` (reinstate, no fulfilment_id) is accepted — the state the engine exists to record.
      const coherentRecoverable = await svc().rpc<string>(RPC, { ...recoverableRpcArgs() });
      expect(coherentRecoverable.error, coherentRecoverable.error?.message).toBeNull();
      expect(coherentRecoverable.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const recoveryId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: recoveryId });
      expect(filed.error, filed.error?.message).toBeNull();

      const updated = await svc()
        .from(TABLE)
        .update({ resolution_state: "unresolved" })
        .eq("recovery_id", recoveryId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      const deleted = await svc().from(TABLE).delete().eq("recovery_id", recoveryId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      const read = await rowsForRecovery(recoveryId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.resolution_state).toBe("terminal");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const recoveryId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: recoveryId });

      const asService = await rowsForRecovery(recoveryId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      expectAnonDenied(await anon().from(TABLE).select("id").eq("recovery_id", recoveryId));

      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file a resolution").not.toBeNull();

      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to read the resolution context").not.toBeNull();

      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the folds, the field shapes, the provenance and the determined status", async () => {
      // A resolution type outside {resolve_booking_recovery} is rejected.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_type: "resolve_quote_recovery" });
      expect(badType.error, "a resolution type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {conversation_resolution_determined} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_resolution_outcome: "conversation_resolution_executed",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A state outside {terminal, recoverable, unresolved} is rejected.
      const badState = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_state: "closed" });
      expect(badState.error, "a state outside the vocabulary must be rejected").not.toBeNull();

      // A recovery classification outside {none, reinstate, reconcile} is rejected.
      const badClassification = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_recovery_classification: "retry",
      });
      expect(badClassification.error, "a classification outside the vocabulary must be rejected").not.toBeNull();

      // A resolution with a malformed expected number / postcode is rejected — the ledger never records an unringable
      // expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // A resolve_booking_recovery with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a resolution with no expected job type must be rejected").not.toBeNull();

      // The recovery anchor and the full Human Review provenance are MANDATORY.
      const noRecovery = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: null });
      expect(noRecovery.error, "a resolution with no recovery reference must be rejected").not.toBeNull();
      const noAuthorisation = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: null });
      expect(noAuthorisation.error, "a resolution with no authorisation reference must be rejected").not.toBeNull();
      const noVerification = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_id: null });
      expect(noVerification.error, "a resolution with no verification reference must be rejected").not.toBeNull();
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a resolution with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a resolution with no sent-reply reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noResolution.error, "a resolution with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), resolution_outcome: "conversation_resolution_executed" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // DETERMINED BY CONSTRUCTION: a direct service_role insert claiming any status but 'determined' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "executed" });
      expect(badStatus.error, "a status other than 'determined' must be rejected by the CHECK").not.toBeNull();
    });

    it("the resolution-context reader centres on the recovery ledger — returns the recorded recovery, or nothing", async () => {
      const orgId = crypto.randomUUID();

      // A recorded recovery behind held reply A (via the full R29→R32 chain, as `reinstate`).
      const reviewA = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewA,
        decision: authorise("allow", true),
      });
      expect(seeded?.state).toBe("pending");
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(recovered, "R32 recorded a recovery behind held reply A").not.toBeNull();

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const rRow = found.data?.[0] ?? {};
      // The reader returns R32's RECORDED recovery verbatim, so the runtime can reconstruct the decision.
      expect(rRow.recovery_id).toBe(recovered?.recovery_id);
      expect(rRow.authorisation_id).toBe(seeded?.authorisation_id);
      expect(rRow.recovery_type).toBe("recover_booking_fulfilment");
      expect(rRow.recovery_outcome).toBe("fulfilment_recovery_determined");
      expect(rRow.recovery_classification).toBe("reinstate");
      expect(rRow.recovery_required).toBe(true);
      expect(rRow.integrity).toBe("missing");
      expect(rRow.approval_state).toBe("approved");
      expect(rRow.job_type).toBe(JOB);
      expect(rRow.postcode).toBe(POSTCODE);
      expect(rRow.phone_number).toBe(PHONE);
      expect(rRow.fulfilment_id).toBeNull(); // reinstate → no fulfilment

      // A held reply B with NO recorded recovery — the reader returns nothing.
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

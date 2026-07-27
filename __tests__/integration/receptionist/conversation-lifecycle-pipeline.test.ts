import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Lifecycle pipeline — real-Postgres proof of the AI Receptionist Programme R34
 * (CONVERSATION LIFECYCLE ENGINE), the FOURTH layer that does not perform: given an APPROVED, PERFORMED, VERIFIED,
 * RECOVERED, RESOLVED conversation it reads R33's RECORDED resolution disposition and GOVERNS it into the
 * conversation-lifecycle transition it undergoes and the state it comes to rest in — `close`/`closed` (terminal, the
 * lifecycle is complete), `retain`/`retained` (recoverable, a clear recovery path, held open) and `escalate`/`escalated`
 * (unresolved, an ambiguous record, raised for attention) — filing an auditable LIFECYCLE. It GOVERNS the lifecycle; it
 * EXECUTES no recovery or business action.
 *
 * The unit tier proves the pure core governs a lifecycle DECISION deterministically, DEFERS when R33 rendered no
 * decision, folds the resolution state to its transition and the transition to its state, and keeps `closed` / `ongoing`
 * coherent; the security tier proves, as SOURCE, that the ledger is append-only, service-role-only, approved-only,
 * closed-coherent, ongoing-coherent, transition-fold-coherent, state-fold-coherent, fulfilment-coherent and idempotent,
 * that the Resolution (R33), Recovery (R32), Verification (R31) and Fulfilment (R30) Engines stay authoritative, that
 * Human Review can never be bypassed, and that no duplicate lifecycle logic exists. This tier proves the BEHAVIOUR the
 * mocks can't — that when the CANONICAL RUNTIME actually reads R33's RECORDED resolution behind a held reply,
 * reconstructs the resolution decision, governs it against a live database, exactly one idempotent lifecycle row is
 * really filed with the right transition + state, and the migration's storage / RLS / append-only guard / privilege
 * model / vocabulary CHECKs / the APPROVED-ONLY CHECK / the TRANSITION FOLD CHECK / the STATE FOLD CHECK / the
 * FULFILMENT-COHERENCE CHECK / and — the R34 keystone — the CLOSED and ONGOING COHERENCE CHECKs all hold in Postgres.
 * The load-bearing R34 claims are proven here:
 *
 *   • THE RUNTIME GOVERNS `close`/`closed` FOR A `terminal` RESOLUTION — driven through the real
 *     `governConversationLifecycle` (not the RPC directly), after the real R30 `fulfilApprovedBooking` performed the
 *     booking, the real R31 `verifyApprovedFulfilment` recorded a `consistent` verdict, the real R32
 *     `recoverVerifiedFulfilment` determined a `none` recovery and the real R33 `resolveConversationCompletion`
 *     determined a `terminal` resolution: it reads the recorded resolution, governs it, and files EXACTLY ONE lifecycle
 *     row — threaded to the resolution it was governed from, the recovery, the authorisation, the verification, the
 *     fulfilment, the held reply, the sent reply and the human's resolution — with `lifecycle_transition` = 'close',
 *     `lifecycle_state` = 'closed', `closed` = true, `ongoing` = false, `resolution_state` = 'terminal', `approval_state`
 *     = 'approved' and `status` = 'governed'.
 *   • THE RUNTIME GOVERNS `retain`/`retained` FOR A `recoverable` RESOLUTION — when R33 determined a `recoverable`
 *     resolution (the approved operation went unrecorded), the runtime files a lifecycle with `lifecycle_transition` =
 *     'retain', `lifecycle_state` = 'retained', `closed` = false, `ongoing` = true and `fulfilment_id` NULL. Holding the
 *     conversation open on a clear recovery path is an observable, auditable state — the whole point of the engine.
 *   • THE RUNTIME GOVERNS `escalate`/`escalated` FOR AN `unresolved` RESOLUTION — when R33 determined an `unresolved`
 *     resolution (a divergent record), the runtime files a lifecycle with `lifecycle_transition` = 'escalate',
 *     `lifecycle_state` = 'escalated', `closed` = false, `ongoing` = true and `fulfilment_id` set. The ambiguity is
 *     raised, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is never fulfilled, so
 *     never verified, so never recovered, so never resolved, so the lifecycle-context reader finds NO resolution and the
 *     runtime governs NOTHING.
 *   • A NON-RESOLVED REPLY GOVERNS NOTHING — when there is no recorded resolution behind the held reply (the common case
 *     — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same determined resolution governs AT MOST ONCE: the second call returns the
 *     SAME lifecycle id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved'. There is no path to governing a lifecycle for un-approved work.
 *   • THE LIFECYCLE FLAGS ARE COHERENT WITH THE STATE (the R34 keystone) — the write primitive and column CHECKs REJECT
 *     a `closed` or `ongoing` that contradicts the state (closed iff state = closed; ongoing iff state <> closed).
 *   • THE TRANSITION IS THE DETERMINISTIC FOLD OF THE RESOLUTION STATE (stage 1) — the write primitive and a column
 *     CHECK REJECT a transition that contradicts the source resolution state (terminal→close, recoverable→retain,
 *     unresolved→escalate).
 *   • THE STATE IS THE DETERMINISTIC FOLD OF THE TRANSITION (stage 2) — the write primitive and a column CHECK REJECT a
 *     state that contradicts its transition (close→closed, retain→retained, escalate→escalated).
 *   • THE FULFILMENT PRESENCE IS COHERENT WITH THE SOURCE STATE (inherited transitively) — a `recoverable` lifecycle
 *     carrying a `fulfilment_id`, or a `terminal`/`unresolved` lifecycle carrying none, is rejected.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or call
 *     the lifecycle-context reader.
 *   • THE VOCABULARY, THE FOLDS AND THE FIELD SHAPES ARE PINNED — a lifecycle type/outcome/transition/state/resolution
 *     state outside its set, a malformed expected booking field, a missing job type, an absent resolution or Human
 *     Review provenance id, or a status other than 'governed' is rejected.
 *   • THE READER CENTRES ON THE RESOLUTION LEDGER — it returns the RECORDED resolution behind a held reply (the input
 *     the runtime governs), and returns nothing when no resolution was recorded.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All six receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications, R32 recoveries, R33 resolutions, R34 lifecycles) are append-only (even service_role cannot DELETE), so
 * these tests intentionally leave their rows behind — harmless in the ephemeral CI database, and proving exactly that is
 * one of the tests below. Rows are addressed by a per-call resolution id so each assertion sees only its own writes. No
 * FK'd tenant rows are created, so no teardown is required.
 */

// receptionist_conversation_lifecycles / record_receptionist_conversation_lifecycle /
// find_receptionist_lifecycle_context are service-role-only internals, NOT in the generated Database types. Cast to the
// minimal surface this suite exercises (the same `as unknown as` convention the resolution / recovery / verification
// suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type LifecycleTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type LifecycleClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): LifecycleTable;
};

const TABLE = "receptionist_conversation_lifecycles";
const RPC = "record_receptionist_conversation_lifecycle";
const READER = "find_receptionist_lifecycle_context";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): LifecycleClient => serviceClient() as unknown as LifecycleClient;
const anon = (): LifecycleClient => anonClient() as unknown as LifecycleClient;

// The columns every assertion below reads back — the full captured lifecycle record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, review_audit_id, sent_audit_id, review_resolution_id, " +
  "lifecycle_type, lifecycle_outcome, lifecycle_transition, lifecycle_state, closed, ongoing, resolution_state, " +
  "approval_state, job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a `terminal` govern_resolution_lifecycle (a `close`/`closed` lifecycle) — spread and
// overridden per case. `closed` requires transition='close', state='closed', closed=true, ongoing=false and, via the
// fulfilment-coherence CHECK, a NON-NULL fulfilment_id (a `terminal` resolution means the operation WAS recorded) — so
// the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_resolution_id: crypto.randomUUID(),
  p_recovery_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_id: crypto.randomUUID(),
  p_lifecycle_type: "govern_resolution_lifecycle",
  p_lifecycle_outcome: "conversation_lifecycle_governed",
  p_lifecycle_transition: "close",
  p_lifecycle_state: "closed",
  p_closed: true,
  p_ongoing: false,
  p_resolution_state: "terminal",
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

// A valid RPC payload for a `retained` lifecycle (a `recoverable` resolution) — transition='retain', state='retained',
// closed=false, ongoing=true, fulfilment_id NULL (the fulfilment-coherence CHECK). Used for the coherence NEGATIVE cases
// that must start coherent.
const retainableRpcArgs = () => ({
  ...validRpcArgs(),
  p_lifecycle_transition: "retain",
  p_lifecycle_state: "retained",
  p_closed: false,
  p_ongoing: true,
  p_resolution_state: "recoverable",
  p_fulfilment_id: null as string | null,
});

// A valid direct-insert row (every NOT NULL column present, every field well-formed, all folds coherent) — used ONLY for
// the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  resolution_id: crypto.randomUUID(),
  recovery_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  verification_id: crypto.randomUUID(),
  fulfilment_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  lifecycle_type: "govern_resolution_lifecycle",
  lifecycle_outcome: "conversation_lifecycle_governed",
  lifecycle_transition: "close",
  lifecycle_state: "closed",
  closed: true,
  ongoing: false,
  resolution_state: "terminal",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the state + flags ALWAYS match the deterministic
 * fold of the eligibility they are recorded with. `allow`+live ⇒ pending (fulfillable, so verifiable, so recoverable,
 * so resolvable, so governable); `block` ⇒ foreclosed (never fulfillable, so never verifiable, so never recoverable, so
 * never resolvable, so never governable).
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

/** Read every lifecycle row filed for one resolution id, as service_role (ground truth). */
function rowsForResolution(resolutionId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("resolution_id", resolutionId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration(
  "Conversation Lifecycle pipeline · receptionist_conversation_lifecycles (R34)",
  () => {
    it("governConversationLifecycle governs `close`/`closed` for a `terminal` resolution — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed a PENDING approve_booking authorisation, PERFORM the R30 fulfilment, VERIFY it (consistent), RECOVER it
      // (none) and RESOLVE it (terminal) — the full R29→R30→R31→R32→R33 chain, so the recorded resolution the Lifecycle
      // Engine reads is genuine.
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
      expect(recovered?.recovery_classification).toBe("none");

      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved, "R33 determined the resolution").not.toBeNull();
      expect(resolved?.resolution_state).toBe("terminal");

      // The R33 resolution row carries the sent-reply + human-grant anchors the Lifecycle Engine threads VERBATIM: the
      // runtime reads the RECORDED resolution and copies its provenance, it never re-uses the governance trigger's own
      // sent/resolution ids. Capture them as the provenance ground truth the lifecycle row must match.
      const resolutionRead = await svc()
        .from("receptionist_conversation_resolutions")
        .select("sent_audit_id, review_resolution_id")
        .eq("id", resolved?.resolution_id as string);
      expect(resolutionRead.error, resolutionRead.error?.message).toBeNull();
      const recordedResolution = resolutionRead.data?.[0] ?? {};

      // THE LIFECYCLE — the runtime reads R33's recorded resolution, governs the `terminal` disposition, and records the
      // lifecycle transition + state. `terminal` ⇒ `close`/`closed`, closed=true, ongoing=false. The trigger's sent /
      // resolution ids are DELIBERATELY fresh (not the recorded ones) to prove the runtime threads from the record.
      const sentAuditId = crypto.randomUUID();
      const reviewResolutionId = crypto.randomUUID();
      const governed = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: reviewResolutionId,
      });
      expect(governed, "the resolved conversation's lifecycle was governed").not.toBeNull();
      expect(governed?.lifecycle_type).toBe("govern_resolution_lifecycle");
      expect(governed?.lifecycle_outcome).toBe("conversation_lifecycle_governed");
      expect(governed?.lifecycle_transition).toBe("close");
      expect(governed?.lifecycle_state).toBe("closed");
      expect(governed?.closed).toBe(true);
      expect(governed?.ongoing).toBe(false);

      // EXACTLY ONE row — not zero, not two. Keyed by the R33 resolution's id (R34's anchor + idempotency key).
      const read = await rowsForResolution(resolved?.resolution_id as string);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(governed?.lifecycle_id);
      // The governed state is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.resolution_id).toBe(resolved?.resolution_id); // the resolution it was governed from (R34's anchor + idempotency key)
      expect(row.recovery_id).toBe(recovered?.recovery_id); // the recovery the resolution was determined from
      expect(row.verification_id).toBe(verified?.verification_id); // the verification the recovery classified
      expect(row.authorisation_id).toBe(seeded?.authorisation_id); // the authorisation the recovery traced
      expect(row.fulfilment_id).toBe(fulfilled?.fulfilment_id); // the fulfilment the verification reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      expect(row.sent_audit_id).toBe(recordedResolution.sent_audit_id); // threaded from the recorded resolution, NOT the trigger
      expect(row.review_resolution_id).toBe(recordedResolution.review_resolution_id); // threaded from the recorded resolution
      // ...and the trigger's own ids were NOT copied onto the row — provenance follows the record, never the caller.
      expect(row.sent_audit_id).not.toBe(sentAuditId);
      expect(row.review_resolution_id).not.toBe(reviewResolutionId);
      // The anchors threaded THROUGH the recorded resolution the reader governed.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was governed, the transition, the state, the flags, the source resolution state, and the EXPECTED payload.
      expect(row.lifecycle_type).toBe("govern_resolution_lifecycle");
      expect(row.lifecycle_outcome).toBe("conversation_lifecycle_governed");
      expect(row.lifecycle_transition).toBe("close");
      expect(row.lifecycle_state).toBe("closed");
      expect(row.closed).toBe(true);
      expect(row.ongoing).toBe(false);
      expect(row.resolution_state).toBe("terminal");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + GOVERNED BY CONSTRUCTION — the grant that authorised the operation, and the governed status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("governed");
    });

    it("governs `retain`/`retained` for a `recoverable` resolution (the operation went unrecorded)", async () => {
      // Seed a PENDING approve_booking, DO NOT perform R30 — R31 verifies `missing`, R32 recovers `reinstate`, R33
      // resolves `recoverable`. The Lifecycle Engine governs it `retain`/`retained` with fulfilment_id NULL.
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
      expect(recovered?.recovery_classification).toBe("reinstate");
      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved?.resolution_state).toBe("recoverable");

      const governed = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(governed, "a recoverable resolution is retained").not.toBeNull();
      expect(governed?.lifecycle_transition).toBe("retain");
      expect(governed?.lifecycle_state).toBe("retained");
      expect(governed?.closed).toBe(false);
      expect(governed?.ongoing).toBe(true);

      const read = await rowsForResolution(resolved?.resolution_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.lifecycle_transition).toBe("retain");
      expect(row.lifecycle_state).toBe("retained");
      expect(row.closed).toBe(false);
      expect(row.ongoing).toBe(true);
      expect(row.resolution_state).toBe("recoverable");
      // The coherence invariant, observed end-to-end: a `recoverable` disposition carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.resolution_id).toBe(resolved?.resolution_id);
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("governed");
    });

    it("governs `escalate`/`escalated` for an `unresolved` resolution (the record diverges from the decision)", async () => {
      // Seed a PENDING approve_booking for JOB=plumbing, file a DIVERGENT R30 fulfilment (a different trade), so R31
      // verifies `inconsistent`, R32 recovers `reconcile` and R33 resolves `unresolved`. The Lifecycle Engine governs it
      // `escalate`/`escalated`.
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
      expect(resolved?.resolution_state).toBe("unresolved");

      const governed = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(governed, "an unresolved resolution is escalated").not.toBeNull();
      expect(governed?.lifecycle_transition).toBe("escalate");
      expect(governed?.lifecycle_state).toBe("escalated");
      expect(governed?.closed).toBe(false);
      expect(governed?.ongoing).toBe(true);

      const read = await rowsForResolution(resolved?.resolution_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.lifecycle_transition).toBe("escalate");
      expect(row.lifecycle_state).toBe("escalated");
      expect(row.closed).toBe(false);
      expect(row.ongoing).toBe(true);
      expect(row.resolution_state).toBe("unresolved");
      // An escalation is still governed against a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).toBe(divergent.data);
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never resolved, so never governed", async () => {
      // A policy-/org-blocked booking folds to FORECLOSED at R29 → never fulfilled → never verified → never recovered →
      // never resolved → the lifecycle-context reader finds no resolution → the runtime governs NOTHING.
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

      // (Even if a send fired the whole chain, nothing resolves — so nothing governs.)
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
      await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const result = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never governed").toBeNull();
    });

    it("a NON-RESOLVED reply governs nothing — no recorded resolution behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No resolution was recorded, so
      // the runtime returns null and files no row.
      const result = await governConversationLifecycle({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no resolution behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same determined resolution governs AT MOST ONCE", async () => {
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
      // Record the verification + recovery + resolution once (as `missing`/`reinstate`/`recoverable`; the disposition is
      // immaterial to idempotency).
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
      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved).not.toBeNull();

      const first = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME recorded resolution.
      const second = await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call governed nothing; ON CONFLICT (resolution_id) returned the existing row.
      expect(second?.lifecycle_id).toBe(first?.lifecycle_id);

      const read = await rowsForResolution(resolved?.resolution_id as string);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.lifecycle_id);
    });

    it("the write primitive files a lifecycle and is idempotent on the resolution id (direct RPC)", async () => {
      const resolutionId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: resolutionId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the lifecycle id").toBeTruthy();

      // A repeat with the SAME resolution id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_resolution_id: resolutionId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc()
        .from(TABLE)
        .select("id, approval_state, status, lifecycle_transition, lifecycle_state, closed, ongoing")
        .eq("resolution_id", resolutionId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("governed");
      expect(read.data?.[0]?.lifecycle_transition).toBe("close");
      expect(read.data?.[0]?.lifecycle_state).toBe("closed");
      expect(read.data?.[0]?.closed).toBe(true);
      expect(read.data?.[0]?.ongoing).toBe(false);
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited transitively from R33 → R32 → R31 → R30: a lifecycle can ONLY exist for an approved authorisation.
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }
      const insertUnapproved = await svc().from(TABLE).insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved lifecycle, even for service_role",
      ).not.toBeNull();
    });

    it("THE KEYSTONE — closed/ongoing flags are coherent with the state (RPC and CHECK)", async () => {
      // A `closed` state claiming NOT closed is rejected by the RPC's closed-coherence validation…
      const closedButNotClosed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_closed: false });
      expect(closedButNotClosed.error, "a `closed` state claiming closed=false must be rejected").not.toBeNull();

      // …and a `retained` state claiming closed is rejected too.
      const retainedButClosed = await svc().rpc<string>(RPC, { ...retainableRpcArgs(), p_closed: true });
      expect(retainedButClosed.error, "a `retained` state claiming closed=true must be rejected").not.toBeNull();

      // A `closed` state claiming it remains ongoing is rejected…
      const closedButOngoing = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_ongoing: true });
      expect(closedButOngoing.error, "a `closed` state claiming ongoing=true must be rejected").not.toBeNull();

      // …and a `retained` state claiming it is NOT ongoing is rejected.
      const retainedButNotOngoing = await svc().rpc<string>(RPC, { ...retainableRpcArgs(), p_ongoing: false });
      expect(
        retainedButNotOngoing.error,
        "a `retained` state claiming ongoing=false must be rejected",
      ).not.toBeNull();

      // The column CHECKs enforce the same equivalences on a direct service_role insert.
      const insertBadClosed = await svc().from(TABLE).insert({ ...validInsertRow(), closed: false });
      expect(
        insertBadClosed.error,
        "the closed-coherence CHECK rejects closed=false on a `closed` state, even for service_role",
      ).not.toBeNull();
      const insertBadOngoing = await svc().from(TABLE).insert({ ...validInsertRow(), ongoing: true });
      expect(
        insertBadOngoing.error,
        "the ongoing-coherence CHECK rejects ongoing=true on a `closed` state, even for service_role",
      ).not.toBeNull();
    });

    it("THE TRANSITION FOLD (stage 1) — the transition is the deterministic fold of the resolution state (RPC and CHECK)", async () => {
      // `terminal` folds to `close` ONLY — a `terminal` resolution state with transition `retain` is rejected (state +
      // flags kept coherent with the wrong transition so ONLY the transition fold is violated)…
      const terminalRetain = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_transition: "retain",
        p_lifecycle_state: "retained",
        p_closed: false,
        p_ongoing: true,
      });
      expect(terminalRetain.error, "terminal must fold to close, not retain").not.toBeNull();

      // …and a `recoverable` resolution state with transition `close` is rejected (state + flags + fulfilment coherent).
      const recoverableClose = await svc().rpc<string>(RPC, {
        ...retainableRpcArgs(),
        p_lifecycle_transition: "close",
        p_lifecycle_state: "closed",
        p_closed: true,
        p_ongoing: false,
      });
      expect(recoverableClose.error, "recoverable must fold to retain, not close").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadTransition = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), lifecycle_transition: "retain", lifecycle_state: "retained", closed: false, ongoing: true });
      expect(
        insertBadTransition.error,
        "the transition-fold CHECK rejects terminal + retain, even for service_role",
      ).not.toBeNull();
    });

    it("THE STATE FOLD (stage 2) — the state is the deterministic fold of the transition (RPC and CHECK)", async () => {
      // `close` folds to `closed` ONLY — a `close` transition resting in `retained` is rejected (resolution state +
      // transition kept coherent, closed/ongoing kept coherent with the wrong state, so ONLY the state fold is
      // violated)…
      const closeRetained = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_state: "retained",
        p_closed: false,
        p_ongoing: true,
      });
      expect(closeRetained.error, "close must fold to closed, not retained").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadState = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), lifecycle_state: "retained", closed: false, ongoing: true });
      expect(
        insertBadState.error,
        "the state-fold CHECK rejects close + retained, even for service_role",
      ).not.toBeNull();
    });

    it("THE FULFILMENT PRESENCE is coherent with the source state (inherited) — recoverable iff no fulfilment_id (RPC and CHECK)", async () => {
      // A `recoverable` lifecycle carrying a fulfilment_id is rejected…
      const recoverableWithFulfilment = await svc().rpc<string>(RPC, {
        ...retainableRpcArgs(),
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(
        recoverableWithFulfilment.error,
        "a `recoverable` lifecycle carrying a fulfilment_id must be rejected",
      ).not.toBeNull();

      // …and a `terminal` lifecycle with NO fulfilment_id is rejected.
      const terminalWithoutFulfilment = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_fulfilment_id: null });
      expect(
        terminalWithoutFulfilment.error,
        "a `terminal` lifecycle with no fulfilment_id must be rejected",
      ).not.toBeNull();

      // A COHERENT `retained` (recoverable, no fulfilment_id) is accepted — the state the engine exists to record.
      const coherentRetained = await svc().rpc<string>(RPC, { ...retainableRpcArgs() });
      expect(coherentRetained.error, coherentRetained.error?.message).toBeNull();
      expect(coherentRetained.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const resolutionId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: resolutionId });
      expect(filed.error, filed.error?.message).toBeNull();

      const updated = await svc()
        .from(TABLE)
        .update({ lifecycle_state: "escalated" })
        .eq("resolution_id", resolutionId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      const deleted = await svc().from(TABLE).delete().eq("resolution_id", resolutionId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      const read = await rowsForResolution(resolutionId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.lifecycle_state).toBe("closed");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const resolutionId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: resolutionId });

      const asService = await rowsForResolution(resolutionId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      expectAnonDenied(await anon().from(TABLE).select("id").eq("resolution_id", resolutionId));

      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file a lifecycle").not.toBeNull();

      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to read the lifecycle context").not.toBeNull();

      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the folds, the field shapes, the provenance and the governed status", async () => {
      // A lifecycle type outside {govern_resolution_lifecycle} is rejected.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_type: "govern_quote_lifecycle" });
      expect(badType.error, "a lifecycle type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {conversation_lifecycle_governed} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_outcome: "conversation_lifecycle_executed",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A transition outside {close, retain, escalate} is rejected.
      const badTransition = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_transition: "reopen" });
      expect(badTransition.error, "a transition outside the vocabulary must be rejected").not.toBeNull();

      // A state outside {closed, retained, escalated} is rejected.
      const badState = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_transition: "escalate",
        p_lifecycle_state: "terminal",
        p_closed: false,
        p_ongoing: true,
        p_resolution_state: "unresolved",
      });
      expect(badState.error, "a state outside the vocabulary must be rejected").not.toBeNull();

      // A resolution state outside {terminal, recoverable, unresolved} is rejected.
      const badResolutionState = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_state: "closed" });
      expect(badResolutionState.error, "a resolution state outside the vocabulary must be rejected").not.toBeNull();

      // A lifecycle with a malformed expected number / postcode is rejected — the ledger never records an unringable
      // expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // A govern_resolution_lifecycle with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a lifecycle with no expected job type must be rejected").not.toBeNull();

      // The resolution anchor and the full Human Review provenance are MANDATORY.
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: null });
      expect(noResolution.error, "a lifecycle with no resolution reference must be rejected").not.toBeNull();
      const noRecovery = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: null });
      expect(noRecovery.error, "a lifecycle with no recovery reference must be rejected").not.toBeNull();
      const noAuthorisation = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: null });
      expect(noAuthorisation.error, "a lifecycle with no authorisation reference must be rejected").not.toBeNull();
      const noVerification = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_id: null });
      expect(noVerification.error, "a lifecycle with no verification reference must be rejected").not.toBeNull();
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a lifecycle with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a lifecycle with no sent-reply reference must be rejected").not.toBeNull();
      const noReviewResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noReviewResolution.error, "a lifecycle with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), lifecycle_outcome: "conversation_lifecycle_executed" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // GOVERNED BY CONSTRUCTION: a direct service_role insert claiming any status but 'governed' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "executed" });
      expect(badStatus.error, "a status other than 'governed' must be rejected by the CHECK").not.toBeNull();
    });

    it("the lifecycle-context reader centres on the resolution ledger — returns the recorded resolution, or nothing", async () => {
      const orgId = crypto.randomUUID();

      // A recorded resolution behind held reply A (via the full R29→R33 chain, as `recoverable`).
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
      await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const resolved = await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(resolved, "R33 recorded a resolution behind held reply A").not.toBeNull();

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const rRow = found.data?.[0] ?? {};
      // The reader returns R33's RECORDED resolution verbatim, so the runtime can reconstruct the decision.
      expect(rRow.resolution_id).toBe(resolved?.resolution_id);
      expect(rRow.authorisation_id).toBe(seeded?.authorisation_id);
      expect(rRow.resolution_type).toBe("resolve_booking_recovery");
      expect(rRow.resolution_outcome).toBe("conversation_resolution_determined");
      expect(rRow.resolution_state).toBe("recoverable");
      expect(rRow.terminal).toBe(false);
      expect(rRow.intervention_required).toBe(true);
      expect(rRow.recovery_classification).toBe("reinstate");
      expect(rRow.approval_state).toBe("approved");
      expect(rRow.job_type).toBe(JOB);
      expect(rRow.postcode).toBe(POSTCODE);
      expect(rRow.phone_number).toBe(PHONE);
      expect(rRow.fulfilment_id).toBeNull(); // recoverable → no fulfilment

      // A held reply B with NO recorded resolution — the reader returns nothing.
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Recovery pipeline — real-Postgres proof of the AI Receptionist Programme R32
 * (CONVERSATION RECOVERY ENGINE), the SECOND layer that does not perform: given an APPROVED, PERFORMED, VERIFIED
 * fulfilment it reads R31's RECORDED verification verdict and CLASSIFIES it into the recovery it warrants — `none`
 * (consistent, no recovery required), `reinstate` (missing), `reconcile` (inconsistent) — filing an auditable
 * RECOVERY disposition. It DETERMINES recovery; it EXECUTES no recovery action.
 *
 * The unit tier proves the pure core resolves a recovery DECISION deterministically, DEFERS when R31 rendered no
 * decision, folds the integrity verdict to its classification, and keeps `recovery_required` coherent; the security
 * tier proves, as SOURCE, that the ledger is append-only, service-role-only, approved-only, classification-coherent,
 * requirement-coherent and idempotent, that the Verification (R31) and Fulfilment (R30) Engines stay authoritative,
 * that Human Review can never be bypassed, and that no duplicate recovery logic exists. This tier proves the
 * BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME actually reads R31's RECORDED verification behind a
 * held reply, reconstructs the verification decision, classifies it against a live database, exactly one idempotent
 * recovery row is really filed with the right disposition, and the migration's storage / RLS / append-only guard /
 * privilege model / vocabulary CHECKs / the APPROVED-ONLY CHECK / the DETERMINISTIC FOLD CHECK / the CLASSIFICATION
 * FOLD CHECK / the INTEGRITY-COHERENCE CHECK / and — the R32 keystone — the RECOVERY-REQUIREMENT COHERENCE CHECK all
 * hold in Postgres. The load-bearing R32 claims are proven here:
 *
 *   • THE RUNTIME DETERMINES `none` FOR A CONSISTENT VERIFICATION — driven through the real `recoverVerifiedFulfilment`
 *     (not the RPC directly), after the real R30 `fulfilApprovedBooking` performed the booking and the real R31
 *     `verifyApprovedFulfilment` recorded a `consistent` verdict: it reads the recorded verification, classifies it,
 *     and files EXACTLY ONE recovery row — threaded to the verification it was determined from, the authorisation, the
 *     fulfilment, the held reply, the sent reply and the human's resolution — with `recovery_classification` = 'none',
 *     `recovery_required` = false, `integrity` = 'consistent', `approval_state` = 'approved' and `status` =
 *     'determined'.
 *   • THE RUNTIME DETERMINES `reinstate` FOR A MISSING VERIFICATION — when R31 recorded a `missing` verdict (the
 *     approved operation went unrecorded), the runtime files a recovery with `recovery_classification` = 'reinstate',
 *     `recovery_required` = true and `fulfilment_id` NULL. The operation warranting reinstatement is an observable,
 *     auditable disposition — the whole point of the engine.
 *   • THE RUNTIME DETERMINES `reconcile` FOR AN INCONSISTENT VERIFICATION — when R31 recorded an `inconsistent` verdict
 *     (a divergent record), the runtime files a recovery with `recovery_classification` = 'reconcile',
 *     `recovery_required` = true and `fulfilment_id` set. Divergence warranting reconciliation is caught, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is never fulfilled,
 *     so never verified, so the recovery-context reader finds NO verification and the runtime recovers NOTHING.
 *   • A NON-VERIFIED REPLY RECOVERS NOTHING — when there is no recorded verification behind the held reply (the common
 *     case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same approved authorisation determines recovery AT MOST ONCE: the second call
 *     returns the SAME recovery id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved'. There is no path to determining recovery for un-approved work.
 *   • THE RECOVERY REQUIREMENT IS COHERENT WITH THE DISPOSITION (the R32 keystone) — the write primitive and a column
 *     CHECK REJECT a `recovery_required` that contradicts the classification (required iff not `none`).
 *   • THE CLASSIFICATION IS THE DETERMINISTIC FOLD OF THE VERDICT — the write primitive and a column CHECK REJECT a
 *     classification that contradicts the source integrity verdict (consistent→none, missing→reinstate,
 *     inconsistent→reconcile).
 *   • THE INTEGRITY VERDICT IS COHERENT WITH THE RECORD (inherited from R31) — a `missing` verdict carrying a
 *     `fulfilment_id`, or a `consistent`/`inconsistent` verdict carrying none, is rejected.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or
 *     call the recovery-context reader.
 *   • THE VOCABULARY, THE FOLDS AND THE FIELD SHAPES ARE PINNED — a recovery type/outcome/classification/integrity
 *     outside its set, a malformed expected booking field, a missing job type, an absent verification or Human Review
 *     provenance id, or a status other than 'determined' is rejected.
 *   • THE READER CENTRES ON THE VERIFICATION LEDGER — it returns the RECORDED verification behind a held reply (the
 *     input the runtime classifies), and returns nothing when no verification was recorded.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All four receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications, R32 recoveries) are append-only (even service_role cannot DELETE), so these tests intentionally
 * leave their rows behind — harmless in the ephemeral CI database, and proving exactly that is one of the tests
 * below. Rows are addressed by a per-call authorisation id so each assertion sees only its own writes. No FK'd tenant
 * rows are created, so no teardown is required.
 */

// receptionist_conversation_recoveries / record_receptionist_conversation_recovery /
// find_receptionist_recovery_context are service-role-only internals, NOT in the generated Database types. Cast to the
// minimal surface this suite exercises (the same `as unknown as` convention the verification / fulfilment suites use)
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
type RecoveryTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type RecoveryClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): RecoveryTable;
};

const TABLE = "receptionist_conversation_recoveries";
const RPC = "record_receptionist_conversation_recovery";
const READER = "find_receptionist_recovery_context";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): RecoveryClient => serviceClient() as unknown as RecoveryClient;
const anon = (): RecoveryClient => anonClient() as unknown as RecoveryClient;

// The columns every assertion below reads back — the full captured recovery record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "authorisation_id, verification_id, fulfilment_id, review_audit_id, sent_audit_id, review_resolution_id, " +
  "recovery_type, recovery_outcome, recovery_classification, recovery_required, integrity, approval_state, " +
  "job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a `none` recover_booking_fulfilment (consistent verdict) — spread and overridden per case.
// `none` requires recovery_required=false and, via the classification fold, integrity='consistent', which via the
// integrity-coherence CHECK requires a non-null fulfilment_id — so the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_id: crypto.randomUUID(),
  p_recovery_type: "recover_booking_fulfilment",
  p_recovery_outcome: "fulfilment_recovery_determined",
  p_recovery_classification: "none",
  p_recovery_required: false,
  p_integrity: "consistent",
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

// A valid RPC payload for a `reinstate` recovery (missing verdict) — recovery_required=true, integrity='missing',
// fulfilment_id NULL (the integrity-coherence CHECK). Used for the coherence NEGATIVE cases that must start coherent.
const reinstateRpcArgs = () => ({
  ...validRpcArgs(),
  p_recovery_classification: "reinstate",
  p_recovery_required: true,
  p_integrity: "missing",
  p_fulfilment_id: null as string | null,
});

// A valid direct-insert row (every NOT NULL column present, every field well-formed, all folds coherent) — used ONLY
// for the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  verification_id: crypto.randomUUID(),
  fulfilment_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  recovery_type: "recover_booking_fulfilment",
  recovery_outcome: "fulfilment_recovery_determined",
  recovery_classification: "none",
  recovery_required: false,
  integrity: "consistent",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the requirement + state ALWAYS match the
 * deterministic fold of the eligibility they are recorded with. `allow`+live ⇒ pending (fulfillable, so verifiable,
 * so recoverable); `block` ⇒ foreclosed (never fulfillable, so never verifiable, so never recoverable).
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

/** Read every recovery row filed for one authorisation id, as service_role (ground truth). */
function rowsForAuth(authorisationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("authorisation_id", authorisationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error
 *  or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration(
  "Conversation Recovery pipeline · receptionist_conversation_recoveries (R32)",
  () => {
    it("recoverVerifiedFulfilment determines `none` for a CONSISTENT verification — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed a PENDING approve_booking authorisation, PERFORM the R30 fulfilment, then VERIFY it (consistent) — the
      // full R29→R30→R31 chain, so the recorded verification the Recovery Engine reads is genuine.
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
      expect(verified, "R31 verified the approved fulfilment").not.toBeNull();
      expect(verified?.integrity).toBe("consistent");

      // THE RECOVERY — the runtime reads R31's recorded verification, classifies the `consistent` verdict, and records
      // the disposition. `consistent` ⇒ `none`, recovery_required=false.
      const sentAuditId = crypto.randomUUID();
      const resolutionId = crypto.randomUUID();
      const recovered = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: resolutionId,
      });
      expect(recovered, "the verified fulfilment's recovery was determined").not.toBeNull();
      expect(recovered?.recovery_type).toBe("recover_booking_fulfilment");
      expect(recovered?.recovery_outcome).toBe("fulfilment_recovery_determined");
      expect(recovered?.recovery_classification).toBe("none");
      expect(recovered?.recovery_required).toBe(false);

      // EXACTLY ONE row — not zero, not two.
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(recovered?.recovery_id);
      // The determined disposition is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.verification_id).toBe(verified?.verification_id); // the verification it was determined from (R32's anchor)
      expect(row.authorisation_id).toBe(seeded?.authorisation_id); // the authorisation (the idempotency anchor)
      expect(row.fulfilment_id).toBe(fulfilled?.fulfilment_id); // the fulfilment the verification reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      // The anchors threaded THROUGH the recorded verification the reader resolved.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was determined, the disposition, the flag, the source verdict, and the EXPECTED booking payload.
      expect(row.recovery_type).toBe("recover_booking_fulfilment");
      expect(row.recovery_outcome).toBe("fulfilment_recovery_determined");
      expect(row.recovery_classification).toBe("none");
      expect(row.recovery_required).toBe(false);
      expect(row.integrity).toBe("consistent");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + DETERMINED BY CONSTRUCTION — the grant that authorised the operation, and the determined status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("determined");
    });

    it("determines `reinstate` for a MISSING verification (the operation went unrecorded)", async () => {
      // Seed a PENDING approve_booking authorisation, but DO NOT perform the R30 fulfilment — R31 verifies it as
      // `missing`. The Recovery Engine reads that verdict and classifies it `reinstate` with fulfilment_id NULL.
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
      expect(recovered, "a missing verification warrants reinstatement").not.toBeNull();
      expect(recovered?.recovery_classification).toBe("reinstate");
      expect(recovered?.recovery_required).toBe(true);

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.recovery_classification).toBe("reinstate");
      expect(row.recovery_required).toBe(true);
      expect(row.integrity).toBe("missing");
      // The coherence invariant, observed end-to-end: a `missing` verdict carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.verification_id).toBe(verified?.verification_id);
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("determined");
    });

    it("determines `reconcile` for an INCONSISTENT verification (the record diverges from the decision)", async () => {
      // Seed a PENDING approve_booking for JOB=plumbing, file a DIVERGENT R30 fulfilment (a different trade), so R31
      // verifies it as `inconsistent`. The Recovery Engine reads that verdict and classifies it `reconcile`.
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
      // its id, but for a different trade than the authorisation carries. (An R30 row cannot be mutated; divergence is
      // filed, not edited.)
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
      expect(recovered, "an inconsistent verification warrants reconciliation").not.toBeNull();
      expect(recovered?.recovery_classification).toBe("reconcile");
      expect(recovered?.recovery_required).toBe(true);

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.recovery_classification).toBe("reconcile");
      expect(row.recovery_required).toBe(true);
      expect(row.integrity).toBe("inconsistent");
      // A divergence is still classified against a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).toBe(divergent.data);
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never verified, so never recovered", async () => {
      // A policy-/org-blocked booking folds to FORECLOSED at R29 → never fulfilled → never verified → the
      // recovery-context reader finds no verification → the runtime recovers NOTHING.
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

      // (Even if a send fired the whole chain, nothing verifies — so nothing recovers.)
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const result = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never recovered").toBeNull();

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data ?? []).toHaveLength(0);
    });

    it("a NON-VERIFIED reply recovers nothing — no recorded verification behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No verification was recorded,
      // so the runtime returns null and files no row.
      const result = await recoverVerifiedFulfilment({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no verification behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same approved authorisation determines recovery AT MOST ONCE", async () => {
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
      // Record the verification once (as `missing`, since no R30 fulfilment; the verdict is immaterial to idempotency).
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      const first = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME authorisation.
      const second = await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call determined nothing; ON CONFLICT (authorisation_id) returned the existing row.
      expect(second?.recovery_id).toBe(first?.recovery_id);

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.recovery_id);
    });

    it("the write primitive files a recovery and is idempotent on the authorisation id (direct RPC)", async () => {
      const authId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the recovery id").toBeTruthy();

      // A repeat with the SAME authorisation id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_authorisation_id: authId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc()
        .from(TABLE)
        .select("id, approval_state, status, recovery_classification, recovery_required")
        .eq("authorisation_id", authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("determined");
      expect(read.data?.[0]?.recovery_classification).toBe("none");
      expect(read.data?.[0]?.recovery_required).toBe(false);
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited transitively from R31 → R30: a recovery can ONLY exist for an approved authorisation.
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }
      const insertUnapproved = await svc().from(TABLE).insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved recovery, even for service_role",
      ).not.toBeNull();
    });

    it("THE KEYSTONE — recovery_required is coherent with the disposition (required iff not `none`) (RPC and CHECK)", async () => {
      // A `none` disposition claiming recovery is required is rejected by the RPC's keystone validation…
      const noneButRequired = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_required: true });
      expect(noneButRequired.error, "a `none` disposition claiming recovery required must be rejected").not.toBeNull();

      // …and a real recovery (`reinstate`) claiming recovery is NOT required is rejected too.
      const reinstateButNotRequired = await svc().rpc<string>(RPC, {
        ...reinstateRpcArgs(),
        p_recovery_required: false,
      });
      expect(
        reinstateButNotRequired.error,
        "a `reinstate` disposition claiming no recovery required must be rejected",
      ).not.toBeNull();

      // The column CHECK enforces the same equivalence on a direct service_role insert.
      const insertIncoherent = await svc().from(TABLE).insert({ ...validInsertRow(), recovery_required: true });
      expect(
        insertIncoherent.error,
        "the requirement-coherence CHECK rejects `none` + required, even for service_role",
      ).not.toBeNull();
    });

    it("THE CLASSIFICATION is the deterministic fold of the verdict (RPC and CHECK)", async () => {
      // `consistent` folds to `none` ONLY — a `consistent` verdict classified `reinstate` is rejected (keystone kept
      // coherent so ONLY the fold is violated)…
      const consistentReinstate = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_recovery_classification: "reinstate",
        p_recovery_required: true,
      });
      expect(consistentReinstate.error, "consistent must fold to none, not reinstate").not.toBeNull();

      // …and a `missing` verdict classified `none` is rejected (integrity + keystone kept coherent).
      const missingNone = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_integrity: "missing",
        p_fulfilment_id: null,
        p_recovery_classification: "none",
        p_recovery_required: false,
      });
      expect(missingNone.error, "missing must fold to reinstate, not none").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), recovery_classification: "reconcile", recovery_required: true });
      expect(
        insertBadFold.error,
        "the classification-fold CHECK rejects consistent + reconcile, even for service_role",
      ).not.toBeNull();
    });

    it("THE INTEGRITY VERDICT is coherent with the record (inherited from R31) — missing iff no fulfilment_id (RPC and CHECK)", async () => {
      // A `missing` recovery carrying a fulfilment_id is rejected…
      const missingWithFulfilment = await svc().rpc<string>(RPC, {
        ...reinstateRpcArgs(),
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(missingWithFulfilment.error, "a MISSING recovery carrying a fulfilment_id must be rejected").not.toBeNull();

      // …and a `consistent` recovery with NO fulfilment_id is rejected.
      const consistentWithoutFulfilment = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_fulfilment_id: null,
      });
      expect(
        consistentWithoutFulfilment.error,
        "a consistent recovery with no fulfilment_id must be rejected",
      ).not.toBeNull();

      // A COHERENT `reinstate` (missing, no fulfilment_id) is accepted — the disposition the engine exists to record.
      const coherentReinstate = await svc().rpc<string>(RPC, { ...reinstateRpcArgs() });
      expect(coherentReinstate.error, coherentReinstate.error?.message).toBeNull();
      expect(coherentReinstate.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const authId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(filed.error, filed.error?.message).toBeNull();

      const updated = await svc()
        .from(TABLE)
        .update({ recovery_classification: "reconcile" })
        .eq("authorisation_id", authId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      const deleted = await svc().from(TABLE).delete().eq("authorisation_id", authId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      const read = await rowsForAuth(authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.recovery_classification).toBe("none");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const authId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });

      const asService = await rowsForAuth(authId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      expectAnonDenied(await anon().from(TABLE).select("id").eq("authorisation_id", authId));

      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file a recovery").not.toBeNull();

      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to read the recovery context").not.toBeNull();

      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the folds, the field shapes, the provenance and the determined status", async () => {
      // A recovery type outside {recover_booking_fulfilment} is rejected.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_type: "recover_quote_fulfilment" });
      expect(badType.error, "a recovery type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {fulfilment_recovery_determined} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_recovery_outcome: "fulfilment_recovery_executed",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A classification outside {none, reinstate, reconcile} is rejected.
      const badClassification = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_recovery_classification: "retry",
      });
      expect(badClassification.error, "a classification outside the vocabulary must be rejected").not.toBeNull();

      // An integrity outside {consistent, missing, inconsistent} is rejected.
      const badIntegrity = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_integrity: "partial" });
      expect(badIntegrity.error, "an integrity outside the vocabulary must be rejected").not.toBeNull();

      // A recovery with a malformed expected number / postcode is rejected — the ledger never records an unringable
      // expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // A recover_booking_fulfilment with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a recovery with no expected job type must be rejected").not.toBeNull();

      // The verification anchor and the full Human Review provenance are MANDATORY.
      const noVerification = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_id: null });
      expect(noVerification.error, "a recovery with no verification reference must be rejected").not.toBeNull();
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a recovery with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a recovery with no sent-reply reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noResolution.error, "a recovery with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), recovery_outcome: "fulfilment_recovery_executed" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // DETERMINED BY CONSTRUCTION: a direct service_role insert claiming any status but 'determined' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "executed" });
      expect(badStatus.error, "a status other than 'determined' must be rejected by the CHECK").not.toBeNull();
    });

    it("the recovery-context reader centres on the verification ledger — returns the recorded verification, or nothing", async () => {
      const orgId = crypto.randomUUID();

      // A recorded verification behind held reply A (via the full R29→R31 chain, as `missing`).
      const reviewA = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewA,
        decision: authorise("allow", true),
      });
      expect(seeded?.state).toBe("pending");
      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(verified, "R31 recorded a verification behind held reply A").not.toBeNull();

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const vRow = found.data?.[0] ?? {};
      // The reader returns R31's RECORDED verification verbatim, so the runtime can reconstruct the decision.
      expect(vRow.verification_id).toBe(verified?.verification_id);
      expect(vRow.authorisation_id).toBe(seeded?.authorisation_id);
      expect(vRow.verification_type).toBe("verify_booking_fulfilment");
      expect(vRow.verification_outcome).toBe("fulfilment_reconciled");
      expect(vRow.integrity).toBe("missing");
      expect(vRow.approval_state).toBe("approved");
      expect(vRow.job_type).toBe(JOB);
      expect(vRow.postcode).toBe(POSTCODE);
      expect(vRow.phone_number).toBe(PHONE);
      expect(vRow.fulfilment_id).toBeNull(); // missing → no fulfilment

      // A held reply B with NO recorded verification — the reader returns nothing.
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

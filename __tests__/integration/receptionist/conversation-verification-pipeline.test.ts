import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Verification pipeline — real-Postgres proof of the AI Receptionist Programme R31
 * (CONVERSATION VERIFICATION ENGINE), the FIRST layer that VERIFIES: given an APPROVED, PERFORMED fulfilment it
 * RECONCILES the DECIDED operation (re-derived through R30's own `resolveFulfilment`) against the RECORDED one (the
 * R30 row R30 filed beside it) and files an auditable INTEGRITY verdict — and never performs any business action.
 *
 * The unit tier proves the pure core resolves a verification DECISION deterministically, DEFERS when R30 rendered no
 * decision, and reports `consistent` / `missing` / `inconsistent` correctly; the security tier proves, as SOURCE,
 * that the ledger is append-only, service-role-only, approved-only, integrity-coherent and idempotent, that the
 * Fulfilment (R30) and Authorisation (R29) Engines stay authoritative, that Human Review can never be bypassed, and
 * that no duplicate verification logic exists. This tier proves the BEHAVIOUR the mocks can't — that when the
 * CANONICAL RUNTIME actually resolves the pending authorisation behind a held reply, re-derives the human's `sent`
 * grant through R29's OWN bridge, re-derives the EXPECTED fulfilment through R30's OWN resolver, reads the RECORDED
 * fulfilment R30 filed (or its ABSENCE) through the single reconciliation reader, and reconciles the two against a
 * live database, exactly one idempotent verification row is really filed with the right verdict, and the migration's
 * storage / RLS / append-only guard / privilege model / vocabulary CHECKs / the APPROVED-ONLY CHECK / the
 * DETERMINISTIC FOLD CHECK / and — the R31 keystone — the INTEGRITY-COHERENCE CHECK all hold in Postgres. The
 * load-bearing R31 claims are proven here:
 *
 *   • THE RUNTIME VERIFIES A CONSISTENT FULFILMENT — driven through the real `verifyApprovedFulfilment` (not the RPC
 *     directly), after the real R30 `fulfilApprovedBooking` has performed the booking: it resolves the PENDING
 *     `approve_booking` authorisation behind the held reply, LEFT JOINs the fulfilment R30 filed, re-derives the
 *     EXPECTED fulfilment, reconciles it against the RECORDED one, and files EXACTLY ONE verification row — threaded
 *     to the authorisation it verifies, the fulfilment it reconciled, the held reply, the sent reply and the human's
 *     resolution — with `integrity` = 'consistent', `approval_state` = 'approved' and `status` = 'verified'.
 *   • THE RUNTIME DETECTS A MISSING FULFILMENT — when the operation was DECIDED (the authorisation is approved) but
 *     R30 filed NO record (its best-effort write never landed), the reconciliation reader's LEFT JOIN yields NULLs,
 *     and the runtime files a verification with `integrity` = 'missing' and `fulfilment_id` NULL. R30's silent gap
 *     becomes an observable, auditable signal — the whole point of the engine.
 *   • THE RUNTIME DETECTS AN INCONSISTENT FULFILMENT — when a RECORDED fulfilment DIVERGES from the decision (here a
 *     directly-filed R30 row whose booking payload differs from the authorisation's), the runtime files a
 *     verification with `integrity` = 'inconsistent' and `fulfilment_id` set. Divergence is caught, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is invisible to the
 *     reconciliation reader (which returns only PENDING approve_booking rows), so the runtime verifies NOTHING: no
 *     fold to `approved` is possible, no fulfilment was ever decided, and no verification row is filed.
 *   • A NON-BOOKING REPLY VERIFIES NOTHING — when there is no pending booking authorisation behind the held reply
 *     (the common case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same approved authorisation (a retried review-send, a double-fire) verifies
 *     AT MOST ONCE: the second call returns the SAME verification id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved', even for a direct service_role insert. There is no path to verifying
 *     un-approved work.
 *   • THE INTEGRITY VERDICT IS COHERENT WITH THE RECORD IT RECONCILES — the write primitive and a column CHECK
 *     REJECT a `missing` verdict carrying a `fulfilment_id`, and a `consistent`/`inconsistent` verdict carrying
 *     none. A stored verdict can never contradict the presence of the record it claims to have reconciled.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or
 *     call the reconciliation reader.
 *   • THE VOCABULARY, THE FOLD AND THE FIELD SHAPES ARE PINNED — a verification type/outcome/integrity outside its
 *     set, a malformed expected booking field, a missing job type, an absent Human Review provenance id, or a status
 *     other than 'verified' is rejected, so a stored row can never misrepresent a verified reconciliation.
 *   • THE READER RECONCILES BOTH LEDGERS — it returns the PENDING `approve_booking` authorisation behind a held
 *     reply LEFT JOINed to the fulfilment R30 filed for it (NULLs when MISSING), and excludes a foreclosed one; the
 *     approval fold stays in R29 and the expected shape stays in R30.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All three receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications) are append-only (even service_role cannot DELETE), so these tests intentionally leave their rows
 * behind — harmless in the ephemeral CI database, and proving exactly that is one of the tests below. Rows are
 * addressed by a per-call authorisation id so each assertion sees only its own writes. No FK'd tenant rows are
 * created, so no teardown is required.
 */

// receptionist_conversation_verifications / record_receptionist_conversation_verification /
// find_receptionist_fulfilment_reconciliation are service-role-only internals, NOT in the generated Database types.
// Cast to the minimal surface this suite exercises (the same `as unknown as` convention the fulfilment / execution /
// authorisation suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type VerificationTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type VerificationClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): VerificationTable;
};

const TABLE = "receptionist_conversation_verifications";
const RPC = "record_receptionist_conversation_verification";
const READER = "find_receptionist_fulfilment_reconciliation";
// R30's write primitive — used ONLY to file a DIVERGENT recorded fulfilment for the `inconsistent` proof (an R30 row
// cannot be mutated: the ledger is append-only, so divergence must be filed, not edited).
const FULFIL_RPC = "record_receptionist_conversation_fulfilment";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): VerificationClient => serviceClient() as unknown as VerificationClient;
const anon = (): VerificationClient => anonClient() as unknown as VerificationClient;

// The columns every assertion below reads back — the full captured verification record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "authorisation_id, fulfilment_id, review_audit_id, sent_audit_id, review_resolution_id, verification_type, " +
  "verification_outcome, integrity, approval_state, job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a CONSISTENT verify_booking_fulfilment — spread and overridden per case. `consistent`
// requires a non-null fulfilment_id (the integrity-coherence CHECK), so the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_type: "verify_booking_fulfilment",
  p_verification_outcome: "fulfilment_reconciled",
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

// A valid direct-insert row (every NOT NULL column present, every field well-formed, verdict coherent with the
// fulfilment_id) — used ONLY for the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  fulfilment_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  verification_type: "verify_booking_fulfilment",
  verification_outcome: "fulfilment_reconciled",
  integrity: "consistent",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

// A valid R30 fulfilment RPC payload — used to file the DIVERGENT recorded fulfilment behind the `inconsistent`
// proof. Overridden with the authorisation id it should join to and a divergent booking field.
const validFulfilRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_fulfilment_type: "fulfil_booking",
  p_fulfilment_outcome: "booking_recorded",
  p_approval_state: "approved",
  p_correlation_id: crypto.randomUUID(),
  p_review_audit_id: crypto.randomUUID(),
  p_sent_audit_id: crypto.randomUUID(),
  p_review_resolution_id: crypto.randomUUID(),
  p_job_type: JOB,
  p_postcode: POSTCODE,
  p_phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the requirement + state ALWAYS match the
 * deterministic fold of the eligibility they are recorded with — a genuine composition of the R28 execution
 * engine and the R29 authorisation engine, never a hand-forged decision. `allow`+live ⇒ pending (fulfillable, so
 * verifiable); `block` ⇒ foreclosed (never fulfillable, so never verifiable).
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

/** Read every verification row filed for one authorisation id, as service_role (ground truth). */
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
  "Conversation Verification pipeline · receptionist_conversation_verifications (R31)",
  () => {
    it("verifyApprovedFulfilment records a CONSISTENT verdict — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed a PENDING approve_booking authorisation in the R29 ledger behind a held reply, through the real R29
      // runtime — so the requirement/state/eligibility and the booking payload are genuine. `allow`+live folds to
      // (human_approval_required, pending).
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

      // THE HUMAN APPROVES — R30 PERFORMS the booking on the `sent` resolution (the layer R31 verifies).
      const fulfilSentAuditId = crypto.randomUUID();
      const fulfilResolutionId = crypto.randomUUID();
      const fulfilled = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: fulfilSentAuditId,
        review_resolution_id: fulfilResolutionId,
      });
      expect(fulfilled, "R30 performed the approved booking").not.toBeNull();

      // THE VERIFICATION — the runtime re-derives the EXPECTED fulfilment, reads the RECORDED one R30 just filed,
      // reconciles them, and records the verdict. The RECORDED matches the DECISION, so the verdict is `consistent`.
      const sentAuditId = crypto.randomUUID();
      const resolutionId = crypto.randomUUID();
      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: resolutionId,
      });
      expect(verified, "the approved fulfilment was verified").not.toBeNull();
      expect(verified?.verification_type).toBe("verify_booking_fulfilment");
      expect(verified?.verification_outcome).toBe("fulfilment_reconciled");
      expect(verified?.integrity).toBe("consistent");

      // EXACTLY ONE row — not zero, not two.
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(verified?.verification_id);
      // The verified operation is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.authorisation_id).toBe(seeded?.authorisation_id); // the authorisation it verifies (the idempotency anchor)
      expect(row.fulfilment_id).toBe(fulfilled?.fulfilment_id); // the fulfilment it reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      expect(row.sent_audit_id).toBe(sentAuditId); // the reply that carried the approval
      expect(row.review_resolution_id).toBe(resolutionId); // the human's grant itself
      // The anchors threaded THROUGH the R29 authorisation the reader resolved.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was verified, the verdict, and the EXPECTED booking payload (from the decision, not the recorded row).
      expect(row.verification_type).toBe("verify_booking_fulfilment");
      expect(row.verification_outcome).toBe("fulfilment_reconciled");
      expect(row.integrity).toBe("consistent");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + VERIFIED BY CONSTRUCTION — the grant that authorised the operation, and the verified status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("verified");
    });

    it("records a MISSING verdict when the operation was decided but R30 recorded nothing", async () => {
      // Seed a PENDING approve_booking authorisation, but DO NOT perform the R30 fulfilment — R30's best-effort write
      // never landed. The reconciliation reader's LEFT JOIN yields NULLs for the fulfilment side, so the runtime
      // reconciles the DECISION against ABSENCE and records `missing` with `fulfilment_id` NULL.
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
      expect(verified, "a decided-but-unrecorded operation is verified as MISSING").not.toBeNull();
      expect(verified?.integrity).toBe("missing");

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.integrity).toBe("missing");
      // The coherence invariant, observed end-to-end: a `missing` verdict carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("verified");
    });

    it("records an INCONSISTENT verdict when the recorded fulfilment diverges from the decision", async () => {
      // Seed a PENDING approve_booking authorisation for JOB=plumbing. Then file — directly through R30's write
      // primitive (a row cannot be mutated: the ledger is append-only) — a fulfilment joined to that authorisation
      // whose booking payload DIVERGES (a different trade). The runtime re-derives the EXPECTED fulfilment from the
      // authorisation (plumbing), reads the RECORDED one back (the divergent trade), and records `inconsistent`.
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

      // A RECORDED fulfilment that diverges from the decision — joined to the authorisation by its id, but for a
      // different trade than the authorisation carries.
      const divergent = await svc().rpc<string>(FULFIL_RPC, {
        ...validFulfilRpcArgs(),
        p_org_id: orgId,
        p_authorisation_id: seeded?.authorisation_id,
        p_job_type: "electrical", // DIVERGENT — the authorisation is for plumbing
      });
      expect(divergent.error, divergent.error?.message).toBeNull();

      const verified = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(verified, "a divergent recorded fulfilment is verified as INCONSISTENT").not.toBeNull();
      expect(verified?.integrity).toBe("inconsistent");

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.integrity).toBe("inconsistent");
      // A divergence is still RECONCILED against a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).toBe(divergent.data);
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never verified", async () => {
      // A policy-/org-blocked booking folds to a FORECLOSED authorisation at R29. The reader returns only PENDING
      // approve_booking rows, so the runtime cannot even see it — no fulfilment was ever decided, and nothing is
      // verified. `block` ⇒ blocked_by_policy ⇒ (not_required, foreclosed).
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

      const result = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never verified").toBeNull();

      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data ?? []).toHaveLength(0);
    });

    it("a NON-BOOKING reply verifies nothing — no pending authorisation behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No pending authorisation is
      // found, so the runtime returns null and files no row.
      const result = await verifyApprovedFulfilment({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no authorisation behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same approved authorisation verifies AT MOST ONCE", async () => {
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

      // First send — verifies (as `missing`, since no R30 fulfilment was performed; the verdict is immaterial to
      // idempotency).
      const first = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME authorisation.
      const second = await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call verified nothing; ON CONFLICT (authorisation_id) returned the existing row.
      expect(second?.verification_id).toBe(first?.verification_id);

      // Exactly ONE row survives for the authorisation.
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.verification_id);
    });

    it("the write primitive files a verification and is idempotent on the authorisation id (direct RPC)", async () => {
      const authId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the verification id").toBeTruthy();

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
        .select("id, approval_state, status, integrity")
        .eq("authorisation_id", authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("verified");
      expect(read.data?.[0]?.integrity).toBe("consistent");
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited from R30: a verification can ONLY exist for an approved authorisation. An attempt to verify
      // un-approved work is rejected by the RPC's approval validation…
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }

      // …and by the column CHECK on a direct service_role insert.
      const insertUnapproved = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved verification, even for service_role",
      ).not.toBeNull();
    });

    it("the INTEGRITY VERDICT is coherent with the record it reconciles — missing iff no fulfilment_id (RPC and CHECK)", async () => {
      // THE R31 KEYSTONE. `missing` means, and can ONLY mean, no fulfilment was recorded — a `missing` verdict
      // carrying a fulfilment_id is rejected by the RPC's coherence validation…
      const missingWithFulfilment = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_integrity: "missing",
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(
        missingWithFulfilment.error,
        "a MISSING verdict carrying a fulfilment_id must be rejected",
      ).not.toBeNull();

      // …and a `consistent`/`inconsistent` verdict with NO fulfilment_id is rejected too (there is nothing to have
      // reconciled).
      for (const integrity of ["consistent", "inconsistent"]) {
        const presentWithoutFulfilment = await svc().rpc<string>(RPC, {
          ...validRpcArgs(),
          p_integrity: integrity,
          p_fulfilment_id: null,
        });
        expect(
          presentWithoutFulfilment.error,
          `a ${integrity} verdict with no fulfilment_id must be rejected`,
        ).not.toBeNull();
      }

      // The column CHECK enforces the same equivalence on a direct service_role insert, both directions.
      const insertMissingWithFulfilment = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), integrity: "missing" }); // keeps a fulfilment_id → incoherent
      expect(
        insertMissingWithFulfilment.error,
        "the coherence CHECK rejects MISSING with a fulfilment_id, even for service_role",
      ).not.toBeNull();

      const insertConsistentWithoutFulfilment = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), fulfilment_id: null }); // consistent + no fulfilment_id → incoherent
      expect(
        insertConsistentWithoutFulfilment.error,
        "the coherence CHECK rejects CONSISTENT with no fulfilment_id, even for service_role",
      ).not.toBeNull();

      // A COHERENT `missing` (no fulfilment_id) is accepted — the verdict the engine exists to record.
      const coherentMissing = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_integrity: "missing",
        p_fulfilment_id: null,
      });
      expect(coherentMissing.error, coherentMissing.error?.message).toBeNull();
      expect(coherentMissing.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const authId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(filed.error, filed.error?.message).toBeNull();

      // A verification verdict can never be rewritten…
      const updated = await svc()
        .from(TABLE)
        .update({ integrity: "inconsistent" })
        .eq("authorisation_id", authId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      // …nor erased.
      const deleted = await svc().from(TABLE).delete().eq("authorisation_id", authId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      // The row survived both attempts — still exactly one, unchanged.
      const read = await rowsForAuth(authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.integrity).toBe("consistent");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const authId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });

      // service_role (BYPASSRLS) sees the row…
      const asService = await rowsForAuth(authId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      // …anon does not (RLS enabled, zero policies → deny).
      expectAnonDenied(await anon().from(TABLE).select("id").eq("authorisation_id", authId));

      // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file a verification").not.toBeNull();

      // anon cannot call the SECURITY DEFINER reconciliation reader either.
      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to resolve the reconciliation").not.toBeNull();

      // anon cannot write around the RPC with a direct insert either.
      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the fold, the field shapes, the provenance and the verified status", async () => {
      // A verification type outside {verify_booking_fulfilment} is rejected by the RPC's validation.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_type: "verify_quote_fulfilment" });
      expect(badType.error, "a verification type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {fulfilment_reconciled} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_verification_outcome: "fulfilment_scheduled",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // An integrity outside {consistent, missing, inconsistent} is rejected.
      const badIntegrity = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_integrity: "partial" });
      expect(badIntegrity.error, "an integrity outside the vocabulary must be rejected").not.toBeNull();

      // A verification with a malformed expected number is rejected — the ledger never records an unringable expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();

      // A verification with a malformed expected postcode is rejected.
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // A verify_booking_fulfilment with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a verification with no expected job type must be rejected").not.toBeNull();

      // The full Human Review provenance is MANDATORY — a missing held reply, sent reply or resolution is rejected.
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a verification with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a verification with no sent-reply reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noResolution.error, "a verification with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected by
      // the CHECKs (the outcome vocabulary CHECK and the fold CHECK) — the verified result cannot be forged.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), verification_outcome: "fulfilment_scheduled" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // VERIFIED BY CONSTRUCTION: a direct service_role insert claiming any status but 'verified' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "reversed" });
      expect(badStatus.error, "a status other than 'verified' must be rejected by the CHECK").not.toBeNull();
    });

    it("the reconciliation reader returns the PENDING authorisation LEFT JOINed to its fulfilment, and excludes a foreclosed one", async () => {
      const orgId = crypto.randomUUID();

      // A PENDING approve_booking behind held reply A, with R30 having performed its fulfilment.
      const reviewA = crypto.randomUUID();
      const pending = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewA,
        decision: authorise("allow", true),
      });
      expect(pending?.state).toBe("pending");
      const fulfilled = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewA,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(fulfilled, "R30 performed the booking behind held reply A").not.toBeNull();

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const authRow = found.data?.[0] ?? {};
      // The AUTHORISATION side — the pending row, so the runtime can reconstruct it and re-derive the expected fulfilment.
      expect(authRow.authorisation_id).toBe(pending?.authorisation_id);
      expect(authRow.authorisation_state).toBe("pending");
      expect(authRow.requirement).toBe("human_approval_required");
      expect(authRow.execution_eligibility).toBe("requires_human_review");
      expect(authRow.job_type).toBe(JOB);
      expect(authRow.postcode).toBe(POSTCODE);
      expect(authRow.phone_number).toBe(PHONE);
      // The RECORDED side — the R30 fulfilment LEFT JOINed on the authorisation.
      expect(authRow.fulfilment_id).toBe(fulfilled?.fulfilment_id);
      expect(authRow.recorded_fulfilment_type).toBe("fulfil_booking");
      expect(authRow.recorded_fulfilment_outcome).toBe("booking_recorded");
      expect(authRow.recorded_approval_state).toBe("approved");
      expect(authRow.recorded_status).toBe("fulfilled");
      expect(authRow.recorded_job_type).toBe(JOB);

      // A PENDING approve_booking behind held reply B with NO fulfilment — the RECORDED side is all NULLs (MISSING).
      const reviewB = crypto.randomUUID();
      const pendingUnfulfilled = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewB,
        decision: authorise("allow", true),
      });
      expect(pendingUnfulfilled?.state).toBe("pending");
      const foundMissing = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewB,
      });
      expect(foundMissing.data).toHaveLength(1);
      const missingRow = foundMissing.data?.[0] ?? {};
      expect(missingRow.authorisation_id).toBe(pendingUnfulfilled?.authorisation_id);
      expect(missingRow.fulfilment_id).toBeNull();
      expect(missingRow.recorded_fulfilment_type).toBeNull();
      expect(missingRow.recorded_status).toBeNull();

      // A FORECLOSED authorisation behind held reply C is INVISIBLE to the reader (it returns only PENDING rows).
      const reviewC = crypto.randomUUID();
      await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewC,
        decision: authorise("block", true),
      });
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewC,
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

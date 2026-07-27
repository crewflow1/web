import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Fulfilment pipeline — real-Postgres proof of the AI Receptionist Programme R30
 * (CONVERSATION FULFILMENT ENGINE), the FIRST layer that PERFORMS: given an APPROVED authorisation it CARRIES OUT
 * the approved internal business operation (booking fulfilment) — and never for anything else.
 *
 * The unit tier proves the pure core resolves a fulfilment DECISION deterministically and ONLY for an approved
 * grant; the security tier proves, as SOURCE, that the ledger is append-only, service-role-only, approved-only and
 * idempotent, that the Authorisation Engine stays authoritative, that policy is consumed transitively, that Human
 * Review can never be bypassed (fulfilment fires on SEND only, downstream of a human's grant), and that no
 * duplicate fulfilment logic exists. This tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL
 * RUNTIME actually resolves the pending authorisation behind a held reply, folds the human's `sent` grant through
 * R29's OWN bridge, and PERFORMS the booking against a live database, exactly one idempotent fulfilment row is
 * really filed, and the migration's storage / RLS / append-only guard / privilege model / vocabulary CHECKs / and —
 * the R30 keystone — the APPROVED-ONLY CHECK and the DETERMINISTIC FOLD CHECK all hold in Postgres. The
 * load-bearing R30 claims are proven here:
 *
 *   • THE RUNTIME PERFORMS THE APPROVED BOOKING — driven through the real `fulfilApprovedBooking` (not the RPC
 *     directly): it resolves the PENDING `approve_booking` authorisation behind a held reply through the
 *     service-role-only reader, reconstructs the authorisation, folds the human's `sent` resolution to `approved`
 *     through R29's `deriveAuthorisationState`, and files EXACTLY ONE fulfilment row — threaded to the
 *     authorisation it fulfils, the held reply, the sent reply and the human's resolution — with its
 *     `approval_state` pinned to 'approved' and its `status` pinned to 'fulfilled'.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is invisible to the
 *     reader (which returns only PENDING approve_booking rows), so the runtime performs NOTHING: no fold to
 *     `approved` is possible, and no fulfilment row is filed. Policy's refusal propagates all the way here.
 *   • A NON-BOOKING REPLY FULFILS NOTHING — when there is no pending booking authorisation behind the held reply
 *     (the common case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same approved authorisation (a retried review-send, a double-fire) performs
 *     the booking AT MOST ONCE: the second call returns the SAME fulfilment id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved', even for a direct service_role insert. There is no path to performing
 *     un-approved work.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or
 *     call the pending-authorisation reader.
 *   • THE VOCABULARY, THE FOLD AND THE FIELD SHAPES ARE PINNED — a fulfilment type/outcome outside its set, a
 *     malformed booking field, a missing job type, an absent Human Review provenance id, or a status other than
 *     'fulfilled' is rejected, so a stored row can never misrepresent a performed operation.
 *   • THE READER READS ONLY THE R29 LEDGER — it returns the PENDING `approve_booking` authorisation behind a held
 *     reply and excludes a foreclosed one; the approval fold stays in R29.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. Both ledgers (R29 authorisations, R30 fulfilments) are append-only (even service_role cannot
 * DELETE), so these tests intentionally leave their rows behind — harmless in the ephemeral CI database, and
 * proving exactly that is one of the tests below. Rows are addressed by a per-call authorisation id so each
 * assertion sees only its own writes. No FK'd tenant rows are created, so no teardown is required.
 */

// receptionist_conversation_fulfilments / record_receptionist_conversation_fulfilment /
// find_receptionist_pending_booking_authorisation are service-role-only internals, NOT in the generated Database
// types. Cast to the minimal surface this suite exercises (the same `as unknown as` convention the reply-audit /
// outcome / action / execution / authorisation suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type FulfilmentTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type FulfilmentClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): FulfilmentTable;
};

const TABLE = "receptionist_conversation_fulfilments";
const RPC = "record_receptionist_conversation_fulfilment";
const READER = "find_receptionist_pending_booking_authorisation";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): FulfilmentClient => serviceClient() as unknown as FulfilmentClient;
const anon = (): FulfilmentClient => anonClient() as unknown as FulfilmentClient;

// The columns every assertion below reads back — the full captured fulfilment record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "authorisation_id, review_audit_id, sent_audit_id, review_resolution_id, fulfilment_type, fulfilment_outcome, " +
  "approval_state, job_type, postcode, phone_number, status, metadata";

// The valid RPC payload for an APPROVED fulfil_booking — spread and overridden per rejection case.
const validRpcArgs = () => ({
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

// A valid direct-insert row (every NOT NULL column present, every field well-formed) — used ONLY for the NEGATIVE
// cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  fulfilment_type: "fulfil_booking",
  fulfilment_outcome: "booking_recorded",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the requirement + state ALWAYS match the
 * deterministic fold of the eligibility they are recorded with — a genuine composition of the R28 execution
 * engine and the R29 authorisation engine, never a hand-forged decision. `allow`+live ⇒ pending (fulfillable);
 * `block` ⇒ foreclosed (never fulfillable).
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

/** Read every fulfilment row filed for one authorisation id, as service_role (ground truth). */
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
  "Conversation Fulfilment pipeline · receptionist_conversation_fulfilments (R30)",
  () => {
    it("fulfilApprovedBooking PERFORMS the approved booking — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed a PENDING approve_booking authorisation in the R29 ledger behind a held reply (the shape the Human
      // Review inbox surfaces), through the real R29 runtime — so the requirement/state/eligibility and the booking
      // payload are genuine, never hand-forged. `allow`+live folds to (human_approval_required, pending).
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

      // THE HUMAN APPROVES — a `sent` resolution on the held reply. The runtime resolves the pending authorisation,
      // folds `sent` → `approved`, decides `fulfil_booking`, and performs it.
      const sentAuditId = crypto.randomUUID();
      const resolutionId = crypto.randomUUID();
      const fulfilled = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: resolutionId,
      });
      expect(fulfilled, "the approved booking was performed").not.toBeNull();
      expect(fulfilled?.fulfilment_type).toBe("fulfil_booking");
      expect(fulfilled?.fulfilment_outcome).toBe("booking_recorded");

      // EXACTLY ONE row — not zero (unapproved), not two (double-performed).
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(fulfilled?.fulfilment_id);
      // The performed operation is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.authorisation_id).toBe(seeded?.authorisation_id); // the authorisation it fulfils (the idempotency anchor)
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
      // WHAT was performed, and the booking payload it materialised.
      expect(row.fulfilment_type).toBe("fulfil_booking");
      expect(row.fulfilment_outcome).toBe("booking_recorded");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + PERFORMED BY CONSTRUCTION — the grant that authorised it, and the performed status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("fulfilled");
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never fulfilled", async () => {
      // A policy-/org-blocked booking folds to a FORECLOSED authorisation at R29. The reader returns only PENDING
      // approve_booking rows, so the runtime cannot even see it — there is no path to `approved`, and nothing is
      // performed. `block` ⇒ blocked_by_policy ⇒ (not_required, foreclosed).
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

      const result = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation performs no fulfilment").toBeNull();

      // No fulfilment row was filed for the foreclosed authorisation.
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data ?? []).toHaveLength(0);
    });

    it("a NON-BOOKING reply fulfils nothing — no pending authorisation behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No pending authorisation is
      // found, so the runtime returns null and files no row.
      const result = await fulfilApprovedBooking({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no authorisation behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same approved authorisation performs the booking AT MOST ONCE", async () => {
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

      // First send — performs the booking.
      const first = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME authorisation.
      const second = await fulfilApprovedBooking({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call performed nothing; ON CONFLICT (authorisation_id) returned the existing row.
      expect(second?.fulfilment_id).toBe(first?.fulfilment_id);

      // Exactly ONE row survives for the authorisation.
      const read = await rowsForAuth(seeded?.authorisation_id as string);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.fulfilment_id);
    });

    it("the write primitive files an APPROVED fulfilment and is idempotent on the authorisation id (direct RPC)", async () => {
      const authId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the fulfilment id").toBeTruthy();

      // A repeat with the SAME authorisation id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_authorisation_id: authId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc().from(TABLE).select("id, approval_state, status").eq("authorisation_id", authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("fulfilled");
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // The R30 keystone (the inverse of R29). A fulfilment can ONLY exist for an approved authorisation. An attempt
      // to perform un-approved work is rejected by the RPC's approval validation…
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
        "the approval_state CHECK rejects an un-approved fulfilment, even for service_role",
      ).not.toBeNull();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const authId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: authId });
      expect(filed.error, filed.error?.message).toBeNull();

      // A performed operation can never be rewritten…
      const updated = await svc()
        .from(TABLE)
        .update({ status: "fulfilled" })
        .eq("authorisation_id", authId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      // …nor erased.
      const deleted = await svc().from(TABLE).delete().eq("authorisation_id", authId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      // The row survived both attempts — still exactly one, unchanged.
      const read = await rowsForAuth(authId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.approval_state).toBe("approved");
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
      expect(anonWrite.error, "anon must not be able to perform a fulfilment").not.toBeNull();

      // anon cannot call the SECURITY DEFINER reader either.
      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to resolve the pending authorisation").not.toBeNull();

      // anon cannot write around the RPC with a direct insert either.
      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the fold, the field shapes, the provenance and the performed status", async () => {
      // A fulfilment type outside {fulfil_booking} is rejected by the RPC's validation.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_fulfilment_type: "fulfil_quote" });
      expect(badType.error, "a fulfilment type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {booking_recorded} — the shape of an EXTERNAL effect (e.g. booking_scheduled) — is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_fulfilment_outcome: "booking_scheduled",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A fulfilment with a malformed number is rejected — the ledger never materialises an unringable booking.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed booking number must be rejected").not.toBeNull();

      // A fulfilment with a malformed postcode is rejected — the ledger never materialises an unplaceable booking.
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed postcode must be rejected").not.toBeNull();

      // A fulfil_booking with NO job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a booking with no job type must be rejected").not.toBeNull();

      // The full Human Review provenance is MANDATORY — a missing held reply, sent reply or resolution is rejected.
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a fulfilment with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a fulfilment with no sent-reply reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noResolution.error, "a fulfilment with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected
      // by the CHECKs (the outcome vocabulary CHECK and the fold CHECK) — the performed result cannot be forged.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), fulfilment_outcome: "booking_scheduled" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // PERFORMED BY CONSTRUCTION: a direct service_role insert claiming any status but 'fulfilled' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "reversed" });
      expect(badStatus.error, "a status other than 'fulfilled' must be rejected by the CHECK").not.toBeNull();
    });

    it("the reader returns the PENDING approve_booking authorisation behind a held reply, and excludes a foreclosed one", async () => {
      const orgId = crypto.randomUUID();

      // A PENDING approve_booking behind held reply A.
      const reviewA = crypto.randomUUID();
      const pending = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewA,
        decision: authorise("allow", true),
      });
      expect(pending?.state).toBe("pending");

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const authRow = found.data?.[0] ?? {};
      expect(authRow.authorisation_id).toBe(pending?.authorisation_id);
      expect(authRow.authorisation_state).toBe("pending");
      expect(authRow.requirement).toBe("human_approval_required");
      expect(authRow.execution_eligibility).toBe("requires_human_review");
      expect(authRow.job_type).toBe(JOB);
      expect(authRow.postcode).toBe(POSTCODE);
      expect(authRow.phone_number).toBe(PHONE);

      // A FORECLOSED authorisation behind held reply B is INVISIBLE to the reader (it returns only PENDING rows).
      const reviewB = crypto.randomUUID();
      await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewB,
        decision: authorise("block", true),
      });
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewB,
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Authorisation pipeline — real-Postgres proof of the AI Receptionist Programme R29
 * (CONVERSATION AUTHORISATION ENGINE), the layer that DETERMINES whether a DECIDED execution requires approval —
 * and never grants it, and never executes it.
 *
 * The unit tier proves the pure core resolves an authorisation DECISION deterministically; the security tier
 * proves, as SOURCE, that the ledger is append-only, service-role-only, DETERMINES approval (never grants, never
 * executes), keeps the Execution + Action + Outcome Engines authoritative, consumes policy transitively without
 * importing it, integrates with Human Review without duplicating the grant, and that the runtime authorises
 * ALONGSIDE — never instead of — the audited confirmation. This tier proves the BEHAVIOUR the mocks can't — that
 * when the CANONICAL RUNTIME actually resolves, prepares, decides and AUTHORISES a booking against a live
 * database, the decision is really filed, and the migration's storage / RLS / append-only guard / privilege
 * model / vocabulary CHECKs / and — the R29 keystone — the DETERMINISTIC FOLD CHECK and the NON-GRANTING STATE
 * CHECK all hold in Postgres. The load-bearing R29 claims are proven here:
 *
 *   • THE SERVER RUNTIME FILES EXACTLY ONE LEDGER ROW — driven through the real `recordConversationAuthorisation`
 *     (not the RPC directly), carrying the resolved requirement + turn-time state, the execution eligibility it
 *     folded, the booking payload, the shared correlation id, the execution row it authorises, the held-reply
 *     reference it joins to Human Review, and every anchor — with its `status` pinned to the non-granting
 *     'assessed'.
 *   • THE DATABASE ENFORCES THE DETERMINISTIC FOLD — (requirement, state) MUST be the exact fold of the
 *     eligibility; a row that contradicts it — including any autonomous-approve attempt — is rejected by the fold
 *     CHECK, even for a direct service_role insert.
 *   • THE GRANT IS UNREPRESENTABLE — the `authorisation_state` vocabulary is EXACTLY {pending, foreclosed}: an
 *     attempt to file a grant ('approved' / 'rejected') is rejected by the RPC and by the column CHECK, so the
 *     ledger is structurally incapable of recording an approval. The grant lives only in the R14 Human Review
 *     ledger.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, or call the SECURITY
 *     DEFINER write primitive.
 *   • THE VOCABULARY AND FIELD SHAPES ARE PINNED — an authorisation type outside {approve_booking}, a requirement
 *     or state outside its set, an eligibility outside the three, a malformed booking field, or a status other
 *     than 'assessed' is rejected, so a stored row can never misrepresent a decision or claim a grant.
 *   • A FULL TURN RESOLVES, PREPARES, DECIDES, AUTHORISES AND CONFIRMS — a `runConversationTurn` on a genuinely
 *     satisfied booking resolves prepare_booking (Outcome ABSTAINS), prepares it (R27), DECIDES its execution
 *     (R28), AUTHORISES it (R29) threaded to the dispatch's correlation id and the execution row (so it JOINS the
 *     confirmation audit and the execution ledger), and surfaces `authorisation` / `authorisation_recorded` /
 *     `authorisation_id`.
 *   • THE EXECUTION + ACTION + OUTCOME ENGINES STAY AUTHORITATIVE — a satisfied CALLBACK turn records the OUTCOME,
 *     the Action Engine DEFERS, the Execution Engine ABSTAINS, and the Authorisation Engine ABSTAINS too (no
 *     execution decided → no authorisation filed); an unsatisfied turn authorises nothing either.
 *   • THE RUNTIME WRITES NO TENANT ROW — an authorisation decision touches NO lead and NO customer; the ledger row
 *     IS the exposure to future business workflows.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. The ledger is append-only (even service_role cannot DELETE), so these tests intentionally
 * leave their decision rows behind — harmless in the ephemeral CI database, and proving exactly that is one of
 * the tests below. Rows are addressed by a per-call correlation id so each assertion sees only its own writes.
 * Teardown drops the seeded orgs and clears the un-FK'd admin_activity_log rows.
 */

// receptionist_conversation_authorisations / record_receptionist_conversation_authorisation are service-role-only
// internals, NOT in the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the reply-audit / outcome / action / execution suites use) rather than reaching for
// `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type AuthorisationTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type AuthorisationClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): AuthorisationTable;
};

const TABLE = "receptionist_conversation_authorisations";
const RPC = "record_receptionist_conversation_authorisation";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";
// A booking message that STATES an appointment objective (the "book" / "come round" cues) AND provides all three
// arrange_booking slots — job type ("plumber" → plumbing), postcode, and a UK number the engine canonicalises to
// +44 E.164. It carries NO callback cue, so the intent is a booking — which is why the Outcome Engine abstains,
// the Action Engine prepares, the Execution Engine decides, and the Authorisation Engine authorises.
const BOOKING_TEXT =
  "I'd like to book a plumber to come round. My postcode is SW1A 1AA and my number is 07700 900123.";
// The R26 callback message — used to prove the Authorisation Engine ABSTAINS on a turn where no action is prepared.
const CALLBACK_TEXT = "Please call me back on 07700 900123.";

const svc = (): AuthorisationClient => serviceClient() as unknown as AuthorisationClient;
const anon = (): AuthorisationClient => anonClient() as unknown as AuthorisationClient;

// The columns every assertion below reads back — the full captured record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "review_audit_id, authorisation_type, requirement, authorisation_state, execution_eligibility, job_type, " +
  "postcode, phone_number, status, metadata";

// The valid RPC payload for a decided approve_booking (pending) — spread and overridden per rejection case.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_authorisation_type: "approve_booking",
  p_requirement: "human_approval_required",
  p_authorisation_state: "pending",
  p_execution_eligibility: "requires_human_review",
  p_correlation_id: crypto.randomUUID(),
  p_job_type: JOB,
  p_postcode: POSTCODE,
  p_phone_number: PHONE,
});

const createdOrgs: string[] = [];

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the requirement + state ALWAYS match the
 * deterministic fold of the eligibility they are recorded with — a genuine composition of the R28 execution
 * engine, the R29 authorisation engine and the server runtime, never a hand-forged decision.
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

/** Stand up a real organisation the runtime can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r29-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R29 Conversation Authorisation Org", slug })
    .select("id");
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data ?? [])[0]?.id);
  createdOrgs.push(id);
  return id;
}

/** The persisted contact_phone of a lead, read as service_role (ground truth). */
async function leadPhoneOf(leadId: string): Promise<string | null> {
  const res = await svc().from("leads").select("contact_phone").eq("id", leadId);
  expect(res.error, res.error?.message).toBeNull();
  const v = (res.data ?? [])[0]?.contact_phone;
  return v == null ? null : String(v);
}

/** Read every authorisation row filed under one correlation id, as service_role. */
function rowsFor(correlationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("correlation_id", correlationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege
 *  error or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration(
  "Conversation Authorisation pipeline · receptionist_conversation_authorisations (R29)",
  () => {
    afterAll(async () => {
      for (const id of createdOrgs) {
        await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
        await svc().from("organizations").delete().eq("id", id);
      }
    });

    it("recordConversationAuthorisation files EXACTLY ONE ledger row and returns its real id (approve_booking)", async () => {
      const correlationId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const enquiryId = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      const actionId = crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();

      // The strongest, richest path: org ARMED (live) and a clean verdict — the fold lands on
      // (human_approval_required, pending). The held-reply reference threads the JOIN to Human Review.
      const recorded = await recordConversationAuthorisation({
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
      expect(recorded, "the ledger write returned a handle").not.toBeNull();
      expect(recorded?.authorisation_type).toBe("approve_booking");
      expect(recorded?.requirement).toBe("human_approval_required");
      expect(recorded?.state).toBe("pending");

      // EXACTLY ONE row — not zero (undecided), not two (double-written).
      const read = await rowsFor(correlationId);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(recorded?.authorisation_id);
      // The decision is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.correlation_id).toBe(correlationId);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId); // it authorises over the very execution row R28 decided
      expect(row.review_audit_id).toBe(reviewAuditId); // the JOIN to the EXISTING Human Review inbox
      expect(row.authorisation_type).toBe("approve_booking");
      expect(row.requirement).toBe("human_approval_required");
      expect(row.authorisation_state).toBe("pending");
      // The INPUT that produced the requirement + state is recorded, so the decision is reconstructable.
      expect(row.execution_eligibility).toBe("requires_human_review");
      // The booking payload it authorises over.
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // NON-GRANTING BY CONSTRUCTION — the status can only ever be 'assessed'.
      expect(row.status).toBe("assessed");
      expect(row.metadata).toMatchObject({ strategy: "progress_goal", goal: "arrange_booking" });
    });

    it("both deterministic folds persist — and only the fold each eligibility produces", async () => {
      // Every arm of the fold, filed through the real runtime, read back, and confirmed. The (requirement, state)
      // is never chosen — it is the deterministic fold of the execution eligibility.
      const cases = [
        { verdict: "allow" as const, live: true, eligibility: "requires_human_review", requirement: "human_approval_required", state: "pending" },
        { verdict: "review" as const, live: true, eligibility: "requires_human_review", requirement: "human_approval_required", state: "pending" },
        { verdict: "block" as const, live: true, eligibility: "blocked_by_policy", requirement: "not_required", state: "foreclosed" },
        { verdict: "allow" as const, live: false, eligibility: "blocked_by_org", requirement: "not_required", state: "foreclosed" },
        { verdict: "review" as const, live: false, eligibility: "blocked_by_org", requirement: "not_required", state: "foreclosed" },
        { verdict: "block" as const, live: false, eligibility: "blocked_by_org", requirement: "not_required", state: "foreclosed" },
      ];
      for (const c of cases) {
        const correlationId = crypto.randomUUID();
        const recorded = await recordConversationAuthorisation({
          org_id: crypto.randomUUID(),
          conversation_id: crypto.randomUUID(),
          correlation_id: correlationId,
          decision: authorise(c.verdict, c.live),
        });
        const label = `verdict=${c.verdict} live=${c.live}`;
        expect(recorded?.requirement, label).toBe(c.requirement);
        expect(recorded?.state, label).toBe(c.state);
        const read = await rowsFor(correlationId);
        expect(read.data, label).toHaveLength(1);
        expect(read.data?.[0]?.requirement, label).toBe(c.requirement);
        expect(read.data?.[0]?.authorisation_state, label).toBe(c.state);
        expect(read.data?.[0]?.execution_eligibility, label).toBe(c.eligibility);
      }
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const correlationId = crypto.randomUUID();
      const recorded = await recordConversationAuthorisation({
        org_id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        correlation_id: correlationId,
        decision: authorise("allow", true),
      });
      expect(recorded).not.toBeNull();

      // A decision can never be rewritten to resemble a different one…
      const updated = await svc()
        .from(TABLE)
        .update({ authorisation_state: "foreclosed" })
        .eq("correlation_id", correlationId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      // …nor erased.
      const deleted = await svc().from(TABLE).delete().eq("correlation_id", correlationId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      // The row survived both attempts — still exactly one, unchanged.
      const read = await rowsFor(correlationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(recorded?.authorisation_id);
      expect(read.data?.[0]?.authorisation_state).toBe("pending");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
      const correlationId = crypto.randomUUID();
      await recordConversationAuthorisation({
        org_id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        correlation_id: correlationId,
        decision: authorise("allow", true),
      });

      // service_role (BYPASSRLS) sees the row…
      const asService = await rowsFor(correlationId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      // …anon does not (RLS enabled, zero policies → deny).
      expectAnonDenied(await anon().from(TABLE).select("id").eq("correlation_id", correlationId));

      // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
      const anonRpc = await anon().rpc<string>(RPC, { ...validRpcArgs(), p_correlation_id: crypto.randomUUID() });
      expect(anonRpc.error, "anon must not be able to authorise a booking").not.toBeNull();

      // anon cannot write around the RPC with a direct insert either.
      const anonInsert = await anon().from(TABLE).insert({
        org_id: crypto.randomUUID(),
        authorisation_type: "approve_booking",
        requirement: "human_approval_required",
        authorisation_state: "pending",
        execution_eligibility: "requires_human_review",
        correlation_id: crypto.randomUUID(),
        job_type: JOB,
        postcode: POSTCODE,
        phone_number: PHONE,
      });
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the GRANT is unrepresentable — a state outside {pending, foreclosed} is rejected (RPC and column CHECK)", async () => {
      // The R29 keystone. The turn-time engine and the ledger can NEVER record a grant. An attempt to file
      // 'approved' — the shape of an autonomous approval — is rejected by the RPC's state validation…
      const rpcGrant = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_authorisation_state: "approved",
      });
      expect(rpcGrant.error, "a grant state 'approved' does not exist here and is rejected").not.toBeNull();

      // …and by the column CHECK on a direct service_role insert (which also trips the fold CHECK).
      const insertGrant = await svc().from(TABLE).insert({
        org_id: crypto.randomUUID(),
        authorisation_type: "approve_booking",
        requirement: "human_approval_required",
        authorisation_state: "approved",
        execution_eligibility: "requires_human_review",
        correlation_id: crypto.randomUUID(),
        job_type: JOB,
        postcode: POSTCODE,
        phone_number: PHONE,
      });
      expect(insertGrant.error, "the authorisation_state CHECK rejects a grant, even for service_role").not.toBeNull();
    });

    it("the database pins the vocabulary, the field shapes and the non-granting status", async () => {
      // An authorisation type outside {approve_booking} is rejected by the RPC's validation (and the column CHECK).
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_type: "approve_quote" });
      expect(badType.error, "an authorisation type outside the vocabulary must be rejected").not.toBeNull();

      // A requirement outside {human_approval_required, not_required} is rejected.
      const badReq = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_requirement: "auto_approved" });
      expect(badReq.error, "a requirement outside the vocabulary must be rejected").not.toBeNull();

      // An eligibility outside the three is rejected.
      const badElig = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_execution_eligibility: "execute_now",
      });
      expect(badElig.error, "an eligibility outside the vocabulary must be rejected").not.toBeNull();

      // A decision with a malformed number is rejected — the ledger never authorises over an unringable booking.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed booking number must be rejected").not.toBeNull();

      // A decision with a malformed postcode is rejected — the ledger never authorises over an unplaceable booking.
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed postcode must be rejected").not.toBeNull();

      // A booking with NO job type is rejected too (the RPC requires all three for an approve_booking).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a booking with no job type must be rejected").not.toBeNull();

      // NON-GRANTING BY CONSTRUCTION: a direct service_role insert that tries to claim an executed/granted status
      // is rejected by the CHECK — the ledger is structurally incapable of recording anything but 'assessed'.
      const badStatus = await svc().from(TABLE).insert({
        org_id: crypto.randomUUID(),
        authorisation_type: "approve_booking",
        requirement: "human_approval_required",
        authorisation_state: "pending",
        execution_eligibility: "requires_human_review",
        correlation_id: crypto.randomUUID(),
        job_type: JOB,
        postcode: POSTCODE,
        phone_number: PHONE,
        status: "executed",
      });
      expect(badStatus.error, "a status other than 'assessed' must be rejected by the CHECK").not.toBeNull();
    });

    it("the database ENFORCES the deterministic fold — a decision that contradicts its eligibility is rejected", async () => {
      // The R29 keystone. (requirement, state) MUST be the exact fold of the execution eligibility. A row that
      // contradicts it — the shape of a non-deterministic or autonomous authorisation — is rejected, whether it
      // arrives through the validated RPC or a direct service_role insert.

      // requires_human_review but claiming (not_required, foreclosed) — MUST be (human_approval_required, pending).
      const reviewButForeclosed = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_requirement: "not_required",
        p_authorisation_state: "foreclosed",
        p_execution_eligibility: "requires_human_review",
      });
      expect(
        reviewButForeclosed.error,
        "requires_human_review cannot yield (not_required, foreclosed) — the fold rejects it",
      ).not.toBeNull();

      // blocked_by_policy but claiming (human_approval_required, pending) — MUST be (not_required, foreclosed).
      const blockedButPending = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_requirement: "human_approval_required",
        p_authorisation_state: "pending",
        p_execution_eligibility: "blocked_by_policy",
      });
      expect(
        blockedButPending.error,
        "blocked_by_policy cannot yield (human_approval_required, pending) — the fold rejects it",
      ).not.toBeNull();

      // blocked_by_org but claiming a pending approval requirement — MUST be (not_required, foreclosed).
      const orgBlockedButPending = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_requirement: "human_approval_required",
        p_authorisation_state: "pending",
        p_execution_eligibility: "blocked_by_org",
      });
      expect(
        orgBlockedButPending.error,
        "blocked_by_org cannot yield (human_approval_required, pending) — the fold rejects it",
      ).not.toBeNull();

      // A direct service_role insert cannot bypass the fold either — the TABLE CHECK holds independently of the RPC.
      const directFoldViolation = await svc().from(TABLE).insert({
        org_id: crypto.randomUUID(),
        authorisation_type: "approve_booking",
        requirement: "not_required", // contradicts requires_human_review (which ⇒ human_approval_required, pending)
        authorisation_state: "foreclosed",
        execution_eligibility: "requires_human_review",
        correlation_id: crypto.randomUUID(),
        job_type: JOB,
        postcode: POSTCODE,
        phone_number: PHONE,
      });
      expect(
        directFoldViolation.error,
        "the table fold CHECK rejects a decision that contradicts its eligibility, even for service_role",
      ).not.toBeNull();
    });

    it("a full runConversationTurn on a satisfied booking RESOLVES, PREPARES, DECIDES, AUTHORISES and CONFIRMS", async () => {
      const orgId = await freshOrg();
      // Seed a flag-OFF inbound that STATES a booking objective AND provides its three slots. The container is
      // created and the inbound threaded, but no turn has run yet.
      const seed = await processInboundEnquiry({
        org_id: orgId,
        channel: "sms",
        caller: CALLER,
        raw_text: BOOKING_TEXT,
      });
      const convId = seed.conversation_id as string;

      // Drive ONE turn directly through the exported orchestration entry point.
      const turn = await runConversationTurn({
        org_id: orgId,
        channel: "sms",
        conversation_id: convId,
        enquiry_id: seed.enquiry_id,
        lead_id: seed.lead_id,
        customer_ref: CALLER,
        metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
      });

      // The stack derived a genuinely satisfied booking; the Outcome Engine ABSTAINS, the Action Engine PREPARES,
      // and R28 DECIDED the execution. Default-off org ⇒ blocked_by_org — never autonomous.
      expect(turn.resolved_goal).toBe("arrange_booking");
      expect(turn.action_recorded).toBe(true);
      expect(turn.execution).toEqual({
        kind: "execute_booking",
        eligibility: "blocked_by_org",
        action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
      });
      expect(turn.execution_decided).toBe(true);
      expect(turn.execution_id).toBeTruthy();

      // …so R29 AUTHORISED it. A blocked_by_org execution folds to (not_required, foreclosed) — nothing to approve.
      expect(turn.authorisation).toEqual({
        kind: "approve_booking",
        requirement: "not_required",
        state: "foreclosed",
        execution: {
          kind: "execute_booking",
          eligibility: "blocked_by_org",
          action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
        },
      });
      expect(turn.authorisation_recorded).toBe(true);
      expect(turn.authorisation_id).toBeTruthy();

      // The dispatch still ran the UNCHANGED reply pipeline — a clean audited confirmation.
      expect(turn.dispatch.audit_id, "the confirmation was audited").toBeTruthy();
      expect(turn.dispatch.correlation_id, "the dispatch carries a correlation id").toBeTruthy();

      // The decision is filed to the ledger, threaded to the SAME correlation id — so it JOINS the confirmation
      // audit and the execution row (via execution_id). Read it back as ground truth.
      const read = await rowsFor(turn.dispatch.correlation_id as string);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.id).toBe(turn.authorisation_id);
      expect(row.authorisation_type).toBe("approve_booking");
      expect(row.requirement).toBe("not_required");
      expect(row.authorisation_state).toBe("foreclosed");
      expect(row.execution_eligibility).toBe("blocked_by_org");
      expect(row.execution_id).toBe(turn.execution_id); // it authorises over the very execution row R28 filed
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      expect(row.status).toBe("assessed");
      expect(row.conversation_id).toBe(convId);
      expect(row.org_id).toBe(orgId);

      // THE RUNTIME WRITES NO TENANT ROW — the lead the inbound created (which started with no phone) is UNTOUCHED:
      // an authorisation decision never reflects onto the customer; the ledger row IS the exposure.
      expect(await leadPhoneOf(seed.lead_id as string), "an authorisation never writes the lead").toBeNull();
    });

    it("the Execution + Action + Outcome Engines stay authoritative — a satisfied CALLBACK turn AUTHORISES nothing", async () => {
      const orgId = await freshOrg();
      const seed = await processInboundEnquiry({
        org_id: orgId,
        channel: "sms",
        caller: CALLER,
        raw_text: CALLBACK_TEXT,
      });
      const convId = seed.conversation_id as string;

      const turn = await runConversationTurn({
        org_id: orgId,
        channel: "sms",
        conversation_id: convId,
        enquiry_id: seed.enquiry_id,
        lead_id: seed.lead_id,
        customer_ref: CALLER,
        metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
      });

      // The Outcome Engine OWNS a satisfied callback; the Action Engine DEFERS, so the Execution Engine ABSTAINS…
      expect(turn.resolved_goal).toBe("arrange_callback");
      expect(turn.execution).toEqual({ kind: "none", reason: "no_action_prepared" });
      expect(turn.execution_decided).toBe(false);
      // …and with NO execution decided, the Authorisation Engine ABSTAINS — it authorises nothing.
      expect(turn.authorisation).toEqual({ kind: "none", reason: "no_execution_decision" });
      expect(turn.authorisation_recorded).toBe(false);
      expect(turn.authorisation_id).toBeNull();

      // No authorisation row was filed under this turn's correlation id.
      if (turn.dispatch.correlation_id) {
        const read = await rowsFor(turn.dispatch.correlation_id);
        expect(read.data ?? []).toHaveLength(0);
      }
    });

    it("an unsatisfied turn resolves an abstention and AUTHORISES nothing", async () => {
      const orgId = await freshOrg();
      // A quote request that provides NONE of its slots — the objective is unsatisfied, so the strategy is
      // request_information, the Action Engine abstains, the Execution Engine abstains, and so does R29.
      const seed = await processInboundEnquiry({
        org_id: orgId,
        channel: "sms",
        caller: CALLER,
        raw_text: "How much do you charge for a boiler service?",
      });
      const convId = seed.conversation_id as string;

      const turn = await runConversationTurn({
        org_id: orgId,
        channel: "sms",
        conversation_id: convId,
        enquiry_id: seed.enquiry_id,
        lead_id: seed.lead_id,
        customer_ref: CALLER,
        metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
      });

      // The objective is unsatisfied → the Action Engine abstains → the Execution Engine abstains → R29 abstains.
      expect(turn.strategy.strategy).not.toBe("progress_goal");
      expect(turn.execution).toEqual({ kind: "none", reason: "no_action_prepared" });
      expect(turn.authorisation).toEqual({ kind: "none", reason: "no_execution_decision" });
      expect(turn.authorisation_recorded).toBe(false);
      expect(turn.authorisation_id).toBeNull();

      // No authorisation row was filed under this turn's correlation id.
      if (turn.dispatch.correlation_id) {
        const read = await rowsFor(turn.dispatch.correlation_id);
        expect(read.data ?? []).toHaveLength(0);
      }
    });
  },
);

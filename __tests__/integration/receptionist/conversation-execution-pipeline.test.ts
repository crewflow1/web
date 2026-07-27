import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import {
  isBookingExecutionLive,
  recordConversationExecution,
} from "@/server/services/receptionist-execution";
import {
  isExecutionDecided,
  resolveExecution,
  type ExecuteBookingDecision,
} from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Execution pipeline — real-Postgres proof of the AI Receptionist Programme R28
 * (CONVERSATION EXECUTION ENGINE), the layer that DECIDES whether a PREPARED action is eligible to execute —
 * and never executes it.
 *
 * The unit tier proves the pure core resolves an execution DECISION deterministically; the security tier
 * proves, as SOURCE, that the ledger is append-only, service-role-only, DECIDES eligibility (never executes),
 * keeps the Action + Outcome Engines authoritative, consumes the policy verdict without re-running it, and that
 * the runtime decides ALONGSIDE — never instead of — the audited confirmation. This tier proves the BEHAVIOUR
 * the mocks can't — that when the CANONICAL RUNTIME actually resolves, prepares and DECIDES a booking against a
 * live database, the decision is really filed, and the migration's storage / RLS / append-only guard / privilege
 * model / vocabulary CHECKs / and — the R28 keystone — the DETERMINISTIC FOLD CHECK all hold in Postgres. The
 * load-bearing R28 claims are proven here:
 *
 *   • THE SERVER RUNTIME FILES EXACTLY ONE LEDGER ROW — driven through the real `recordConversationExecution`
 *     (not the RPC directly), carrying the resolved eligibility, the policy verdict it consumed, the org control
 *     it validated, the booking payload it decided over, the shared correlation id and every anchor, with its
 *     `status` pinned to the non-executing 'decided'.
 *   • THE DATABASE ENFORCES THE DETERMINISTIC FOLD — every eligibility a row can store is the exact fold of
 *     (live_execution, policy_verdict); a row whose eligibility contradicts its inputs — including any
 *     autonomous-execute attempt — is rejected by the fold CHECK, even for a direct service_role insert.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, or call the SECURITY
 *     DEFINER write primitive.
 *   • THE VOCABULARY AND FIELD SHAPES ARE PINNED — an execution type outside {execute_booking}, an eligibility
 *     outside the three (there is NO autonomous value), a verdict outside {allow,review,block}, a malformed
 *     booking field, or a status other than 'decided' is rejected, so a stored row can never misrepresent a
 *     decision or claim an external action.
 *   • THE ORG CONTROL IS DEFAULT-OFF — with `NEXT_PUBLIC_FEATURE_BOOKING_EXECUTION` unset (the CI posture), a
 *     satisfied booking DECIDES `blocked_by_org`: live booking execution is armed only by an explicit opt-in,
 *     and even when armed the strongest a decision reaches is `requires_human_review`.
 *   • A FULL TURN RESOLVES, PREPARES, DECIDES AND CONFIRMS — a `runConversationTurn` on a genuinely satisfied
 *     booking resolves prepare_booking (Outcome ABSTAINS), prepares it (R27), DECIDES its execution (R28) threaded
 *     to the dispatch's correlation id (so it JOINS the confirmation audit and the action row), and surfaces
 *     `execution` / `execution_decided` / `execution_id`.
 *   • THE ACTION + OUTCOME ENGINES STAY AUTHORITATIVE — a satisfied CALLBACK turn records the OUTCOME, the Action
 *     Engine DEFERS, and the Execution Engine ABSTAINS (no action prepared → no decision filed); an unsatisfied
 *     turn prepares nothing and decides nothing either.
 *   • THE RUNTIME WRITES NO TENANT ROW — a decided execution touches NO lead and NO customer; the ledger row IS
 *     the exposure to future business workflows.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if
 * the database is missing. The ledger is append-only (even service_role cannot DELETE), so these tests
 * intentionally leave their decision rows behind — harmless in the ephemeral CI database, and proving exactly
 * that is one of the tests below. Rows are addressed by a per-call correlation id so each assertion sees only
 * its own writes. Teardown drops the seeded orgs and clears the un-FK'd admin_activity_log rows.
 */

// receptionist_conversation_executions / record_receptionist_conversation_execution are service-role-only
// internals, NOT in the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the reply-audit / outcome / action suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type ExecutionTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ExecutionClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ExecutionTable;
};

const TABLE = "receptionist_conversation_executions";
const RPC = "record_receptionist_conversation_execution";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";
// A booking message that STATES an appointment objective (the "book" / "come round" cues) AND provides all
// three arrange_booking slots — job type ("plumber" → plumbing), postcode, and a UK number the engine
// canonicalises to +44 E.164. It carries NO callback cue, so the intent is a booking, not a callback — which is
// why the Outcome Engine abstains, the Action Engine prepares, and the Execution Engine decides.
const BOOKING_TEXT =
  "I'd like to book a plumber to come round. My postcode is SW1A 1AA and my number is 07700 900123.";
// The R26 callback message — used to prove the Execution Engine ABSTAINS on a turn where no action is prepared.
const CALLBACK_TEXT = "Please call me back on 07700 900123.";

const svc = (): ExecutionClient => serviceClient() as unknown as ExecutionClient;
const anon = (): ExecutionClient => anonClient() as unknown as ExecutionClient;

// The columns every assertion below reads back — the full captured record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, " +
  "execution_type, eligibility, policy_verdict, live_execution, job_type, postcode, phone_number, status, metadata";

const createdOrgs: string[] = [];

/**
 * Resolve a REAL `execute_booking` decision through the pure core, so the eligibility ALWAYS matches the
 * deterministic fold of (verdict, live) it is recorded with — a genuine composition of the pure engine and the
 * server runtime, never a hand-forged eligibility.
 */
function decide(verdict: GuardrailVerdict, live: boolean): ExecuteBookingDecision {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const d = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  if (!isExecutionDecided(d)) throw new Error("test setup: expected a decided execution");
  return d;
}

/** Stand up a real organisation the runtime can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R28 Conversation Execution Org", slug })
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

/** Read every execution row filed under one correlation id, as service_role. */
function rowsFor(correlationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("correlation_id", correlationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege
 *  error or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Execution pipeline · receptionist_conversation_executions (R28)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });

  it("recordConversationExecution files EXACTLY ONE ledger row and returns its real id (execute_booking)", async () => {
    const correlationId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const actionId = crypto.randomUUID();

    // The strongest, richest path: org ARMED (live) and a clean verdict — the fold lands on requires_human_review.
    const recorded = await recordConversationExecution({
      org_id: orgId,
      conversation_id: conversationId,
      enquiry_id: enquiryId,
      lead_id: leadId,
      customer_ref: CALLER,
      correlation_id: correlationId,
      action_id: actionId,
      decision: decide("allow", true),
      policy_verdict: "allow",
      live_execution: true,
      metadata: { strategy: "progress_goal", goal: "arrange_booking" },
    });
    expect(recorded, "the ledger write returned a handle").not.toBeNull();
    expect(recorded?.execution_type).toBe("execute_booking");
    expect(recorded?.eligibility).toBe("requires_human_review");

    // EXACTLY ONE row — not zero (undecided), not two (double-written).
    const read = await rowsFor(correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The runtime's returned handle is the real stored row.
    expect(row.id).toBe(recorded?.execution_id);
    // The decision is captured verbatim, with every anchor that threads it to who and what it concerns.
    expect(row.org_id).toBe(orgId);
    expect(row.conversation_id).toBe(conversationId);
    expect(row.enquiry_id).toBe(enquiryId);
    expect(row.lead_id).toBe(leadId);
    expect(row.customer_ref).toBe(CALLER);
    expect(row.correlation_id).toBe(correlationId);
    expect(row.action_id).toBe(actionId);
    expect(row.execution_type).toBe("execute_booking");
    expect(row.eligibility).toBe("requires_human_review");
    // The INPUTS that produced the eligibility are recorded, so the decision is reconstructable from the row.
    expect(row.policy_verdict).toBe("allow");
    expect(row.live_execution).toBe(true);
    // The booking payload it decided over.
    expect(row.job_type).toBe(JOB);
    expect(row.postcode).toBe(POSTCODE);
    expect(row.phone_number).toBe(PHONE);
    // NON-EXECUTING BY CONSTRUCTION — the status can only ever be 'decided'.
    expect(row.status).toBe("decided");
    expect(row.metadata).toMatchObject({ strategy: "progress_goal", goal: "arrange_booking" });
  });

  it("all three deterministic folds persist — and only the fold each input produces", async () => {
    // Every arm of the fold, filed through the real runtime, read back, and confirmed. The eligibility is never
    // chosen — it is the deterministic fold of the two inputs.
    const cases = [
      { verdict: "allow" as const, live: false, eligibility: "blocked_by_org" },
      { verdict: "review" as const, live: false, eligibility: "blocked_by_org" },
      { verdict: "block" as const, live: false, eligibility: "blocked_by_org" },
      { verdict: "block" as const, live: true, eligibility: "blocked_by_policy" },
      { verdict: "allow" as const, live: true, eligibility: "requires_human_review" },
      { verdict: "review" as const, live: true, eligibility: "requires_human_review" },
    ];
    for (const c of cases) {
      const correlationId = crypto.randomUUID();
      const recorded = await recordConversationExecution({
        org_id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        correlation_id: correlationId,
        decision: decide(c.verdict, c.live),
        policy_verdict: c.verdict,
        live_execution: c.live,
      });
      expect(recorded?.eligibility, `verdict=${c.verdict} live=${c.live}`).toBe(c.eligibility);
      const read = await rowsFor(correlationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.eligibility).toBe(c.eligibility);
      expect(read.data?.[0]?.policy_verdict).toBe(c.verdict);
      expect(read.data?.[0]?.live_execution).toBe(c.live);
    }
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const recorded = await recordConversationExecution({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      decision: decide("allow", true),
      policy_verdict: "allow",
      live_execution: true,
    });
    expect(recorded).not.toBeNull();

    // A decision can never be rewritten to resemble a stronger one…
    const updated = await svc()
      .from(TABLE)
      .update({ eligibility: "blocked_by_org" })
      .eq("correlation_id", correlationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TABLE).delete().eq("correlation_id", correlationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(recorded?.execution_id);
    expect(read.data?.[0]?.eligibility).toBe("requires_human_review");
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const correlationId = crypto.randomUUID();
    await recordConversationExecution({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      decision: decide("allow", true),
      policy_verdict: "allow",
      live_execution: true,
    });

    // service_role (BYPASSRLS) sees the row…
    const asService = await rowsFor(correlationId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS enabled, zero policies → deny).
    expectAnonDenied(await anon().from(TABLE).select("id").eq("correlation_id", correlationId));

    // anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only.
    const anonRpc = await anon().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(anonRpc.error, "anon must not be able to decide an execution").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      execution_type: "execute_booking",
      eligibility: "requires_human_review",
      policy_verdict: "allow",
      live_execution: true,
      correlation_id: crypto.randomUUID(),
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the vocabulary, the field shapes and the non-executing status", async () => {
    // An execution type outside {execute_booking} is rejected by the RPC's validation (and the column CHECK).
    const badType = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_now",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(badType.error, "an execution type outside the vocabulary must be rejected").not.toBeNull();

    // There is NO autonomous-execute eligibility — an attempt to file one is rejected by the vocabulary CHECK.
    const autonomous = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "execute_now",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(autonomous.error, "an autonomous-execute eligibility does not exist and is rejected").not.toBeNull();

    // A verdict outside {allow,review,block} is rejected.
    const badVerdict = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "maybe",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(badVerdict.error, "a verdict outside the vocabulary must be rejected").not.toBeNull();

    // A decision with a malformed number is rejected — the ledger never decides over an unringable booking.
    const badPhone = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: "07700 900123",
    });
    expect(badPhone.error, "a malformed booking number must be rejected").not.toBeNull();

    // A decision with a malformed postcode is rejected — the ledger never decides over an unplaceable booking.
    const badPostcode = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: "ZZ",
      p_phone_number: PHONE,
    });
    expect(badPostcode.error, "a malformed postcode must be rejected").not.toBeNull();

    // A booking with NO job type is rejected too (the RPC requires all three for an execute_booking).
    const noJob = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(noJob.error, "a booking with no job type must be rejected").not.toBeNull();

    // NON-EXECUTING BY CONSTRUCTION: a direct service_role insert that tries to claim an EXECUTED decision is
    // rejected by the CHECK — the ledger is structurally incapable of recording an external business action.
    const executed = await svc().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      execution_type: "execute_booking",
      eligibility: "requires_human_review",
      policy_verdict: "allow",
      live_execution: true,
      correlation_id: crypto.randomUUID(),
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
      status: "executed",
    });
    expect(executed.error, "a status other than 'decided' must be rejected by the CHECK").not.toBeNull();
  });

  it("the database ENFORCES the deterministic fold — a decision that contradicts its inputs is rejected", async () => {
    // The R28 keystone. The eligibility MUST be the exact fold of (live_execution, policy_verdict). A row that
    // contradicts its inputs — the shape of a non-deterministic or autonomous decision — is rejected, whether it
    // arrives through the validated RPC or a direct service_role insert.

    // org OFF but claiming a human-reviewable execution (off ⇒ MUST be blocked_by_org) — rejected by the RPC fold.
    const offButReview = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "allow",
      p_live_execution: false,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(offButReview.error, "org-off cannot yield requires_human_review — the fold rejects it").not.toBeNull();

    // org ON + clean verdict but claiming a policy block (allow ⇒ MUST be requires_human_review) — rejected.
    const cleanButBlocked = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "blocked_by_policy",
      p_policy_verdict: "allow",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(cleanButBlocked.error, "a clean verdict cannot yield blocked_by_policy — the fold rejects it").not.toBeNull();

    // org ON + block verdict but claiming human review (block ⇒ MUST be blocked_by_policy) — rejected.
    const blockedButReview = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_execution_type: "execute_booking",
      p_eligibility: "requires_human_review",
      p_policy_verdict: "block",
      p_live_execution: true,
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(blockedButReview.error, "a block verdict cannot yield requires_human_review — the fold rejects it").not.toBeNull();

    // A direct service_role insert cannot bypass the fold either — the TABLE CHECK holds independently of the RPC.
    const directFoldViolation = await svc().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      execution_type: "execute_booking",
      eligibility: "requires_human_review",
      policy_verdict: "allow",
      live_execution: false, // contradicts requires_human_review (off ⇒ blocked_by_org)
      correlation_id: crypto.randomUUID(),
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(
      directFoldViolation.error,
      "the table fold CHECK rejects a decision that contradicts its inputs, even for service_role",
    ).not.toBeNull();
  });

  it("a full runConversationTurn on a satisfied booking RESOLVES, PREPARES, DECIDES and CONFIRMS", async () => {
    // The org control is DEFAULT-OFF in CI (the flag is unset), so the decision folds to blocked_by_org: live
    // booking execution is armed only by an explicit opt-in.
    expect(isBookingExecutionLive(), "the booking-execution flag is DEFAULT-OFF").toBe(false);

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
      metadata: { dedup_key: `CE-${crypto.randomUUID()}` },
    });

    // The stack derived a genuinely satisfied booking; the Outcome Engine ABSTAINS and the Action Engine PREPARES…
    expect(turn.resolved_goal).toBe("arrange_booking");
    expect(turn.gap.satisfied).toBe(true);
    expect(turn.strategy.strategy).toBe("progress_goal");
    expect(turn.outcome).toEqual({ kind: "none", reason: "goal_has_no_outcome" });
    expect(turn.action).toEqual({
      kind: "prepare_booking",
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(turn.action_recorded).toBe(true);
    expect(turn.action_id).toBeTruthy();

    // …so R28 DECIDED the execution. Default-off org ⇒ blocked_by_org — never autonomous.
    expect(turn.execution).toEqual({
      kind: "execute_booking",
      eligibility: "blocked_by_org",
      action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
    });
    expect(turn.execution_decided).toBe(true);
    expect(turn.execution_id).toBeTruthy();

    // The dispatch still ran the UNCHANGED reply pipeline — a clean audited confirmation.
    expect(turn.dispatch.audit_id, "the confirmation was audited").toBeTruthy();
    expect(turn.dispatch.correlation_id, "the dispatch carries a correlation id").toBeTruthy();

    // The decision is filed to the ledger, threaded to the SAME correlation id — so it JOINS the confirmation
    // audit and the action row (via action_id). Read it back as ground truth.
    const read = await rowsFor(turn.dispatch.correlation_id as string);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    expect(row.id).toBe(turn.execution_id);
    expect(row.execution_type).toBe("execute_booking");
    expect(row.eligibility).toBe("blocked_by_org");
    expect(row.policy_verdict).toBeTruthy(); // the verdict the confirmation reply was decided under
    expect(row.live_execution).toBe(false);
    expect(row.action_id).toBe(turn.action_id); // it decides over the very action row R27 prepared
    expect(row.job_type).toBe(JOB);
    expect(row.postcode).toBe(POSTCODE);
    expect(row.phone_number).toBe(PHONE);
    expect(row.status).toBe("decided");
    expect(row.conversation_id).toBe(convId);
    expect(row.org_id).toBe(orgId);

    // THE RUNTIME WRITES NO TENANT ROW — the lead the inbound created (which started with no phone) is UNTOUCHED:
    // a decided execution never reflects onto the customer; the ledger row IS the exposure.
    expect(await leadPhoneOf(seed.lead_id as string), "a decided execution never writes the lead").toBeNull();
  });

  it("the Action + Outcome Engines stay authoritative — a satisfied CALLBACK turn DECIDES no execution", async () => {
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
      metadata: { dedup_key: `CE-${crypto.randomUUID()}` },
    });

    // The Outcome Engine OWNS a satisfied callback; the Action Engine DEFERS…
    expect(turn.resolved_goal).toBe("arrange_callback");
    expect(turn.outcome).toEqual({ kind: "callback", phone_number: PHONE });
    expect(turn.outcome_recorded).toBe(true);
    expect(turn.action).toEqual({ kind: "none", reason: "outcome_resolved" });
    expect(turn.action_recorded).toBe(false);
    // …and with NO action prepared, the Execution Engine ABSTAINS — it decides nothing.
    expect(turn.execution).toEqual({ kind: "none", reason: "no_action_prepared" });
    expect(turn.execution_decided).toBe(false);
    expect(turn.execution_id).toBeNull();

    // No execution row was filed under this turn's correlation id.
    if (turn.dispatch.correlation_id) {
      const read = await rowsFor(turn.dispatch.correlation_id);
      expect(read.data ?? []).toHaveLength(0);
    }
  });

  it("an unsatisfied turn resolves an abstention and DECIDES nothing", async () => {
    const orgId = await freshOrg();
    // A quote request that provides NONE of its slots — the objective is unsatisfied, so the strategy is
    // request_information (not progress_goal), the Action Engine abstains, and the Execution Engine abstains.
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
      metadata: { dedup_key: `CE-${crypto.randomUUID()}` },
    });

    // The objective is unsatisfied → the strategy is not progress_goal → the Action Engine abstains → the
    // Execution Engine abstains (no action prepared).
    expect(turn.strategy.strategy).not.toBe("progress_goal");
    expect(turn.action).toEqual({ kind: "none", reason: "not_progressing" });
    expect(turn.action_recorded).toBe(false);
    expect(turn.execution).toEqual({ kind: "none", reason: "no_action_prepared" });
    expect(turn.execution_decided).toBe(false);
    expect(turn.execution_id).toBeNull();

    // No execution row was filed under this turn's correlation id.
    if (turn.dispatch.correlation_id) {
      const read = await rowsFor(turn.dispatch.correlation_id);
      expect(read.data ?? []).toHaveLength(0);
    }
  });
});

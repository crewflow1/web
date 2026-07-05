import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import { recordConversationAction } from "@/server/services/receptionist-action";

/**
 * Conversation Action pipeline — real-Postgres proof of the AI Receptionist Programme R27
 * (CONVERSATION ACTION ENGINE), the layer that CONVERTS a resolved outcome into an internal business action.
 *
 * The unit tier proves the pure core resolves an action deterministically; the security tier proves, as
 * SOURCE, that the ledger is append-only, service-role-only, prepares only INTERNAL actions, keeps the Outcome
 * Engine authoritative, and that the runtime prepares the action ALONGSIDE — never instead of — the audited
 * confirmation. This tier proves the BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME actually
 * resolves and prepares a booking against a live database, the action is really filed, the migration's storage
 * / RLS / append-only guard / privilege model / CHECK constraints all hold in Postgres, and a full
 * `runConversationTurn` on a satisfied booking both prepares the action AND drives the UNCHANGED reply
 * pipeline. The load-bearing R27 claims are proven here:
 *
 *   • THE SERVER RUNTIME FILES EXACTLY ONE LEDGER ROW — driven through the real `recordConversationAction`
 *     (not the RPC directly), carrying the resolved booking payload (job type, postcode, number), the shared
 *     correlation id and every anchor, with its `status` pinned to the non-executing 'prepared'.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, or call the SECURITY
 *     DEFINER write primitive.
 *   • THE DATABASE PINS THE VOCABULARY, THE FIELD SHAPES AND THE NON-EXECUTING STATUS — an action type
 *     outside {prepare_booking}, a booking missing/malforming a required field, or a status other than
 *     'prepared' is rejected by the CHECK/RPC, so a stored row can never misrepresent an action or claim an
 *     external one.
 *   • THE RUNTIME WRITES NO TENANT ROW — a prepared booking touches NO lead and NO customer; the ledger row
 *     IS the exposure to future business workflows.
 *   • A FULL TURN RESOLVES, PREPARES AND CONFIRMS — a `runConversationTurn` on a genuinely satisfied booking
 *     resolves prepare_booking (the Outcome Engine ABSTAINS), files it threaded to the dispatch's correlation
 *     id (so it JOINS the confirmation audit), and surfaces `action` / `action_recorded` / `action_id`.
 *   • THE OUTCOME ENGINE STAYS AUTHORITATIVE — a satisfied CALLBACK turn records the OUTCOME and the Action
 *     Engine DEFERS (`outcome_resolved`), preparing NOTHING; an unsatisfied turn prepares nothing either.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if
 * the database is missing. The ledger is append-only (even service_role cannot DELETE), so these tests
 * intentionally leave their action rows behind — harmless in the ephemeral CI database, and proving exactly
 * that is one of the tests below. Rows are addressed by a per-call correlation id so each assertion sees only
 * its own writes. Teardown drops the seeded orgs and clears the un-FK'd admin_activity_log rows.
 */

// receptionist_conversation_actions / record_receptionist_conversation_action are service-role-only internals,
// NOT in the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the reply-audit / outcome suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type ActionTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ActionClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ActionTable;
};

const TABLE = "receptionist_conversation_actions";
const RPC = "record_receptionist_conversation_action";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";
// A booking message that STATES an appointment objective (the "book" / "come round" cues) AND provides all
// three arrange_booking slots — job type ("plumber" → plumbing), postcode, and a UK number the engine
// canonicalises to +44 E.164. It carries NO callback cue ("call me" / "ring me"), so the intent is a booking,
// not a callback — which is exactly why the Outcome Engine abstains and the Action Engine acts.
const BOOKING_TEXT =
  "I'd like to book a plumber to come round. My postcode is SW1A 1AA and my number is 07700 900123.";
// The R26 callback message — used to prove the Action Engine DEFERS to the Outcome Engine on a callback turn.
const CALLBACK_TEXT = "Please call me back on 07700 900123.";

const svc = (): ActionClient => serviceClient() as unknown as ActionClient;
const anon = (): ActionClient => anonClient() as unknown as ActionClient;

// The columns every assertion below reads back — the full captured record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, " +
  "action_type, job_type, postcode, phone_number, status, metadata";

const createdOrgs: string[] = [];

/** Stand up a real organisation the runtime can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r27-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R27 Conversation Action Org", slug })
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

/** Read every action row filed under one correlation id, as service_role. */
function rowsFor(correlationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("correlation_id", correlationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege
 *  error or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Action pipeline · receptionist_conversation_actions (R27)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });

  it("recordConversationAction files EXACTLY ONE ledger row and returns its real id (prepare_booking)", async () => {
    const correlationId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();
    const leadId = crypto.randomUUID();

    const recorded = await recordConversationAction({
      org_id: orgId,
      conversation_id: conversationId,
      enquiry_id: enquiryId,
      lead_id: leadId,
      customer_ref: CALLER,
      correlation_id: correlationId,
      action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
      metadata: { strategy: "progress_goal", goal: "arrange_booking" },
    });
    expect(recorded, "the ledger write returned a handle").not.toBeNull();
    expect(recorded?.action_type).toBe("prepare_booking");

    // EXACTLY ONE row — not zero (unprepared), not two (double-written).
    const read = await rowsFor(correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The runtime's returned handle is the real stored row.
    expect(row.id).toBe(recorded?.action_id);
    // The action is captured verbatim, with every anchor that threads it to who and what it concerns.
    expect(row.org_id).toBe(orgId);
    expect(row.conversation_id).toBe(conversationId);
    expect(row.enquiry_id).toBe(enquiryId);
    expect(row.lead_id).toBe(leadId);
    expect(row.customer_ref).toBe(CALLER);
    expect(row.correlation_id).toBe(correlationId);
    expect(row.action_type).toBe("prepare_booking");
    expect(row.job_type).toBe(JOB);
    expect(row.postcode).toBe(POSTCODE);
    expect(row.phone_number).toBe(PHONE);
    // NON-EXECUTING BY CONSTRUCTION — the status can only ever be 'prepared'.
    expect(row.status).toBe("prepared");
    expect(row.metadata).toMatchObject({ strategy: "progress_goal", goal: "arrange_booking" });
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const recorded = await recordConversationAction({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
    });
    expect(recorded).not.toBeNull();

    // A prepared action can never be rewritten to resemble something it is not…
    const updated = await svc()
      .from(TABLE)
      .update({ phone_number: "+440000000000" })
      .eq("correlation_id", correlationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    // …nor erased.
    const deleted = await svc().from(TABLE).delete().eq("correlation_id", correlationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await rowsFor(correlationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.id).toBe(recorded?.action_id);
    expect(read.data?.[0]?.phone_number).toBe(PHONE);
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const correlationId = crypto.randomUUID();
    await recordConversationAction({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      action: { kind: "prepare_booking", job_type: JOB, postcode: POSTCODE, phone_number: PHONE },
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
      p_action_type: "prepare_booking",
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(anonRpc.error, "anon must not be able to prepare an action").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      action_type: "prepare_booking",
      correlation_id: crypto.randomUUID(),
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the action vocabulary, the field shapes and the non-executing status", async () => {
    // An action type outside {prepare_booking} is rejected by the RPC's validation (and the column CHECK).
    const badType = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_action_type: "callback",
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(badType.error, "an action type outside the vocabulary must be rejected").not.toBeNull();

    // A booking with a malformed number is rejected — the ledger never prepares an unringable booking.
    const badPhone = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_action_type: "prepare_booking",
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: POSTCODE,
      p_phone_number: "07700 900123",
    });
    expect(badPhone.error, "a malformed booking number must be rejected").not.toBeNull();

    // A booking with a malformed postcode is rejected — the ledger never prepares an unplaceable booking.
    const badPostcode = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_action_type: "prepare_booking",
      p_correlation_id: crypto.randomUUID(),
      p_job_type: JOB,
      p_postcode: "ZZ",
      p_phone_number: PHONE,
    });
    expect(badPostcode.error, "a malformed postcode must be rejected").not.toBeNull();

    // A booking with NO job type is rejected too (the RPC requires all three for a prepare_booking).
    const noJob = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_action_type: "prepare_booking",
      p_correlation_id: crypto.randomUUID(),
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(noJob.error, "a booking with no job type must be rejected").not.toBeNull();

    // NON-EXECUTING BY CONSTRUCTION: a direct service_role insert that tries to claim an EXECUTED action is
    // rejected by the CHECK — the ledger is structurally incapable of recording an external business action.
    const executed = await svc().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      action_type: "prepare_booking",
      correlation_id: crypto.randomUUID(),
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
      status: "executed",
    });
    expect(executed.error, "a status other than 'prepared' must be rejected by the CHECK").not.toBeNull();
  });

  it("a full runConversationTurn on a satisfied booking RESOLVES, PREPARES and CONFIRMS", async () => {
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

    // The stack derived a genuinely satisfied, genuinely progressing booking…
    expect(turn.resolved_goal).toBe("arrange_booking");
    expect(turn.next_information).toMatchObject({
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(turn.gap.satisfied).toBe(true);
    expect(turn.strategy.strategy).toBe("progress_goal");
    // …the Outcome Engine ABSTAINS on a booking (a booking is not an R26 outcome) — it stays authoritative…
    expect(turn.outcome).toEqual({ kind: "none", reason: "goal_has_no_outcome" });
    expect(turn.outcome_recorded).toBe(false);
    expect(turn.outcome_id).toBeNull();
    // …so R27 resolved the prepare_booking action and PREPARED it.
    expect(turn.action).toEqual({
      kind: "prepare_booking",
      job_type: JOB,
      postcode: POSTCODE,
      phone_number: PHONE,
    });
    expect(turn.action_recorded).toBe(true);
    expect(turn.action_id).toBeTruthy();

    // The dispatch still ran the UNCHANGED reply pipeline — a clean audited confirmation.
    expect(turn.dispatch.audit_id, "the confirmation was audited").toBeTruthy();
    expect(turn.dispatch.correlation_id, "the dispatch carries a correlation id").toBeTruthy();

    // The action is filed to the ledger, threaded to the SAME correlation id — so it JOINS the confirmation
    // audit. Read it back as ground truth.
    const read = await rowsFor(turn.dispatch.correlation_id as string);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    expect(row.id).toBe(turn.action_id);
    expect(row.action_type).toBe("prepare_booking");
    expect(row.job_type).toBe(JOB);
    expect(row.postcode).toBe(POSTCODE);
    expect(row.phone_number).toBe(PHONE);
    expect(row.status).toBe("prepared");
    expect(row.conversation_id).toBe(convId);
    expect(row.org_id).toBe(orgId);

    // THE RUNTIME WRITES NO TENANT ROW — the lead the inbound created (which started with no phone) is
    // UNTOUCHED: a prepared booking never reflects onto the customer; the ledger row IS the exposure.
    expect(await leadPhoneOf(seed.lead_id as string), "a prepared booking never writes the lead").toBeNull();
  });

  it("the Outcome Engine stays authoritative — a satisfied CALLBACK turn prepares NO action", async () => {
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

    // The Outcome Engine OWNS a satisfied callback — it resolves and records the callback outcome…
    expect(turn.resolved_goal).toBe("arrange_callback");
    expect(turn.strategy.strategy).toBe("progress_goal");
    expect(turn.outcome).toEqual({ kind: "callback", phone_number: PHONE });
    expect(turn.outcome_recorded).toBe(true);
    // …and the Action Engine DEFERS — it prepares nothing, tagged with why.
    expect(turn.action).toEqual({ kind: "none", reason: "outcome_resolved" });
    expect(turn.action_recorded).toBe(false);
    expect(turn.action_id).toBeNull();

    // No action row was filed under this turn's correlation id.
    if (turn.dispatch.correlation_id) {
      const read = await rowsFor(turn.dispatch.correlation_id);
      expect(read.data ?? []).toHaveLength(0);
    }
  });

  it("an unsatisfied turn resolves an abstention and prepares NOTHING", async () => {
    const orgId = await freshOrg();
    // A quote request that provides NONE of its slots — the objective is unsatisfied, so the strategy is
    // request_information (not progress_goal) and the Action Engine abstains not_progressing.
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

    // The objective is unsatisfied → the strategy is not progress_goal → the Action Engine abstains.
    expect(turn.strategy.strategy).not.toBe("progress_goal");
    expect(turn.action).toEqual({ kind: "none", reason: "not_progressing" });
    expect(turn.action_recorded).toBe(false);
    expect(turn.action_id).toBeNull();

    // No action row was filed under this turn's correlation id.
    if (turn.dispatch.correlation_id) {
      const read = await rowsFor(turn.dispatch.correlation_id);
      expect(read.data ?? []).toHaveLength(0);
    }
  });
});

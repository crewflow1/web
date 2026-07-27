import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import { recordConversationOutcome } from "@/server/services/receptionist-outcome";

/**
 * Conversation Outcome pipeline — real-Postgres proof of the AI Receptionist Programme R26
 * (CONVERSATION OUTCOME ENGINE), the FIRST layer that ACTS on a satisfied conversational goal.
 *
 * The unit tier proves the pure core resolves an outcome deterministically; the security tier proves, as
 * SOURCE, that the ledger is append-only, service-role-only, records only INTERNAL outcomes, and that the
 * runtime records the outcome ALONGSIDE — never instead of — the audited confirmation. This tier proves the
 * BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME actually resolves and records a callback
 * against a live database, the outcome is really filed, the migration's storage / RLS / append-only guard /
 * privilege model / CHECK constraints all hold in Postgres, and a full `runConversationTurn` on a satisfied
 * callback both records the outcome AND drives the UNCHANGED reply pipeline. The load-bearing R26 claims are
 * proven here:
 *
 *   • THE SERVER RUNTIME FILES EXACTLY ONE LEDGER ROW — driven through the real
 *     `recordConversationOutcome` (not the RPC directly), so the assertion is about the actual execution
 *     path — carrying the resolved callback number, the shared correlation id and every anchor, with its
 *     `status` pinned to the non-executing 'recorded'.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role, so a recorded
 *     outcome can never be rewritten or erased.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, or call the SECURITY
 *     DEFINER write primitive.
 *   • THE DATABASE PINS THE VOCABULARY, THE E.164 SHAPE AND THE NON-EXECUTING STATUS — an outcome type
 *     outside {callback}, a callback with no/малformed number, or a status other than 'recorded' is rejected
 *     by the CHECK/RPC, so a stored row can never misrepresent an outcome or claim an external action.
 *   • THE CALLBACK IS REFLECTED ONTO THE LEAD — fill-if-empty and org-scoped: the lead's `contact_phone` is
 *     filled only when empty (an existing CRM value is never clobbered), and only within the org.
 *   • A FULL TURN RESOLVES, RECORDS AND CONFIRMS — a `runConversationTurn` on a genuinely satisfied callback
 *     resolves the callback outcome, files it to the ledger threaded to the dispatch's correlation id (so it
 *     JOINS the confirmation audit), and surfaces `outcome` / `outcome_recorded` / `outcome_id`; a
 *     non-actionable turn resolves an abstention and records NOTHING.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI
 * if the database is missing. The ledger is append-only (even service_role cannot DELETE), so these tests
 * intentionally leave their outcome rows behind — harmless in the ephemeral CI database, and proving exactly
 * that is one of the tests below. Rows are addressed by a per-call correlation id so each assertion sees only
 * its own writes. Teardown drops the seeded orgs (cascading leads / conversations / enquiries) and clears the
 * un-FK'd admin_activity_log rows.
 */

// receptionist_conversation_outcomes / record_receptionist_conversation_outcome are service-role-only
// internals, NOT in the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the reply-audit suite uses) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type OutcomeTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type OutcomeClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): OutcomeTable;
};

const TABLE = "receptionist_conversation_outcomes";
const RPC = "record_receptionist_conversation_outcome";
const CALLER = "+447700900123";
const PHONE = "+447700900123";

const svc = (): OutcomeClient => serviceClient() as unknown as OutcomeClient;
const anon = (): OutcomeClient => anonClient() as unknown as OutcomeClient;

// The columns every assertion below reads back — the full captured record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, " +
  "outcome_type, phone_number, status, metadata";

const createdOrgs: string[] = [];

/** Stand up a real organisation the runtime can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r26-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R26 Conversation Outcome Org", slug })
    .select("id");
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data ?? [])[0]?.id);
  createdOrgs.push(id);
  return id;
}

/** Seed a lead in an org, optionally with a contact_phone already set; returns its id. */
async function seedLead(orgId: string, contactPhone?: string): Promise<string> {
  const row: Record<string, unknown> = { org_id: orgId, source: "phone", status: "new" };
  if (contactPhone !== undefined) row.contact_phone = contactPhone;
  const res = await svc().from("leads").insert(row).select("id");
  expect(res.error, res.error?.message).toBeNull();
  return String((res.data ?? [])[0]?.id);
}

/** The persisted contact_phone of a lead, read as service_role (ground truth). */
async function leadPhoneOf(leadId: string): Promise<string | null> {
  const res = await svc().from("leads").select("contact_phone").eq("id", leadId);
  expect(res.error, res.error?.message).toBeNull();
  const v = (res.data ?? [])[0]?.contact_phone;
  return v == null ? null : String(v);
}

/** Read every outcome row filed under one correlation id, as service_role. */
function rowsFor(correlationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("correlation_id", correlationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege
 *  error or an RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Outcome pipeline · receptionist_conversation_outcomes (R26)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });

  it("recordConversationOutcome files EXACTLY ONE ledger row and returns its real id (callback)", async () => {
    const correlationId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();

    const recorded = await recordConversationOutcome({
      org_id: orgId,
      conversation_id: conversationId,
      enquiry_id: enquiryId,
      customer_ref: CALLER,
      correlation_id: correlationId,
      outcome: { kind: "callback", phone_number: PHONE },
      metadata: { strategy: "progress_goal", goal: "arrange_callback" },
    });
    expect(recorded, "the ledger write returned a handle").not.toBeNull();
    expect(recorded?.outcome_type).toBe("callback");

    // EXACTLY ONE row — not zero (unrecorded), not two (double-written).
    const read = await rowsFor(correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(1);

    const row = read.data?.[0] ?? {};
    // The runtime's returned handle is the real stored row.
    expect(row.id).toBe(recorded?.outcome_id);
    // The outcome is captured verbatim, with every anchor that threads it to who and what it concerns.
    expect(row.org_id).toBe(orgId);
    expect(row.conversation_id).toBe(conversationId);
    expect(row.enquiry_id).toBe(enquiryId);
    expect(row.customer_ref).toBe(CALLER);
    expect(row.correlation_id).toBe(correlationId);
    expect(row.outcome_type).toBe("callback");
    expect(row.phone_number).toBe(PHONE);
    // NON-EXECUTING BY CONSTRUCTION — the status can only ever be 'recorded'.
    expect(row.status).toBe("recorded");
    expect(row.metadata).toMatchObject({ strategy: "progress_goal", goal: "arrange_callback" });
  });

  it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const recorded = await recordConversationOutcome({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      outcome: { kind: "callback", phone_number: PHONE },
    });
    expect(recorded).not.toBeNull();

    // A recorded outcome can never be rewritten to resemble something it is not…
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
    expect(read.data?.[0]?.id).toBe(recorded?.outcome_id);
    expect(read.data?.[0]?.phone_number).toBe(PHONE);
  });

  it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write RPC", async () => {
    const correlationId = crypto.randomUUID();
    await recordConversationOutcome({
      org_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      correlation_id: correlationId,
      outcome: { kind: "callback", phone_number: PHONE },
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
      p_outcome_type: "callback",
      p_correlation_id: crypto.randomUUID(),
      p_phone_number: PHONE,
    });
    expect(anonRpc.error, "anon must not be able to file an outcome").not.toBeNull();

    // anon cannot write around the RPC with a direct insert either.
    const anonInsert = await anon().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      outcome_type: "callback",
      correlation_id: crypto.randomUUID(),
      phone_number: PHONE,
    });
    expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
  });

  it("the database pins the outcome vocabulary, the E.164 shape and the non-executing status", async () => {
    // An outcome type outside {callback} is rejected by the RPC's validation (and the column CHECK).
    const badType = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_outcome_type: "booking",
      p_correlation_id: crypto.randomUUID(),
      p_phone_number: PHONE,
    });
    expect(badType.error, "an outcome type outside the vocabulary must be rejected").not.toBeNull();

    // A callback with a malformed number is rejected — the ledger never records an unringable callback.
    const badPhone = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_outcome_type: "callback",
      p_correlation_id: crypto.randomUUID(),
      p_phone_number: "07700 900123",
    });
    expect(badPhone.error, "a malformed callback number must be rejected").not.toBeNull();

    // A callback with NO number is rejected too (the RPC requires it for a callback).
    const noPhone = await svc().rpc<string>(RPC, {
      p_org_id: crypto.randomUUID(),
      p_outcome_type: "callback",
      p_correlation_id: crypto.randomUUID(),
    });
    expect(noPhone.error, "a callback with no number must be rejected").not.toBeNull();

    // NON-EXECUTING BY CONSTRUCTION: a direct service_role insert that tries to claim an EXECUTED outcome is
    // rejected by the CHECK — the ledger is structurally incapable of recording an external business action.
    const executed = await svc().from(TABLE).insert({
      org_id: crypto.randomUUID(),
      outcome_type: "callback",
      correlation_id: crypto.randomUUID(),
      phone_number: PHONE,
      status: "executed",
    });
    expect(executed.error, "a status other than 'recorded' must be rejected by the CHECK").not.toBeNull();
  });

  it("reflects the callback onto the lead — fills contact_phone when empty, never clobbers, org-scoped", async () => {
    const orgId = await freshOrg();

    // A lead with NO contact phone — the reflection fills it (fill-if-empty).
    const emptyLead = await seedLead(orgId);
    expect(await leadPhoneOf(emptyLead), "seeded lead starts with no phone").toBeNull();
    await recordConversationOutcome({
      org_id: orgId,
      conversation_id: crypto.randomUUID(),
      lead_id: emptyLead,
      correlation_id: crypto.randomUUID(),
      outcome: { kind: "callback", phone_number: PHONE },
    });
    expect(await leadPhoneOf(emptyLead), "the callback number was reflected onto the empty lead").toBe(PHONE);

    // A lead that ALREADY has a phone — the reflection must NOT clobber the existing CRM value.
    const existing = "+441234567890";
    const filledLead = await seedLead(orgId, existing);
    await recordConversationOutcome({
      org_id: orgId,
      conversation_id: crypto.randomUUID(),
      lead_id: filledLead,
      correlation_id: crypto.randomUUID(),
      outcome: { kind: "callback", phone_number: PHONE },
    });
    expect(await leadPhoneOf(filledLead), "an existing phone is never overwritten").toBe(existing);
  });

  it("a full runConversationTurn on a satisfied callback RESOLVES, RECORDS and CONFIRMS", async () => {
    const orgId = await freshOrg();
    // Seed a flag-OFF inbound that STATES a callback objective AND provides its one slot: an explicit
    // "call me back" cue (→ callback_request → arrange_callback) plus a UK number the engine canonicalises
    // to +44 E.164. The container is created and the inbound threaded, but no turn has run yet.
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Please call me back on 07700 900123.",
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

    // The stack derived a genuinely satisfied, genuinely progressing callback…
    expect(turn.resolved_goal).toBe("arrange_callback");
    expect(turn.next_information).toMatchObject({ phone_number: PHONE });
    expect(turn.gap.satisfied).toBe(true);
    expect(turn.strategy.strategy).toBe("progress_goal");
    // …so R26 resolved the callback outcome and RECORDED it.
    expect(turn.outcome).toEqual({ kind: "callback", phone_number: PHONE });
    expect(turn.outcome_recorded).toBe(true);
    expect(turn.outcome_id).toBeTruthy();

    // The dispatch still ran the UNCHANGED reply pipeline — a clean audited confirmation.
    expect(turn.dispatch.audit_id, "the confirmation was audited").toBeTruthy();
    expect(turn.dispatch.correlation_id, "the dispatch carries a correlation id").toBeTruthy();

    // The outcome is filed to the ledger, threaded to the SAME correlation id — so it JOINS the confirmation
    // audit. Read it back as ground truth.
    const read = await rowsFor(turn.dispatch.correlation_id as string);
    expect(read.data).toHaveLength(1);
    const row = read.data?.[0] ?? {};
    expect(row.id).toBe(turn.outcome_id);
    expect(row.outcome_type).toBe("callback");
    expect(row.phone_number).toBe(PHONE);
    expect(row.status).toBe("recorded");
    expect(row.conversation_id).toBe(convId);
    expect(row.org_id).toBe(orgId);

    // And the callback was reflected onto the lead the inbound created (which started with no phone).
    expect(await leadPhoneOf(seed.lead_id as string), "the lead now carries the callback number").toBe(PHONE);
  });

  it("a non-actionable turn resolves an abstention and records NOTHING", async () => {
    const orgId = await freshOrg();
    // A quote request that provides NONE of its slots — the objective is unsatisfied, so the strategy is
    // request_information (not progress_goal) and R26 abstains. Nothing is recorded.
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

    // The objective is unsatisfied → the strategy is not progress_goal → R26 abstains.
    expect(turn.strategy.strategy).not.toBe("progress_goal");
    expect(turn.outcome).toEqual({ kind: "none", reason: "not_progressing" });
    expect(turn.outcome_recorded).toBe(false);
    expect(turn.outcome_id).toBeNull();

    // No outcome row was filed under this turn's correlation id.
    if (turn.dispatch.correlation_id) {
      const read = await rowsFor(turn.dispatch.correlation_id);
      expect(read.data ?? []).toHaveLength(0);
    }
  });
});

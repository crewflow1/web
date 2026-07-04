import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import { getConversation, listConversations } from "@/server/services/receptionist-conversation-reads";

/**
 * Multi-turn Conversation Runtime — real-Postgres proof of the AI Receptionist Programme R15
 * (MULTI-TURN CONVERSATION RUNTIME), R17 (FORMAL CONVERSATION STATE MACHINE), R18 (CONVERSATION
 * INTENT ENGINE), R19 (CONVERSATION GOAL ENGINE) and R20 (CONVERSATION INFORMATION ENGINE).
 *
 * R1–R14 built a one-shot responder. R15 makes the receptionist a CONVERSATION RUNTIME:
 * `runConversationTurn` is the single orchestration layer that, for a turn, RESOLVES the existing
 * conversation, LOADS its canonical timeline, ASSEMBLES its context, DETERMINES its current state,
 * GENERATES → POLICY → AUDIT → ROUTES the reply through the UNCHANGED canonical dispatch, and
 * ADVANCES the coarse runtime-state marker. The unit tier pins the pure state calculus exhaustively;
 * the security tier proves, as SOURCE, that the runtime adds no second enforcement/generation/
 * transport/state path. This tier proves the BEHAVIOUR the others can't — that when the runtime
 * actually runs against Postgres, driven the way production writes the substrate
 * (`processInboundEnquiry`) and by the exported entry point directly, the directive's criteria hold:
 *
 *   • A TURN ADVANCES THE STATE — an inbound reply resolves the conversation and, on a clean
 *     `allow`, advances the persisted marker to `awaiting_customer` (the AI answered; the ball is
 *     with the customer). The advance is read back through the R11 read model, end to end.
 *   • REPEAT REPLIES CONTINUE THE SAME CONVERSATION — a second inbound from the same contact folds
 *     onto the SAME conversation (the R10 identity key), and the runtime advances from its PERSISTED
 *     state each turn — never a new thread, never a spontaneous re-drive.
 *   • THE NINE STEPS ARE OBSERVABLE — `runConversationTurn` surfaces the prior state it READ, the
 *     context it ASSEMBLED, the dispatch it DELEGATED, and the next state it ADVANCED to.
 *   • THE PROGRESSION IS GOVERNED (R17) — the persisted advance is the `advance` plan of the formal
 *     state machine (awaiting_ai → awaiting_customer), surfaced live as `turn.transition`; a no-op turn
 *     is an `unchanged` self-loop the machine persists nothing for. Every live progression is a
 *     validated edge — never an ungoverned write.
 *   • A DUPLICATE IS A NO-OP — a turn whose dispatch short-circuits on an already-SENT transport
 *     produces no audit, so it routes `noop` and the persisted state is left UNCHANGED.
 *   • INTENT IS RESOLVED, GOVERNED AND PERSISTED (R18) — every turn resolves the conversational intent
 *     DETERMINISTICALLY from the assembled context (the customer's latest message), plans the
 *     (prior → resolved) progression through the intent engine, and persists ONLY a validated `advance`
 *     through its OWN org-scoped writer — surfaced live as `turn.resolved_intent` / `turn.intent_transition`
 *     and read back through the R11 read model. It is an INDEPENDENT marker: intent advances on the
 *     INBOUND even when the dispatch is a duplicate no-op that moves the ownership state not at all, and a
 *     re-resolved self-loop is an `unchanged` the engine persists nothing for. Intent NEVER moves
 *     `runtime_state`, so its progression can never bypass the state machine.
 *   • THE GOAL IS RESOLVED, GOVERNED AND PERSISTED (R19) — ON TOP of the intent engine, every turn ELEVATES
 *     the resolved intent into the conversation's OBJECTIVE (quote_request → provide_quote, general_enquiry
 *     → answer_enquiry), plans the (prior → resolved) progression through the goal engine, and persists ONLY
 *     a validated `advance` through its OWN org-scoped writer — surfaced live as `turn.resolved_goal` /
 *     `turn.goal_transition` and read back through the R11 read model. It is a THIRD INDEPENDENT marker:
 *     like intent it advances on the INBOUND even under a duplicate no-op, a deterministic re-resolution is
 *     an `unchanged` self-loop, and the objective is MONOTONIC (never regresses to `undetermined`). The goal
 *     NEVER moves `runtime_state` OR `intent`, so its progression can never bypass the state machine or the
 *     intent engine.
 *   • THE INFORMATION IS EXTRACTED, GOVERNED AND PERSISTED (R20) — ON TOP of the goal engine, every turn
 *     EXTRACTS the structured facts the resolved goal needs (via GOAL_SLOTS) from the customer's OWN turns in
 *     the assembled context — a real email, a `+44…`-canonical phone, a UK postcode, a job type — plans the
 *     (prior → folded) accumulation through the information engine, and persists ONLY a validated `updated`
 *     through its OWN org-scoped writer — surfaced live as `turn.extracted_information` /
 *     `turn.information_update` and read back through the R11 read model. It is a FOURTH INDEPENDENT marker:
 *     extraction VALIDATES on the way in (an invalid candidate never enters the record, so there is no
 *     `rejected` arm), a re-extraction of an unchanged context is an `unchanged` self-loop the engine persists
 *     nothing for, and the record is MONOTONIC (a known field is never dropped). The information NEVER moves
 *     `runtime_state`, `intent` OR `goal`, so its accumulation can never bypass any layer beneath it — and it
 *     only EXTRACTS: it books nothing, schedules nothing, prompts nothing (all R20 non-goals).
 *   • THE ONE-SHOT PATH IS INTACT — with the missed-call flag OFF the runtime never runs: no
 *     outbound is threaded and the conversation still `awaiting_ai` (the AI still owes the turn),
 *     byte-for-byte its pre-R15 self.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly
 * in CI if the database is missing. Teardown drops the seeded orgs (cascading enquiries, leads,
 * conversations and messages) and clears the un-FK'd admin_activity_log rows; the append-only
 * audit/transport rows are intentionally left behind (harmless in the ephemeral CI database).
 *
 * NOTE ON THE CI TRANSPORT PATH: CI configures no SMS provider, so a cleared reply's TRANSPORT is a
 * recorded failure (`no_provider`) while its AUDIT is still a clean `allow`. The runtime routes on
 * the guardrail VERDICT (an ownership fact), not on provider reachability (a delivery-lifecycle fact
 * owned by R7 receipts), so an `allow` deterministically advances to `awaiting_customer` here.
 */

// The substrate/ledger tables and their record_* primitives are service-role-only internals, NOT in
// the generated Database types. Cast to the minimal surface this suite exercises (the same
// `as unknown as` convention the R10/R11 suites use).
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Filterable<T> extends Thenable<T> {
  eq(column: string, value: unknown): Filterable<T>;
}
interface Insertable extends Filterable<null> {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
}
interface Table {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  delete(): Filterable<null>;
}
interface Client {
  from(table: string): Table;
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Thenable<T>;
}
const svc = (): Client => serviceClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const CONVERSATIONS = "receptionist_conversations";
const AUDIT_RPC = "record_ai_reply_audit";
const TRANSPORT_RPC = "record_ai_reply_transport";
const EMPLOYEE_SLUG = "voice-receptionist-ai";
const CALLER = "+447700900123";

const createdOrgs: string[] = [];

/** Stand up a real organisation the runtime can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r15-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R15 Conversation Runtime Org", slug })
    .select("id");
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data ?? [])[0]?.id);
  createdOrgs.push(id);
  return id;
}

/** The persisted runtime_state, read straight from the container as service_role (ground truth). */
async function runtimeStateOf(convId: string): Promise<string | null> {
  const res = await svc().from(CONVERSATIONS).select("runtime_state, message_count").eq("id", convId);
  expect(res.error, res.error?.message).toBeNull();
  return (String((res.data ?? [])[0]?.runtime_state ?? "")) || null;
}

/** The persisted intent (R18), read straight from the container as service_role (ground truth). The
 *  intent column is written by a SEPARATE org-scoped writer from runtime_state, so this proves the
 *  independent marker moved on its own. */
async function intentOf(convId: string): Promise<string | null> {
  const res = await svc().from(CONVERSATIONS).select("intent").eq("id", convId);
  expect(res.error, res.error?.message).toBeNull();
  return (String((res.data ?? [])[0]?.intent ?? "")) || null;
}

/** The persisted goal (R19), read straight from the container as service_role (ground truth). The goal
 *  column is written by its OWN org-scoped writer — distinct from both runtime_state and intent — so this
 *  proves the conversational OBJECTIVE marker moved on its own, a THIRD independent observation. */
async function goalOf(convId: string): Promise<string | null> {
  const res = await svc().from(CONVERSATIONS).select("goal").eq("id", convId);
  expect(res.error, res.error?.message).toBeNull();
  return (String((res.data ?? [])[0]?.goal ?? "")) || null;
}

/** The persisted information (R20), read straight from the container as service_role (ground truth). The
 *  information column is a jsonb OBJECT written by its OWN org-scoped, SHAPE-validating writer — distinct
 *  from runtime_state, intent AND goal — so this proves the structured-facts marker accumulated on its own,
 *  a FOURTH independent observation. Returns the parsed object ('{}' for a conversation that provided
 *  nothing). */
async function informationOf(convId: string): Promise<Record<string, unknown>> {
  const res = await svc().from(CONVERSATIONS).select("information").eq("id", convId);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? [])[0]?.information ?? {}) as Record<string, unknown>;
}

/** Seed an allowed audit through the canonical write primitive; returns its id. */
async function seedAudit(orgId: string, draft: string): Promise<string> {
  const res = await svc().rpc<string>(AUDIT_RPC, {
    p_org_id: orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_correlation_id: crypto.randomUUID(),
    p_draft: draft,
    p_verdict: "allow",
    p_allowed: true,
    p_reason: "clean",
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as string;
}

/** File a SENT transport keyed on a dedup_key — the row `findSentTransport` short-circuits on. */
async function seedSentTransport(auditId: string, orgId: string, dedupKey: string): Promise<void> {
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: auditId,
    p_org_id: orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: CALLER,
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "twilio",
    p_provider_message_id: `SM-${crypto.randomUUID()}`,
    p_dedup_key: dedupKey,
  });
  expect(res.error, res.error?.message).toBeNull();
}

describeIntegration("Multi-turn Conversation Runtime (R15)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a turn RESOLVES the conversation, threads the outbound, and ADVANCES the state to awaiting_customer", async () => {
    vi.stubEnv(FLAG, "true"); // arm the text-back so the inbound drives a full runtime turn
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call — please call me back.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = result.conversation_id as string;
    expect(convId, "a contact-bearing inbound resolves a conversation").toBeTruthy();

    // The turn produced a clean, audited `allow`.
    const tb = result.textback;
    if (!tb.attempted || !("dispatch" in tb)) throw new Error("armed reply must have dispatched");
    expect(tb.dispatch.audit_id, "an audit was produced").toBeTruthy();
    expect(tb.dispatch.decision?.verdict).toBe("allow");

    // The runtime ADVANCED the persisted marker — read back BOTH directly and through the R11 read model.
    expect(await runtimeStateOf(convId)).toBe("awaiting_customer");
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.runtime_state, "the read model surfaces the advanced state").toBe("awaiting_customer");
    // The runtime OWNS the outbound append: the timeline threaded inbound + outbound.
    expect(summary?.message_count).toBe(2);
  });

  it("REPEAT replies continue the SAME conversation, and the runtime advances from its persisted state each turn", async () => {
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();

    const first = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "First contact.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = first.conversation_id as string;
    expect(await runtimeStateOf(convId)).toBe("awaiting_customer");

    // A SECOND inbound from the same contact/channel/org folds onto the SAME conversation (R10 identity).
    const second = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Following up on my earlier call.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    expect(second.conversation_id, "the repeat reply continues the same conversation").toBe(convId);

    // Exactly ONE conversation exists — never a second thread — and it now carries four messages
    // (two inbound + two outbound), each turn having advanced from the persisted marker.
    const list = await listConversations({ org_id: orgId });
    expect(list).toHaveLength(1);
    expect(list[0]?.conversation_id).toBe(convId);
    expect(list[0]?.message_count).toBe(4);
    expect(await runtimeStateOf(convId)).toBe("awaiting_customer");
  });

  it("runConversationTurn surfaces the nine steps — the prior state READ, the context ASSEMBLED, the dispatch DELEGATED, the state ADVANCED", async () => {
    const orgId = await freshOrg();
    // Seed a conversation with a flag-OFF inbound: the container is created (state defaults to
    // `awaiting_ai`) and the inbound is threaded, but no turn has run yet.
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "I'd like a quote please.",
    });
    const convId = seed.conversation_id as string;
    expect(await runtimeStateOf(convId), "a fresh conversation owes an AI turn").toBe("awaiting_ai");

    // Drive ONE turn directly through the exported orchestration entry point.
    const turn = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
    });

    // Steps 1–4 — it READ the persisted prior state and ASSEMBLED context from the timeline.
    expect(turn.prior_state).toBe("awaiting_ai");
    expect(turn.context, "context was assembled from the canonical timeline").not.toBeNull();
    expect(turn.context?.total_message_count).toBe(1); // only the seeded inbound so far
    expect(turn.context?.included_message_count).toBe(1);

    // Steps 5–8 — it DELEGATED the canonical dispatch (generate → policy → audit → route).
    expect(turn.dispatch.audit_id).toBeTruthy();
    expect(turn.dispatch.decision?.verdict).toBe("allow");

    // Step 9 — it GOVERNED the progression through the R17 state machine and persisted the advance.
    expect(turn.routing).toBe("sent");
    expect(turn.next_state).toBe("awaiting_customer");
    expect(turn.state_advanced).toBe(true);
    // The persisted advance is the machine's VALIDATED `advance` plan — the exact edge it wrote.
    expect(turn.transition).toEqual({
      kind: "advance",
      from: "awaiting_ai",
      to: "awaiting_customer",
    });
    expect(await runtimeStateOf(convId)).toBe("awaiting_customer");

    // Steps 4–6 (R18) — it RESOLVED the conversational intent DETERMINISTICALLY from the assembled
    // context (the seeded "I'd like a quote please." → quote_request), GOVERNED the progression through
    // the intent engine, and PERSISTED the validated advance through the separate org-scoped writer.
    expect(turn.prior_intent).toBe("unknown");
    expect(turn.resolved_intent).toBe("quote_request");
    expect(turn.next_intent).toBe("quote_request");
    expect(turn.intent_advanced).toBe(true);
    expect(turn.intent_transition).toEqual({
      kind: "advance",
      from: "unknown",
      to: "quote_request",
    });
    expect(await intentOf(convId), "the intent marker advanced live").toBe("quote_request");

    // Step 5 (R19) — ON TOP of the intent engine, the goal engine ELEVATES the resolved intent
    // (quote_request) into the conversation's OBJECTIVE (provide_quote), GOVERNS the (undetermined →
    // provide_quote) progression as a validated `advance`, and PERSISTS it through its OWN org-scoped
    // writer — a THIRD independent marker moved by its own door.
    expect(turn.prior_goal).toBe("undetermined");
    expect(turn.resolved_goal).toBe("provide_quote");
    expect(turn.next_goal).toBe("provide_quote");
    expect(turn.goal_advanced).toBe(true);
    expect(turn.goal_transition).toEqual({
      kind: "advance",
      from: "undetermined",
      to: "provide_quote",
    });
    expect(await goalOf(convId), "the goal marker advanced live").toBe("provide_quote");

    // Step 6 (R20) — ON TOP of the goal engine, the information engine EXTRACTS the facts the resolved goal
    // (provide_quote) needs. This seed states the OBJECTIVE ("I'd like a quote please.") but provides NONE of
    // the fields it selects (job_type/postcode/phone_number/email_address), so extraction yields the empty
    // record, the plan is `unchanged`, and NOTHING is persisted — the honest "learned nothing" path, surfaced
    // live on the turn result. Information is a FOURTH marker moved by its own door (here, not moved at all).
    expect(turn.prior_information).toEqual({});
    expect(turn.extracted_information).toEqual({});
    expect(turn.information_update).toEqual({ kind: "unchanged", information: {} });
    expect(turn.information_updated).toBe(false);
    expect(turn.next_information).toEqual({});
    expect(await informationOf(convId), "nothing extracted → the column stays the honest empty '{}'").toEqual(
      {},
    );

    // The runtime OWNS the outbound append — the timeline now carries the reply too, and the R11 read model
    // surfaces ALL FOUR independent markers (the ownership state, the R18 intent, the R19 goal AND the R20
    // information — empty here, since this turn provided no structured facts).
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.message_count).toBe(2);
    expect(summary?.runtime_state).toBe("awaiting_customer");
    expect(summary?.intent, "the read model surfaces the resolved intent").toBe("quote_request");
    expect(summary?.goal, "the read model surfaces the resolved goal").toBe("provide_quote");
    expect(summary?.information, "the read model surfaces the (empty) information").toEqual({});
  });

  it("a DUPLICATE dispatch is a NO-OP — the turn advances nothing and the persisted state is unchanged", async () => {
    const orgId = await freshOrg();
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Please text me back.",
    });
    const convId = seed.conversation_id as string;
    expect(await runtimeStateOf(convId)).toBe("awaiting_ai");

    // Pre-file a SENT transport under a known dedup key — the app-level duplicate guard
    // (`findSentTransport`) short-circuits any dispatch that carries the same key.
    const dedupKey = `CA-${crypto.randomUUID()}`;
    const auditId = await seedAudit(orgId, "Thanks — a member of the team will be in touch shortly.");
    await seedSentTransport(auditId, orgId, dedupKey);

    // A turn carrying that key never generates, enforces, audits or sends again.
    const turn = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: dedupKey },
    });

    expect(turn.dispatch.transport.duplicate, "the dispatch short-circuited as a duplicate").toBe(true);
    expect(turn.dispatch.audit_id, "no new audit was produced").toBeNull();
    // The routing is a no-op, so ownership does not move.
    expect(turn.routing).toBe("noop");
    expect(turn.state_advanced).toBe(false);
    expect(turn.next_state).toBe(turn.prior_state);
    expect(turn.next_state).toBe("awaiting_ai");
    // R17 — the state machine planned an `unchanged` self-loop, so nothing was persisted.
    expect(turn.transition).toEqual({ kind: "unchanged", state: "awaiting_ai" });
    // The persisted marker is UNCHANGED, and no phantom outbound was threaded.
    expect(await runtimeStateOf(convId)).toBe("awaiting_ai");

    // R18 — intent is resolved PRE-dispatch from the INBOUND, so it advances INDEPENDENTLY of the
    // duplicate no-op that moved the ownership state not at all. The seeded "Please text me back." carries
    // no callback cue the R2 detector recognises (it knows call / ring / phone me back, not "text"), so it
    // resolves to the honest general_enquiry — and that concrete intent is governed, advanced and persisted
    // even though `state_advanced` is false. The two markers are independent observations.
    expect(turn.prior_intent).toBe("unknown");
    expect(turn.resolved_intent).toBe("general_enquiry");
    expect(turn.intent_advanced, "intent advances on the inbound even under a duplicate dispatch").toBe(
      true,
    );
    expect(turn.state_advanced, "yet the ownership state did NOT advance — independent markers").toBe(
      false,
    );
    expect(turn.intent_transition).toEqual({
      kind: "advance",
      from: "unknown",
      to: "general_enquiry",
    });
    expect(await intentOf(convId), "the intent marker advanced live, independent of the no-op").toBe(
      "general_enquiry",
    );

    // R19 — the goal ELEVATES the resolved intent (general_enquiry → answer_enquiry) and, like intent, is
    // resolved PRE-dispatch from the inbound, so its OBJECTIVE advances INDEPENDENTLY of the duplicate no-op
    // that left the ownership state untouched. Three independent markers, three separate doors.
    expect(turn.prior_goal).toBe("undetermined");
    expect(turn.resolved_goal).toBe("answer_enquiry");
    expect(turn.goal_advanced, "goal advances on the inbound even under a duplicate dispatch").toBe(true);
    expect(turn.goal_transition).toEqual({
      kind: "advance",
      from: "undetermined",
      to: "answer_enquiry",
    });
    expect(await goalOf(convId), "the goal marker advanced live, independent of the no-op").toBe(
      "answer_enquiry",
    );

    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.message_count, "a noop threads no outbound").toBe(1);
  });

  it("the ONE-SHOT path is intact — with the flag OFF the runtime never runs and the state stays awaiting_ai", async () => {
    const orgId = await freshOrg(); // flag OFF (default): maybeTextBackMissedCall returns before the runtime
    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Missed call with the flag off.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = result.conversation_id as string;

    // The text-back stayed inert, so no turn ran: no outbound was threaded and the AI still owes
    // the next turn — the conversation is byte-for-byte its pre-R15 self.
    expect(result.textback.attempted).toBe(false);
    expect(await runtimeStateOf(convId)).toBe("awaiting_ai");
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.message_count, "only the inbound is threaded").toBe(1);
    expect(summary?.runtime_state).toBe("awaiting_ai");
  });

  it("R18 — intent is resolved DETERMINISTICALLY, its progression GOVERNED and persisted, and a re-resolved self-loop advances nothing", async () => {
    const orgId = await freshOrg();
    // Seed a flag-OFF inbound: the container is created (intent defaults to `unknown`) and the inbound is
    // threaded, but no turn has run — so nothing has resolved the intent yet.
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "How much do you charge for a boiler service?",
    });
    const convId = seed.conversation_id as string;
    expect(await intentOf(convId), "a fresh conversation has no resolved intent").toBe("unknown");

    // TURN 1 — the engine RESOLVES the intent from the assembled context (a price question → quote_request,
    // via the QUOTE cues; the R2 booking detector finds no appointment/callback signal), GOVERNS the
    // (unknown → quote_request) progression as a validated `advance`, and PERSISTS it through its OWN writer.
    const first = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
    });
    expect(first.prior_intent).toBe("unknown");
    expect(first.resolved_intent).toBe("quote_request");
    expect(first.intent_advanced).toBe(true);
    expect(first.intent_transition).toEqual({ kind: "advance", from: "unknown", to: "quote_request" });
    expect(await intentOf(convId)).toBe("quote_request");

    // R19 — the goal engine ELEVATES that resolved intent into the OBJECTIVE (quote_request → provide_quote),
    // governs the (undetermined → provide_quote) advance, and persists it through its own writer.
    expect(first.prior_goal).toBe("undetermined");
    expect(first.resolved_goal).toBe("provide_quote");
    expect(first.goal_advanced).toBe(true);
    expect(first.goal_transition).toEqual({ kind: "advance", from: "undetermined", to: "provide_quote" });
    expect(await goalOf(convId)).toBe("provide_quote");

    // The R11 read model surfaces BOTH markers on the single-conversation read and the list read.
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.intent, "getConversation surfaces the intent").toBe("quote_request");
    expect(summary?.goal, "getConversation surfaces the goal").toBe("provide_quote");
    const list = await listConversations({ org_id: orgId });
    expect(list[0]?.intent, "listConversations surfaces the intent").toBe("quote_request");
    expect(list[0]?.goal, "listConversations surfaces the goal").toBe("provide_quote");

    // TURN 2 — no new customer message has arrived, so the latest customer turn is UNCHANGED. Resolution is
    // DETERMINISTIC (the same context resolves the same intent — quote_request again), so folding it onto
    // the now-persisted quote_request is a self-loop the engine plans as `unchanged` and persists NOTHING
    // for. The intent never regresses (monotonic knowledge): it is still quote_request afterwards.
    const second = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
    });
    expect(second.resolved_intent, "resolution is deterministic — same context, same intent").toBe(
      "quote_request",
    );
    expect(second.prior_intent).toBe("quote_request");
    expect(second.intent_advanced, "a re-resolved self-loop advances nothing").toBe(false);
    expect(second.intent_transition).toEqual({ kind: "unchanged", intent: "quote_request" });
    expect(second.next_intent).toBe("quote_request");
    expect(await intentOf(convId), "the intent is monotonic — it never regressed").toBe("quote_request");

    // R19 — goal resolution is equally deterministic: the same intent elevates to the same objective
    // (provide_quote), so folding it onto the now-persisted provide_quote is an `unchanged` self-loop the
    // engine persists nothing for. The OBJECTIVE is monotonic too — it never regressed to `undetermined`.
    expect(second.resolved_goal, "goal resolution is deterministic — same intent, same objective").toBe(
      "provide_quote",
    );
    expect(second.prior_goal).toBe("provide_quote");
    expect(second.goal_advanced, "a re-resolved goal self-loop advances nothing").toBe(false);
    expect(second.goal_transition).toEqual({ kind: "unchanged", goal: "provide_quote" });
    expect(second.next_goal).toBe("provide_quote");
    expect(await goalOf(convId), "the goal is monotonic — it never regressed").toBe("provide_quote");
  });

  it("R20 — information is EXTRACTED from the customer's own turns, GOVERNED and persisted, and a re-extracted self-loop persists nothing", async () => {
    const orgId = await freshOrg();
    // Seed a flag-OFF inbound RICH in structured facts: a quote request (→ provide_quote, whose slots are
    // job_type/postcode/phone_number/email_address) that STATES all four — a leaking pipe (→ plumbing), an
    // email, a UK number and a UK postcode. The container is created (information defaults to the empty
    // '{}'::jsonb) and the inbound is threaded, but no turn has run, so nothing has extracted yet.
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text:
        "I'd like a quote to fix a leaking pipe. My email is jo@brightspark.co.uk, my number is 07700 900123, and the address is SW1A 1AA.",
    });
    const convId = seed.conversation_id as string;
    expect(await informationOf(convId), "a fresh conversation has extracted nothing").toEqual({});

    // The four canonical facts the engine extracts — each in the ONE canonical form it stores: the job type
    // from the symptom cue (leaking pipe → plumbing), the postcode upper-cased `OUTWARD INWARD`, the phone in
    // `+44…` E.164 (the SAME form the SMS transport dials), the email verbatim + lower-cased.
    const FACTS = {
      job_type: "plumbing",
      postcode: "SW1A 1AA",
      phone_number: "+447700900123",
      email_address: "jo@brightspark.co.uk",
    };

    // TURN 1 — the goal resolves to provide_quote (a quote request), which SELECTS all four slots; the engine
    // EXTRACTS each from the customer's OWN turn, PLANS an `updated` fold over the empty prior, and PERSISTS
    // it through its OWN org-scoped, shape-validating writer — a FOURTH independent observation, distinct from
    // state/intent/goal.
    const first = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
    });
    // The goal that SELECTED the slots is the provide_quote objective (extraction keys on the resolved goal).
    expect(first.resolved_goal).toBe("provide_quote");
    expect(first.next_goal).toBe("provide_quote");
    // The extraction is a fresh record of exactly what THIS context provided — all four fields, canonicalised.
    expect(first.prior_information).toEqual({});
    expect(first.extracted_information).toEqual(FACTS);
    expect(first.next_information).toEqual(FACTS);
    expect(first.information_updated).toBe(true);
    // The plan is a validated `updated` naming exactly the fields that appeared, in INFORMATION_FIELDS order.
    expect(first.information_update).toEqual({
      kind: "updated",
      information: FACTS,
      added: ["email_address", "phone_number", "postcode", "job_type"],
    });
    // Persisted through the writer and read back — directly from the container AND through the R11 read model.
    expect(await informationOf(convId), "the extracted facts were persisted through the writer").toEqual(
      FACTS,
    );
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.information, "getConversation surfaces the extracted information").toEqual(FACTS);
    const list = await listConversations({ org_id: orgId });
    expect(list[0]?.information, "listConversations surfaces the extracted information").toEqual(FACTS);
    // Information NEVER moved the layers beneath it — the ownership state, intent and goal all advanced by
    // their OWN doors; information rode ON TOP without touching any of them.
    expect(summary?.runtime_state).toBe("awaiting_customer");
    expect(summary?.intent).toBe("quote_request");
    expect(summary?.goal).toBe("provide_quote");

    // TURN 2 — no new customer message, so extraction is DETERMINISTIC: the same context re-extracts the same
    // four facts. Folding them onto the now-persisted record adds nothing new, so the plan is `unchanged` and
    // the engine persists NOTHING — the record is MONOTONIC (it never shrinks, never regresses).
    const second = await runConversationTurn({
      org_id: orgId,
      channel: "sms",
      conversation_id: convId,
      enquiry_id: seed.enquiry_id,
      customer_ref: CALLER,
      metadata: { dedup_key: `CA-${crypto.randomUUID()}` },
    });
    expect(
      second.extracted_information,
      "re-extraction is deterministic — same context, same facts",
    ).toEqual(FACTS);
    expect(second.prior_information).toEqual(FACTS);
    expect(second.information_updated, "a re-extracted self-loop persists nothing").toBe(false);
    expect(second.information_update).toEqual({ kind: "unchanged", information: FACTS });
    expect(second.next_information).toEqual(FACTS);
    expect(await informationOf(convId), "the information is monotonic — it never regressed").toEqual(FACTS);
  });
});

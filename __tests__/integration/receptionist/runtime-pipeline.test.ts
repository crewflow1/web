import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry, runConversationTurn } from "@/server/services/receptionist";
import { getConversation, listConversations } from "@/server/services/receptionist-conversation-reads";

/**
 * Multi-turn Conversation Runtime — real-Postgres proof of the AI Receptionist Programme R15
 * (MULTI-TURN CONVERSATION RUNTIME) and R17 (FORMAL CONVERSATION STATE MACHINE).
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

    // The runtime OWNS the outbound append — the timeline now carries the reply too.
    const summary = await getConversation({ org_id: orgId, conversation_id: convId });
    expect(summary?.message_count).toBe(2);
    expect(summary?.runtime_state).toBe("awaiting_customer");
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
});

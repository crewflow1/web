import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry } from "@/server/services/receptionist";
import {
  getConversation,
  reconstructConversation,
} from "@/server/services/receptionist-conversation-reads";
import { getConversationContext } from "@/server/services/receptionist-conversation-context";
import { resolveEventText, roleOf } from "@/lib/receptionist/conversation-context";

/**
 * Conversation Context Assembly — real-Postgres proof of the AI Receptionist Programme R12
 * (CONVERSATION CONTEXT ASSEMBLY).
 *
 * R11 built the canonical READ model (reconstructConversation). R12 is the canonical ASSEMBLY
 * layer ABOVE it: getConversationContext reconstructs a conversation through R11 (org-scoped,
 * deterministic) and folds it — with the pure, model-free assembler — into a model-ready context
 * object. The unit tier pins the pure fold; the security tier proves, as a matter of SOURCE, that
 * the layer is additive, read-only, model-free and the single assembly path. This tier proves the
 * BEHAVIOUR the others can't — that when the SEAM actually runs against Postgres, driven the way
 * production writes the substrate (`processInboundEnquiry`), the directive's R12 validation holds
 * end to end:
 *
 *   • DETERMINISTIC ASSEMBLY — the same conversation assembles to a BYTE-IDENTICAL context object
 *     on every call.
 *   • FAITHFUL PROJECTION — every assembled turn's role and text is exactly the R11 timeline
 *     event's canonical role/resolution; the customer turn is the customer's own words, resolved
 *     live from the authoritative enquiry row.
 *   • VERBATIM METADATA — the context's conversation + contact metadata equals the R11 container's,
 *     recomputed nowhere.
 *   • DETERMINISTIC TRUNCATION — a tight token budget retains the newest turns, drops the oldest,
 *     and reports the omission; the whole conversation fits under the default budget.
 *   • ORGANISATION ISOLATION — assembly inherits R11's org scope; one org can never assemble
 *     another's context.
 *   • NO MUTATION — assembling a context, repeatedly, never advances a counter or writes a ledger.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing. Teardown drops the seeded orgs and clears the un-FK'd
 * admin_activity_log rows, exactly as the R11 suite does.
 */

// The substrate/ledger tables are service-role-only internals, NOT in the generated Database
// types. Cast to the minimal surface this suite exercises (the same convention the R11 suite uses).
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
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
}
interface Client {
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const AUDITS = "ai_reply_audits";
const ENQUIRIES = "inbound_enquiries";
const CONVERSATIONS = "receptionist_conversations";

const CALLER = "+447700900000";
const OTHER_CALLER = "+447700900999";

const createdOrgs: string[] = [];

/** Stand up a real organisation the inbound processor can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r12-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R12 Conversation Context Org", slug })
    .select("id");
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data ?? [])[0]?.id);
  createdOrgs.push(id);
  return id;
}

/** The authoritative enquiry row, read directly as service_role (ground truth for resolution). */
async function enquiryById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc().from(ENQUIRIES).select("id, raw_text").eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/** The substrate container row, read directly (ground truth for the read-only invariant). */
async function conversationRow(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc()
    .from(CONVERSATIONS)
    .select("id, message_count, last_message_at")
    .eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

describeIntegration("Conversation Context Assembly (R12)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("assembles a model-ready context deterministically — inbound then outbound, BYTE-IDENTICAL on every call", async () => {
    vi.stubEnv(FLAG, "true"); // arm the text-back so the flow threads BOTH an inbound and an outbound
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

    const ctx = await getConversationContext({ org_id: orgId, conversation_id: convId });
    expect(ctx, "the conversation assembles a context").not.toBeNull();
    if (!ctx) throw new Error("unreachable");

    // Two role-attributed turns, in canonical order: the customer message, then the assistant reply.
    expect(ctx.messages.map((m) => m.role)).toEqual(["customer", "assistant"]);
    expect(ctx.boundaries.total_message_count).toBe(2);
    expect(ctx.conversation.message_count).toBe(2);
    // The reserved summariser slot stays a null placeholder — R12 generates nothing.
    expect(ctx.summary).toBeNull();

    // DETERMINISTIC: a second assembly is byte-identical to the first.
    const again = await getConversationContext({ org_id: orgId, conversation_id: convId });
    expect(JSON.stringify(again)).toBe(JSON.stringify(ctx));
  });

  it("faithfully projects the R11 timeline — every turn's role + text is the canonical resolution", async () => {
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();

    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "The customer's actual words.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = result.conversation_id as string;

    const reconstructed = await reconstructConversation({ org_id: orgId, conversation_id: convId });
    if (!reconstructed) throw new Error("the conversation must reconstruct");
    const ctx = await getConversationContext({ org_id: orgId, conversation_id: convId });
    if (!ctx) throw new Error("the conversation must assemble");

    // The assembled turns are a faithful, in-order projection of the R11 timeline: each turn's
    // role and text is EXACTLY the canonical role/resolution of the corresponding timeline event.
    expect(ctx.messages).toHaveLength(reconstructed.timeline.length);
    reconstructed.timeline.forEach((event, i) => {
      const turn = ctx.messages[i]!;
      expect(turn.message_id).toBe(event.message_id);
      expect(turn.role).toBe(roleOf(event));
      expect(turn.text).toBe(resolveEventText(event));
    });

    // The customer turn is the customer's OWN words, resolved live from the authoritative enquiry.
    const enquiry = await enquiryById(result.enquiry_id);
    const customerTurn = ctx.messages.find((m) => m.role === "customer")!;
    expect(customerTurn.text).toBe(enquiry?.raw_text);
    // The assistant turn resolved to a non-empty reply body.
    const assistantTurn = ctx.messages.find((m) => m.role === "assistant")!;
    expect(assistantTurn.text.length).toBeGreaterThan(0);
  });

  it("carries the conversation + contact metadata VERBATIM from the R11 container", async () => {
    const orgId = await freshOrg(); // flag OFF: an inbound-only conversation is enough
    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "I'd like a quote please.",
    });
    const convId = result.conversation_id as string;

    const conv = await getConversation({ org_id: orgId, conversation_id: convId });
    if (!conv) throw new Error("the conversation summary must resolve");
    const ctx = await getConversationContext({ org_id: orgId, conversation_id: convId });
    if (!ctx) throw new Error("the conversation must assemble");

    // Conversation metadata projected straight off the R11 summary — recomputed nowhere.
    expect(ctx.conversation).toEqual({
      conversation_id: conv.conversation_id,
      org_id: conv.org_id,
      employee_slug: conv.employee_slug,
      channel: conv.channel,
      status: conv.status,
      message_count: conv.message_count,
      first_message_at: conv.first_message_at,
      last_message_at: conv.last_message_at,
      last_direction: conv.last_direction,
    });
    // Contact identity projected verbatim too.
    expect(ctx.contact).toEqual({
      contact_ref: conv.contact_ref,
      contact_name: conv.contact_name,
    });
  });

  it("applies deterministic truncation — a tight token budget keeps the newest turn, drops the oldest", async () => {
    const orgId = await freshOrg(); // flag OFF: three inbound turns threaded onto ONE conversation
    await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "First message from the customer.",
    });
    await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Second message from the customer.",
    });
    const third = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Third message from the customer.",
    });
    const convId = third.conversation_id as string;

    // Under the default budget the whole conversation fits — nothing is dropped.
    const full = await getConversationContext({ org_id: orgId, conversation_id: convId });
    if (!full) throw new Error("the conversation must assemble");
    expect(full.messages).toHaveLength(3);
    expect(full.boundaries.truncated).toBe(false);
    expect(full.elision).toBeNull();

    // Under a 1-token budget only the single newest turn survives (the always-in rule); the two
    // older turns are dropped and reported.
    const tight = await getConversationContext({
      org_id: orgId,
      conversation_id: convId,
      options: { token_budget: 1 },
    });
    if (!tight) throw new Error("the conversation must assemble");
    expect(tight.messages).toHaveLength(1);
    // The retained turn is the newest of the three (the last in canonical order).
    expect(tight.messages[0]!.message_id).toBe(full.messages[2]!.message_id);
    expect(tight.boundaries).toMatchObject({
      total_message_count: 3,
      included_message_count: 1,
      omitted_message_count: 2,
      truncated: true,
    });
    expect(tight.elision).toBe("[2 earlier messages omitted]");
  });

  it("is ORGANISATION-scoped — one org can never assemble another's context", async () => {
    const orgA = await freshOrg();
    const orgB = await freshOrg();
    const a = await processInboundEnquiry({
      org_id: orgA,
      channel: "phone",
      caller: CALLER,
      raw_text: "Org A's conversation.",
    });
    const b = await processInboundEnquiry({
      org_id: orgB,
      channel: "phone",
      caller: OTHER_CALLER,
      raw_text: "Org B's conversation.",
    });
    const convA = a.conversation_id as string;
    const convB = b.conversation_id as string;

    // Each org assembles ONLY its own conversation; the other org's id resolves to null (R11's
    // org-scoped null, propagated unchanged) — no cross-tenant bleed.
    expect(await getConversationContext({ org_id: orgA, conversation_id: convA })).not.toBeNull();
    expect(await getConversationContext({ org_id: orgB, conversation_id: convB })).not.toBeNull();
    expect(await getConversationContext({ org_id: orgA, conversation_id: convB })).toBeNull();
    expect(await getConversationContext({ org_id: orgB, conversation_id: convA })).toBeNull();
  });

  it("performs NO mutation — assembling a context repeatedly never advances a counter or writes a ledger", async () => {
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();
    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Seed a conversation, then assemble it repeatedly.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = result.conversation_id as string;

    const before = await conversationRow(convId);
    const auditsBefore = (await svc().from(AUDITS).select("id").eq("org_id", orgId)).data ?? [];

    // Assemble the context several times, at different budgets.
    for (let i = 0; i < 3; i++) {
      await getConversationContext({ org_id: orgId, conversation_id: convId });
      await getConversationContext({
        org_id: orgId,
        conversation_id: convId,
        options: { token_budget: 1 },
      });
    }

    const after = await conversationRow(convId);
    const auditsAfter = (await svc().from(AUDITS).select("id").eq("org_id", orgId)).data ?? [];
    // The container counter and timestamp are untouched; no new audit was written. Assembly is inert.
    expect(after?.message_count).toBe(before?.message_count);
    expect(after?.last_message_at).toBe(before?.last_message_at);
    expect(auditsAfter.length).toBe(auditsBefore.length);
  });

  it("returns null for a conversation that does not exist in the org", async () => {
    const orgId = await freshOrg();
    const ghost = crypto.randomUUID();
    expect(await getConversationContext({ org_id: orgId, conversation_id: ghost })).toBeNull();
  });
});

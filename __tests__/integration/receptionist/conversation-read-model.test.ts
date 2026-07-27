import { afterAll, afterEach, expect, it, vi } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { processInboundEnquiry } from "@/server/services/receptionist";
import {
  getConversation,
  getConversationByContact,
  getConversationTimeline,
  listConversations,
  reconstructConversation,
} from "@/server/services/receptionist-conversation-reads";

/**
 * Conversation Timeline Read Model — real-Postgres proof of the AI Receptionist Programme R11
 * (CONVERSATION TIMELINE READ MODEL).
 *
 * R10 laid a WRITE-ONLY substrate (receptionist_conversations + receptionist_messages) that
 * threaded a contact's messages but that nothing could READ. R11 is the canonical READ layer
 * over it — two `security_invoker` projections (receptionist_conversation_timeline /
 * _list) and the org-scoped read service that resolves each message's authoritative content AT
 * READ TIME. The unit tier pins the pure canonical-ordering fold; the security tier proves, as
 * a matter of SOURCE, that the migration is a read-only projection reusing the R9 pattern and
 * that reconstruction lives in exactly one module. This tier proves the BEHAVIOUR the others
 * can't — that when the read SERVICE actually runs against Postgres, driven the way production
 * writes the substrate (`processInboundEnquiry`), the directive's validation criteria hold end
 * to end:
 *
 *   • DETERMINISTIC RECONSTRUCTION — a conversation's complete timeline reconstructs in ONE
 *     canonical order, identically on every read.
 *   • INBOUND + OUTBOUND RESOLVE CORRECTLY — the inbound entry surfaces the customer's message
 *     (from inbound_enquiries); the outbound entry surfaces the AI reply + guardrail decision
 *     (from ai_reply_lifecycle), with the inbound-only / outbound-only fields correctly null.
 *   • NO CONTENT DUPLICATED — the timeline holds no copy: mutate the authoritative source row
 *     and the very next read reflects it, proving the body is RESOLVED, never stored twice.
 *   • TRANSPORT + DELIVERY-RECEIPT REFERENCES — an outbound entry carries its transport and
 *     (when one exists) its terminal delivery receipt, reusing the R9 resolution.
 *   • ORGANISATION ISOLATION — every read is org-scoped; one org can never read another's
 *     conversation, timeline, or list row.
 *   • THE READ MODEL PERFORMS NO MUTATION — reading never advances a counter, threads a
 *     message, or writes a ledger; and the views themselves reject every write verb and deny
 *     anon, so the substrate stays the single write source.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing. Teardown drops the seeded orgs (cascading enquiries,
 * leads, conversations and messages) and clears the un-FK'd admin_activity_log rows; the
 * append-only audit/transport/receipt rows are intentionally left behind (harmless in the
 * ephemeral CI database). Rows are addressed by per-test org ids so each assertion sees only
 * its own writes.
 */

// The substrate/ledger tables, their record_* primitives and the two read-model views are
// service-role-only internals, NOT in the generated Database types. Cast to the minimal surface
// this suite exercises (the same `as unknown as` convention the R9/R10 suites use).
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
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Thenable<T>;
}
const svc = (): Client => serviceClient() as unknown as Client;
const anon = (): Client => anonClient() as unknown as Client;

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";
const TIMELINE_VIEW = "receptionist_conversation_timeline";
const LIST_VIEW = "receptionist_conversation_list";
const AUDITS = "ai_reply_audits";
const ENQUIRIES = "inbound_enquiries";
const CONVERSATIONS = "receptionist_conversations";
const AUDIT_RPC = "record_ai_reply_audit";
const TRANSPORT_RPC = "record_ai_reply_transport";
const RECEIPT_RPC = "record_ai_reply_delivery_receipt";
const APPEND_RPC = "append_receptionist_message";
const EMPLOYEE_SLUG = "voice-receptionist-ai";

const CALLER = "+447700900000";
const OTHER_CALLER = "+447700900999";

const createdOrgs: string[] = [];

/** Stand up a real organisation the inbound processor can write against, tracked for teardown. */
async function freshOrg(): Promise<string> {
  const slug = `it-r11-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc()
    .from("organizations")
    .insert({ name: "R11 Conversation Read Model Org", slug })
    .select("id");
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data ?? [])[0]?.id);
  createdOrgs.push(id);
  return id;
}

/** The authoritative enquiry row, read directly as service_role (ground truth for resolution). */
async function enquiryById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc()
    .from(ENQUIRIES)
    .select("id, raw_text, ai_summary, caller, urgency, status")
    .eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? [])[0] ?? null;
}

/** The authoritative audit row, read directly as service_role (ground truth for resolution). */
async function auditById(id: string): Promise<Record<string, unknown> | null> {
  const res = await svc().from(AUDITS).select("id, draft, verdict, allowed").eq("id", id);
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

/** File a SENT transport for an audit (mints the provider message id the receipt keys on). */
async function seedSentTransport(auditId: string, orgId: string): Promise<string> {
  const providerMessageId = `SM-${crypto.randomUUID()}`;
  const res = await svc().rpc<string>(TRANSPORT_RPC, {
    p_reply_audit_id: auditId,
    p_org_id: orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "sms",
    p_to_ref: CALLER,
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "twilio",
    p_provider_message_id: providerMessageId,
  });
  expect(res.error, res.error?.message).toBeNull();
  return providerMessageId;
}

/** Record a delivery receipt against a sent transport's provider message id. */
async function recordReceipt(providerMessageId: string, status: string): Promise<void> {
  const res = await svc().rpc(RECEIPT_RPC, {
    p_provider_message_id: providerMessageId,
    p_status: status,
    p_error_code: null,
  });
  expect(res.error, res.error?.message).toBeNull();
}

/** Thread an OUTBOUND message entry that references an audit, through the substrate primitive. */
async function appendOutbound(convId: string, orgId: string, auditId: string): Promise<void> {
  const res = await svc().rpc<string>(APPEND_RPC, {
    p_conversation_id: convId,
    p_org_id: orgId,
    p_direction: "outbound",
    p_channel: "sms",
    p_enquiry_id: null,
    p_audit_id: auditId,
  });
  expect(res.error, res.error?.message).toBeNull();
}

/** Denial is valid whether it arrives as a privilege error or an RLS-filtered empty set. */
function expectAnonDenied(res: Res<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Conversation Timeline Read Model (R11)", () => {
  afterAll(async () => {
    for (const id of createdOrgs) {
      await svc().from("admin_activity_log").delete().eq("metadata->>org_id", id);
      await svc().from("organizations").delete().eq("id", id);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reconstructs a complete conversation deterministically — inbound then outbound, identically on every read", async () => {
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

    // The canonical reconstruction: container metadata + ordered timeline in one call.
    const reconstructed = await reconstructConversation({ org_id: orgId, conversation_id: convId });
    expect(reconstructed, "the conversation reconstructs").not.toBeNull();
    if (!reconstructed) throw new Error("unreachable");

    // Two events, in canonical (chronological) order: the inbound message, then the AI reply.
    expect(reconstructed.timeline.map((e) => e.direction)).toEqual(["inbound", "outbound"]);
    // The container counter and the timeline agree — one source of truth for "how many".
    expect(reconstructed.conversation.message_count).toBe(2);
    expect(reconstructed.timeline).toHaveLength(2);

    // DETERMINISTIC: a second read returns the SAME rows in the SAME order.
    const again = await getConversationTimeline({ org_id: orgId, conversation_id: convId });
    expect(again.map((e) => e.message_id)).toEqual(
      reconstructed.timeline.map((e) => e.message_id),
    );
    // Chronological: the inbound instant is not after the outbound instant.
    expect(
      Date.parse(reconstructed.timeline[0]!.event_at) <=
        Date.parse(reconstructed.timeline[1]!.event_at),
    ).toBe(true);
  });

  it("resolves the inbound and outbound records correctly — each side's fields, the other side's null", async () => {
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
    const auditId = (() => {
      const tb = result.textback;
      if (!tb.attempted || !("dispatch" in tb)) throw new Error("armed reply must have dispatched");
      return tb.dispatch.audit_id as string;
    })();

    const timeline = await getConversationTimeline({ org_id: orgId, conversation_id: convId });
    const inbound = timeline.find((e) => e.direction === "inbound")!;
    const outbound = timeline.find((e) => e.direction === "outbound")!;

    // Ground truth, read straight from the authoritative rows.
    const enquiry = await enquiryById(result.enquiry_id);
    const audit = await auditById(auditId);

    // INBOUND entry: references the enquiry and surfaces its content; carries no outbound fields.
    expect(inbound.enquiry_id).toBe(result.enquiry_id);
    expect(inbound.inbound_text, "the inbound text is resolved from inbound_enquiries").toBe(
      enquiry?.raw_text,
    );
    expect(inbound.audit_id).toBeNull();
    expect(inbound.outbound_draft).toBeNull();
    expect(inbound.transport_id).toBeNull();

    // OUTBOUND entry: references the audit and surfaces the reply + verdict; carries no inbound.
    expect(outbound.audit_id).toBe(auditId);
    expect(outbound.outbound_draft, "the reply is resolved from ai_reply_lifecycle").toBe(
      audit?.draft,
    );
    expect(outbound.outbound_verdict).toBe("allow");
    expect(outbound.outbound_allowed).toBe(true);
    expect(outbound.enquiry_id).toBeNull();
    expect(outbound.inbound_text).toBeNull();
    // With no configured SMS provider (the CI path) the reply's transport is a recorded
    // failure — the timeline surfaces that transport reference, no receipt.
    expect(outbound.transport_status).toBe("failed");
    expect(outbound.transport_failure_reason).toBe("no_provider");
    expect(outbound.provider_message_id).toBeNull();
    expect(outbound.receipt_id).toBeNull();
  });

  it("duplicates no content — mutating the authoritative source is reflected on the next read", async () => {
    const orgId = await freshOrg(); // flag OFF: a single inbound entry is enough to prove resolution
    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Original enquiry text.",
    });
    const convId = result.conversation_id as string;

    // The timeline resolves the enquiry's summary live — so change the SOURCE and re-read.
    const sentinel = `LIVE-RESOLUTION-${crypto.randomUUID()}`;
    const patched = await svc()
      .from(ENQUIRIES)
      .update({ ai_summary: sentinel })
      .eq("id", result.enquiry_id);
    expect(patched.error, patched.error?.message).toBeNull();

    const timeline = await getConversationTimeline({ org_id: orgId, conversation_id: convId });
    const inbound = timeline.find((e) => e.direction === "inbound")!;
    // The read model held NO copy: it reflects the just-written source value. A duplicated
    // body would still show the old summary — this proves resolution at read time.
    expect(inbound.inbound_summary).toBe(sentinel);
  });

  it("retrieves the transport AND terminal delivery-receipt references for a delivered reply", async () => {
    const orgId = await freshOrg();
    // A realistic inbound conversation (flag OFF → inbound-only), then a controlled clean
    // outbound chain threaded onto it: audit → SENT transport → DELIVERED receipt.
    const seed = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "I'd like a quote please.",
    });
    const convId = seed.conversation_id as string;

    const auditId = await seedAudit(orgId, "Thanks — a member of the team will be in touch shortly.");
    const providerMessageId = await seedSentTransport(auditId, orgId);
    await recordReceipt(providerMessageId, "delivered");
    await appendOutbound(convId, orgId, auditId);

    const timeline = await getConversationTimeline({ org_id: orgId, conversation_id: convId });
    expect(timeline.map((e) => e.direction)).toEqual(["inbound", "outbound"]);
    const outbound = timeline.find((e) => e.direction === "outbound")!;

    // The transport reference…
    expect(outbound.transport_id).toBeTruthy();
    expect(outbound.transport_status).toBe("sent");
    expect(outbound.provider_message_id).toBe(providerMessageId);
    // …and the terminal delivery-receipt reference, resolved through the R9 lifecycle.
    expect(outbound.receipt_id).toBeTruthy();
    expect(outbound.delivery_status).toBe("delivered");
    expect(outbound.delivery_terminal).toBe(true);
    expect(outbound.receipt_count).toBe(1);
  });

  it("lists an org's conversations with metadata, and resolves one by contact identity", async () => {
    const orgId = await freshOrg();
    const a = await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Contact A first message.",
    });
    await processInboundEnquiry({
      org_id: orgId,
      channel: "sms",
      caller: CALLER,
      raw_text: "Contact A second message.",
    });
    const b = await processInboundEnquiry({
      org_id: orgId,
      channel: "instagram_dm",
      caller: "@Second.Contact",
      raw_text: "Contact B on Instagram.",
    });

    // The list index: both conversations, each with its container metadata + last-message preview.
    const list = await listConversations({ org_id: orgId });
    expect(list).toHaveLength(2);
    const byId = new Map(list.map((c) => [c.conversation_id, c]));
    const convA = byId.get(a.conversation_id as string)!;
    expect(convA.contact_ref).toBe(CALLER);
    expect(convA.channel).toBe("sms");
    expect(convA.message_count, "two inbound messages threaded").toBe(2);
    expect(convA.last_direction).toBe("inbound");
    expect(convA.last_event_at).toBeTruthy();

    // Contact-scoped retrieval reuses the SAME normalisation as the writer — casing/whitespace
    // still resolves the one conversation, with no drift.
    const foundA = await getConversationByContact({
      org_id: orgId,
      channel: "sms",
      contact_ref: "  +447700900000  ",
    });
    expect(foundA?.conversation_id).toBe(a.conversation_id);
    const foundB = await getConversationByContact({
      org_id: orgId,
      channel: "instagram_dm",
      contact_ref: "@second.contact",
    });
    expect(foundB?.conversation_id).toBe(b.conversation_id);
    // An empty identifier resolves to nothing (the writer's short-circuit, mirrored on read).
    expect(await getConversationByContact({ org_id: orgId, channel: "sms", contact_ref: "  " })).toBeNull();
  });

  it("is ORGANISATION-scoped — one org can never read another's conversation, timeline, or list", async () => {
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

    // Each org lists ONLY its own conversation.
    expect((await listConversations({ org_id: orgA })).map((c) => c.conversation_id)).toEqual([
      convA,
    ]);
    expect((await listConversations({ org_id: orgB })).map((c) => c.conversation_id)).toEqual([
      convB,
    ]);

    // Reading org B's conversation UNDER org A's scope returns nothing — no cross-tenant bleed.
    expect(await getConversation({ org_id: orgA, conversation_id: convB })).toBeNull();
    expect(await getConversationTimeline({ org_id: orgA, conversation_id: convB })).toHaveLength(0);
    expect(await reconstructConversation({ org_id: orgA, conversation_id: convB })).toBeNull();
    // …and the same contact string in the wrong org resolves to nothing.
    expect(
      await getConversationByContact({ org_id: orgA, channel: "phone", contact_ref: OTHER_CALLER }),
    ).toBeNull();
  });

  it("performs NO mutation — reading never advances a counter, threads a message, or writes a ledger", async () => {
    vi.stubEnv(FLAG, "true");
    const orgId = await freshOrg();
    const result = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Seed a conversation, then read it repeatedly.",
      dedup_key: `CA-${crypto.randomUUID()}`,
    });
    const convId = result.conversation_id as string;

    const before = await conversationRow(convId);
    const auditsBefore = (await svc().from(AUDITS).select("id").eq("org_id", orgId)).data ?? [];

    // Exercise every read path several times.
    for (let i = 0; i < 3; i++) {
      await reconstructConversation({ org_id: orgId, conversation_id: convId });
      await getConversationTimeline({ org_id: orgId, conversation_id: convId });
      await listConversations({ org_id: orgId });
      await getConversation({ org_id: orgId, conversation_id: convId });
      await getConversationByContact({ org_id: orgId, channel: "phone", contact_ref: CALLER });
    }

    const after = await conversationRow(convId);
    const auditsAfter = (await svc().from(AUDITS).select("id").eq("org_id", orgId)).data ?? [];
    // The container counter and timestamp are untouched; no new audit was written. Reading is inert.
    expect(after?.message_count).toBe(before?.message_count);
    expect(after?.last_message_at).toBe(before?.last_message_at);
    expect(auditsAfter.length).toBe(auditsBefore.length);
  });

  it("the views reject every write verb and deny anon — the read model can never mutate the substrate", async () => {
    const orgId = await freshOrg();
    const seeded = await processInboundEnquiry({
      org_id: orgId,
      channel: "phone",
      caller: CALLER,
      raw_text: "Seed a row for the writability + RLS probe.",
    });
    const convId = seeded.conversation_id as string;

    // A multi-relation join view is not auto-updatable and has no INSTEAD OF trigger, so
    // Postgres itself refuses every write verb through BOTH projections.
    for (const view of [TIMELINE_VIEW, LIST_VIEW]) {
      const updated = await svc().from(view).update({ org_id: crypto.randomUUID() }).eq("org_id", orgId);
      expect(updated.error, `UPDATE through ${view} must be rejected`).not.toBeNull();
      const deleted = await svc().from(view).delete().eq("org_id", orgId);
      expect(deleted.error, `DELETE through ${view} must be rejected`).not.toBeNull();
      const inserted = await svc().from(view).insert({ org_id: orgId });
      expect(inserted.error, `INSERT through ${view} must be rejected`).not.toBeNull();
    }

    // service_role reads the projections; anon reads nothing (SELECT revoked; base-table RLS
    // denies JWT clients through the security_invoker views regardless).
    const asService = await svc().from(TIMELINE_VIEW).select("conversation_id").eq("conversation_id", convId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect((asService.data ?? []).length).toBeGreaterThan(0);
    expectAnonDenied(await anon().from(TIMELINE_VIEW).select("conversation_id").eq("conversation_id", convId));
    expectAnonDenied(await anon().from(LIST_VIEW).select("conversation_id").eq("conversation_id", convId));
  });

  it("returns empty / null for a conversation that does not exist in the org", async () => {
    const orgId = await freshOrg();
    const ghost = crypto.randomUUID();
    expect(await getConversationTimeline({ org_id: orgId, conversation_id: ghost })).toEqual([]);
    expect(await getConversation({ org_id: orgId, conversation_id: ghost })).toBeNull();
    expect(await reconstructConversation({ org_id: orgId, conversation_id: ghost })).toBeNull();
  });
});

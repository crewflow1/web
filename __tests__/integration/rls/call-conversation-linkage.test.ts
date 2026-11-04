import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { updateCallAssociation } from "@/server/services/telephony";

/**
 * Phone call ↔ receptionist-conversation linkage, against real Postgres.
 *
 * Regression cover for the defect fixed by migration 20261290000000 + the
 * independent-writes hardening in updateCallAssociation:
 *
 *   `updateCallAssociation` stores the id returned by processInboundEnquiry —
 *   a receptionist_conversations.id — into calls.conversation_id. The baseline
 *   FK pointed that column at the generic `conversations` table, so every link
 *   UPDATE FK-violated and rolled back, silently taking the lead_id link with it
 *   (one statement). The /leads/[id] Calls section (filters calls.lead_id) was
 *   therefore always empty for phone calls.
 *
 * These tests use the REAL writer against real tables + the real (fixed) FK —
 * actual DB assertions, no mocks.
 */

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TOKEN = `cclink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

let orgA = "";
let orgB = "";
let convA = ""; // receptionist_conversations in A
let convB = ""; // receptionist_conversations in B
let leadA = "";

async function mkOrg(tag: string): Promise<string> {
  const r = await svc().from("organizations").insert({ name: `CClink ${tag}`, slug: `${TOKEN}-${tag}` }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkConversation(org: string, contact: string): Promise<string> {
  const r = await svc()
    .from("receptionist_conversations")
    .insert({ org_id: org, employee_slug: "receptionist", channel: "phone", contact_ref: contact })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkLead(org: string): Promise<string> {
  const r = await svc().from("leads").insert({ org_id: org, source: "phone", status: "new", contact_name: "Pat Caller" }).select("id").single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function mkCall(org: string, providerCallId: string): Promise<string> {
  const r = await svc()
    .from("calls")
    .insert({ org_id: org, direction: "inbound", status: "in_progress", provider: "twilio", provider_call_id: providerCallId })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return String(r.data.id);
}
async function readCall(id: string): Promise<Row> {
  const r = await svc().from("calls").select("id, org_id, lead_id, conversation_id").eq("id", id).single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data as Row;
}

describeIntegration("rls · call ↔ receptionist-conversation linkage (20261290)", () => {
  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    convA = await mkConversation(orgA, "+447700900001");
    convB = await mkConversation(orgB, "+447700900002");
    leadA = await mkLead(orgA);
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
  });

  it("1. links a call to a receptionist conversation + lead in the same org (the core fix)", async () => {
    const cid = `${TOKEN}-CA1`;
    const callId = await mkCall(orgA, cid);
    await updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convA });
    const row = await readCall(callId);
    expect(row.lead_id).toBe(leadA);
    expect(row.conversation_id).toBe(convA); // would FK-violate under the old `conversations` target
  });

  it("2. cross-org conversation is REJECTED, but the lead link still lands (independent writes)", async () => {
    const cid = `${TOKEN}-CA2`;
    const callId = await mkCall(orgA, cid);
    // convB belongs to org B — the org-scoped composite FK makes this unrepresentable.
    await expect(
      updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convB }),
    ).rejects.toThrow();
    const row = await readCall(callId);
    expect(row.lead_id, "lead link must survive a failed conversation link").toBe(leadA);
    expect(row.conversation_id, "cross-org conversation must never link").toBeNull();
  });

  it("3. a conversations.id (wrong table) is REJECTED — pins the FK target to receptionist_conversations", async () => {
    // Prove we cannot regress to the old target: a row in the generic
    // `conversations` table must NOT be acceptable as a call's conversation.
    const genericConv = await svc().from("conversations").insert({ org_id: orgA, channel: "voice" }).select("id").single();
    expect(genericConv.error, genericConv.error?.message).toBeNull();
    const cid = `${TOKEN}-CA3`;
    const callId = await mkCall(orgA, cid);
    await expect(
      updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: String(genericConv.data.id) }),
    ).rejects.toThrow();
    const row = await readCall(callId);
    expect(row.conversation_id).toBeNull();
    expect(row.lead_id).toBe(leadA); // still landed
  });

  it("4. re-linking the same ids is idempotent (no duplicate, no error)", async () => {
    const cid = `${TOKEN}-CA4`;
    const callId = await mkCall(orgA, cid);
    await updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convA });
    await updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convA });
    const row = await readCall(callId);
    expect(row.lead_id).toBe(leadA);
    expect(row.conversation_id).toBe(convA);
  });

  it("5. a bare re-link (no conversation) never nulls an existing conversation link (monotonic)", async () => {
    const cid = `${TOKEN}-CA5`;
    const callId = await mkCall(orgA, cid);
    await updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convA });
    await updateCallAssociation(orgA, cid, { leadId: leadA }); // no conversationId
    const row = await readCall(callId);
    expect(row.conversation_id).toBe(convA);
  });

  it("6. ON DELETE SET NULL clears only conversation_id when the conversation is deleted", async () => {
    const cid = `${TOKEN}-CA6`;
    const callId = await mkCall(orgA, cid);
    const convTmp = await mkConversation(orgA, "+447700900006");
    await updateCallAssociation(orgA, cid, { leadId: leadA, conversationId: convTmp });
    // Delete the conversation → the call row must survive with conversation_id nulled.
    const del = await svc().from("receptionist_conversations").delete().eq("id", convTmp);
    expect(del.error, del.error?.message).toBeNull();
    const row = await readCall(callId);
    expect(row.conversation_id).toBeNull();
    expect(row.org_id).toBe(orgA); // org_id (NOT NULL) untouched — call row preserved
    expect(row.lead_id).toBe(leadA);
  });

  it("7. a call id that matches no row is a benign no-op (not an error)", async () => {
    await expect(
      updateCallAssociation(orgA, `${TOKEN}-NOPE`, { leadId: leadA, conversationId: convA }),
    ).resolves.toBeUndefined();
  });
});

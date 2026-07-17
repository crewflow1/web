import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  enforceAndAuditReply,
  processInboundEnquiry,
  recordWhatsAppDeliveryReceipt,
} from "@/server/services/receptionist";

/**
 * WhatsApp outbound receipts + message metadata — real-Postgres proof (Parts 10, 11).
 *
 * Outbound is dark in CI (no Meta creds), so a `sent` WhatsApp transport is SEEDED directly
 * through the service-role RPC (channel='whatsapp', provider='meta', provider_message_id=wamid)
 * — the widened channel CHECK (20260920) now admits it. Against that, this proves the
 * WhatsApp RECEIPT authority: correlation by wamid, channel='whatsapp', org copied from the
 * transport; delivered/read/failed idempotent + append-only (out-of-order cannot regress);
 * unknown wamid fails safe; cross-org is impossible. Plus the INBOUND message metadata:
 * provider_message_id persisted on the enquiry, and the partial-unique (org, provider_message_id)
 * making a re-ingestion a no-op while NULL rows coexist.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Client = {
  from: (t: string) => {
    insert: (v: unknown) => PromiseLike<Res<null>> & {
      select: (c: string) => { single: () => PromiseLike<Res<Record<string, unknown>>> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>>;
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<Res<null>> };
  };
  rpc: <T = unknown>(fn: string, args: Record<string, unknown>) => PromiseLike<Res<T>>;
};
const svc = (): Client => serviceClient() as unknown as Client;

const TOKEN = `it-wa-or-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMPLOYEE_SLUG = "voice-receptionist-ai";
const ALLOW_DRAFT = "Thanks for your message — a member of the team will get back to you shortly.";
const createdOrgs: string[] = [];

/** Seed an allowed audit on the WhatsApp channel (a random-UUID org — ledgers don't FK org). */
async function seedAllowedAudit(orgId: string): Promise<string> {
  const outcome = await enforceAndAuditReply({
    org_id: orgId,
    channel: "whatsapp_msg",
    correlation_id: crypto.randomUUID(),
    draft: ALLOW_DRAFT,
  });
  expect(outcome.decision.allowed, "seed draft must be a clean allow").toBe(true);
  return outcome.audit_id;
}

/** Seed a SENT WhatsApp transport, returning the wamid it carries (the receipt correlation key). */
async function seedSentWhatsAppTransport(orgId: string): Promise<string> {
  const auditId = await seedAllowedAudit(orgId);
  const wamid = `wamid.${TOKEN}.${Math.random().toString(36).slice(2, 8)}`;
  const res = await svc().rpc<string>("record_ai_reply_transport", {
    p_reply_audit_id: auditId,
    p_org_id: orgId,
    p_employee_slug: EMPLOYEE_SLUG,
    p_channel: "whatsapp",
    p_to_ref: "+447700900123",
    p_status: "sent",
    p_correlation_id: crypto.randomUUID(),
    p_provider: "meta",
    p_provider_message_id: wamid,
    p_dedup_key: null,
  });
  expect(res.error, res.error?.message).toBeNull();
  expect(res.data, "seeded sent transport must return an id").toBeTruthy();
  return wamid;
}

async function receiptsFor(wamid: string): Promise<Record<string, unknown>[]> {
  const res = await svc()
    .from("ai_reply_delivery_receipts")
    .select("id, channel, status, org_id, provider_message_id")
    .eq("provider_message_id", wamid);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

async function freshOrg(): Promise<string> {
  const slug = `${TOKEN}-org-${createdOrgs.length}`;
  const res = await svc().from("organizations").insert({ name: "WA Outbound Org", slug }).select("id").single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

describeIntegration("whatsapp outbound receipts + metadata · real Postgres", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    for (const id of createdOrgs) await svc().from("organizations").delete().eq("id", id);
  });

  it("correlates a receipt to its WhatsApp transport — channel='whatsapp', org copied from the transport", async () => {
    const orgId = crypto.randomUUID();
    const wamid = await seedSentWhatsAppTransport(orgId);

    const result = await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "delivered" });
    expect(result.recorded).toBe(true);
    if (!result.recorded) throw new Error("unreachable");
    expect(result.org_id).toBe(orgId);

    const rows = await receiptsFor(wamid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("whatsapp");
    expect(rows[0]?.org_id).toBe(orgId);
  });

  it("records the full lifecycle queued→sent→delivered→read as four append-only rows", async () => {
    const wamid = await seedSentWhatsAppTransport(crypto.randomUUID());
    for (const status of ["queued", "sent", "delivered", "read"] as const) {
      const r = await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status });
      expect(r.recorded, `status ${status} should record`).toBe(true);
    }
    const rows = await receiptsFor(wamid);
    expect(rows.map((r) => r.status).sort()).toEqual(["delivered", "queued", "read", "sent"]);
  });

  it("OUT-OF-ORDER: a late 'delivered' after 'read' appends a row and NEVER regresses the read", async () => {
    const wamid = await seedSentWhatsAppTransport(crypto.randomUUID());
    await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "read" });
    await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "delivered" });
    const rows = await receiptsFor(wamid);
    // Both facts persist as distinct immutable rows; the read row is untouched (append-only).
    expect(rows.map((r) => r.status).sort()).toEqual(["delivered", "read"]);
  });

  it("DUPLICATE: the same (wamid, status) twice is idempotent — one row, was_duplicate", async () => {
    const wamid = await seedSentWhatsAppTransport(crypto.randomUUID());
    const first = await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "delivered" });
    const second = await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "delivered" });
    expect(first.recorded && second.recorded).toBe(true);
    if (second.recorded) expect(second.duplicate).toBe(true);
    expect(await receiptsFor(wamid)).toHaveLength(1);
  });

  it("UNKNOWN wamid fails safe — records nothing, returns unknown_message (every wamid while outbound is dark)", async () => {
    const result = await recordWhatsAppDeliveryReceipt({
      providerMessageId: `wamid.${TOKEN}.never-sent`,
      status: "delivered",
    });
    expect(result.recorded).toBe(false);
    if (!result.recorded) expect(result.reason).toBe("unknown_message");
  });

  it("CROSS-ORG impossible — the receipt's org is copied from the transport, not the caller", async () => {
    const orgA = crypto.randomUUID();
    const wamid = await seedSentWhatsAppTransport(orgA);
    // The webhook supplies only wamid + status; org is resolved from the transport row.
    const result = await recordWhatsAppDeliveryReceipt({ providerMessageId: wamid, status: "delivered" });
    expect(result.recorded && result.org_id).toBe(orgA);
    const rows = await receiptsFor(wamid);
    expect(rows.every((r) => r.org_id === orgA)).toBe(true);
  });

  it("inbound metadata: an ingestion persists provider_message_id, and a re-ingestion is a no-op (23505)", async () => {
    const orgId = await freshOrg();
    const wamid = `wamid.${TOKEN}.inbound-1`;
    const first = await processInboundEnquiry({
      org_id: orgId,
      channel: "whatsapp_msg",
      caller: "447700900555",
      raw_text: "Hello",
      dedup_key: wamid,
      provider_message_id: wamid,
      has_media: false,
    });
    // Re-ingest the SAME (org, wamid): the partial-unique short-circuits to the same enquiry.
    const second = await processInboundEnquiry({
      org_id: orgId,
      channel: "whatsapp_msg",
      caller: "447700900555",
      raw_text: "Hello again (duplicate delivery)",
      dedup_key: wamid,
      provider_message_id: wamid,
      has_media: false,
    });
    expect(second.enquiry_id).toBe(first.enquiry_id);
    expect(second.textback).toEqual({ attempted: false, reason: "duplicate_message" });

    // Exactly one enquiry carries this provider_message_id.
    const res = await svc()
      .from("inbound_enquiries")
      .select("id, provider_message_id")
      .eq("provider_message_id", wamid);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(1);
  });

  it("nullable-unique: multiple NULL-provider_message_id enquiries coexist (legacy/phone unconstrained)", async () => {
    const orgId = await freshOrg();
    // Two phone enquiries (no provider_message_id) in the same org must both insert.
    for (const text of ["call one", "call two"]) {
      const r = await processInboundEnquiry({ org_id: orgId, channel: "phone", caller: "+447700900777", raw_text: text });
      expect(r.enquiry_id).toBeTruthy();
    }
    const res = await svc().from("inbound_enquiries").select("id").eq("org_id", orgId);
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

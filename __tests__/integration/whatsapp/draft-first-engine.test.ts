import { afterAll, afterEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  processInboundEnquiry,
  enforceAndAuditReply,
} from "@/server/services/receptionist";
import { listReviewQueue } from "@/server/services/receptionist-review";

/**
 * WhatsApp draft-first engine — real-Postgres proof (Parts 5–8).
 *
 * Drives the REAL `processInboundEnquiry` with `channel: "whatsapp_msg"` against real
 * Postgres and proves the draft-first guarantees the mocks can't:
 *   - an ELIGIBLE WhatsApp message (feature flag on + org enabled & live) runs the SAME
 *     reasoning engine and writes an audit on `channel='whatsapp_msg'` — reusing the
 *     substrate, not a second AI;
 *   - the reply's transport records `no_provider` on `channel='whatsapp'` — DARK, sends
 *     nothing, and NEVER an `sms` row (the no-fallback guarantee, in the ledger);
 *   - the gate FAILS CLOSED: feature off, org not-live, or no setup row → no audit, no
 *     transport, `reason: channel_not_enabled`;
 *   - conversation continuation folds a sender's messages into one conversation;
 *   - a WhatsApp `review` audit surfaces in the channel-agnostic operator inbox.
 *
 * The WhatsApp feature flag is a runtime toggle read from process.env at call time, so
 * vi.stubEnv drives it exactly as a deploy would. CI configures NO WhatsApp provider, so
 * the transport degrades to a recorded `failed`/`no_provider` attempt — the dark path.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => PromiseLike<Res<null>> & {
      select: (c: string) => { single: () => PromiseLike<Res<Record<string, unknown>>> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>>;
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<Res<null>> };
  };
};
const db = (): Db => serviceClient() as unknown as Db;

const WHATSAPP_FLAG = "NEXT_PUBLIC_FEATURE_WHATSAPP";
const WA_CALLER = "447700900000"; // a wa_id — a phone number without '+'
const TOKEN = `it-wa-df-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdOrgs: string[] = [];

async function freshOrg(): Promise<string> {
  const slug = `${TOKEN}-${createdOrgs.length}`;
  const res = await db().from("organizations").insert({ name: "WA Draft-First Org", slug }).select("id").single();
  expect(res.error, res.error?.message).toBeNull();
  const id = String((res.data as { id: string }).id);
  createdOrgs.push(id);
  return id;
}

/** Enable the WhatsApp channel for an org via ai_receptionist_setups (enabled + status). */
async function enableWhatsApp(orgId: string, status: string = "live"): Promise<void> {
  const res = await db()
    .from("ai_receptionist_setups")
    .insert({ org_id: orgId, enabled: true, status });
  expect(res.error, res.error?.message).toBeNull();
}

async function auditsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("ai_reply_audits").select("id, channel, verdict, allowed").eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

async function transportsForOrg(orgId: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("ai_reply_transports").select("id, channel, status, failure_reason").eq("org_id", orgId);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

describeIntegration("whatsapp draft-first engine · real Postgres", () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    for (const id of createdOrgs) await db().from("organizations").delete().eq("id", id);
  });

  it("ELIGIBLE: an inbound WhatsApp message drafts an audit on channel=whatsapp_msg (reuses the engine)", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await freshOrg();
    await enableWhatsApp(org);

    const res = await processInboundEnquiry({
      org_id: org,
      channel: "whatsapp_msg",
      caller: WA_CALLER,
      raw_text: "Hi, do you cover my area?",
      dedup_key: `${TOKEN}.1`,
    });

    expect(res.textback.attempted).toBe(true);
    const audits = await auditsForOrg(org);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.channel).toBe("whatsapp_msg");
  });

  it("DARK transport: the reply records no_provider on channel=whatsapp — NEVER sms, nothing sent", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await freshOrg();
    await enableWhatsApp(org);

    await processInboundEnquiry({
      org_id: org,
      channel: "whatsapp_msg",
      caller: WA_CALLER,
      raw_text: "Hello there",
      dedup_key: `${TOKEN}.2`,
    });

    const transports = await transportsForOrg(org);
    expect(transports).toHaveLength(1);
    expect(transports[0]?.channel).toBe("whatsapp"); // the dark WhatsApp transport
    expect(transports[0]?.status).toBe("failed");
    expect(transports[0]?.failure_reason).toBe("no_provider");
    // The no-fallback guarantee, proven in the ledger: not one SMS transport for this org.
    expect(transports.filter((t) => t.channel === "sms")).toHaveLength(0);
  });

  it("FAIL CLOSED — feature flag off: a live org still drafts nothing", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "false");
    const org = await freshOrg();
    await enableWhatsApp(org); // enabled + live, but the global flag is off

    const res = await processInboundEnquiry({
      org_id: org,
      channel: "whatsapp_msg",
      caller: WA_CALLER,
      raw_text: "Hi",
      dedup_key: `${TOKEN}.3`,
    });

    expect(res.textback).toEqual({ attempted: false, reason: "channel_not_enabled" });
    expect(await auditsForOrg(org)).toHaveLength(0);
    expect(await transportsForOrg(org)).toHaveLength(0);
  });

  it("FAIL CLOSED — org not live: flag on but still provisioning → no draft", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await freshOrg();
    await enableWhatsApp(org, "testing"); // enabled but not 'live'

    const res = await processInboundEnquiry({
      org_id: org,
      channel: "whatsapp_msg",
      caller: WA_CALLER,
      raw_text: "Hi",
      dedup_key: `${TOKEN}.4`,
    });

    expect(res.textback).toEqual({ attempted: false, reason: "channel_not_enabled" });
    expect(await auditsForOrg(org)).toHaveLength(0);
  });

  it("FAIL CLOSED — no setup row: an org that never configured WhatsApp is dark", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await freshOrg(); // no ai_receptionist_setups row at all

    const res = await processInboundEnquiry({
      org_id: org,
      channel: "whatsapp_msg",
      caller: WA_CALLER,
      raw_text: "Hi",
      dedup_key: `${TOKEN}.5`,
    });

    expect(res.textback).toEqual({ attempted: false, reason: "channel_not_enabled" });
    expect(await auditsForOrg(org)).toHaveLength(0);
  });

  it("conversation continuation: two WhatsApp messages from one sender fold into ONE conversation", async () => {
    vi.stubEnv(WHATSAPP_FLAG, "true");
    const org = await freshOrg();
    await enableWhatsApp(org);

    const r1 = await processInboundEnquiry({
      org_id: org, channel: "whatsapp_msg", caller: WA_CALLER, raw_text: "First", dedup_key: `${TOKEN}.6a`,
    });
    const r2 = await processInboundEnquiry({
      org_id: org, channel: "whatsapp_msg", caller: WA_CALLER, raw_text: "Second", dedup_key: `${TOKEN}.6b`,
    });

    expect(r1.conversation_id).not.toBeNull();
    expect(r2.conversation_id).toBe(r1.conversation_id);
  });

  it("operator inbox: a WhatsApp review audit surfaces with channel whatsapp_msg (Workstream D visibility)", async () => {
    // A substantive draft is held for review. The real AI generator (absent in CI) would produce it;
    // here we seed a review-verdict audit on channel=whatsapp_msg via the canonical audit path — a
    // price draft trips a commitment category → review — and prove it appears in the channel-agnostic
    // operator inbox. Proves WhatsApp reuses the existing review queue, no parallel inbox.
    const org = await freshOrg();
    const outcome = await enforceAndAuditReply({
      org_id: org,
      channel: "whatsapp_msg",
      correlation_id: crypto.randomUUID(),
      draft: "That job will cost £450 including parts — shall I book it in?",
    });
    expect(outcome.decision.verdict, "a price/commitment draft must be held for review").toBe("review");

    const queue = await listReviewQueue({ org_id: org });
    const mine = queue.filter((item) => item.org_id === org);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.channel).toBe("whatsapp_msg");
  });
});

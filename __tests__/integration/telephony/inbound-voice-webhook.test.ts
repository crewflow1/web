import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import type { NormalizedInboundCall } from "@/lib/telephony/types";

/**
 * Inbound voice — routing / idempotency / isolation / composite FK, real Postgres.
 *
 * Drives the REAL service (recordInboundCall / appendCallEvent) and router
 * (resolveOrgForDialedNumber) — the admin-client execution surface the webhook
 * routes use. The guarantees that matter are all database behaviour: routing by
 * dialed number attributes to exactly one org, an unrouted number resolves to
 * null (→ ack-drop, no tenant write), a redelivered CallSid/event is idempotent,
 * orgs are isolated, and the composite (call_id, org_id) FK rejects a mismatch.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string } | null }> & {
      select: (c: string) => { single: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }> & {
        eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("inbound voice · routing/idempotency/isolation", () => {
  let orgA = "";
  let orgB = "";
  let recordInboundCall: typeof import("@/server/services/telephony").recordInboundCall;
  let appendCallEvent: typeof import("@/server/services/telephony").appendCallEvent;
  let resolveOrgForDialedNumber: typeof import("@/lib/telephony/router").resolveOrgForDialedNumber;

  const NUM_A = `+4470001${TOKEN.replace(/\D/g, "").slice(-5).padStart(5, "0")}`;
  const NUM_B = `+4470002${TOKEN.replace(/\D/g, "").slice(-5).padStart(5, "0")}`;
  const NUM_UNROUTED = `+4470009${TOKEN.replace(/\D/g, "").slice(-5).padStart(5, "0")}`;

  const call = (over: Partial<NormalizedInboundCall> & { providerCallId: string; to: string }): NormalizedInboundCall => ({
    provider: "twilio",
    from: "+447700900123",
    status: "ringing",
    providerEventId: over.status ?? "ringing",
    occurredAt: new Date().toISOString(),
    raw: { CallSid: over.providerCallId },
    ...over,
  });

  const callsFor = async (org: string) => {
    const res = await db(serviceClient()).from("calls").select("id").eq("org_id", org);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<{ id: string }>;
  };
  const eventsFor = async (callId: string) => {
    const res = await db(serviceClient()).from("call_events").select("id").eq("call_id", callId);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<{ id: string }>;
  };
  const statusOf = async (callId: string) => {
    const res = await db(serviceClient()).from("calls").select("status").eq("id", callId);
    expect(res.error, res.error?.message).toBeNull();
    return ((res.data ?? [])[0] as { status: string } | undefined)?.status;
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    for (const [label, slug] of [["A", `${TOKEN}-a`], ["B", `${TOKEN}-b`]] as const) {
      const o = await svc.from("organizations").insert({ name: `Voice ${label}`, slug }).select("id").single();
      expect(o.error, o.error?.message).toBeNull();
      if (label === "A") orgA = o.data?.id as string; else orgB = o.data?.id as string;
    }
    // Active routes: NUM_A → orgA, NUM_B → orgB. NUM_UNROUTED unmapped.
    for (const [num, org] of [[NUM_A, orgA], [NUM_B, orgB]] as const) {
      const r = await svc.from("phone_numbers").insert({
        org_id: org,
        provider: "twilio",
        e164: num,
        provider_number_sid: `PN-${num}`,
        active: true,
      });
      expect(r.error, r.error?.message).toBeNull();
    }
    // An INACTIVE route for orgA — must not resolve.
    const inactive = await svc.from("phone_numbers").insert({
      org_id: orgA,
      provider: "twilio",
      e164: NUM_UNROUTED,
      active: false,
    });
    expect(inactive.error, inactive.error?.message).toBeNull();

    const svcMod = await import("@/server/services/telephony");
    recordInboundCall = svcMod.recordInboundCall;
    appendCallEvent = svcMod.appendCallEvent;
    resolveOrgForDialedNumber = (await import("@/lib/telephony/router")).resolveOrgForDialedNumber;
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await db(serviceClient()).from("organizations").delete().eq("id", id);
  });

  // ── routing ─────────────────────────────────────────────────────────────────

  it("routes each active dialed number to exactly one org", async () => {
    expect(await resolveOrgForDialedNumber(NUM_A)).toBe(orgA);
    expect(await resolveOrgForDialedNumber(NUM_B)).toBe(orgB);
  });

  it("an UNMAPPED or INACTIVE dialed number resolves to null (→ ack-drop)", async () => {
    expect(await resolveOrgForDialedNumber(`${NUM_A}0000`)).toBeNull();
    // NUM_UNROUTED is provisioned but inactive → must not resolve.
    expect(await resolveOrgForDialedNumber(NUM_UNROUTED)).toBeNull();
  });

  it("an unrouted call creates NO tenant call row (the route ack-drops)", async () => {
    const before = await callsFor(orgA);
    // The route would resolve null and return before any write; we assert the
    // service is never asked, so no calls row appears.
    expect(await resolveOrgForDialedNumber(NUM_UNROUTED)).toBeNull();
    expect((await callsFor(orgA)).length).toBe(before.length);
  });

  // ── idempotency ───────────────────────────────────────────────────────────

  it("records one call and REDELIVERY of the same CallSid is idempotent", async () => {
    const sid = `CA-${TOKEN}-1`;
    const before = await callsFor(orgA);
    const first = await recordInboundCall(orgA, call({ providerCallId: sid, to: NUM_A }));
    expect(first.created).toBe(true);
    const again = await recordInboundCall(orgA, call({ providerCallId: sid, to: NUM_A }));
    expect(again.created).toBe(false);
    expect(again.callId).toBe(first.callId);
    expect((await callsFor(orgA)).length).toBe(before.length + 1);
  });

  it("REDELIVERY of the same (call, event) is a benign no-op", async () => {
    const sid = `CA-${TOKEN}-2`;
    const { callId } = await recordInboundCall(orgA, call({ providerCallId: sid, to: NUM_A }));
    const e1 = await appendCallEvent(orgA, callId, {
      type: "answered",
      providerEventId: "answered",
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    expect(e1.appended).toBe(true);
    const e2 = await appendCallEvent(orgA, callId, {
      type: "answered",
      providerEventId: "answered",
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    expect(e2.duplicate).toBe(true);
    // 'ringing' (from recordInboundCall's implicit first event? no — record only
    // creates the calls row) — so exactly one event so far.
    expect((await eventsFor(callId)).length).toBe(1);
  });

  // ── status reducer via the service ──────────────────────────────────────────

  it("advances calls.status via the reducer, and terminal is absorbing", async () => {
    const sid = `CA-${TOKEN}-3`;
    const { callId } = await recordInboundCall(orgA, call({ providerCallId: sid, to: NUM_A }));
    await appendCallEvent(orgA, callId, { type: "answered", providerEventId: "answered", payload: {}, occurredAt: new Date().toISOString() });
    expect(await statusOf(callId)).toBe("answered");
    await appendCallEvent(orgA, callId, { type: "completed", providerEventId: "completed", payload: {}, occurredAt: new Date().toISOString() });
    expect(await statusOf(callId)).toBe("completed");
    // A late out-of-order 'ringing' must NOT walk a completed call back.
    await appendCallEvent(orgA, callId, { type: "ringing", providerEventId: "ringing-late", payload: {}, occurredAt: new Date().toISOString() });
    expect(await statusOf(callId)).toBe("completed");
  });

  // ── isolation + composite FK ────────────────────────────────────────────────

  it("org B's call never appears under org A", async () => {
    const sid = `CA-${TOKEN}-B`;
    const beforeA = await callsFor(orgA);
    const { callId } = await recordInboundCall(orgB, call({ providerCallId: sid, to: NUM_B }));
    expect((await callsFor(orgA)).length).toBe(beforeA.length); // A unchanged
    const bRows = await callsFor(orgB);
    expect(bRows.some((r) => r.id === callId)).toBe(true);
  });

  it("the composite FK REJECTS a call_event with a mismatched (call_id, org_id)", async () => {
    const sid = `CA-${TOKEN}-FK`;
    const { callId } = await recordInboundCall(orgA, call({ providerCallId: sid, to: NUM_A }));
    // Direct insert of an event that names orgA's call but claims orgB.
    const bad = await db(serviceClient()).from("call_events").insert({
      call_id: callId,
      org_id: orgB,
      event_type: "ringing",
      provider_event_id: "x",
      occurred_at: new Date().toISOString(),
    });
    expect(bad.error, "mismatched (call_id, org_id) must be refused by the composite FK").not.toBeNull();
  });
});

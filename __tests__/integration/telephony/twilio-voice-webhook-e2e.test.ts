import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  buildSignedTwilioRequest,
  TEST_TWILIO_ACCOUNT_SID,
  TEST_TWILIO_AUTH_TOKEN,
} from "./_twilio-sign";

/**
 * Telephone receptionist — SANDBOX VERIFIED over the REAL Twilio voice route POST.
 *
 * WHAT THIS PROVES (and what the existing suites do NOT): the route POST handlers
 * were only ever exercised HERMETICALLY (vi.mock of the router + services) under
 * `__tests__/telephony/`. This test imports the ACTUAL `POST` from
 * `app/api/webhooks/twilio/voice/route.ts`, sends a REAL-signature-verified
 * request through the whole edge (maintenance → rate-limit → DARK GATE →
 * raw body → FAIL-CLOSED signature verify → org from `phone_numbers` → persist
 * `calls`/`call_events` → delegate `processInboundEnquiry`), and asserts the
 * real Postgres effects.
 *
 * SANDBOX, NOT LIVE: the signature is computed locally with a TEST auth token and
 * verified by the SAME `twilio.validateRequest` the route uses — no Twilio network
 * call, no real PSTN number. The AI spoken-turn seam is dark (no `mid` tier), so
 * the greeting is the deterministic TwiML — never a fabricated reply. A genuine
 * inbound call from Twilio remains LIVE-only.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => PromiseLike<Res<null>> & {
      select: (c: string) => { single: () => PromiseLike<Res<Record<string, unknown>>> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>> & {
        eq: (k: string, v: unknown) => PromiseLike<Res<Record<string, unknown>[]>>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => PromiseLike<Res<null>> };
  };
};
const db = (): Db => serviceClient() as unknown as Db;

const TOKEN = `it-tw-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const VOICE_PATH = "/api/webhooks/twilio/voice";

/** Arm the voice channel live (flag + a resolvable Twilio provider credential). */
function armVoice(): void {
  vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
  vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
  vi.stubEnv("TWILIO_ACCOUNT_SID", TEST_TWILIO_ACCOUNT_SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TEST_TWILIO_AUTH_TOKEN);
}

async function callsFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("calls").select("id, provider_call_id, status").eq("org_id", org);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}
async function enquiriesFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db()
    .from("inbound_enquiries")
    .select("id, provider_message_id")
    .eq("org_id", org)
    .eq("channel", "phone");
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

describeIntegration("telephone receptionist · SANDBOX VERIFIED real Twilio voice route", () => {
  let orgA = "";
  let POST: (req: Request) => Promise<Response>;

  const NUM_A = `+1500${Math.floor(Math.random() * 9000000 + 1000000)}`; // dialed (To)
  const NUM_UNROUTED = `+1500${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const CALLER = "+447700900555";

  beforeAll(async () => {
    const svc = db();
    const o = await svc.from("organizations").insert({ name: "Voice E2E", slug: `${TOKEN}-a` }).select("id").single();
    expect(o.error, o.error?.message).toBeNull();
    orgA = String((o.data as { id: string }).id);

    const r = await svc.from("phone_numbers").insert({
      org_id: orgA,
      provider: "twilio",
      e164: NUM_A,
      provider_number_sid: `PN-${TOKEN}`,
      active: true,
    });
    expect(r.error, r.error?.message).toBeNull();

    POST = (await import("@/app/api/webhooks/twilio/voice/route")).POST as typeof POST;
  });

  beforeEach(() => armVoice());
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (orgA) await db().from("organizations").delete().eq("id", orgA);
  });

  it("DARK GATE: with the voice flag OFF, the route 503s before any work", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "false");
    const req = await buildSignedTwilioRequest({
      path: VOICE_PATH,
      params: { CallSid: `CA_${TOKEN}_dark`, From: CALLER, To: NUM_A, CallStatus: "ringing" },
    });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it("BAD SIGNATURE: a mis-signed request is rejected 401 (fail-closed, no tenant write)", async () => {
    const callSid = `CA_${TOKEN}_badsig`;
    const req = await buildSignedTwilioRequest({
      path: VOICE_PATH,
      params: { CallSid: callSid, From: CALLER, To: NUM_A, CallStatus: "ringing" },
      tamper: true,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    // Nothing persisted for a forged request.
    const calls = (await callsFor(orgA)).filter((c) => c.provider_call_id === callSid);
    expect(calls).toHaveLength(0);
  });

  it("VALID signed origination → calls row + phone enquiry for the org, TwiML 200", async () => {
    const callSid = `CA_${TOKEN}_ok`;
    const req = await buildSignedTwilioRequest({
      path: VOICE_PATH,
      params: { CallSid: callSid, From: CALLER, To: NUM_A, CallStatus: "ringing" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/xml");

    const calls = (await callsFor(orgA)).filter((c) => c.provider_call_id === callSid);
    expect(calls, "exactly one calls row, attributed to the org via phone_numbers").toHaveLength(1);

    const enq = (await enquiriesFor(orgA)).filter((e) => e.provider_message_id === callSid);
    expect(enq, "origination delegated to the unchanged ingestion core").toHaveLength(1);
  });

  it("UNROUTED dialed number is ack-dropped — 200 TwiML, NO calls row", async () => {
    const callSid = `CA_${TOKEN}_unrouted`;
    const req = await buildSignedTwilioRequest({
      path: VOICE_PATH,
      params: { CallSid: callSid, From: CALLER, To: NUM_UNROUTED, CallStatus: "ringing" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const calls = (await callsFor(orgA)).filter((c) => c.provider_call_id === callSid);
    expect(calls, "an unattributable call must not touch tenant data").toHaveLength(0);
  });

  it("REDELIVERED signed origination is idempotent on the CallSid (one calls row, one enquiry)", async () => {
    const callSid = `CA_${TOKEN}_dup`;
    const mk = () =>
      buildSignedTwilioRequest({
        path: VOICE_PATH,
        params: { CallSid: callSid, From: CALLER, To: NUM_A, CallStatus: "ringing" },
      });
    expect((await POST(await mk())).status).toBe(200);
    expect((await POST(await mk())).status).toBe(200);

    const calls = (await callsFor(orgA)).filter((c) => c.provider_call_id === callSid);
    expect(calls, "recordInboundCall is idempotent on (provider, provider_call_id)").toHaveLength(1);
    const enq = (await enquiriesFor(orgA)).filter((e) => e.provider_message_id === callSid);
    expect(enq, "ingestion dedups on (org_id, provider_message_id)").toHaveLength(1);
  });
});

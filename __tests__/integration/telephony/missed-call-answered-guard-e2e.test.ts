import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  buildSignedTwilioRequest,
  TEST_TWILIO_ACCOUNT_SID,
  TEST_TWILIO_AUTH_TOKEN,
} from "./_twilio-sign";

/**
 * Missed-call text-back — SANDBOX VERIFIED answered-guard over the REAL status route.
 *
 * WHAT THIS PROVES (and what the existing suites do NOT): the answered-guard
 * ("a mid-call failure is a dropped conversation, NOT a missed call") is tested
 * today only at the HERMETIC route level, where `appendCallEvent` is mocked to
 * hand back a canned `priorStatus`. This test drives the ACTUAL
 * `POST /api/webhooks/twilio/voice/status` with real-signature-verified requests,
 * so a REAL `calls.status`/`call_events` sequence produces the REAL `priorStatus`,
 * and asserts on real Postgres that:
 *   - unanswered terminal (ringing → no-answer)  → missed-call textback RUNS
 *     (an enquiry is ingested on the CallSid; the dark SMS provider records an
 *     honest no-send);
 *   - answered terminal   (in-progress → failed)  → textback is SUPPRESSED
 *     (no enquiry is ingested for that call at all);
 *   - a redelivered terminal is idempotent (one enquiry, never a double text).
 *
 * SANDBOX, NOT LIVE: locally-signed requests verified by the same
 * `twilio.validateRequest`; no Twilio/PSTN contact. With `NEXT_PUBLIC_FEATURE_
 * MISSED_CALL_TEXTBACK` armed but NO SMS provider credential, the reply reaches
 * the transport seam and records `failed/no_provider` — it NEVER sends. A real
 * text-back SMS to a real caller remains LIVE-only.
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

const TOKEN = `it-mctb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const STATUS_PATH = "/api/webhooks/twilio/voice/status";

function armVoiceAndTextback(): void {
  vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
  vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
  vi.stubEnv("TWILIO_ACCOUNT_SID", TEST_TWILIO_ACCOUNT_SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TEST_TWILIO_AUTH_TOKEN);
  vi.stubEnv("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK", "true");
  // Deliberately NO Twilio/SMS SEND credential beyond verification → outbound dark.
}

async function enquiriesForCall(org: string, callSid: string): Promise<Record<string, unknown>[]> {
  const res = await db()
    .from("inbound_enquiries")
    .select("id, provider_message_id")
    .eq("org_id", org)
    .eq("channel", "phone");
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).filter((e) => e.provider_message_id === callSid);
}
async function transportsFor(org: string): Promise<Record<string, unknown>[]> {
  const res = await db().from("ai_reply_transports").select("id, status, failure_reason").eq("org_id", org);
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

async function postStatus(
  POST: (r: Request) => Promise<Response>,
  callSid: string,
  callStatus: string,
  to: string,
  caller: string,
): Promise<Response> {
  const req = await buildSignedTwilioRequest({
    path: STATUS_PATH,
    params: { CallSid: callSid, From: caller, To: to, CallStatus: callStatus },
  });
  return POST(req);
}

describeIntegration("missed-call text-back · SANDBOX VERIFIED answered-guard (real status route)", () => {
  let orgA = "";
  let POST: (req: Request) => Promise<Response>;
  const NUM_A = `+1500${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const CALLER = "+447700900777";

  beforeAll(async () => {
    const svc = db();
    const o = await svc.from("organizations").insert({ name: "MCTB E2E", slug: `${TOKEN}-a` }).select("id").single();
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

    POST = (await import("@/app/api/webhooks/twilio/voice/status/route")).POST as typeof POST;
  });

  beforeEach(() => armVoiceAndTextback());
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (orgA) await db().from("organizations").delete().eq("id", orgA);
  });

  it("UNANSWERED (ringing → no-answer): the missed-call textback runs — enquiry ingested, outbound dark (no send)", async () => {
    const callSid = `CA_${TOKEN}_missed`;
    expect((await postStatus(POST, callSid, "ringing", NUM_A, CALLER)).status).toBe(200);
    const term = await postStatus(POST, callSid, "no-answer", NUM_A, CALLER);
    expect(term.status).toBe(200);

    // The missed-call engine re-entered the ingestion idempotently on the CallSid.
    expect(await enquiriesForCall(orgA, callSid), "a missed call ingests exactly one enquiry").toHaveLength(1);

    // Dark outbound: the reply reached the transport seam and recorded an honest
    // no-send (nothing was dispatched to a real caller).
    const noSend = (await transportsFor(orgA)).filter((t) => t.failure_reason === "no_provider");
    expect(noSend.length, "a dark SMS provider records failed/no_provider, never a send").toBeGreaterThanOrEqual(1);
  });

  it("ANSWERED (in-progress → failed): the answered-guard SUPPRESSES the textback — no enquiry ingested", async () => {
    const callSid = `CA_${TOKEN}_answered`;
    // The call was answered (in-progress) before the terminal failure → a dropped
    // conversation, not a missed call.
    expect((await postStatus(POST, callSid, "in-progress", NUM_A, CALLER)).status).toBe(200);
    expect((await postStatus(POST, callSid, "failed", NUM_A, CALLER)).status).toBe(200);

    expect(
      await enquiriesForCall(orgA, callSid),
      "a caller we were already speaking to is NEVER texted back",
    ).toHaveLength(0);
  });

  it("REDELIVERED terminal is idempotent — a missed call never ingests (or texts) twice", async () => {
    const callSid = `CA_${TOKEN}_redeliver`;
    expect((await postStatus(POST, callSid, "ringing", NUM_A, CALLER)).status).toBe(200);
    expect((await postStatus(POST, callSid, "no-answer", NUM_A, CALLER)).status).toBe(200);
    // Twilio re-delivers the same terminal callback; the (call_id, provider_event_id)
    // unique makes the second a duplicate → the trigger is skipped.
    const dup = await postStatus(POST, callSid, "no-answer", NUM_A, CALLER);
    expect(dup.status).toBe(200);
    const body = (await dup.json()) as { duplicate?: boolean };
    expect(body.duplicate, "the redelivered terminal event is a duplicate").toBe(true);

    expect(await enquiriesForCall(orgA, callSid), "still exactly one enquiry").toHaveLength(1);
  });
});

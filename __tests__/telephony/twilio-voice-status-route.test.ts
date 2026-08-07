import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Twilio inbound-VOICE STATUS callback route — the CALL-COMPLETION enrichment
 * branch (the Twilio half of the C35c completion path; Vapi's was built, Twilio's
 * was missed, so duration_sec / ended_at were silently discarded for every
 * completed Twilio call — the DEFAULT live voice provider).
 *
 * These tests pin, hermetically (no real provider, no Supabase — the Twilio
 * signature verification runs FOR REAL via the twilio SDK validateRequest, so the
 * auth gate is proven rather than stubbed; only the org router and the telephony
 * service are mocked):
 *   - a signed `completed` callback WITH CallDuration enriches the calls row with
 *     durationSec + endedAt, org-pinned + keyed on the CallSid;
 *   - recording_url is passed through only when Twilio supplied a RecordingUrl
 *     (legitimately absent without a <Record>);
 *   - a NON-terminal transition (ringing) NEVER enriches;
 *   - every terminal status (busy / failed / no-answer / canceled) enriches;
 *   - a persistence error degrades to 200 (never a 500 that retry-storms Twilio),
 *     and the event append still succeeds;
 *   - the DARK gate 503s before any work, and a bad signature 401s fail-closed,
 *     before any enrichment write.
 *
 * Mirrors the exact posture of twilio-voice-gather-route.test.ts.
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
// Mock the whole service so the enrichment write is assertable and no branch can
// fall through to Supabase.
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  appendCallEvent: vi.fn(),
  updateCallCompletion: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/twilio/voice/status/route");
}
async function routerMock() {
  return vi.mocked((await import("@/lib/telephony/router")).resolveOrgForDialedNumber);
}
async function recordMock() {
  return vi.mocked((await import("@/server/services/telephony")).recordInboundCall);
}
async function appendMock() {
  return vi.mocked((await import("@/server/services/telephony")).appendCallEvent);
}
async function updateMock() {
  return vi.mocked((await import("@/server/services/telephony")).updateCallCompletion);
}

const TOKEN = "voice_status_auth_token_abc123";
const PUBLIC_HOST = "app.crewflow.uk";
const CALLBACK_URL = `https://${PUBLIC_HOST}/api/webhooks/twilio/voice/status`;

/** Twilio's signature algorithm: HMAC-SHA1(base64) over url + sorted k+v. */
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function buildRequest(opts: { params: Record<string, string>; signature: string | null }): Request {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    // Force the route's URL reconstruction to the signed public host (prod path).
    "x-forwarded-proto": "https",
    "x-forwarded-host": PUBLIC_HOST,
  });
  if (opts.signature !== null) headers.set("x-twilio-signature", opts.signature);
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/status", {
    method: "POST",
    headers,
    body: new URLSearchParams(opts.params).toString(),
  });
}

function signedRequest(params: Record<string, string>): Request {
  return buildRequest({ params, signature: twilioSignature(TOKEN, CALLBACK_URL, params) });
}

const COMPLETED = {
  CallSid: "CA-status-1",
  From: "+447700900123",
  To: "+441234567890",
  CallStatus: "completed",
  CallDuration: "42",
};

describe("POST /api/webhooks/twilio/voice/status — completion enrichment", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    (await recordMock()).mockResolvedValue({ callId: "call-1", created: true });
    (await appendMock()).mockResolvedValue({ duplicate: false, status: "completed" } as never);
    (await updateMock()).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await recordMock()).mockReset();
    (await appendMock()).mockReset();
    (await updateMock()).mockReset();
  });

  it("enriches duration_sec + ended_at on a signed `completed` callback, org-pinned by CallSid", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(COMPLETED) as never);

    expect(res.status).toBe(200);
    // The event append still advances status (unchanged behaviour).
    expect(await appendMock()).toHaveBeenCalledWith(
      "org-1",
      "call-1",
      expect.objectContaining({ type: "completed" }),
    );
    // Enrichment: org-pinned, keyed on the CallSid, with duration + ended-at;
    // recording_url is undefined (no <Record> ⇒ never written / nulled).
    const call = (await updateMock()).mock.calls[0]!;
    expect(call[0]).toBe("org-1");
    expect(call[1]).toBe("CA-status-1");
    expect(call[2]).toMatchObject({ durationSec: 42, recordingUrl: undefined });
    expect(typeof (call[2] as { endedAt?: unknown }).endedAt).toBe("string");
  });

  it("passes recording_url through when Twilio supplied a RecordingUrl", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    await POST(
      signedRequest({ ...COMPLETED, RecordingUrl: "https://api.twilio.com/rec/RE1.mp3" }) as never,
    );
    expect((await updateMock()).mock.calls[0]![2]).toMatchObject({
      durationSec: 42,
      recordingUrl: "https://api.twilio.com/rec/RE1.mp3",
    });
  });

  it("does NOT enrich on a non-terminal transition (ringing)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(
      signedRequest({ CallSid: "CA-r", From: "+447", To: "+441234567890", CallStatus: "ringing" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await appendMock()).toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("enriches on EVERY terminal status (busy / failed / no-answer / canceled)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    for (const status of ["busy", "failed", "no-answer", "canceled"]) {
      (await updateMock()).mockClear();
      await POST(
        signedRequest({ CallSid: `CA-${status}`, To: "+441234567890", CallStatus: status }) as never,
      );
      expect(await updateMock(), `terminal status ${status} must enrich`).toHaveBeenCalledTimes(1);
    }
  });

  it("degrades gracefully (200) when the enrichment write throws — never a 500", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await updateMock()).mockRejectedValue(new Error("db unavailable"));
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(COMPLETED) as never);
    expect(res.status).toBe(200);
    // The event append (the primary lifecycle write) still succeeded.
    expect(await appendMock()).toHaveBeenCalled();
  });

  it("rejects a MISSING signature 401 FAIL-CLOSED before any enrichment write", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(buildRequest({ params: COMPLETED, signature: null }) as never);
    expect(res.status).toBe(401);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("rejects a signature minted with the WRONG token 401 — no enrichment write", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      buildRequest({
        params: COMPLETED,
        signature: twilioSignature("attacker_token", CALLBACK_URL, COMPLETED),
      }) as never,
    );
    expect(res.status).toBe(401);
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when DARK — no enrichment write", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(COMPLETED) as never);
    expect(res.status).toBe(503);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("ack-drops an unrouted number with no tenant write", async () => {
    (await routerMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(COMPLETED) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unrouted: true });
    expect(await recordMock()).not.toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Twilio inbound-VOICE recording-status callback (Twilio receptionist PR 6).
 * Hermetic (real signature verification; router + persistence mocked). Pins:
 * fail-closed on a bad signature, dark 503, org resolved from the CallSid (the
 * callback carries no dialed number), recording URL persisted org-pinned, and an
 * unattributable CallSid acked with no write.
 */

vi.mock("@/lib/telephony/router", () => ({ resolveOrgForProviderCall: vi.fn() }));
vi.mock("@/server/services/telephony", () => ({ updateCallCompletion: vi.fn() }));

async function loadRoute() {
  return import("@/app/api/webhooks/twilio/voice/recording-status/route");
}
async function routerMock() {
  return vi.mocked((await import("@/lib/telephony/router")).resolveOrgForProviderCall);
}
async function updateMock() {
  return vi.mocked((await import("@/server/services/telephony")).updateCallCompletion);
}

const TOKEN = "rec_status_token_123";
const HOST = "app.crewflow.uk";
const URL_ = `https://${HOST}/api/webhooks/twilio/voice/recording-status`;

function sig(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}
function req(params: Record<string, string>, signature: string | null): Request {
  const h = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-proto": "https",
    "x-forwarded-host": HOST,
  });
  if (signature !== null) h.set("x-twilio-signature", signature);
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/recording-status", {
    method: "POST",
    headers: h,
    body: new URLSearchParams(params).toString(),
  });
}
const PARAMS = {
  CallSid: "CA-rec-1",
  RecordingSid: "RE-1",
  RecordingUrl: "https://api.twilio.com/.../RE-1",
  RecordingStatus: "completed",
};
const signed = (p = PARAMS) => req(p, sig(TOKEN, URL_, p));

describe("POST /api/webhooks/twilio/voice/recording-status", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    (await updateMock()).mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("persists the recording URL org-pinned, resolving the org from the CallSid", async () => {
    (await routerMock()).mockResolvedValue("org-5");
    const { POST } = await loadRoute();
    const res = await POST(signed() as never);
    expect(res.status).toBe(200);
    expect(await routerMock()).toHaveBeenCalledWith("twilio", "CA-rec-1");
    expect(await updateMock()).toHaveBeenCalledWith("org-5", "CA-rec-1", {
      recordingUrl: "https://api.twilio.com/.../RE-1",
    });
  });

  it("rejects a bad signature 401 before any work", async () => {
    (await routerMock()).mockResolvedValue("org-5");
    const { POST } = await loadRoute();
    const res = await POST(req(PARAMS, sig("attacker", URL_, PARAMS)) as never);
    expect(res.status).toBe(401);
    expect(await routerMock()).not.toHaveBeenCalled();
  });

  it("503s when the feature is dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    expect((await POST(signed() as never)).status).toBe(503);
  });

  it("acks an unattributable CallSid with no write", async () => {
    (await routerMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signed() as never);
    expect(res.status).toBe(200);
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("acks (no write) when RecordingUrl is absent", async () => {
    (await routerMock()).mockResolvedValue("org-5");
    const { POST } = await loadRoute();
    const p = { CallSid: "CA-rec-1", RecordingStatus: "completed" };
    const res = await POST(req(p, sig(TOKEN, URL_, p)) as never);
    expect(res.status).toBe(200);
    expect(await updateMock()).not.toHaveBeenCalled();
  });
});

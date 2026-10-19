import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * G-6 — the INTERNAL missed-call trigger on the Twilio voice STATUS callback.
 *
 * THE DEFECT (pre-fix): the missed-call text-back engine existed
 * (processInboundEnquiry → maybeTextBackMissedCall → the canonical dispatch) but
 * NOTHING internal detected a missed call. The origination edge delegated at call
 * START — where the call is live and "missed" is unknowable — so with the flag on
 * it would have texted "sorry we missed you" to a caller the AI loop was actively
 * answering, and a call that genuinely ended unanswered triggered nothing.
 *
 * THE FIX, pinned here hermetically (real Twilio signature verification via the
 * SDK; the org router, telephony service and receptionist service mocked):
 *   - an UNANSWERED terminal status (no-answer / busy / failed) invokes
 *     processMissedCallTextback IN-PROCESS, exactly once, with the org, the
 *     CallSid and the caller;
 *   - an ANSWERED terminal (completed), a caller-abandoned terminal (canceled)
 *     and a non-terminal transition (ringing) NEVER invoke it;
 *   - a REDELIVERED terminal callback (duplicate event append) is skipped — no
 *     double-texting on status-callback retries;
 *   - the DARK gate (voice flag off) 503s before the trigger is reachable;
 *   - a trigger failure degrades to 200 (never a 500 that retry-storms Twilio);
 *   - when the trigger's ingestion created the lead (terminal arrived first),
 *     the calls row is linked to it (the reachability contract).
 *
 * Mirrors the exact posture of twilio-voice-status-route.test.ts.
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
vi.mock("@/server/services/telephony", async (importActual) => {
  const actual = await importActual<typeof import("@/server/services/telephony")>();
  return {
    ...actual,
    recordInboundCall: vi.fn(),
    appendCallEvent: vi.fn(),
    updateCallCompletion: vi.fn(),
    updateCallAssociation: vi.fn(),
    loadAllSpokenTurns: vi.fn(),
    loadRecentSpokenTurns: vi.fn(),
    loadEnquirySummary: vi.fn(),
  };
});
vi.mock("@/server/services/receptionist", () => ({
  refreshVoiceExtractionFromTranscript: vi.fn(),
  processMissedCallTextback: vi.fn(),
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
async function associationMock() {
  return vi.mocked((await import("@/server/services/telephony")).updateCallAssociation);
}
async function turnsMock() {
  return vi.mocked((await import("@/server/services/telephony")).loadAllSpokenTurns);
}
async function summaryMock() {
  return vi.mocked((await import("@/server/services/telephony")).loadEnquirySummary);
}
async function reextractMock() {
  return vi.mocked(
    (await import("@/server/services/receptionist")).refreshVoiceExtractionFromTranscript,
  );
}
async function missedCallMock() {
  return vi.mocked(
    (await import("@/server/services/receptionist")).processMissedCallTextback,
  );
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

function signedRequest(params: Record<string, string>): Request {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-proto": "https",
    "x-forwarded-host": PUBLIC_HOST,
    "x-twilio-signature": twilioSignature(TOKEN, CALLBACK_URL, params),
  });
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/status", {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

const MISSED = {
  CallSid: "CA-missed-1",
  From: "+447700900123",
  To: "+441234567890",
  CallStatus: "no-answer",
};

describe("POST /api/webhooks/twilio/voice/status — missed-call trigger (G-6)", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    (await routerMock()).mockResolvedValue("org-1");
    (await recordMock()).mockResolvedValue({ callId: "call-1", created: true });
    (await appendMock()).mockResolvedValue({
      appended: true,
      duplicate: false,
      status: "no_answer",
    } as never);
    (await turnsMock()).mockResolvedValue([]);
    (await summaryMock()).mockResolvedValue(null);
    (await reextractMock()).mockResolvedValue({ refreshed: false } as never);
    (await missedCallMock()).mockResolvedValue({
      enquiry_id: "enq-1",
      lead_id: null,
      conversation_id: null,
      // The engine's own gates decide the outcome — dark flag here, which the
      // route must treat as a completed (non-throwing) trigger.
      textback: { attempted: false, reason: "flag_off" },
    } as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await recordMock()).mockReset();
    (await appendMock()).mockReset();
    (await associationMock()).mockReset();
    (await turnsMock()).mockReset();
    (await summaryMock()).mockReset();
    (await reextractMock()).mockReset();
    (await missedCallMock()).mockReset();
  });

  it("invokes the trigger EXACTLY ONCE on a signed no-answer terminal, in-process, with org + CallSid + caller", async () => {
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(MISSED) as never);
    expect(res.status).toBe(200);
    expect(await missedCallMock()).toHaveBeenCalledTimes(1);
    expect(await missedCallMock()).toHaveBeenCalledWith({
      org_id: "org-1",
      provider_call_id: "CA-missed-1",
      caller: "+447700900123",
    });
  });

  it("fires on EVERY unanswered terminal (busy / failed), never on completed / canceled / ringing", async () => {
    const { POST } = await loadRoute();
    for (const status of ["busy", "failed"]) {
      (await missedCallMock()).mockClear();
      await POST(signedRequest({ ...MISSED, CallSid: `CA-${status}`, CallStatus: status }) as never);
      expect(
        await missedCallMock(),
        `unanswered terminal ${status} must trigger the text-back`,
      ).toHaveBeenCalledTimes(1);
    }
    for (const status of ["completed", "canceled", "ringing"]) {
      (await missedCallMock()).mockClear();
      await POST(signedRequest({ ...MISSED, CallSid: `CA-${status}`, CallStatus: status }) as never);
      expect(
        await missedCallMock(),
        `${status} is not a missed call — the trigger must stay silent`,
      ).not.toHaveBeenCalled();
    }
  });

  it("SKIPS the trigger on a redelivered terminal (duplicate event append) — no double-texting", async () => {
    (await appendMock()).mockResolvedValue({
      appended: false,
      duplicate: true,
      status: null,
    } as never);
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(MISSED) as never);
    expect(res.status).toBe(200);
    expect(await missedCallMock()).not.toHaveBeenCalled();
  });

  it("503s before the trigger is reachable when voice is DARK", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(MISSED) as never);
    expect(res.status).toBe(503);
    expect(await missedCallMock()).not.toHaveBeenCalled();
  });

  it("never fires for an unrouted dialed number (ack-drop, no tenant write)", async () => {
    (await routerMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(MISSED) as never);
    expect(res.status).toBe(200);
    expect(await missedCallMock()).not.toHaveBeenCalled();
  });

  it("degrades a trigger failure to 200 — never a 500 that retry-storms Twilio", async () => {
    (await missedCallMock()).mockRejectedValue(new Error("db unavailable"));
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(MISSED) as never);
    expect(res.status).toBe(200);
    // The lifecycle write (the event append) still succeeded.
    expect(await appendMock()).toHaveBeenCalled();
  });

  it("links the calls row to the lead when the trigger's ingestion created it (terminal-first ordering)", async () => {
    (await missedCallMock()).mockResolvedValue({
      enquiry_id: "enq-1",
      lead_id: "lead-1",
      conversation_id: "conv-1",
      textback: { attempted: false, reason: "flag_off" },
    } as never);
    const { POST } = await loadRoute();
    await POST(signedRequest(MISSED) as never);
    expect(await associationMock()).toHaveBeenCalledWith("org-1", "CA-missed-1", {
      leadId: "lead-1",
      conversationId: "conv-1",
    });
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Vapi inbound-VOICE route — the conversational branches (Wave 8, C28).
 *
 * Hermetic (no real provider, no Supabase): the HMAC verification runs FOR REAL
 * (stdlib crypto, VAPI_WEBHOOK_SECRET), only the org router and the governed turn
 * seam are mocked. Pins that an `assistant-request` is answered with the
 * receptionist assistant config, a `tool-calls` message routes the caller's
 * utterance through the SAME governed seam as Twilio, an invalid signature is
 * rejected 401 fail-closed, and the whole door 503s while dark.
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
vi.mock("@/lib/telephony/ai-turn", () => ({
  maybeGenerateVoiceTurn: vi.fn(),
}));
// The lifecycle path touches the DB service; mock so an accidental fall-through
// never reaches Supabase (these tests only exercise the conversational branches).
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  appendCallEvent: vi.fn(),
}));
vi.mock("@/server/services/receptionist", () => ({
  processInboundEnquiry: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/vapi/route");
}
async function routerMock() {
  return vi.mocked((await import("@/lib/telephony/router")).resolveOrgForDialedNumber);
}
async function turnMock() {
  return vi.mocked((await import("@/lib/telephony/ai-turn")).maybeGenerateVoiceTurn);
}

const SECRET = "whsec_vapi_test";

function signed(bodyObj: unknown): Request {
  const rawBody = JSON.stringify(bodyObj);
  const sig = crypto.createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex");
  return new Request("https://app.crewflow.uk/api/webhooks/vapi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-signature": sig },
    body: rawBody,
  });
}

const CALL = {
  phoneNumber: { number: "+441234567890" },
  customer: { number: "+447700900123" },
};

describe("POST /api/webhooks/vapi — conversational branches", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "vapi");
    vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await turnMock()).mockReset();
  });

  it("answers an assistant-request with the receptionist assistant config", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(signed({ message: { type: "assistant-request", call: CALL } }) as never);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { assistant?: { model?: unknown; voice?: unknown; firstMessage?: string } };
    expect(json.assistant).toBeTruthy();
    expect(json.assistant?.model).toBeTruthy();
    expect(json.assistant?.voice).toBeTruthy();
    expect(typeof json.assistant?.firstMessage).toBe("string");
  });

  it("routes a tool-calls utterance through the governed turn seam", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("Sorry to hear that — is it dripping or fully leaking?");

    const { POST } = await loadRoute();
    const res = await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "my boiler is leaking",
          call: CALL,
          toolCalls: [{ id: "tc1", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
    expect(json.results).toEqual([
      { toolCallId: "tc1", result: "Sorry to hear that — is it dripping or fully leaking?" },
    ]);
    expect(await turnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", transcript: "my boiler is leaking" }),
    );
  });

  it("degrades a tool-call to a fixed ack when the turn is null (dark)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue(null);

    const { POST } = await loadRoute();
    const res = await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "hello",
          call: CALL,
          toolCalls: [{ id: "tc9", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );
    const json = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
    expect(json.results[0]?.toolCallId).toBe("tc9");
    expect(json.results[0]?.result).toMatch(/team will follow up/i);
  });

  it("rejects an invalid signature 401 fail-closed", async () => {
    const rawBody = JSON.stringify({ message: { type: "assistant-request", call: CALL } });
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-signature": "deadbeef" },
      body: rawBody,
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await turnMock()).not.toHaveBeenCalled();
    expect(await routerMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signed({ message: { type: "assistant-request", call: CALL } }) as never);

    expect(res.status).toBe(503);
    expect(await turnMock()).not.toHaveBeenCalled();
  });
});

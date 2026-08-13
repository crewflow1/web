import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Vapi inbound-VOICE route — the conversational branches (Wave 8, C28 / C35).
 *
 * Hermetic (no real provider, no Supabase): verification runs FOR REAL against
 * the PRIMARY scheme Vapi actually sends — the `X-Vapi-Secret` shared secret
 * checked constant-time against VAPI_WEBHOOK_SECRET — only the org router, the
 * governed turn seam and the per-org profile loader are mocked. Pins that an
 * `assistant-request` is answered with the PER-ORG receptionist assistant config
 * (business name + greeting + mapped voice), a `tool-calls` message routes the
 * caller's utterance through the SAME governed seam as Twilio (with the org's
 * business context), a wrong/missing secret is rejected 401 fail-closed, and the
 * whole door 503s while dark.
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
vi.mock("@/lib/telephony/ai-turn", () => ({
  maybeGenerateVoiceTurn: vi.fn(),
}));
// Keep the pure builders (greeting / voice map / context) real; mock only the
// admin-client read so the route is hermetic and per-org config is assertable.
vi.mock("@/lib/telephony/receptionist-profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telephony/receptionist-profile")>()),
  loadReceptionistProfile: vi.fn(),
}));
// The lifecycle + spoken-turn persistence paths touch the DB service; mock so an
// accidental fall-through never reaches Supabase, and so the tool-call persistence
// (recordInboundCall / loadRecentSpokenTurns / persistSpokenTurn) can be asserted.
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  appendCallEvent: vi.fn(),
  loadRecentSpokenTurns: vi.fn(),
  persistSpokenTurn: vi.fn(),
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
async function recordMock() {
  return vi.mocked((await import("@/server/services/telephony")).recordInboundCall);
}
async function loadTurnsMock() {
  return vi.mocked((await import("@/server/services/telephony")).loadRecentSpokenTurns);
}
async function persistMock() {
  return vi.mocked((await import("@/server/services/telephony")).persistSpokenTurn);
}
async function profileMock() {
  return vi.mocked((await import("@/lib/telephony/receptionist-profile")).loadReceptionistProfile);
}

const SECRET = "whsec_vapi_test";

/** A request carrying the PRIMARY Vapi credential — the X-Vapi-Secret shared secret. */
function signed(bodyObj: unknown): Request {
  const rawBody = JSON.stringify(bodyObj);
  return new Request("https://app.crewflow.uk/api/webhooks/vapi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": SECRET },
    body: rawBody,
  });
}

const CALL = {
  phoneNumber: { number: "+441234567890" },
  customer: { number: "+447700900123" },
};

describe("POST /api/webhooks/vapi — conversational branches", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "vapi");
    vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
    (await recordMock()).mockResolvedValue({ callId: "call-1", created: true });
    (await loadTurnsMock()).mockResolvedValue([]);
    (await persistMock()).mockResolvedValue(undefined);
    // Default: no per-org setup ⇒ generic fallback (the safe default).
    (await profileMock()).mockResolvedValue(null);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await turnMock()).mockReset();
    (await recordMock()).mockReset();
    (await loadTurnsMock()).mockReset();
    (await persistMock()).mockReset();
    (await profileMock()).mockReset();
  });

  const CALL_WITH_ID = { id: "vapi-call-1", ...CALL };

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

  it("serves the PER-ORG business name, greeting and mapped voice in the assistant config", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await profileMock()).mockResolvedValue({
      businessName: "Ace Plumbing",
      preferredVoice: "female",
      businessHours: "Mon-Fri 8-6",
      tradeType: "Plumbing",
    });
    const { POST } = await loadRoute();
    const res = await POST(signed({ message: { type: "assistant-request", call: CALL } }) as never);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      assistant?: {
        firstMessage?: string;
        voice?: { voiceId?: string };
        model?: { messages?: Array<{ role?: string; content?: string }> };
      };
    };
    // The greeting names the business…
    expect(json.assistant?.firstMessage).toBe(
      "Thank you for calling Ace Plumbing. How can I help you today?",
    );
    // …preferred_voice "female" maps to a Vapi voiceId (not the generic default)…
    expect(json.assistant?.voice?.voiceId).toBe("Paige");
    // …and the business identity rides along as CONTEXT, framed as data.
    const systemMsg = json.assistant?.model?.messages?.find((m) => m.role === "system")?.content ?? "";
    expect(systemMsg).toContain("Ace Plumbing");
    expect(systemMsg).toMatch(/not instructions/i);
  });

  it("falls back to the GENERIC assistant config when the org has no setup row", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await profileMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signed({ message: { type: "assistant-request", call: CALL } }) as never);

    const json = (await res.json()) as {
      assistant?: { firstMessage?: string; voice?: { voiceId?: string } };
    };
    expect(json.assistant?.firstMessage).toBe("Thank you for calling. How can I help you today?");
    expect(json.assistant?.voice?.voiceId).toBe("Elliot");
  });

  it("threads the org's business identity into the governed tool-call turn", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("Sure, I can help with that.");
    const profile = {
      businessName: "Ace Plumbing",
      preferredVoice: null,
      businessHours: null,
      tradeType: "Plumbing",
    };
    (await profileMock()).mockResolvedValue(profile);

    const { POST } = await loadRoute();
    await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "do you fix boilers",
          call: CALL,
          toolCalls: [{ id: "tc1", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );
    expect(await turnMock()).toHaveBeenCalledWith(expect.objectContaining({ business: profile }));
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

  it("persists the tool-call transcript + reply and passes prior turns as memory", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await loadTurnsMock()).mockResolvedValue([
      { transcript: "hi", reply: "Hello, how can I help?" },
    ]);
    (await turnMock()).mockResolvedValue("Sorry to hear that — is it dripping or fully leaking?");

    const { POST } = await loadRoute();
    const res = await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "my boiler is leaking",
          call: CALL_WITH_ID,
          toolCalls: [{ id: "tc1", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );
    expect(res.status).toBe(200);

    // The call was resolved by the Vapi call id and prior turns loaded + threaded in.
    expect(await recordMock()).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ provider: "vapi", providerCallId: "vapi-call-1" }),
    );
    expect(await loadTurnsMock()).toHaveBeenCalledWith("org-1", "call-1");
    expect(await turnMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        transcript: "my boiler is leaking",
        history: [{ transcript: "hi", reply: "Hello, how can I help?" }],
      }),
    );
    // The caller utterance + generated reply are persisted, correlated by call id.
    // persistSpokenTurn re-reads the COMPLETE turn set (loadAllSpokenTurns) for the
    // raw_text fold, so the route no longer passes it the bounded recent-window.
    expect(await persistMock()).toHaveBeenCalledWith({
      orgId: "org-1",
      callId: "call-1",
      providerCallId: "vapi-call-1",
      transcript: "my boiler is leaking",
      reply: "Sorry to hear that — is it dripping or fully leaking?",
    });
  });

  it("still captures WHAT THE CALLER SAID even when the turn is null (dark)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue(null); // dark: no tier bound

    const { POST } = await loadRoute();
    const res = await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "my roof is leaking",
          call: CALL_WITH_ID,
          toolCalls: [{ id: "tc2", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );
    expect(res.status).toBe(200);
    // Dark → reply is null, but the caller's words are STILL persisted (the whole
    // point: a body-less enquiry was the bug).
    expect(await persistMock()).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "my roof is leaking", reply: null }),
    );
  });

  it("degrades gracefully (200) when tool-call persistence throws", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("Noted — the team will call you back.");
    (await persistMock()).mockRejectedValue(new Error("db unavailable"));

    const { POST } = await loadRoute();
    const res = await POST(
      signed({
        message: {
          type: "tool-calls",
          transcript: "hello",
          call: CALL_WITH_ID,
          toolCalls: [{ id: "tc3", function: { name: "answer", arguments: "{}" } }],
        },
      }) as never,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ toolCallId: string; result: string }> };
    // The generated reply still returns to Vapi despite the persistence failure.
    expect(json.results[0]?.result).toBe("Noted — the team will call you back.");
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

  it("accepts an Authorization: Bearer <secret> as the shared-secret alias", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const rawBody = JSON.stringify({ message: { type: "assistant-request", call: CALL } });
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: rawBody,
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);
    expect(res.status).toBe(200);
  });

  it("rejects a WRONG X-Vapi-Secret 401 fail-closed", async () => {
    const rawBody = JSON.stringify({ message: { type: "assistant-request", call: CALL } });
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-secret": "not-the-secret" },
      body: rawBody,
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await turnMock()).not.toHaveBeenCalled();
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await recordMock()).not.toHaveBeenCalled();
    expect(await persistMock()).not.toHaveBeenCalled();
  });

  it("rejects a MISSING secret 401 fail-closed (and the legacy HMAC-only header alone does not pass)", async () => {
    const rawBody = JSON.stringify({ message: { type: "assistant-request", call: CALL } });
    // An x-vapi-signature (the OLD scheme) with NO shared secret must NOT pass:
    // HMAC is opt-in only, so this is exactly the "genuine Vapi traffic rejected"
    // failure inverted — a valid shared-secret request DOES pass (above), an
    // HMAC-only request does not (here).
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-signature": "deadbeef" },
      body: rawBody,
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await recordMock()).not.toHaveBeenCalled();
    expect(await persistMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signed({ message: { type: "assistant-request", call: CALL } }) as never);

    expect(res.status).toBe(503);
    expect(await turnMock()).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Vapi custom-llm `/chat/completions` endpoint (C30, GAP 2 / C35).
 *
 * This is the GOVERNED OpenAI-compatible door Vapi's custom-llm calls for every
 * turn (`model.url`). Hermetic: verification runs FOR REAL against the PRIMARY
 * scheme Vapi sends — the `X-Vapi-Secret` shared secret checked constant-time
 * against VAPI_WEBHOOK_SECRET — only the org router, the governed turn seam, the
 * persistence service and the per-org profile loader are mocked. Pins: it routes
 * the caller's utterance through the SAME governed seam as the other voice doors
 * (with the per-call dedupe identity AND the org's business context), returns a
 * well-formed OpenAI body, degrades a null/dark turn to a DETERMINISTIC ack
 * (never ungoverned), rejects a wrong/missing secret 401 fail-closed, and 503s
 * while dark.
 */

vi.mock("@/lib/telephony/router", () => ({ resolveOrgForDialedNumber: vi.fn() }));
vi.mock("@/lib/telephony/ai-turn", () => ({ maybeGenerateVoiceTurn: vi.fn() }));
vi.mock("@/lib/telephony/receptionist-profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telephony/receptionist-profile")>()),
  loadReceptionistProfile: vi.fn(),
}));
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  loadRecentSpokenTurns: vi.fn(),
  persistSpokenTurn: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/vapi/chat-completions/route");
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
  return new Request("https://app.crewflow.uk/api/webhooks/vapi/chat-completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": SECRET },
    body: rawBody,
  });
}

const CALL = {
  id: "vapi-call-1",
  phoneNumber: { number: "+441234567890" },
  customer: { number: "+447700900123" },
};

function chatBody(opts?: { stream?: boolean; messages?: Array<{ role: string; content: string }> }) {
  return {
    model: "crewflow-receptionist",
    stream: opts?.stream,
    messages: opts?.messages ?? [
      { role: "system", content: "You are CrewFlow Receptionist." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello, how can I help?" },
      { role: "user", content: "my boiler is leaking" },
    ],
    call: CALL,
  };
}

describe("POST /api/webhooks/vapi/chat-completions", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "vapi");
    vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
    (await recordMock()).mockResolvedValue({ callId: "call-1", created: true });
    (await loadTurnsMock()).mockResolvedValue([]);
    (await persistMock()).mockResolvedValue(undefined);
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

  it("routes the utterance through the governed seam with the per-call dedupe identity", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await loadTurnsMock()).mockResolvedValue([{ transcript: "hi", reply: "Hello, how can I help?" }]);
    (await turnMock()).mockResolvedValue("Sorry to hear that — is it dripping or fully leaking?");

    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody({ stream: false })) as never);
    expect(res.status).toBe(200);

    // The latest user utterance is the transcript; callId + ordinal thread the
    // per-call dedupe identity; prior turns are loaded as memory (durable wins).
    expect(await turnMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        transcript: "my boiler is leaking",
        callId: "call-1",
        ordinal: 1,
        history: [{ transcript: "hi", reply: "Hello, how can I help?" }],
      }),
    );
  });

  it("threads the org's business identity into the governed turn", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const profile = {
      businessName: "Ace Plumbing",
      preferredVoice: null,
      businessHours: "Mon-Fri 8-6",
      tradeType: "Plumbing",
    };
    (await profileMock()).mockResolvedValue(profile);
    (await turnMock()).mockResolvedValue("Sure.");

    const { POST } = await loadRoute();
    await POST(signed(chatBody({ stream: false })) as never);
    expect(await turnMock()).toHaveBeenCalledWith(expect.objectContaining({ business: profile }));
  });

  it("accepts an Authorization: Bearer <secret>, and rejects a wrong secret 401", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("ok");
    const rawBody = JSON.stringify(chatBody({ stream: false }));
    const { POST } = await loadRoute();

    const okReq = new Request("https://app.crewflow.uk/api/webhooks/vapi/chat-completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: rawBody,
    });
    expect((await POST(okReq as never)).status).toBe(200);

    const badReq = new Request("https://app.crewflow.uk/api/webhooks/vapi/chat-completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-secret": "wrong" },
      body: rawBody,
    });
    expect((await POST(badReq as never)).status).toBe(401);
  });

  it("returns a well-formed non-streaming OpenAI completion carrying the governed reply", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("Sorry to hear that.");

    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody({ stream: false })) as never);
    expect(res.headers.get("content-type")).toContain("application/json");
    const json = (await res.json()) as {
      object?: string;
      choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
    };
    expect(json.object).toBe("chat.completion");
    expect(json.choices?.[0]?.message?.role).toBe("assistant");
    expect(json.choices?.[0]?.message?.content).toBe("Sorry to hear that.");
    expect(json.choices?.[0]?.finish_reason).toBe("stop");
  });

  it("returns a well-formed SSE stream when streaming is requested (default)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("How can I help?");

    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody()) as never); // stream undefined ⇒ default true
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("How can I help?");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });

  it("degrades a null (dark/blocked) turn to a DETERMINISTIC ack, never ungoverned", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue(null); // dark / blocked / duplicate

    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody({ stream: false })) as never);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toMatch(/team will follow up/i);
    // The caller's words are still captured even when dark.
    expect(await persistMock()).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "my boiler is leaking", reply: null }),
    );
  });

  it("returns a deterministic ack (no generation) for an unrouted dialed number", async () => {
    (await routerMock()).mockResolvedValue(null);

    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody({ stream: false })) as never);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(json.choices?.[0]?.message?.content).toMatch(/team will follow up/i);
    expect(await turnMock()).not.toHaveBeenCalled();
    expect(await recordMock()).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature 401 fail-closed, before any work", async () => {
    const rawBody = JSON.stringify(chatBody());
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi/chat-completions", {
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

  it("rejects a missing signature 401 fail-closed", async () => {
    const rawBody = JSON.stringify(chatBody());
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi/chat-completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rawBody,
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(await turnMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when dark", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signed(chatBody()) as never);
    expect(res.status).toBe(503);
    expect(await turnMock()).not.toHaveBeenCalled();
  });
});

describe("buildVapiAssistantConfig — custom-llm model.url is config-flip-ready", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets model.url to a non-empty absolute string", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.crewflow.uk");
    const { buildVapiAssistantConfig } = await import("@/lib/telephony/providers/vapi");
    const cfg = buildVapiAssistantConfig() as {
      assistant: { model: { provider: string; url?: string } };
    };
    expect(cfg.assistant.model.provider).toBe("custom-llm");
    expect(typeof cfg.assistant.model.url).toBe("string");
    expect(cfg.assistant.model.url).toBe(
      "https://app.crewflow.uk/api/webhooks/vapi/chat-completions",
    );
  });

  it("honours the VAPI_CUSTOM_LLM_URL pin override", async () => {
    vi.stubEnv("VAPI_CUSTOM_LLM_URL", "https://voice.crewflow.uk/llm");
    const { resolveVapiCustomLlmUrl } = await import("@/lib/telephony/providers/vapi");
    expect(resolveVapiCustomLlmUrl()).toBe("https://voice.crewflow.uk/llm");
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * Vapi inbound-VOICE route — the CALL-COMPLETION enrichment branch (C35c).
 *
 * The confirmed gap: Vapi's `end-of-call-report` event was UNHANDLED, so a
 * completed call's recording_url / transcript / transcript_json / ai_summary /
 * duration_sec / ended_at were never written and the call was never enriched on
 * activation. These tests pin, hermetically (no real provider, no Supabase —
 * verification runs FOR REAL against the PRIMARY X-Vapi-Secret shared-secret
 * scheme; only the org router + the enrichment service are mocked):
 *   - a signed report enriches the calls row with ALL fields, org-pinned;
 *   - an unsigned / wrong-secret report is rejected 401 fail-closed (no write);
 *   - the whole door 503s before any work while DARK;
 *   - a REDELIVERED report drives the same idempotent update (no corruption);
 *   - a persistence error degrades to 200 (never a 500 that retry-storms Vapi).
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
vi.mock("@/lib/telephony/ai-turn", () => ({
  maybeGenerateVoiceTurn: vi.fn(),
}));
vi.mock("@/lib/telephony/receptionist-profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telephony/receptionist-profile")>()),
  loadReceptionistProfile: vi.fn(),
}));
// Mock the whole service so the enrichment write is assertable and no branch can
// fall through to Supabase.
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  appendCallEvent: vi.fn(),
  loadRecentSpokenTurns: vi.fn(),
  persistSpokenTurn: vi.fn(),
  updateCallCompletion: vi.fn(),
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
async function updateMock() {
  return vi.mocked((await import("@/server/services/telephony")).updateCallCompletion);
}

const SECRET = "whsec_vapi_test";

function signed(bodyObj: unknown): Request {
  return new Request("https://app.crewflow.uk/api/webhooks/vapi", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vapi-secret": SECRET },
    body: JSON.stringify(bodyObj),
  });
}

const CALL = {
  id: "vapi-call-1",
  phoneNumber: { number: "+441234567890" },
  customer: { number: "+447700900123" },
};

const STRUCTURED = [
  { role: "assistant", message: "Thank you for calling. How can I help?" },
  { role: "user", message: "My boiler is leaking." },
];

function report(overrides: Record<string, unknown> = {}): unknown {
  return {
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      call: CALL,
      recordingUrl: "https://recordings.vapi.ai/abc.mp3",
      transcript: "AI: Thank you for calling.\nUser: My boiler is leaking.",
      messages: STRUCTURED,
      analysis: { summary: "Caller reported a leaking boiler and wants a callback." },
      durationSeconds: 42,
      endedAt: "2026-08-01T10:00:00.000Z",
      ...overrides,
    },
  };
}

describe("POST /api/webhooks/vapi — end-of-call-report enrichment", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "vapi");
    vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
    (await updateMock()).mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await updateMock()).mockReset();
  });

  it("enriches the calls row with ALL fields, org-pinned by the DIALED number", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(signed(report()) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enriched: true });

    // Org attributed from the DIALED number, never the caller identity.
    expect(await routerMock()).toHaveBeenCalledWith("+441234567890");
    // The enrichment is org-pinned + keyed on the Vapi call id, with every field.
    expect(await updateMock()).toHaveBeenCalledWith("org-1", "vapi-call-1", {
      recordingUrl: "https://recordings.vapi.ai/abc.mp3",
      transcript: "AI: Thank you for calling.\nUser: My boiler is leaking.",
      transcriptJson: STRUCTURED,
      aiSummary: "Caller reported a leaking boiler and wants a callback.",
      durationSec: 42,
      endedAt: "2026-08-01T10:00:00.000Z",
    });
  });

  it("prefers analysis.summary and derives duration from durationMs when seconds absent", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    await POST(
      signed(report({ durationSeconds: undefined, durationMs: 90500, summary: "top-level" })) as never,
    );
    expect(await updateMock()).toHaveBeenCalledWith(
      "org-1",
      "vapi-call-1",
      expect.objectContaining({
        durationSec: 91, // 90500ms rounded to seconds
        aiSummary: "Caller reported a leaking boiler and wants a callback.", // analysis.summary wins
      }),
    );
  });

  it("rejects a WRONG X-Vapi-Secret 401 fail-closed — no enrichment write", async () => {
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json", "x-vapi-secret": "not-the-secret" },
      body: JSON.stringify(report()),
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("rejects a MISSING secret 401 fail-closed — no enrichment write", async () => {
    const req = new Request("https://app.crewflow.uk/api/webhooks/vapi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report()),
    });
    const { POST } = await loadRoute();
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when DARK — no enrichment write", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signed(report()) as never);

    expect(res.status).toBe(503);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("ack-drops an unrouted number with no tenant write", async () => {
    (await routerMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signed(report()) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unrouted: true });
    expect(await updateMock()).not.toHaveBeenCalled();
  });

  it("a REDELIVERED report drives the SAME idempotent update (no corruption)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();

    const first = await POST(signed(report()) as never);
    const second = await POST(signed(report()) as never);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const calls = (await updateMock()).mock.calls;
    expect(calls).toHaveLength(2);
    // Both deliveries carry identical args — the UPDATE is idempotent (no insert,
    // no duplicate, no corruption on redelivery).
    expect(calls[0]).toEqual(calls[1]);
  });

  it("degrades gracefully (200) when the enrichment write throws — never a 500", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await updateMock()).mockRejectedValue(new Error("db unavailable"));
    const { POST } = await loadRoute();
    const res = await POST(signed(report()) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enriched: false });
  });
});

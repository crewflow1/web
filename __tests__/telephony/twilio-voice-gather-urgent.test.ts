import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { defaultAnsweringConfig } from "@/lib/telephony/answering-policy";
import type { LoadedAnsweringPolicy } from "@/lib/telephony/answering-config";

/**
 * Urgent-transfer branch of the gather route (Twilio receptionist PR 6). When the
 * caller's words signal an emergency AND the org has an escalation number, the call
 * is transferred to a human BEFORE the AI turn; otherwise the AI loop continues.
 * Hermetic: real signature verification; router/policy/profile/turn/services mocked;
 * the urgent heuristic + TwiML builder run for real.
 */

vi.mock("@/lib/telephony/router", () => ({ resolveOrgForDialedNumber: vi.fn() }));
vi.mock("@/lib/telephony/answering-config", () => ({ loadAnsweringPolicy: vi.fn() }));
vi.mock("@/lib/telephony/ai-turn", () => ({ maybeGenerateVoiceTurn: vi.fn() }));
vi.mock("@/lib/telephony/receptionist-profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telephony/receptionist-profile")>()),
  loadReceptionistProfile: vi.fn(),
}));
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  loadRecentSpokenTurns: vi.fn(),
  countSpokenTurns: vi.fn(),
  persistSpokenTurn: vi.fn(),
  appendCallEvent: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/twilio/voice/gather/route");
}
const m = async (mod: string, name: string) => vi.mocked((await import(mod))[name as never]);

const TOKEN = "gather_urgent_token";
const HOST = "app.crewflow.uk";
const URL_ = `https://${HOST}/api/webhooks/twilio/voice/gather`;
function sig(token: string, url: string, p: Record<string, string>): string {
  const data = Object.keys(p).sort().reduce((a, k) => a + k + p[k], url);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}
function signed(p: Record<string, string>): Request {
  const h = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-proto": "https",
    "x-forwarded-host": HOST,
    "x-twilio-signature": sig(TOKEN, URL_, p),
  });
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/gather", {
    method: "POST",
    headers: h,
    body: new URLSearchParams(p).toString(),
  });
}
function policy(urgentNumber: string | null): LoadedAnsweringPolicy {
  return {
    config: { ...defaultAnsweringConfig(), enabled: true },
    staffNumbers: [],
    fallbackNumber: null,
    urgentNumber,
    greeting: null,
    recordingEnabled: false,
    transcriptionEnabled: false,
    consentMessage: null,
  };
}

describe("gather route — urgent transfer", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    (await m("@/lib/telephony/router", "resolveOrgForDialedNumber")).mockResolvedValue("org-1");
    (await m("@/server/services/telephony", "recordInboundCall")).mockResolvedValue({ callId: "call-1", created: true });
    (await m("@/server/services/telephony", "loadRecentSpokenTurns")).mockResolvedValue([]);
    (await m("@/server/services/telephony", "countSpokenTurns")).mockResolvedValue(0);
    (await m("@/server/services/telephony", "persistSpokenTurn")).mockResolvedValue(undefined);
    (await m("@/server/services/telephony", "appendCallEvent")).mockResolvedValue({ duplicate: false });
    (await m("@/lib/telephony/receptionist-profile", "loadReceptionistProfile")).mockResolvedValue(null);
    (await m("@/lib/telephony/ai-turn", "maybeGenerateVoiceTurn")).mockResolvedValue("How can I help?");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("transfers an URGENT caller to the escalation number and logs it (no AI turn)", async () => {
    (await m("@/lib/telephony/answering-config", "loadAnsweringPolicy")).mockResolvedValue(policy("+447700900999"));
    const { POST } = await loadRoute();
    const res = await POST(signed({ CallSid: "CA1", From: "+447700900123", To: "+441234567890", SpeechResult: "there's a gas leak" }) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Number>+447700900999</Number>");
    expect(xml).not.toContain('<Gather');
    // The AI turn was NOT generated — we handed straight to a human.
    expect(await m("@/lib/telephony/ai-turn", "maybeGenerateVoiceTurn")).not.toHaveBeenCalled();
    // The transfer was audited.
    expect(await m("@/server/services/telephony", "appendCallEvent")).toHaveBeenCalledWith(
      "org-1",
      "call-1",
      expect.objectContaining({ type: "transferred" }),
    );
  });

  it("continues the AI loop for an urgent caller when NO escalation number is set", async () => {
    (await m("@/lib/telephony/answering-config", "loadAnsweringPolicy")).mockResolvedValue(policy(null));
    const { POST } = await loadRoute();
    const res = await POST(signed({ CallSid: "CA2", From: "+447700900123", To: "+441234567890", SpeechResult: "gas leak" }) as never);
    const xml = await res.text();
    expect(xml).toMatch(/<Gather input="speech"/);
    expect(await m("@/lib/telephony/ai-turn", "maybeGenerateVoiceTurn")).toHaveBeenCalled();
  });

  it("does NOT transfer a routine caller (AI loop continues, policy not consulted)", async () => {
    const loadPolicy = await m("@/lib/telephony/answering-config", "loadAnsweringPolicy");
    loadPolicy.mockResolvedValue(policy("+447700900999"));
    const { POST } = await loadRoute();
    const res = await POST(signed({ CallSid: "CA3", From: "+447700900123", To: "+441234567890", SpeechResult: "can I get a quote for a bathroom" }) as never);
    const xml = await res.text();
    expect(xml).toMatch(/<Gather input="speech"/);
    expect(await m("@/lib/telephony/ai-turn", "maybeGenerateVoiceTurn")).toHaveBeenCalled();
    // Non-urgent ⇒ the urgent branch (and its policy load) never runs.
    expect(loadPolicy).not.toHaveBeenCalled();
  });
});

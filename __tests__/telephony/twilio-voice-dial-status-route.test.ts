import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { defaultAnsweringConfig, type AnsweringConfig } from "@/lib/telephony/answering-policy";
import type { LoadedAnsweringPolicy } from "@/lib/telephony/answering-config";

/**
 * Twilio inbound-VOICE <Dial> ACTION callback — the STAFF-FIRST fallthrough
 * (Twilio receptionist PR 2). Twilio requests this route after the staff leg
 * finishes, carrying DialCallStatus. The tests pin, hermetic (no real provider,
 * no real Supabase), that the route:
 *   - ends the call when staff ANSWERED (human handled it),
 *   - opens the governed AI loop + delegates the enquiry when staff MISSED and
 *     the mode says the AI answers,
 *   - takes a message (fires the missed-call text-back, AI stays out, no <Gather>)
 *     for out_of_hours mode missed during open hours,
 *   - hangs up when the CALLER abandoned (DialCallStatus=canceled),
 *   - is FAIL-CLOSED on a bad/missing signature (401 before any work),
 *   - 503s when the feature is DARK,
 *   - ack-drops an unrouted dialed number with NO tenant write,
 *   - is tenant-SCOPED: every delegation is pinned to the resolved org.
 *
 * Only the org router, the policy load, the profile load and the service seams
 * are mocked; the Twilio signature verification runs FOR REAL (twilio SDK
 * validateRequest), so the auth gate is proven, not stubbed. decideAnswering runs
 * FOR REAL over the mocked policy, so the decision matrix is exercised end-to-end.
 */

vi.mock("@/lib/telephony/router", () => ({ resolveOrgForDialedNumber: vi.fn() }));
vi.mock("@/lib/telephony/answering-config", () => ({ loadAnsweringPolicy: vi.fn() }));
vi.mock("@/lib/telephony/receptionist-profile", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/telephony/receptionist-profile")>()),
  loadReceptionistProfile: vi.fn(),
}));
vi.mock("@/server/services/telephony", () => ({
  recordInboundCall: vi.fn(),
  appendCallEvent: vi.fn(),
  updateCallAssociation: vi.fn(),
}));
vi.mock("@/server/services/receptionist", () => ({
  processInboundEnquiry: vi.fn(),
  processMissedCallTextback: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/twilio/voice/dial-status/route");
}
async function routerMock() {
  return vi.mocked((await import("@/lib/telephony/router")).resolveOrgForDialedNumber);
}
async function policyMock() {
  return vi.mocked((await import("@/lib/telephony/answering-config")).loadAnsweringPolicy);
}
async function profileMock() {
  return vi.mocked((await import("@/lib/telephony/receptionist-profile")).loadReceptionistProfile);
}
async function recordMock() {
  return vi.mocked((await import("@/server/services/telephony")).recordInboundCall);
}
async function appendMock() {
  return vi.mocked((await import("@/server/services/telephony")).appendCallEvent);
}
async function enquiryMock() {
  return vi.mocked((await import("@/server/services/receptionist")).processInboundEnquiry);
}
async function textbackMock() {
  return vi.mocked((await import("@/server/services/receptionist")).processMissedCallTextback);
}

const TOKEN = "voice_dial_status_token_xyz789";
const PUBLIC_HOST = "app.crewflow.uk";
const CALLBACK_URL = `https://${PUBLIC_HOST}/api/webhooks/twilio/voice/dial-status`;

function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function buildRequest(opts: { params: Record<string, string>; signature: string | null }): Request {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-proto": "https",
    "x-forwarded-host": PUBLIC_HOST,
  });
  if (opts.signature !== null) headers.set("x-twilio-signature", opts.signature);
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/dial-status", {
    method: "POST",
    headers,
    body: new URLSearchParams(opts.params).toString(),
  });
}
function signed(params: Record<string, string>): Request {
  return buildRequest({ params, signature: twilioSignature(TOKEN, CALLBACK_URL, params) });
}

function policyWith(config: Partial<AnsweringConfig>): LoadedAnsweringPolicy {
  return {
    config: { ...defaultAnsweringConfig(), enabled: true, hasStaffNumbers: true, ...config },
    staffNumbers: ["+447700900001"],
    fallbackNumber: null,
    urgentNumber: null,
    greeting: null,
    recordingEnabled: false,
    transcriptionEnabled: false,
    consentMessage: null,
  };
}

/** All-days-open / all-days-closed configs make the hours test time-independent. */
const OPEN_ALL = {
  mon: { open: "00:00", close: "23:59" },
  tue: { open: "00:00", close: "23:59" },
  wed: { open: "00:00", close: "23:59" },
  thu: { open: "00:00", close: "23:59" },
  fri: { open: "00:00", close: "23:59" },
  sat: { open: "00:00", close: "23:59" },
  sun: { open: "00:00", close: "23:59" },
} as const;
const CLOSED_ALL = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null } as const;

const DIAL = (over: Record<string, string> = {}) => ({
  CallSid: "CA-dial-1",
  From: "+447700900123",
  To: "+441234567890",
  CallStatus: "in-progress",
  DialCallStatus: "no-answer",
  ...over,
});

describe("POST /api/webhooks/twilio/voice/dial-status", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T10:00:00Z")); // Mon 10:00 GMT
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    (await recordMock()).mockResolvedValue({ callId: "call-1", created: true } as never);
    (await appendMock()).mockResolvedValue({ duplicate: false, status: "in_progress" } as never);
    (await enquiryMock()).mockResolvedValue({ lead_id: "lead-1", conversation_id: "conv-1" } as never);
    (await textbackMock()).mockResolvedValue({ lead_id: "lead-1", conversation_id: "conv-1" } as never);
    (await profileMock()).mockResolvedValue(null);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("ENDS the call when staff answered (completed) — no AI, no enquiry, no text-back", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "both" }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "completed" })) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Gather");
    expect(await enquiryMock()).not.toHaveBeenCalled();
    expect(await textbackMock()).not.toHaveBeenCalled();
  });

  it("opens the AI loop + delegates the enquiry when staff MISS (mode both)", async () => {
    (await routerMock()).mockResolvedValue("org-7");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "both" }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "no-answer" })) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toMatch(/<Gather input="speech"/);
    // Enquiry delegated, pinned to the resolved org (tenant isolation).
    expect(await enquiryMock()).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org-7", channel: "phone", provider_message_id: "CA-dial-1" }),
      { textback: "defer" },
    );
    expect(await textbackMock()).not.toHaveBeenCalled();
    // The staff-miss is logged NON-terminally (in_progress), not as a terminal.
    expect(await appendMock()).toHaveBeenCalledWith(
      "org-7",
      "call-1",
      expect.objectContaining({ type: "in_progress", providerEventId: "dial:no-answer" }),
    );
  });

  it("AI answers on staff BUSY in missed_only mode", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "missed_only" }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "busy" })) as never);
    expect((await res.text())).toMatch(/<Gather input="speech"/);
  });

  it("TAKES A MESSAGE (out_of_hours, within hours, staff miss) — text-back, no AI loop", async () => {
    (await routerMock()).mockResolvedValue("org-9");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "out_of_hours", weekly: OPEN_ALL }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "no-answer" })) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).not.toContain("<Gather");
    expect(xml).toContain("Sorry we missed you");
    // The missed-call text-back fired, pinned to the resolved org; the AI was NOT invoked.
    expect(await textbackMock()).toHaveBeenCalledWith({
      org_id: "org-9",
      provider_call_id: "CA-dial-1",
      caller: "+447700900123",
    });
    expect(await enquiryMock()).not.toHaveBeenCalled();
  });

  it("out_of_hours OUTSIDE hours, staff miss → AI answers", async () => {
    vi.setSystemTime(new Date("2026-01-05T22:00:00Z")); // Mon 22:00 — closed
    (await routerMock()).mockResolvedValue("org-1");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "out_of_hours", weekly: CLOSED_ALL }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "no-answer" })) as never);
    expect((await res.text())).toMatch(/<Gather input="speech"/);
    expect(await enquiryMock()).toHaveBeenCalled();
  });

  it("hangs up when the CALLER abandoned (canceled) — no decision, no delegation", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await policyMock()).mockResolvedValue(policyWith({ mode: "both" }));
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL({ DialCallStatus: "canceled" })) as never);
    const xml = await res.text();
    expect(xml).toContain("<Hangup/>");
    expect(await enquiryMock()).not.toHaveBeenCalled();
    expect(await textbackMock()).not.toHaveBeenCalled();
    expect(await policyMock()).not.toHaveBeenCalled(); // decided before loading policy
  });

  it("rejects a missing signature 401 FAIL-CLOSED before any work", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(buildRequest({ params: DIAL(), signature: null }) as never);
    expect(res.status).toBe(401);
    expect(await routerMock()).not.toHaveBeenCalled();
    expect(await recordMock()).not.toHaveBeenCalled();
  });

  it("rejects a wrong-token signature 401", async () => {
    const { POST } = await loadRoute();
    const req = buildRequest({ params: DIAL(), signature: twilioSignature("attacker", CALLBACK_URL, DIAL()) });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("503s before any work when the feature is DARK", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL()) as never);
    expect(res.status).toBe(503);
    expect(await routerMock()).not.toHaveBeenCalled();
  });

  it("ack-drops an unrouted dialed number with NO tenant write", async () => {
    (await routerMock()).mockResolvedValue(null);
    const { POST } = await loadRoute();
    const res = await POST(signed(DIAL()) as never);
    expect(res.status).toBe(200);
    expect((await res.text())).toContain("not currently in service");
    expect(await recordMock()).not.toHaveBeenCalled();
    expect(await enquiryMock()).not.toHaveBeenCalled();
  });
});

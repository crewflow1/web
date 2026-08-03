import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

/**
 * Twilio inbound-VOICE gather-callback route — the conversational spoken-turn
 * loop (Wave 8, C28). This is the ONLY door that receives a caller transcript
 * (`SpeechResult`), so it is where the governed AI turn seam is actually
 * reachable. The tests pin, end-to-end-ish and hermetic (no real provider, no
 * real Supabase):
 *   - a signed callback with a non-empty SpeechResult, an org, and a NON-null
 *     governed turn returns a spoken <Say> AND nests a further <Gather> back to
 *     this same route (the loop continues),
 *   - a missing / invalid / wrong-token signature is rejected 401 FAIL-CLOSED,
 *     before any turn is generated,
 *   - when the feature is DARK the route 503s before any work,
 *   - when configured but the turn is null (no tier bound), it degrades to a
 *     graceful deterministic close with NO <Gather> (never a silent loop).
 *
 * Only the org router and the governed turn seam are mocked; the Twilio
 * signature verification runs FOR REAL (twilio SDK validateRequest), so the auth
 * gate is proven rather than stubbed — the exact posture of the SMS-status test.
 */

vi.mock("@/lib/telephony/router", () => ({
  resolveOrgForDialedNumber: vi.fn(),
}));
vi.mock("@/lib/telephony/ai-turn", () => ({
  maybeGenerateVoiceTurn: vi.fn(),
}));

async function loadRoute() {
  return import("@/app/api/webhooks/twilio/voice/gather/route");
}
async function routerMock() {
  const { resolveOrgForDialedNumber } = await import("@/lib/telephony/router");
  return vi.mocked(resolveOrgForDialedNumber);
}
async function turnMock() {
  const { maybeGenerateVoiceTurn } = await import("@/lib/telephony/ai-turn");
  return vi.mocked(maybeGenerateVoiceTurn);
}

const TOKEN = "voice_gather_auth_token_abc123";
const PUBLIC_HOST = "app.crewflow.uk";
const CALLBACK_URL = `https://${PUBLIC_HOST}/api/webhooks/twilio/voice/gather`;

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
  return new Request("https://internal.vercel.local/api/webhooks/twilio/voice/gather", {
    method: "POST",
    headers,
    body: new URLSearchParams(opts.params).toString(),
  });
}

function signedRequest(params: Record<string, string>): Request {
  return buildRequest({ params, signature: twilioSignature(TOKEN, CALLBACK_URL, params) });
}

const SPEECH = {
  CallSid: "CA-gather-1",
  From: "+447700900123",
  To: "+441234567890",
  SpeechResult: "my boiler is leaking",
};

describe("POST /api/webhooks/twilio/voice/gather", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "true");
    vi.stubEnv("COMMS_VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    (await routerMock()).mockReset();
    (await turnMock()).mockReset();
  });

  it("SAYs the governed turn and NESTS a further <Gather> (loop continues)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue("Sorry to hear that. Is it dripping or fully leaking?");

    const { POST } = await loadRoute();
    const res = await POST(signedRequest(SPEECH) as never);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    // The AI reply is spoken…
    expect(xml).toContain("<Say>Sorry to hear that. Is it dripping or fully leaking?</Say>");
    // …inside a speech <Gather> that loops back to THIS route (conversation continues).
    expect(xml).toMatch(
      /<Gather input="speech" action="\/api\/webhooks\/twilio\/voice\/gather" method="POST" speechTimeout="auto">/,
    );
    // The governed seam saw the caller's real transcript, scoped to the routed org.
    expect(await turnMock()).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", transcript: "my boiler is leaking" }),
    );
  });

  it("rejects a missing signature 401 FAIL-CLOSED before generating a turn", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    const { POST } = await loadRoute();
    const res = await POST(buildRequest({ params: SPEECH, signature: null }) as never);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_signature" });
    expect(await turnMock()).not.toHaveBeenCalled();
    expect(await routerMock()).not.toHaveBeenCalled();
  });

  it("rejects a signature minted with the wrong token 401", async () => {
    const { POST } = await loadRoute();
    const req = buildRequest({
      params: SPEECH,
      signature: twilioSignature("attacker_token", CALLBACK_URL, SPEECH),
    });
    const res = await POST(req as never);

    expect(res.status).toBe(401);
    expect(await turnMock()).not.toHaveBeenCalled();
  });

  it("503s before any work when the feature is DARK", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_VOICE_INBOUND", "");
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(SPEECH) as never);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "not_enabled" });
    expect(await turnMock()).not.toHaveBeenCalled();
    expect(await routerMock()).not.toHaveBeenCalled();
  });

  it("degrades to a graceful close (no <Gather>) when the turn is null (no tier bound)", async () => {
    (await routerMock()).mockResolvedValue("org-1");
    (await turnMock()).mockResolvedValue(null); // dark: no generative tier bound

    const { POST } = await loadRoute();
    const res = await POST(signedRequest(SPEECH) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<Say>");
    expect(xml).toContain("call you back"); // the deterministic polite close
    expect(xml).not.toContain("<Gather"); // never a silent re-gather loop
  });

  it("ack-drops an unrouted dialed number with polite TwiML and no turn", async () => {
    (await routerMock()).mockResolvedValue(null); // no active route
    const { POST } = await loadRoute();
    const res = await POST(signedRequest(SPEECH) as never);

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("not currently in service");
    expect(await turnMock()).not.toHaveBeenCalled();
  });
});

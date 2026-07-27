import { afterEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  resolveTwilioStatusCallbackUrl,
  twilioSendPayload,
  verifyTwilioSignature,
  SMS_STATUS_CALLBACK_PATH,
} from "@/lib/comms/providers/twilio";

/**
 * SMS delivery-receipt REQUEST wiring — unit tier (the AI Receptionist Programme, R8).
 *
 * R7 built the authenticated receiver for async delivery receipts; R8 makes the send
 * actually ASK for them, by setting a `statusCallback` on the Twilio request. These
 * tests pin the two pure pieces of that wiring WITHOUT the vendor SDK on the send path:
 *   - `resolveTwilioStatusCallbackUrl()` — the send-side callback URL and its precedence,
 *   - `twilioSendPayload()`             — the exact request object, with/without the callback,
 * and then prove the ONE invariant the whole feature rests on: the URL the send tells
 * Twilio to call is the SAME URL the receiver route later authenticates against, so a
 * genuine Twilio signature minted over the resolved URL is accepted by the real
 * `verifyTwilioSignature` (the exact function the route uses). If send and verify ever
 * disagreed on the URL, every real delivery receipt would 401 — this is that guardrail.
 */

const TOKEN = "r8_symmetry_token_xyz";

/**
 * Recompute Twilio's request signature exactly as the vendor does: HMAC-SHA1 over the
 * request URL followed by each POST param (key then value) in sorted-key order, base64.
 * The route suite proves this identical helper validates against the real Twilio SDK,
 * so a signature it mints is what a genuine Twilio callback would carry.
 */
function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

describe("resolveTwilioStatusCallbackUrl — the send-side callback URL precedence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers TWILIO_STATUS_CALLBACK_URL verbatim (trimmed) over the derived form", () => {
    // The explicit public URL is authoritative behind a proxy that rewrites host/proto,
    // and must win even when an app URL is present — mirroring the route's callbackUrl().
    vi.stubEnv(
      "TWILIO_STATUS_CALLBACK_URL",
      "  https://app.crewflow.uk/api/webhooks/twilio/sms-status  ",
    );
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://elsewhere.example");
    expect(resolveTwilioStatusCallbackUrl()).toBe(
      "https://app.crewflow.uk/api/webhooks/twilio/sms-status",
    );
  });

  it("derives from NEXT_PUBLIC_APP_URL + the callback path when the explicit URL is unset", () => {
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crewflow.uk");
    expect(resolveTwilioStatusCallbackUrl()).toBe(
      `https://crewflow.uk${SMS_STATUS_CALLBACK_PATH}`,
    );
  });

  it("strips a trailing slash on the app URL so the callback path is never doubled", () => {
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crewflow.uk/");
    expect(resolveTwilioStatusCallbackUrl()).toBe(
      "https://crewflow.uk/api/webhooks/twilio/sms-status",
    );
  });

  it("returns null when neither the explicit URL nor an app URL is knowable", () => {
    // No public origin → no statusCallback is requested; the send still succeeds, we
    // simply do not point Twilio at a URL that cannot receive.
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(resolveTwilioStatusCallbackUrl()).toBeNull();
  });
});

describe("twilioSendPayload — the exact Twilio request shape", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("carries to/from/body and a statusCallback when a public URL is resolvable", () => {
    vi.stubEnv(
      "TWILIO_STATUS_CALLBACK_URL",
      "https://app.crewflow.uk/api/webhooks/twilio/sms-status",
    );
    expect(
      twilioSendPayload({ to: "+447700900000", from: "+447700900123", body: "hi" }),
    ).toEqual({
      to: "+447700900000",
      from: "+447700900123",
      body: "hi",
      statusCallback: "https://app.crewflow.uk/api/webhooks/twilio/sms-status",
    });
  });

  it("omits statusCallback entirely when no public URL is knowable — the send still proceeds", () => {
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const payload = twilioSendPayload({
      to: "+447700900000",
      from: "+447700900123",
      body: "hi",
    });
    expect(payload).toEqual({ to: "+447700900000", from: "+447700900123", body: "hi" });
    expect(payload).not.toHaveProperty("statusCallback");
  });
});

describe("send/verify URL symmetry — the URL we request receipts on is the URL we authenticate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a genuine signature minted over the resolved URL (explicit TWILIO_STATUS_CALLBACK_URL)", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    vi.stubEnv(
      "TWILIO_STATUS_CALLBACK_URL",
      "https://app.crewflow.uk/api/webhooks/twilio/sms-status",
    );

    const url = resolveTwilioStatusCallbackUrl();
    expect(url).not.toBeNull();

    // Sign the callback exactly as Twilio would, over the URL the SEND requested.
    const params = { MessageSid: "SM_symmetry", MessageStatus: "delivered" };
    const signature = twilioSignature(TOKEN, url as string, params);

    // The real verifier the receiver route uses must accept it — send and verify agree.
    await expect(
      verifyTwilioSignature({ signature, url: url as string, params }),
    ).resolves.toBe(true);
  });

  it("holds on the header-derived production path (app URL + path == the route's reconstruction)", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.crewflow.uk");

    const url = resolveTwilioStatusCallbackUrl();
    // The exact string the route reconstructs from x-forwarded-proto/host (proven in
    // twilio-sms-status-route.test.ts) — so the send-side and receive-side URLs match.
    expect(url).toBe("https://app.crewflow.uk/api/webhooks/twilio/sms-status");

    const params = { MessageSid: "SM_symmetry", MessageStatus: "sent" };
    const signature = twilioSignature(TOKEN, url as string, params);
    await expect(
      verifyTwilioSignature({ signature, url: url as string, params }),
    ).resolves.toBe(true);
  });

  it("rejects a signature minted over a DIFFERENT URL — proof the URL is bound into the signature", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
    vi.stubEnv(
      "TWILIO_STATUS_CALLBACK_URL",
      "https://app.crewflow.uk/api/webhooks/twilio/sms-status",
    );

    const url = resolveTwilioStatusCallbackUrl() as string;
    const params = { MessageSid: "SM_symmetry", MessageStatus: "delivered" };
    // A signature over a mismatched URL fails against the resolved URL — exactly the
    // failure a send/verify URL disagreement would cause. This is why symmetry matters.
    const wrongSignature = twilioSignature(
      TOKEN,
      "https://attacker.example/api/webhooks/twilio/sms-status",
      params,
    );
    await expect(
      verifyTwilioSignature({ signature: wrongSignature, url, params }),
    ).resolves.toBe(false);
  });
});

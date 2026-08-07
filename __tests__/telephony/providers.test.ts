import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  parseTwilioVoiceWebhook,
  mapTwilioCallStatus,
  buildInboundTwiml,
  buildAckDropTwiml,
} from "@/lib/telephony/providers/twilio";
import {
  verifyVapiSignature,
  verifyVapiWebhook,
  parseVapiWebhook,
  mapVapiStatus,
} from "@/lib/telephony/providers/vapi";
import { getVoiceProvider } from "@/lib/telephony";

/**
 * Provider parse/verify contracts. Parsing is pure and fail-closed (null on
 * unusable input); verification fails closed on a missing secret/signature.
 * The factory returns null when unconfigured.
 */

const VOICE_ENV = [
  "NEXT_PUBLIC_FEATURE_VOICE_INBOUND",
  "COMMS_VOICE_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "VAPI_WEBHOOK_SECRET",
  "VAPI_WEBHOOK_HMAC",
];
afterEach(() => {
  for (const k of VOICE_ENV) delete process.env[k];
});

describe("twilio voice parse", () => {
  it("maps CallStatus vocab to neutral events", () => {
    expect(mapTwilioCallStatus("in-progress")).toBe("in_progress");
    expect(mapTwilioCallStatus("no-answer")).toBe("no_answer");
    expect(mapTwilioCallStatus("completed")).toBe("completed");
    expect(mapTwilioCallStatus("queued")).toBe("initiated");
    expect(mapTwilioCallStatus("gibberish")).toBeNull();
  });

  it("returns null without a CallSid", () => {
    expect(parseTwilioVoiceWebhook({ From: "+441", To: "+442" })).toBeNull();
  });

  it("normalises a voice webhook", () => {
    const n = parseTwilioVoiceWebhook({
      CallSid: "CA123",
      From: "+447700900123",
      To: "+441234567890",
      CallStatus: "ringing",
    });
    expect(n).not.toBeNull();
    expect(n!.provider).toBe("twilio");
    expect(n!.providerCallId).toBe("CA123");
    expect(n!.from).toBe("+447700900123");
    expect(n!.to).toBe("+441234567890");
    expect(n!.status).toBe("ringing");
    expect(n!.providerEventId).toBe("ringing");
    // No CallDuration on a non-terminal transition ⇒ undefined (writer skips it).
    expect(n!.durationSec).toBeUndefined();
  });

  it("captures CallDuration (whole seconds) on the completed status callback", () => {
    const n = parseTwilioVoiceWebhook({
      CallSid: "CA123",
      From: "+447700900123",
      To: "+441234567890",
      CallStatus: "completed",
      CallDuration: "42",
    });
    expect(n!.status).toBe("completed");
    expect(n!.durationSec).toBe(42);
  });

  it("leaves durationSec undefined for absent / non-numeric / negative CallDuration", () => {
    const base = { CallSid: "CA123", To: "+441234567890", CallStatus: "completed" };
    expect(parseTwilioVoiceWebhook(base)!.durationSec).toBeUndefined();
    expect(parseTwilioVoiceWebhook({ ...base, CallDuration: "" })!.durationSec).toBeUndefined();
    expect(parseTwilioVoiceWebhook({ ...base, CallDuration: "abc" })!.durationSec).toBeUndefined();
    expect(parseTwilioVoiceWebhook({ ...base, CallDuration: "-5" })!.durationSec).toBeUndefined();
    // A fractional string is truncated to whole seconds (Twilio sends integers).
    expect(parseTwilioVoiceWebhook({ ...base, CallDuration: "42.9" })!.durationSec).toBe(42);
  });

  it("builds escaped TwiML", () => {
    expect(buildInboundTwiml()).toContain("<Response><Say>");
    expect(buildInboundTwiml('a & b <x>')).toContain("a &amp; b &lt;x&gt;");
    expect(buildAckDropTwiml()).toContain("not currently in service");
  });
});

describe("vapi verify + parse", () => {
  it("fails closed without a secret or signature", () => {
    expect(verifyVapiSignature({ signature: "abc", rawBody: "{}" })).toBe(false);
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    expect(verifyVapiSignature({ signature: null, rawBody: "{}" })).toBe(false);
    expect(verifyVapiSignature({ signature: "deadbeef", rawBody: "{}" })).toBe(false);
  });

  it("accepts a correct HMAC (the opt-in low-level verifier)", () => {
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    const body = JSON.stringify({ message: { type: "status-update", status: "ringing" } });
    const sig = createHmac("sha256", "whsec").update(body, "utf8").digest("hex");
    expect(verifyVapiSignature({ signature: sig, rawBody: body })).toBe(true);
    expect(verifyVapiSignature({ signature: `sha256=${sig}`, rawBody: body })).toBe(true);
  });

  it("PRIMARY verifier accepts the X-Vapi-Secret shared secret (constant-time)", () => {
    const body = JSON.stringify({ message: { type: "assistant-request" } });
    // Fail-closed when unconfigured — never accept, even with a secret header.
    expect(verifyVapiWebhook({ secret: "whsec", rawBody: body })).toBe(false);

    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    expect(verifyVapiWebhook({ secret: "whsec", rawBody: body })).toBe(true);
    // Authorization: Bearer <secret> is an accepted alias.
    expect(verifyVapiWebhook({ authorization: "Bearer whsec", rawBody: body })).toBe(true);
    // Wrong / missing secret ⇒ reject fail-closed.
    expect(verifyVapiWebhook({ secret: "nope", rawBody: body })).toBe(false);
    expect(verifyVapiWebhook({ rawBody: body })).toBe(false);
  });

  it("does NOT accept an HMAC signature by default (Vapi never sends it) — opt-in only", () => {
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    const body = JSON.stringify({ message: { type: "assistant-request" } });
    const sig = createHmac("sha256", "whsec").update(body, "utf8").digest("hex");
    // A valid HMAC alone must NOT pass while the shared-secret scheme is primary.
    expect(verifyVapiWebhook({ signature: sig, rawBody: body })).toBe(false);
    // …but a valid shared secret DOES pass (this is the fail-close-on-real-traffic fix).
    expect(verifyVapiWebhook({ secret: "whsec", rawBody: body })).toBe(true);
    // With the explicit opt-in on, the HMAC path becomes an accepted fallback.
    process.env.VAPI_WEBHOOK_HMAC = "true";
    expect(verifyVapiWebhook({ signature: sig, rawBody: body })).toBe(true);
    expect(verifyVapiWebhook({ signature: "deadbeef", rawBody: body })).toBe(false);
  });

  it("maps vapi status vocab", () => {
    expect(mapVapiStatus("in-progress")).toBe("in_progress");
    expect(mapVapiStatus("ended")).toBe("completed");
    expect(mapVapiStatus("ended", "customer-did-not-answer no-answer")).toBe("no_answer");
    expect(mapVapiStatus("forwarding")).toBe("transferred");
  });

  it("returns null on bad JSON or missing call id", () => {
    expect(parseVapiWebhook({ rawBody: "not json", params: {} })).toBeNull();
    expect(
      parseVapiWebhook({ rawBody: JSON.stringify({ message: { status: "ringing" } }), params: {} }),
    ).toBeNull();
  });

  it("normalises a vapi webhook", () => {
    const body = JSON.stringify({
      message: {
        type: "status-update",
        status: "in-progress",
        call: {
          id: "vapi_1",
          customer: { number: "+447700900123" },
          phoneNumber: { number: "+441234567890" },
        },
      },
    });
    const n = parseVapiWebhook({ rawBody: body, params: {} });
    expect(n!.provider).toBe("vapi");
    expect(n!.providerCallId).toBe("vapi_1");
    expect(n!.from).toBe("+447700900123");
    expect(n!.to).toBe("+441234567890");
    expect(n!.status).toBe("in_progress");
  });
});

describe("getVoiceProvider factory", () => {
  it("returns null when unconfigured", () => {
    expect(getVoiceProvider()).toBeNull();
  });

  it("returns twilio when flag + creds present", () => {
    process.env.NEXT_PUBLIC_FEATURE_VOICE_INBOUND = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(getVoiceProvider()?.id).toBe("twilio");
  });

  it("returns null with creds but flag off (two-switch)", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(getVoiceProvider()).toBeNull();
  });
});

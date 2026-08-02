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

  it("accepts a correct HMAC", () => {
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    const body = JSON.stringify({ message: { type: "status-update", status: "ringing" } });
    const sig = createHmac("sha256", "whsec").update(body, "utf8").digest("hex");
    expect(verifyVapiSignature({ signature: sig, rawBody: body })).toBe(true);
    expect(verifyVapiSignature({ signature: `sha256=${sig}`, rawBody: body })).toBe(true);
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

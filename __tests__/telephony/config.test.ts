import { describe, it, expect, afterEach } from "vitest";
import {
  voiceInboundFeatureEnabled,
  isVoiceProviderConfigured,
  isVoiceProviderResolvable,
  isVoiceConfigured,
  selectedVoiceProvider,
} from "@/lib/telephony/config";

/**
 * The activation predicates are DARK by default and require BOTH switches. These
 * pin the two-switch posture: a credential alone (flag off) is not configured,
 * and the flag alone (no credential) is not configured either.
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

describe("voice telephony config — dark by default, two switches", () => {
  it("is dark with nothing set", () => {
    expect(voiceInboundFeatureEnabled()).toBe(false);
    expect(isVoiceProviderResolvable()).toBe(false);
    expect(isVoiceConfigured()).toBe(false);
  });

  it("flag ON but NO credential is still not configured", () => {
    process.env.NEXT_PUBLIC_FEATURE_VOICE_INBOUND = "true";
    expect(voiceInboundFeatureEnabled()).toBe(true);
    expect(isVoiceProviderResolvable()).toBe(false);
    expect(isVoiceConfigured()).toBe(false);
  });

  it("credential present but flag OFF is still not configured (two-switch)", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(isVoiceProviderConfigured("twilio")).toBe(true);
    expect(isVoiceProviderResolvable()).toBe(true);
    expect(voiceInboundFeatureEnabled()).toBe(false);
    expect(isVoiceConfigured()).toBe(false);
  });

  it("flag ON + Twilio creds → configured, provider=twilio", () => {
    process.env.NEXT_PUBLIC_FEATURE_VOICE_INBOUND = "true";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(selectedVoiceProvider()).toBe("twilio");
    expect(isVoiceConfigured()).toBe(true);
  });

  it("auto prefers Twilio, falls back to Vapi", () => {
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    expect(selectedVoiceProvider()).toBe("vapi");
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    expect(selectedVoiceProvider()).toBe("twilio");
  });

  it('"none"/"off" is a kill switch even with creds', () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.COMMS_VOICE_PROVIDER = "none";
    expect(selectedVoiceProvider()).toBeNull();
    expect(isVoiceProviderResolvable()).toBe(false);
  });

  it("Vapi needs only its webhook secret", () => {
    expect(isVoiceProviderConfigured("vapi")).toBe(false);
    process.env.VAPI_WEBHOOK_SECRET = "whsec";
    expect(isVoiceProviderConfigured("vapi")).toBe(true);
  });
});

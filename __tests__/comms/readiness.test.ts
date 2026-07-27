import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getEmailReadiness,
  getSmsReadiness,
  getWhatsAppReadiness,
  getMissedCallTextbackReadiness,
  getCommsReadiness,
} from "@/lib/comms/readiness";

/**
 * Communications readiness (First Impression Experience — P2/P3). Pure env-driven predicates that
 * make missing provider config LOUD instead of silent. Tested behaviourally: configured ⇒ ready,
 * absent/blank ⇒ not-ready with the exact missing vars listed.
 */

afterEach(() => vi.unstubAllEnvs());

describe("email readiness — the customer-facing silent-failure guard", () => {
  it("is configured when RESEND_API_KEY is present", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    expect(getEmailReadiness()).toEqual({ configured: true, provider: "resend", missing: [] });
  });
  it("is NOT configured (and names the missing key) when absent or blank", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const r = getEmailReadiness();
    expect(r.configured).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.missing).toContain("RESEND_API_KEY");
  });
});

describe("sms readiness — needs account creds AND a sender", () => {
  it("configured only when all three Twilio vars are present", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_SMS_FROM", "+441234");
    expect(getSmsReadiness().configured).toBe(true);
  });
  it("lists exactly what is missing when the sender is absent", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_SMS_FROM", "");
    const r = getSmsReadiness();
    expect(r.configured).toBe(false);
    expect(r.missing).toEqual(["TWILIO_SMS_FROM"]);
  });
});

describe("whatsapp readiness — token + phone-number id", () => {
  it("configured when both present; missing listed otherwise", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "t");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    expect(getWhatsAppReadiness().configured).toBe(true);
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    expect(getWhatsAppReadiness().missing).toEqual(["WHATSAPP_PHONE_NUMBER_ID"]);
  });
});

describe("missed-call text-back readiness (P3) — flag AND sms sender", () => {
  it("ready ONLY when the flag is on and SMS is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_SMS_FROM", "+441234");
    expect(getMissedCallTextbackReadiness()).toEqual({
      ready: true,
      flagEnabled: true,
      smsConfigured: true,
      missing: [],
    });
  });

  it("'one env flip from live' — SMS configured, flag off", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK", "false");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC1");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "tok");
    vi.stubEnv("TWILIO_SMS_FROM", "+441234");
    const r = getMissedCallTextbackReadiness();
    expect(r.ready).toBe(false);
    expect(r.smsConfigured).toBe(true);
    expect(r.flagEnabled).toBe(false);
    expect(r.missing).toEqual(["NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK=true"]);
  });

  it("'Twilio provisioning outstanding' — flag on, SMS unconfigured", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_SMS_FROM", "");
    const r = getMissedCallTextbackReadiness();
    expect(r.ready).toBe(false);
    expect(r.flagEnabled).toBe(true);
    expect(r.smsConfigured).toBe(false);
    expect(r.missing).toContain("TWILIO_ACCOUNT_SID");
  });

  it("dark by default (nothing set) — not ready, never throws", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK", "");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    expect(getMissedCallTextbackReadiness().ready).toBe(false);
  });
});

describe("getCommsReadiness — the one-call snapshot", () => {
  it("headline customerEmailReady tracks the email provider", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(getCommsReadiness().customerEmailReady).toBe(false);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const snap = getCommsReadiness();
    expect(snap.customerEmailReady).toBe(true);
    expect(snap.email.configured).toBe(true);
    // shape completeness — every channel reported
    expect(snap).toHaveProperty("sms");
    expect(snap).toHaveProperty("whatsapp");
    expect(snap).toHaveProperty("missedCallTextback");
  });
});

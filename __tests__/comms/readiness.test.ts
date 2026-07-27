import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getEmailReadiness,
  getSmsReadiness,
  getWhatsAppReadiness,
  getMissedCallTextbackReadiness,
  getCommsReadiness,
  composeProviderReadiness,
  hasSenderImplementation,
} from "@/lib/comms/readiness";

/**
 * Communications readiness (First Impression Experience — P2/P3). Pure env-driven predicates that
 * make missing provider config LOUD instead of silent. Tested behaviourally: configured ⇒ ready,
 * absent/blank ⇒ not-ready with the exact missing vars listed.
 *
 * Section F below is the FALSE-READINESS regression suite: readiness must never report a capability
 * as ready when the runtime cannot actually perform it.
 */

afterEach(() => vi.unstubAllEnvs());

/** Everything WhatsApp needs to genuinely be able to send. Set in full, then removed one at a time. */
function stubWhatsAppFullyLive(): void {
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
}

describe("email readiness — the customer-facing silent-failure guard", () => {
  it("is configured when RESEND_API_KEY is present", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const r = getEmailReadiness();
    expect(r).toEqual({
      configured: true,
      credentialsPresent: true,
      senderImplemented: true,
      selectionUsable: true,
      providerResolvable: true,
      enabled: true,
      outboundReady: true,
      provider: "resend",
      missing: [],
      blockers: [],
    });
  });
  it("is NOT configured (and names the missing key) when absent or blank", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const r = getEmailReadiness();
    expect(r.configured).toBe(false);
    expect(r.outboundReady).toBe(false);
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
    expect(getSmsReadiness().outboundReady).toBe(true);
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
  it("credentials present when both set; missing listed otherwise", () => {
    stubWhatsAppFullyLive();
    expect(getWhatsAppReadiness().credentialsPresent).toBe(true);
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

// =====================================================================================
// F. FALSE-READINESS REGRESSION SUITE
//
//    A readiness probe that goes green over a dead path is worse than no probe: it
//    actively suppresses the alert that would have caught the misconfiguration. The
//    incident these lock down: WhatsApp reported ready from WHATSAPP_ACCESS_TOKEN +
//    WHATSAPP_PHONE_NUMBER_ID alone, while the build contained NO WhatsApp sender —
//    so setting two env vars flipped /api/health to whatsapp:true over a capability
//    that was structurally incapable of sending a single message.
// =====================================================================================

describe("F1. no sender implementation ⇒ outboundReady can NEVER be true", () => {
  it("stays false with credentials present, provider selected, and the flag ON", () => {
    // The exact shape of the original bug: EVERYTHING an operator controls is satisfied.
    const r = composeProviderReadiness({
      channel: "whatsapp",
      vendor: "meta",
      missing: [], // credentials fully present
      providerSelection: "meta", // provider explicitly selected
      enabled: true, // feature flag ON
      senderImplemented: false, // …but nothing in this build can send
    });

    expect(r.credentialsPresent).toBe(true);
    expect(r.selectionUsable).toBe(true);
    expect(r.enabled).toBe(true);
    // The invariant. Configuration cannot manufacture a capability that does not exist.
    expect(r.outboundReady).toBe(false);
    expect(r.providerResolvable).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.blockers).toContain("no whatsapp sender implementation in this build");
  });

  it("holds for EVERY channel — the rule is structural, not WhatsApp-specific", () => {
    for (const channel of ["email", "sms", "whatsapp"] as const) {
      const r = composeProviderReadiness({
        channel,
        vendor: "any",
        missing: [],
        providerSelection: "auto",
        enabled: true,
        senderImplemented: false,
      });
      expect(r.outboundReady, `${channel} must not be outboundReady without a sender`).toBe(false);
    }
  });

  it("`missing` being empty is NOT sufficient — blockers still name the gap", () => {
    const r = composeProviderReadiness({
      channel: "whatsapp",
      vendor: "meta",
      missing: [],
      providerSelection: "auto",
      enabled: true,
      senderImplemented: false,
    });
    expect(r.missing).toEqual([]); // credentials really are all present…
    expect(r.blockers.length).toBeGreaterThan(0); // …but activation is still blocked
  });
});

describe("F2. WhatsApp: credentials and flag are BOTH required", () => {
  it("credentials WITHOUT the flag ⇒ NOT ready", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "false");

    const r = getWhatsAppReadiness();
    expect(r.credentialsPresent).toBe(true); // honest about the secrets…
    expect(r.enabled).toBe(false);
    expect(r.outboundReady).toBe(false); // …but not about being able to send
    expect(r.inboundReady).toBe(false);
    expect(r.blockers).toContain("NEXT_PUBLIC_FEATURE_WHATSAPP=true");
  });

  it("the flag WITHOUT credentials ⇒ NOT ready", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");

    const r = getWhatsAppReadiness();
    expect(r.enabled).toBe(true);
    expect(r.credentialsPresent).toBe(false);
    expect(r.outboundReady).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.blockers).toEqual(
      expect.arrayContaining(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]),
    );
  });

  it("both together ⇒ ready (the fields are necessary, not merely obstructive)", () => {
    stubWhatsAppFullyLive();
    const r = getWhatsAppReadiness();
    expect(r.outboundReady).toBe(true);
    expect(r.provider).toBe("meta");
    expect(r.blockers).toEqual([]);
  });

  it("an explicitly disabled provider selection kills readiness even when fully credentialled", () => {
    stubWhatsAppFullyLive();
    vi.stubEnv("COMMS_WHATSAPP_PROVIDER", "off"); // the documented kill switch
    const r = getWhatsAppReadiness();
    expect(r.credentialsPresent).toBe(true);
    expect(r.selectionUsable).toBe(false);
    expect(r.outboundReady).toBe(false);
    expect(r.provider).toBeNull();
  });

  it("an UNKNOWN provider name is treated as not-ready (mirrors the seam degrading to null)", () => {
    stubWhatsAppFullyLive();
    vi.stubEnv("COMMS_WHATSAPP_PROVIDER", "totally-made-up");
    expect(getWhatsAppReadiness().outboundReady).toBe(false);
  });

  it("dark by default — nothing set at all, and it never throws", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "");
    vi.stubEnv("COMMS_WHATSAPP_PROVIDER", "");
    expect(() => getWhatsAppReadiness()).not.toThrow();
    const r = getWhatsAppReadiness();
    expect(r.outboundReady).toBe(false);
    expect(r.inboundReady).toBe(false);
  });
});

describe("F3. WhatsApp inbound and outbound are reported independently", () => {
  it("inbound can be ready while outbound is NOT (the state `main` actually shipped)", () => {
    // #359 put the webhook on main with no sender. Inbound live, outbound impossible.
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "true");
    vi.stubEnv("WHATSAPP_APP_SECRET", "sec");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "vtok");
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", ""); // no outbound credentials
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");

    const r = getWhatsAppReadiness();
    expect(r.inboundReady).toBe(true);
    expect(r.outboundReady).toBe(false);
  });

  it("outbound can be ready while inbound is NOT (no app secret / verify token)", () => {
    stubWhatsAppFullyLive();
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", "");

    const r = getWhatsAppReadiness();
    expect(r.outboundReady).toBe(true);
    expect(r.inboundReady).toBe(false);
    expect(r.inboundBlockers).toEqual(
      expect.arrayContaining(["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"]),
    );
  });
});

describe("F4. /api/health reports 'can actually send', not 'a key is set'", () => {
  it("whatsapp is FALSE with credentials but no flag — the false-green that started this", () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_WHATSAPP", "false");

    // The exact expression app/api/health/route.ts serialises.
    expect(getCommsReadiness().whatsapp.outboundReady).toBe(false);
  });

  it("email is FALSE when the provider is explicitly disabled despite a live key", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("COMMS_EMAIL_PROVIDER", "off");
    expect(getCommsReadiness().email.outboundReady).toBe(false);
    expect(getCommsReadiness().customerEmailReady).toBe(false);
  });
});

describe("F5. the sender registry must not drift from the real provider seam", () => {
  // `readiness.ts` is edge-safe and cannot import the `server-only` @/lib/comms module, so
  // SENDER_IMPLEMENTED is a hand-maintained mirror. This asserts the mirror still matches the
  // source: a channel claiming a sender must actually have one wired into the seam.
  const seam = readFileSync(resolve(process.cwd(), "lib/comms/index.ts"), "utf8");

  const FACTORY: Record<string, string> = {
    email: "createResendEmailProvider",
    sms: "createTwilioSmsProvider",
    whatsapp: "createMetaWhatsAppProvider",
  };

  for (const channel of ["email", "sms", "whatsapp"] as const) {
    it(`${channel}: claims a sender ⇒ ${FACTORY[channel]} is imported AND invoked in lib/comms/index.ts`, () => {
      if (!hasSenderImplementation(channel)) return; // nothing to guard
      expect(seam).toContain(`import { ${FACTORY[channel]} }`);
      expect(seam).toContain(`${FACTORY[channel]}()`);
    });
  }
});

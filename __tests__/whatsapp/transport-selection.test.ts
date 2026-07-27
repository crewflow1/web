import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getWhatsAppProvider,
  isWhatsAppConfigured,
  getTransportProvider,
  getSmsProvider,
  smsCostUsd,
} from "@/lib/comms";
import { transportChannelForInbound } from "@/server/services/receptionist";

/**
 * Channel-aware transport selection (Part 6) — unit tier.
 *
 * Three pinned guarantees, no Postgres:
 *   1. transportChannelForInbound maps each inbound channel to its OUTBOUND transport,
 *      and whatsapp_msg maps to `whatsapp` — NEVER `sms`. This pure mapper is the
 *      type-level half of "WhatsApp never falls back to SMS".
 *   2. getWhatsAppProvider is DARK — null for every config, so the transport records
 *      failed/no_provider on channel='whatsapp' and sends nothing (the CI path).
 *   3. getTransportProvider is the no-fallback registry: 'whatsapp' resolves via the
 *      WhatsApp factory, 'sms' via the SMS factory. (No-bypass is pinned structurally
 *      by the security invariant suite; end-to-end routing by the integration tier.)
 */

describe("transportChannelForInbound — the inbound→outbound channel bridge", () => {
  it("maps phone and sms to the SMS transport (the R5 path, unchanged)", () => {
    expect(transportChannelForInbound("phone")).toBe("sms");
    expect(transportChannelForInbound("sms")).toBe("sms");
  });

  it("maps BOTH whatsapp channels to the WhatsApp transport — NEVER sms", () => {
    expect(transportChannelForInbound("whatsapp_msg")).toBe("whatsapp");
    expect(transportChannelForInbound("whatsapp_call")).toBe("whatsapp");
    // The load-bearing safety assertion: a WhatsApp inbound can never resolve to SMS.
    expect(transportChannelForInbound("whatsapp_msg")).not.toBe("sms");
  });

  it("maps channels with no wired transport to null (drafted/held, never sent)", () => {
    expect(transportChannelForInbound("instagram_dm")).toBeNull();
    expect(transportChannelForInbound("facebook_dm")).toBeNull();
    expect(transportChannelForInbound("manual")).toBeNull();
  });
});

describe("getWhatsAppProvider — DARK by default (draft-first safety)", () => {
  it("returns null in the unit env — no Meta sender is wired, so outbound is impossible", () => {
    expect(getWhatsAppProvider()).toBeNull();
    expect(isWhatsAppConfigured()).toBe(false);
  });
});

/**
 * The feature flag is a KILL SWITCH at the provider seam, not merely a gate on new
 * conversations.
 *
 * Why this matters: NEXT_PUBLIC_FEATURE_WHATSAPP gates conversation ORIGINATION (the webhook
 * 404s, canRunReceptionistChannel returns false) — but `deliverHumanReviewedReply` reaches the
 * transport seam directly when an operator approves a held draft. Without a flag check in
 * `getWhatsAppProvider`, a draft created while the flag was on could be approved and SENT after
 * the flag was switched off, so long as credentials were present. These tests pin the flag as a
 * genuine channel-wide kill switch: flag off ⇒ no provider ⇒ nothing can send, on EVERY path.
 *
 * `vi.resetModules()` + dynamic import is required because `lib/env` validates and freezes
 * credentials at import time — re-importing is the only way to observe a credentialled build.
 */
describe("getWhatsAppProvider — NEXT_PUBLIC_FEATURE_WHATSAPP is a true kill switch", () => {
  const FLAG = "NEXT_PUBLIC_FEATURE_WHATSAPP";

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Re-import the seam with the CURRENT env, so `lib/env` re-reads stubbed credentials. */
  async function freshSeam() {
    vi.resetModules();
    return await import("@/lib/comms");
  }

  it("fully credentialled + flag OFF ⇒ still null (the human-approval leak this closes)", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    vi.stubEnv(FLAG, "false");

    const comms = await freshSeam();
    expect(comms.getWhatsAppProvider()).toBeNull();
    expect(comms.isWhatsAppConfigured()).toBe(false);
    // and the no-fallback registry inherits it — nothing borrows the SMS provider either
    expect(comms.getTransportProvider("whatsapp")).toBeNull();
  });

  it("fully credentialled + flag ABSENT ⇒ null (default-deny, not default-allow)", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    // Genuinely unset, not blank: lib/env.ts types this flag as z.enum(["true","false"])
    // with .default("false"), so `undefined` takes the safe default while a BLANK string is
    // a validation error that fails the boot loudly. Absence must mean dark.
    vi.stubEnv(FLAG, undefined);

    const comms = await freshSeam();
    expect(comms.getWhatsAppProvider()).toBeNull();
  });

  it("flag ON but NO credentials ⇒ null (the flag alone never enables a send)", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    vi.stubEnv(FLAG, "true");

    const comms = await freshSeam();
    expect(comms.getWhatsAppProvider()).toBeNull();
  });

  it("flag ON + credentials + provider explicitly disabled ⇒ null (second kill switch)", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    vi.stubEnv(FLAG, "true");
    vi.stubEnv("COMMS_WHATSAPP_PROVIDER", "off");

    const comms = await freshSeam();
    expect(comms.getWhatsAppProvider()).toBeNull();
  });

  it("ONLY the full set — flag ON + both credentials — resolves a provider", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tok");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "PNID");
    vi.stubEnv(FLAG, "true");

    const comms = await freshSeam();
    const provider = comms.getWhatsAppProvider();
    // Proves the gates above are genuinely load-bearing rather than trivially always-null.
    expect(provider).not.toBeNull();
    expect(provider?.info).toEqual({ provider: "meta", channel: "whatsapp" });
  });
});

describe("getTransportProvider — the no-fallback channel→provider registry", () => {
  it("routes 'whatsapp' through the WhatsApp factory (dark → null), consistent with getWhatsAppProvider", () => {
    expect(getTransportProvider("whatsapp")).toBe(getWhatsAppProvider());
    expect(getTransportProvider("whatsapp")).toBeNull();
  });

  it("routes 'sms' through the SMS factory, consistent with getSmsProvider", () => {
    // Null in the unit env (no Twilio creds) — the point is it resolves via the SMS factory.
    expect(getTransportProvider("sms")).toBe(getSmsProvider());
  });
});

describe("smsCostUsd — WhatsApp is unpriced (cost is observability, never a gate)", () => {
  it("returns null for meta:whatsapp — recorded as unknown cost, never blocks a send", () => {
    expect(smsCostUsd({ provider: "meta", channel: "whatsapp" })).toBeNull();
  });
});

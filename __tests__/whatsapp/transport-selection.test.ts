import { describe, it, expect } from "vitest";
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

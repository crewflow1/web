import { describe, it, expect } from "vitest";
import { getSmsProvider, isSmsConfigured, smsCostUsd } from "@/lib/comms";
import { createTwilioSmsProvider } from "@/lib/comms/providers/twilio";

/**
 * SMS provider seam — unit tier (Directive #018 R5, the first outbound transport).
 *
 * The seam's whole graceful-degradation contract is the `null` it returns when nothing
 * is configured — the path CI exercises end to end (CI sets no Twilio credentials).
 * These tests pin that contract, the provider identity, the throw-on-failure send, and
 * the metered cost ledger, WITHOUT loading the vendor SDK (the provider throws on
 * missing credentials BEFORE its dynamic import). Mirrors how the email seam is
 * unit-tested; the real send/record behaviour is pinned against Postgres in the
 * integration tier (transport-pipeline.test.ts).
 */

describe("getSmsProvider — the graceful-degradation seam", () => {
  it("returns null when no Twilio credentials are configured (the CI path)", () => {
    // The unit env sets no TWILIO_* vars, so "auto" resolves to no provider — the
    // transport then records a terminal failed/no_provider attempt and sends nothing.
    expect(getSmsProvider()).toBeNull();
    expect(isSmsConfigured()).toBe(false);
  });
});

describe("createTwilioSmsProvider — identity and the throw-on-failure contract", () => {
  it("advertises the twilio:sms identity", () => {
    const provider = createTwilioSmsProvider();
    expect(provider.info).toEqual({ provider: "twilio", channel: "sms" });
  });

  it("send() THROWS when misconfigured — never a silent no-op, never a vendor call", async () => {
    // No credentials in the unit env → the defensive guard throws BEFORE any dynamic
    // import of the Twilio SDK, so the canonical service records a `failed` attempt.
    const provider = createTwilioSmsProvider();
    await expect(provider.send({ to: "+447700900000", body: "hi" })).rejects.toThrow(
      /twilio: missing account SID/i,
    );
  });
});

describe("smsCostUsd — the metered cost ledger", () => {
  it("prices a Twilio SMS segment", () => {
    expect(smsCostUsd({ provider: "twilio", channel: "sms" })).toBe(0.04);
  });

  it("returns null for an unpriced provider/channel (cost is observability, never a gate)", () => {
    expect(smsCostUsd({ provider: "unknown", channel: "sms" })).toBeNull();
    expect(smsCostUsd({ provider: "twilio", channel: "voice" })).toBeNull();
  });
});

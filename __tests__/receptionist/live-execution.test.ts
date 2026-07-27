import { afterEach, describe, it, expect, vi } from "vitest";
import { isMissedCallTextbackLive } from "@/server/services/receptionist";

/**
 * Controlled Live Execution — the feature-flag gate, unit tier (the AI Receptionist
 * Programme, R6 — CONTROLLED LIVE EXECUTION).
 *
 * `isMissedCallTextbackLive()` (server/services/receptionist.ts) is the SINGLE runtime
 * switch that arms the first real customer-facing behaviour — the missed-call SMS
 * text-back. R6's cardinal safety property is that it DEFAULTS OFF: with the flag unset,
 * or set to anything but the exact string "true", no outbound is even considered — the
 * inbound flow stays byte-for-byte its pre-R6 self. These tests pin that contract without
 * a database; the end-to-end OFF/ON behaviour (zero SMS when off; the canonical pipeline
 * when on) is proven against real Postgres in
 * __tests__/integration/receptionist/live-execution-pipeline.test.ts.
 *
 * The flag is read from process.env at CALL TIME (not the frozen lib/env singleton), so
 * it is a genuine runtime toggle — drivable here via vi.stubEnv, exactly as it would be
 * flipped in a deploy.
 */

const FLAG = "NEXT_PUBLIC_FEATURE_MISSED_CALL_TEXTBACK";

describe("isMissedCallTextbackLive — the default-OFF live-execution gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is OFF when the flag is unset (the default — the CI path and the safe prod default)", () => {
    // The unit env sets no such var, so the gate resolves to OFF with no stub at all.
    expect(process.env[FLAG]).toBeUndefined();
    expect(isMissedCallTextbackLive()).toBe(false);
  });

  it('is OFF when the flag is explicitly "false"', () => {
    vi.stubEnv(FLAG, "false");
    expect(isMissedCallTextbackLive()).toBe(false);
  });

  it('is ON only for the exact string "true"', () => {
    vi.stubEnv(FLAG, "true");
    expect(isMissedCallTextbackLive()).toBe(true);
  });

  it('is OFF for any other value — only the exact "true" arms live execution', () => {
    // Defence in depth: the env schema already constrains the flag to "true" | "false"
    // at boot, but the gate itself refuses to be armed by an accidental truthy-looking
    // value — no "1", no casing variant, no stray whitespace.
    for (const value of ["1", "TRUE", "True", "yes", "on", "enabled", " true", "true "]) {
      vi.stubEnv(FLAG, value);
      expect(
        isMissedCallTextbackLive(),
        `value ${JSON.stringify(value)} must NOT arm live execution`,
      ).toBe(false);
    }
  });
});

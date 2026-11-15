import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

/**
 * loadAnsweringPolicy (Twilio receptionist PR 2) — the I/O half that feeds the
 * pure decideAnswering. Hermetic: the admin client is mocked. Pins: the DISABLED
 * fallback on no org / no row / DB error (so the webhook degrades to the prior
 * behaviour), E.164 normalisation of staff numbers, structured weekly-hours
 * parsing, and that a bad stored value never reaches the policy.
 */

const maybeSingle = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

async function load() {
  return (await import("@/lib/telephony/answering-config")).loadAnsweringPolicy;
}

describe("loadAnsweringPolicy", () => {
  beforeEach(() => maybeSingle.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("returns a DISABLED policy for a missing orgId (no query)", async () => {
    const fn = await load();
    const p = await fn("");
    expect(p.config.enabled).toBe(false);
    expect(p.staffNumbers).toEqual([]);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("returns a DISABLED policy when there is no row", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const fn = await load();
    const p = await fn("org-1");
    expect(p.config.enabled).toBe(false);
  });

  it("returns a DISABLED policy on a DB error (degrade, never throw)", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const fn = await load();
    const p = await fn("org-1");
    expect(p.config.enabled).toBe(false);
  });

  it("maps a configured row into a validated policy", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        enabled: true,
        answering_mode: "missed_only",
        timezone: "Europe/London",
        weekly_hours: {
          mon: { open: "08:00", close: "17:00" },
          sat: null,
        },
        closures: ["2026-12-25", "garbage"],
        ring_timeout_seconds: 30,
        staff_numbers: ["+447700900001", "07700 900002", "(invalid)", "+447700900001"],
        fallback_number: "+441234000000",
        urgent_escalation_number: "not-a-number",
        greeting: "  Hi there  ",
        recording_enabled: true,
        transcription_enabled: false,
        recording_consent_message: "This call may be recorded.",
      },
      error: null,
    });
    const fn = await load();
    const p = await fn("org-1");

    expect(p.config.enabled).toBe(true);
    expect(p.config.mode).toBe("missed_only");
    expect(p.config.ringTimeoutSeconds).toBe(30);
    expect(p.config.weekly.mon).toEqual({ open: "08:00", close: "17:00" });
    expect(p.config.weekly.sat).toBeNull();
    // closures: only the valid YYYY-MM-DD survives.
    expect(p.config.closures).toEqual(["2026-12-25"]);
    // staff numbers: normalised to E.164, deduped, invalid dropped.
    expect(p.staffNumbers).toEqual(["+447700900001"]);
    expect(p.config.hasStaffNumbers).toBe(true);
    // fallback valid, urgent invalid → null, greeting trimmed.
    expect(p.fallbackNumber).toBe("+441234000000");
    expect(p.urgentNumber).toBeNull();
    expect(p.greeting).toBe("Hi there");
    expect(p.recordingEnabled).toBe(true);
    expect(p.consentMessage).toBe("This call may be recorded.");
  });

  it("clamps an out-of-range ring timeout and defaults an unknown mode", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        enabled: true,
        answering_mode: "nonsense",
        timezone: null,
        weekly_hours: null,
        closures: null,
        ring_timeout_seconds: 9999,
        staff_numbers: null,
        fallback_number: null,
        urgent_escalation_number: null,
        greeting: null,
        recording_enabled: null,
        transcription_enabled: null,
        recording_consent_message: null,
      },
      error: null,
    });
    const fn = await load();
    const p = await fn("org-1");
    expect(p.config.mode).toBe("both"); // unknown → safe default
    expect(p.config.ringTimeoutSeconds).toBe(120); // clamped
    expect(p.config.timezone).toBe("Europe/London"); // null → default
    expect(p.config.hasStaffNumbers).toBe(false);
  });
});

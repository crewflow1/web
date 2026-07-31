import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostcodeDistrict } from "@/lib/weather/types";

/**
 * The service's dark path — proven at RUNTIME, not by reading the source.
 *
 * `__tests__/security/weather-intelligence.test.ts` checks that the readiness
 * guard appears BEFORE `createClient` in the source text. That is a useful
 * tripwire but it is still a claim about characters in a file. This file proves
 * the behaviour: it replaces the Supabase client factory with a spy that FAILS
 * if it is called at all, and asserts that a full snapshot still comes back.
 *
 * Why it matters beyond tidiness: with no provider bound, `weather_readings` is
 * provably empty (no INSERT policy, and nothing in the build writes it), so a
 * query would return zero rows on every page load for every user forever.
 * Skipping it is what makes wiring this feature into a screen cost nothing
 * measurable — the same reasoning as the AI governor's dark short-circuit
 * landing before its budget reservation.
 *
 * The second, more important assertion: the snapshot returned on that path
 * reports `unknown` for every work type. A dark build must never hand a surface
 * something that renders as "no warnings".
 */

const createClient = vi.fn(async () => {
  throw new Error(
    "buildWeatherSnapshot constructed a Supabase client on the DARK path — " +
      "the readiness short-circuit must return before any database access",
  );
});

vi.mock("@/lib/supabase/server", () => ({ createClient }));

// Imported AFTER the mock is registered.
const { buildWeatherSnapshot } = await import("@/server/services/weather");
const { WORK_TYPES } = await import("@/lib/weather/thresholds");

const LS1 = "LS1" as PostcodeDistrict;
const FROM = new Date("2026-11-12T06:00:00Z");
const TO = new Date("2026-11-12T18:00:00Z");

beforeEach(() => {
  createClient.mockClear();
});

describe("buildWeatherSnapshot on the dark path", () => {
  it("never constructs a Supabase client", async () => {
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: LS1,
      workTypes: [...WORK_TYPES],
      from: FROM,
      to: TO,
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(snapshot.shortCircuited).toBe(true);
  });

  it("reports the honest readiness state rather than throwing", async () => {
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: LS1,
      workTypes: ["concrete_pour"],
      from: FROM,
      to: TO,
    });
    expect(snapshot.readiness.available).toBe(false);
    expect(snapshot.statusLine).toMatch(/not configured/i);
    expect(snapshot.window?.readings).toEqual([]);
  });

  it("returns `unknown` for EVERY work type — never something that reads as an all-clear", async () => {
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: LS1,
      workTypes: [...WORK_TYPES],
      from: FROM,
      to: TO,
    });
    expect(snapshot.assessments).toHaveLength(WORK_TYPES.length);
    for (const a of snapshot.assessments) {
      expect(a.verdict, a.workType).toBe("unknown");
    }
  });

  it("still assesses rather than returning nothing — an empty screen would read as 'fine'", async () => {
    // The deliberate choice in the service: hand the EMPTY window to the decision
    // layer so it produces `unknown` with a caveat naming why, instead of
    // returning no assessments and letting a surface render silence.
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: LS1,
      workTypes: ["concrete_pour"],
      from: FROM,
      to: TO,
    });
    expect(snapshot.assessments.length).toBeGreaterThan(0);
    expect(snapshot.assessments[0]!.caveats.join(" ")).toMatch(/no weather data/i);
  });

  it("handles a job with NO postcode without inventing a district", async () => {
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: null,
      workTypes: [...WORK_TYPES],
      from: FROM,
      to: TO,
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(snapshot.district).toBeNull();
    expect(snapshot.window).toBeNull();
    expect(snapshot.assessments).toEqual([]);
  });

  it("carries antecedent rainfall through even on the dark path", async () => {
    // So the shape a caller passes is not silently dropped by the short-circuit.
    const snapshot = await buildWeatherSnapshot({
      orgId: "00000000-0000-0000-0000-000000000001",
      district: LS1,
      workTypes: ["groundworks"],
      from: FROM,
      to: TO,
      antecedentPrecipMm: 60,
      antecedentWindowHours: 72,
    });
    expect(snapshot.window?.antecedentPrecipMm).toBe(60);
    // Saturation alone would block — but temperature and rain are still unknown,
    // so the verdict is `not_viable` on the blocking breach it CAN establish.
    expect(snapshot.assessments[0]!.breaches.map((b) => b.thresholdId)).toContain(
      "groundworks.saturation_blocking",
    );
  });
});

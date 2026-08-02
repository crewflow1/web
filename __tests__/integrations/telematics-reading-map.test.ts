import { describe, it, expect } from "vitest";
import {
  mapSampleToReading,
  mapSamplesToReadings,
  normalizeSamsaraSamples,
  type TelematicsSample,
  type SamsaraVehicleStat,
} from "@/lib/integrations/telematics/reading-map";

/**
 * Telematics reading mapper — PURE mapper unit proofs (20261103).
 *
 * The mapper is the deterministic seam that turns provider-fetched vehicle samples
 * into `telematics_readings` rows keyed to the fleet_vehicles register. These tests
 * pin coordinate rounding (numeric(9,6)), the lat/lng PAIR rule (satisfying the
 * telematics_readings_latlng_pair CHECK), odometer rounding, the has-signal filter
 * (satisfying telematics_readings_has_signal), org/connection pinning, and the
 * Samsara metres→miles normaliser.
 */

const TARGET = {
  orgId: "11111111-1111-1111-1111-111111111111",
  connectionId: "22222222-2222-2222-2222-222222222222",
};

function sample(over: Partial<TelematicsSample>): TelematicsSample {
  return {
    vehicleId: "33333333-3333-3333-3333-333333333333",
    eventId: "evt-1",
    recordedAt: "2026-07-15T09:30:00Z",
    latitude: 51.5074,
    longitude: -0.1278,
    odometerMiles: 12345,
    ...over,
  };
}

describe("mapSampleToReading — pinning + basic shape", () => {
  it("pins org_id, connection_id, vehicle_id, source_event_id, recorded_at", () => {
    const row = mapSampleToReading(sample({}), TARGET);
    expect(row.org_id).toBe(TARGET.orgId);
    expect(row.connection_id).toBe(TARGET.connectionId);
    expect(row.vehicle_id).toBe("33333333-3333-3333-3333-333333333333");
    expect(row.source_event_id).toBe("evt-1");
    expect(row.recorded_at).toBe("2026-07-15T09:30:00Z");
  });

  it("rounds coordinates to 6dp and normalises negative zero", () => {
    const row = mapSampleToReading(
      sample({ latitude: 51.50741234, longitude: -0.12785678 }),
      TARGET,
    );
    expect(row.latitude).toBe(51.507412);
    expect(row.longitude).toBe(-0.127857);
    const zero = mapSampleToReading(sample({ latitude: 0, longitude: 0 }), TARGET);
    expect(Object.is(zero.latitude, -0)).toBe(false);
  });

  it("rounds odometer to whole miles and clamps to >= 0", () => {
    expect(mapSampleToReading(sample({ odometerMiles: 100.6 }), TARGET).odometer_miles).toBe(101);
    expect(mapSampleToReading(sample({ odometerMiles: -5 }), TARGET).odometer_miles).toBe(0);
  });
});

describe("mapSampleToReading — the lat/lng PAIR rule (CHECK compliance)", () => {
  it("keeps a full fix (both coordinates present)", () => {
    const row = mapSampleToReading(sample({ latitude: 51.5, longitude: -0.1 }), TARGET);
    expect(row.latitude).toBe(51.5);
    expect(row.longitude).toBe(-0.1);
  });

  it("drops a HALF-fix to null/null (lat without lng)", () => {
    const row = mapSampleToReading(
      sample({ latitude: 51.5, longitude: null, odometerMiles: 900 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.odometer_miles).toBe(900); // odometer-only sample survives
  });

  it("an odometer-only sample carries no fix", () => {
    const row = mapSampleToReading(
      sample({ latitude: null, longitude: null, odometerMiles: 500 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.odometer_miles).toBe(500);
  });

  it("degrades a non-finite coordinate to null", () => {
    const row = mapSampleToReading(
      sample({ latitude: Number.NaN, longitude: 5, odometerMiles: 10 }),
      TARGET,
    );
    // NaN lat → null, so the pair collapses to null/null.
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });
});

describe("mapSamplesToReadings — batch + has-signal filter", () => {
  it("maps every signal-bearing sample, preserving order", () => {
    const rows = mapSamplesToReadings(
      [
        sample({ eventId: "a", odometerMiles: 10, latitude: null, longitude: null }),
        sample({ eventId: "b", latitude: 51.5, longitude: -0.1, odometerMiles: null }),
      ],
      TARGET,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.source_event_id).toBe("a");
    expect(rows[1]!.source_event_id).toBe("b");
  });

  it("DROPS a sample with neither a fix nor an odometer (has_signal CHECK)", () => {
    const rows = mapSamplesToReadings(
      [
        sample({ eventId: "empty", latitude: null, longitude: null, odometerMiles: null }),
        sample({ eventId: "keep", odometerMiles: 5, latitude: null, longitude: null }),
      ],
      TARGET,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_event_id).toBe("keep");
  });

  it("an empty batch maps to no rows", () => {
    expect(mapSamplesToReadings([], TARGET)).toHaveLength(0);
  });
});

describe("normalizeSamsaraSamples — native shape → agnostic shape", () => {
  const RESOLVE = (id: string) =>
    id === "sam-1" ? "33333333-3333-3333-3333-333333333333" : null;

  function stat(over: Partial<SamsaraVehicleStat>): SamsaraVehicleStat {
    return {
      id: "sam-1",
      gps: {
        latitude: 51.5074,
        longitude: -0.1278,
        odometerMeters: 1609344, // exactly 1000 miles
        time: "2026-07-10T12:00:00Z",
      },
      ...over,
    };
  }

  it("converts odometer METRES → MILES (once, tested here)", () => {
    const n = normalizeSamsaraSamples([stat({})], RESOLVE)[0]!;
    // 1,609,344 m / 1609.344 = 1000 miles.
    expect(n.odometerMiles).toBeCloseTo(1000, 6);
  });

  it("carries the fix, event id (vehicle:time) and recordedAt", () => {
    const n = normalizeSamsaraSamples([stat({})], RESOLVE)[0]!;
    expect(n.latitude).toBe(51.5074);
    expect(n.longitude).toBe(-0.1278);
    expect(n.recordedAt).toBe("2026-07-10T12:00:00Z");
    expect(n.eventId).toBe("sam-1:2026-07-10T12:00:00Z");
    expect(n.vehicleId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("SKIPS an unmapped vehicle rather than guessing", () => {
    const out = normalizeSamsaraSamples([stat({ id: "unknown" })], RESOLVE);
    expect(out).toHaveLength(0);
  });

  it("no odometer metres → null odometer (not NaN)", () => {
    const n = normalizeSamsaraSamples(
      [stat({ gps: { latitude: 1, longitude: 2, time: "2026-01-01T00:00:00Z" } })],
      RESOLVE,
    )[0]!;
    expect(n.odometerMiles).toBeNull();
  });

  it("round-trips through the mapper to a valid, signal-bearing reading", () => {
    const normalized = normalizeSamsaraSamples([stat({})], RESOLVE);
    const rows = mapSamplesToReadings(normalized, TARGET);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.odometer_miles).toBe(1000);
    expect(rows[0]!.latitude).toBe(51.5074);
    expect(rows[0]!.org_id).toBe(TARGET.orgId);
  });
});

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

describe("mapSampleToReading — RANGE CHECK compliance (out-of-range → no insertable-violating row)", () => {
  // These pin the class the red-team wave found: the mapper enforced only the
  // latlng-pair + has-signal CHECKs, so an out-of-range coordinate/odometer flowed
  // straight through into a row the DB's range CHECK rejects — and ONE such row in
  // the single-statement ingest upsert aborts the org's ENTIRE batch (0 rows).

  it("lat=91 (> 90) collapses the WHOLE pair to null/null — latitude CHECK", () => {
    const row = mapSampleToReading(
      sample({ latitude: 91, longitude: 10, odometerMiles: 100 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
    expect(row.odometer_miles).toBe(100); // a valid odometer still survives
  });

  it("lat=-91 (< -90) collapses the WHOLE pair to null/null — latitude CHECK", () => {
    const row = mapSampleToReading(
      sample({ latitude: -91, longitude: 10, odometerMiles: 100 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it("lng=200 (> 180) collapses the WHOLE pair to null/null — longitude CHECK", () => {
    const row = mapSampleToReading(
      sample({ latitude: 10, longitude: 200, odometerMiles: 100 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it("lng=-200 (< -180) collapses the WHOLE pair to null/null — longitude CHECK", () => {
    const row = mapSampleToReading(
      sample({ latitude: 10, longitude: -200, odometerMiles: 100 }),
      TARGET,
    );
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it("odometer=3,000,001 (> 3,000,000) is dropped to null — odometer_miles CHECK", () => {
    const row = mapSampleToReading(
      sample({ latitude: 51.5, longitude: -0.1, odometerMiles: 3_000_001 }),
      TARGET,
    );
    expect(row.odometer_miles).toBeNull();
    // The valid fix is untouched — only the out-of-range odometer is dropped.
    expect(row.latitude).toBe(51.5);
    expect(row.longitude).toBe(-0.1);
  });

  it("keeps the exact CHECK BOUNDARIES (90 / -90 / 180 / -180 / 3,000,000)", () => {
    const north = mapSampleToReading(sample({ latitude: 90, longitude: 180, odometerMiles: 3_000_000 }), TARGET);
    expect(north.latitude).toBe(90);
    expect(north.longitude).toBe(180);
    expect(north.odometer_miles).toBe(3_000_000);
    const south = mapSampleToReading(sample({ latitude: -90, longitude: -180, odometerMiles: 0 }), TARGET);
    expect(south.latitude).toBe(-90);
    expect(south.longitude).toBe(-180);
    expect(south.odometer_miles).toBe(0);
  });

  it("a sample whose ONLY signal is out-of-range is DROPPED by the has-signal filter", () => {
    // Bad coordinate + no odometer → coordinate nulled → all-null → dropped, so a
    // single glitchy vehicle can never contribute an uninsertable row to the batch.
    const badFixOnly = mapSamplesToReadings(
      [sample({ eventId: "badfix", latitude: 99, longitude: 200, odometerMiles: null })],
      TARGET,
    );
    expect(badFixOnly).toHaveLength(0);
    // Glitch odometer + no fix → odometer nulled → all-null → dropped.
    const badOdoOnly = mapSamplesToReadings(
      [sample({ eventId: "bado", latitude: null, longitude: null, odometerMiles: 9_999_999 })],
      TARGET,
    );
    expect(badOdoOnly).toHaveLength(0);
  });

  it("one poison sample in a batch drops ONLY itself — the rest still map", () => {
    // The pre-fix mapper would have emitted the poison row (lat 99 / lng 200),
    // which the single-statement ingest upsert then rejects → 0 rows for the whole
    // org. Post-fix, the poison row is dropped and the good samples still map.
    const rows = mapSamplesToReadings(
      [
        sample({ eventId: "good-1", latitude: 51.5, longitude: -0.1, odometerMiles: 100 }),
        sample({ eventId: "poison", latitude: 99, longitude: 200, odometerMiles: 9_999_999 }),
        sample({ eventId: "good-2", latitude: 52.0, longitude: 0.2, odometerMiles: 200 }),
      ],
      TARGET,
    );
    expect(rows.map((r) => r.source_event_id)).toEqual(["good-1", "good-2"]);
  });

  // ── SHAPE GUARD: the mapper MUST mirror EVERY range CHECK the table declares ──
  // Each entry ties a telematics_readings CHECK (20261103) to an out-of-range
  // value the mapper MUST reject (coordinate nulled / odometer nulled). If a
  // FUTURE migration adds a range CHECK the mapper does not mirror, add its row
  // here AND a matching guard in reading-map.ts — a new CHECK without a mapper
  // guard is exactly the class this test exists to catch. (Full DB introspection
  // is out of the unit tier; this explicit enumeration is the guard.)
  const RANGE_CHECKS: ReadonlyArray<{
    check: string;
    field: "latitude" | "longitude" | "odometer_miles";
    over: Partial<TelematicsSample>;
  }> = [
    { check: "latitude between -90 and 90 (upper)", field: "latitude", over: { latitude: 90.0001, longitude: 0 } },
    { check: "latitude between -90 and 90 (lower)", field: "latitude", over: { latitude: -90.0001, longitude: 0 } },
    { check: "longitude between -180 and 180 (upper)", field: "longitude", over: { latitude: 0, longitude: 180.0001 } },
    { check: "longitude between -180 and 180 (lower)", field: "longitude", over: { latitude: 0, longitude: -180.0001 } },
    { check: "odometer_miles between 0 and 3000000 (upper)", field: "odometer_miles", over: { odometerMiles: 3_000_001 } },
  ];

  it.each(RANGE_CHECKS)(
    "rejects a value outside CHECK: $check (never emits an insertable-violating field)",
    ({ field, over }) => {
      const row = mapSampleToReading(sample(over), TARGET);
      if (field === "odometer_miles") {
        expect(row.odometer_miles).toBeNull();
      } else {
        // An out-of-range coordinate nulls the whole pair (pair CHECK).
        expect(row.latitude).toBeNull();
        expect(row.longitude).toBeNull();
      }
    },
  );
});

describe("normalizeSamsaraSamples — native shape → agnostic shape", () => {
  const RESOLVE = (id: string) =>
    id === "sam-1" ? "33333333-3333-3333-3333-333333333333" : null;

  // The REAL Samsara /fleet/vehicles/stats shape: `gps` carries only the fix
  // (lat/lng/time) and `obdOdometerMeters` is its OWN TOP-LEVEL { time, value }
  // stat where value is METRES. (The old fixtures nested odometerMeters inside
  // gps — a shape the API never returns — so green tests encoded the dead feed.)
  function stat(over: Partial<SamsaraVehicleStat>): SamsaraVehicleStat {
    return {
      id: "sam-1",
      gps: {
        latitude: 51.5074,
        longitude: -0.1278,
        time: "2026-07-10T12:00:00Z",
      },
      obdOdometerMeters: {
        time: "2026-07-10T12:00:00Z",
        value: 1609344, // exactly 1000 miles
      },
      ...over,
    };
  }

  it("converts odometer METRES → MILES from the TOP-LEVEL obdOdometerMeters stat", () => {
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

  it("no obdOdometerMeters stat → null odometer (not NaN)", () => {
    const n = normalizeSamsaraSamples(
      [stat({ obdOdometerMeters: null })],
      RESOLVE,
    )[0]!;
    expect(n.odometerMiles).toBeNull();
  });

  it("an ODOMETER-ONLY sample (no gps fix) still yields a row placed in time", () => {
    // A vehicle reporting an odometer stat but no gps fix must PERSIST: the fix
    // is null/null but the odometer survives, timed by obdOdometerMeters.time.
    const n = normalizeSamsaraSamples(
      [
        stat({
          gps: null,
          obdOdometerMeters: { time: "2026-07-11T08:00:00Z", value: 3218688 }, // 2000 mi
        }),
      ],
      RESOLVE,
    );
    expect(n).toHaveLength(1);
    expect(n[0]!.latitude).toBeNull();
    expect(n[0]!.longitude).toBeNull();
    expect(n[0]!.odometerMiles).toBeCloseTo(2000, 6);
    // recorded_at falls back to the odometer stat's own timestamp.
    expect(n[0]!.recordedAt).toBe("2026-07-11T08:00:00Z");
    expect(n[0]!.eventId).toBe("sam-1:2026-07-11T08:00:00Z");
  });

  it("DROPS a sample with no provider timestamp anywhere (recorded_at is NOT NULL)", () => {
    // Neither a gps.time nor an obdOdometerMeters.time — cannot be honestly
    // placed in time, so it is dropped rather than coined "" or fabricated now.
    const noTime = normalizeSamsaraSamples(
      [stat({ gps: null, obdOdometerMeters: { value: 1609344 } })],
      RESOLVE,
    );
    expect(noTime).toHaveLength(0);
    // Empty-string gps.time with no odometer fallback is likewise dropped.
    const emptyTime = normalizeSamsaraSamples(
      [stat({ gps: { latitude: 1, longitude: 2, time: "" }, obdOdometerMeters: null })],
      RESOLVE,
    );
    expect(emptyTime).toHaveLength(0);
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

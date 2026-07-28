import { describe, it, expect } from "vitest";
import {
  LITRES_PER_IMPERIAL_GALLON,
  computeConsumption,
  mileageSpan,
  operatingCost,
  orderLogs,
  summariseByVehicle,
  sumFuel,
  type FuelLogInput,
} from "@/lib/fleet/fuel";

/**
 * Fuel maths — and above all THE NO-FAKE-MPG RULE.
 *
 * The valuable assertions in this file are the negative ones: the cases where a
 * plausible-looking number could be produced and the module returns null
 * instead. A wrong mpg is worse than no mpg, because a builder compares vans on
 * it and buys the wrong one.
 */

function log(over: Partial<FuelLogInput> = {}): FuelLogInput {
  return {
    id: "l1",
    assetId: "v1",
    filledOn: "2026-07-01",
    odometerMiles: 10_000,
    litres: 60,
    cost: 90,
    isFullFill: true,
    ...over,
  };
}

describe("orderLogs", () => {
  it("orders by date, then odometer, then id — a TOTAL order", () => {
    const out = orderLogs([
      log({ id: "c", filledOn: "2026-07-03", odometerMiles: 300 }),
      log({ id: "b", filledOn: "2026-07-01", odometerMiles: 200 }),
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 100 }),
    ]);
    expect(out.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks a full tie on id so two identical fills never swap between runs", () => {
    const a = log({ id: "aaa" });
    const b = log({ id: "bbb" });
    expect(orderLogs([b, a]).map((l) => l.id)).toEqual(["aaa", "bbb"]);
    expect(orderLogs([a, b]).map((l) => l.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate its input", () => {
    const input = [log({ id: "z", filledOn: "2026-08-01" }), log({ id: "a" })];
    orderLogs(input);
    expect(input.map((l) => l.id)).toEqual(["z", "a"]);
  });
});

describe("computeConsumption — the tank-to-tank rule", () => {
  it("computes mpg between two consecutive full fills, in IMPERIAL gallons", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, litres: 45 }),
    ]);
    // 300 miles on 45 L = 300 / (45 / 4.54609) = 30.307… mpg
    const expected = 300 / (45 / LITRES_PER_IMPERIAL_GALLON);
    expect(r.segments).toHaveLength(1);
    expect(r.mpg).toBeCloseTo(expected, 2);
    expect(r.measuredMiles).toBe(300);
  });

  it("returns NULL — not 0 — when a partial fill breaks the chain", () => {
    const r = computeConsumption([
      log({ id: "a", odometerMiles: 10_000, isFullFill: true }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, isFullFill: false }),
    ]);
    expect(r.mpg).toBeNull();
    expect(r.segments).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("refuses a segment where the PREVIOUS fill was partial", () => {
    // The tank level at the start of the segment is unknown, so the litres
    // added at the end do not measure the distance covered.
    const r = computeConsumption([
      log({ id: "a", odometerMiles: 10_000, isFullFill: false }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, isFullFill: true }),
    ]);
    expect(r.mpg).toBeNull();
  });

  it("refuses to bridge ACROSS a partial fill between two full fills", () => {
    // Deliberately conservative: bridging would assume the log is complete,
    // which nothing in the data can establish.
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000, isFullFill: true }),
      log({ id: "b", filledOn: "2026-07-05", odometerMiles: 10_150, isFullFill: false, litres: 20 }),
      log({ id: "c", filledOn: "2026-07-08", odometerMiles: 10_300, isFullFill: true, litres: 25 }),
    ]);
    expect(r.mpg).toBeNull();
    expect(r.skipped).toBe(2);
  });

  it("refuses when an odometer reading is missing", () => {
    const r = computeConsumption([
      log({ id: "a", odometerMiles: null }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300 }),
    ]);
    expect(r.mpg).toBeNull();
  });

  it("refuses when the odometer does not increase (replaced clock or typo)", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_300 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_000 }),
    ]);
    expect(r.mpg).toBeNull();
  });

  it("refuses when the odometer is unchanged — zero miles is not efficiency", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_000 }),
    ]);
    expect(r.mpg).toBeNull();
  });

  it("refuses an EV charge (cost and mileage, no litres) rather than inventing litres", () => {
    const r = computeConsumption([
      log({ id: "a", odometerMiles: 10_000, litres: null }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, litres: null }),
    ]);
    expect(r.mpg).toBeNull();
    expect(r.segments).toHaveLength(0);
  });

  it("returns null for a single fill — one point is not a measurement", () => {
    expect(computeConsumption([log()]).mpg).toBeNull();
    expect(computeConsumption([]).mpg).toBeNull();
  });

  it("aggregates several valid segments as total miles ÷ total gallons", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, litres: 45 }),
      log({ id: "c", filledOn: "2026-07-15", odometerMiles: 10_700, litres: 55 }),
    ]);
    expect(r.segments).toHaveLength(2);
    const expected = 700 / ((45 + 55) / LITRES_PER_IMPERIAL_GALLON);
    expect(r.mpg).toBeCloseTo(expected, 2);
    expect(r.measuredMiles).toBe(700);
  });

  it("computes cost per mile only where the segment is valid, and never divides by zero", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_200, litres: 40, cost: 60 }),
    ]);
    expect(r.segments[0]!.costPerMile).toBeCloseTo(0.3, 2); // £60 / 200 miles
  });

  it("leaves cost per mile null when the fill recorded no cost", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_200, litres: 40, cost: 0 }),
    ]);
    expect(r.segments[0]!.costPerMile).toBeNull();
  });

  it("accepts numeric-STRING litres and cost as Postgres numeric returns them", () => {
    const r = computeConsumption([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000, litres: "60.00" }),
      log({ id: "b", filledOn: "2026-07-08", odometerMiles: 10_300, litres: "45.00", cost: "67.50" }),
    ]);
    expect(r.mpg).toBeCloseTo(300 / (45 / LITRES_PER_IMPERIAL_GALLON), 2);
  });
});

describe("sumFuel", () => {
  it("sums spend across every entry, including ones with no litres", () => {
    const t = sumFuel([
      log({ id: "a", cost: 90.55 }),
      log({ id: "b", cost: 60.45, litres: null }),
    ]);
    expect(t.spend).toBe(151);
    expect(t.entries).toBe(2);
  });

  it("counts only recorded litres, so an EV charge does not inflate volume", () => {
    const t = sumFuel([log({ id: "a", litres: 50 }), log({ id: "b", litres: null })]);
    expect(t.litres).toBe(50);
  });

  it("rounds money to 2dp with no float drift", () => {
    const t = sumFuel([log({ id: "a", cost: 0.1 }), log({ id: "b", cost: 0.2 })]);
    expect(t.spend).toBe(0.3);
  });
});

describe("summariseByVehicle", () => {
  it("judges each vehicle's mpg on its OWN fills, never pooled across the fleet", () => {
    const out = summariseByVehicle([
      // v1: a valid pair
      log({ id: "a", assetId: "v1", filledOn: "2026-07-01", odometerMiles: 1000 }),
      log({ id: "b", assetId: "v1", filledOn: "2026-07-08", odometerMiles: 1300, litres: 45 }),
      // v2: one fill only → no figure
      log({ id: "c", assetId: "v2", filledOn: "2026-07-02", odometerMiles: 5000, cost: 200 }),
    ]);
    const v1 = out.find((o) => o.assetId === "v1")!;
    const v2 = out.find((o) => o.assetId === "v2")!;
    expect(v1.mpg).not.toBeNull();
    expect(v2.mpg).toBeNull();
  });

  it("sorts by spend descending with an assetId tiebreaker", () => {
    const out = summariseByVehicle([
      log({ id: "a", assetId: "v1", cost: 10 }),
      log({ id: "b", assetId: "v2", cost: 100 }),
    ]);
    expect(out.map((o) => o.assetId)).toEqual(["v2", "v1"]);
  });

  it("reports the highest recorded reading as the latest odometer", () => {
    const out = summariseByVehicle([
      log({ id: "a", assetId: "v1", odometerMiles: 1000 }),
      log({ id: "b", assetId: "v1", filledOn: "2026-07-09", odometerMiles: 4000 }),
      log({ id: "c", assetId: "v1", filledOn: "2026-07-10", odometerMiles: null }),
    ]);
    expect(out[0]!.latestOdometer).toBe(4000);
  });
});

describe("mileageSpan", () => {
  it("reports the measured distance between the first and last readings", () => {
    const s = mileageSpan([
      log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
      log({ id: "b", filledOn: "2026-07-20", odometerMiles: 11_500 }),
    ]);
    expect(s).toEqual({ miles: 1500, fromIso: "2026-07-01", toIso: "2026-07-20" });
  });

  it("returns null with fewer than two readings — no trend from one point", () => {
    expect(mileageSpan([log({ odometerMiles: 10_000 })])).toBeNull();
    expect(mileageSpan([log({ odometerMiles: null }), log({ id: "b", odometerMiles: null })])).toBeNull();
  });

  it("returns null when the readings do not advance", () => {
    expect(
      mileageSpan([
        log({ id: "a", filledOn: "2026-07-01", odometerMiles: 10_000 }),
        log({ id: "b", filledOn: "2026-07-20", odometerMiles: 10_000 }),
      ]),
    ).toBeNull();
  });
});

describe("operatingCost", () => {
  it("adds fuel and maintenance to 2dp", () => {
    expect(operatingCost(100.555, 50.005)).toBe(150.56);
  });

  it("treats a missing half as zero rather than NaN", () => {
    expect(operatingCost(100, Number.NaN)).toBe(100);
  });
});

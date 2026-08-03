import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fleet telematics READER — `loadVehicleTelematics` (C28).
 *
 * `telematics_readings` was written by the sync (20261103) but SELECTed by
 * NOTHING — the consumption half was missing. These tests execute the real
 * reader against a chainable Supabase mock and prove the two load-bearing
 * properties a source-contract test can't:
 *   1. ORG SCOPING — the read is pinned to BOTH org_id and vehicle_id, and
 *      ordered newest-first on the (org_id, vehicle_id, recorded_at desc) index
 *      with an id tiebreaker.
 *   2. latest / latestFix derivation — `latest` is the newest reading overall;
 *      `latestFix` is the newest reading that actually carries a GPS fix.
 * Plus the graceful empty/error degradation the page renders as an empty state.
 */

type Row = Record<string, unknown>;

const cfg = vi.hoisted(() => ({
  rows: [] as Row[],
  error: null as unknown,
  eqs: [] as Array<[string, unknown]>,
  orders: [] as Array<[string, { ascending: boolean }]>,
  table: "" as string,
  limit: -1 as number,
}));

vi.mock("@/lib/supabase/server", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => {
    cfg.eqs.push([k, v]);
    return chain;
  };
  chain.order = (k: string, o: { ascending: boolean }) => {
    cfg.orders.push([k, o]);
    return chain;
  };
  chain.limit = (n: number) => {
    cfg.limit = n;
    return Promise.resolve({ data: cfg.rows, error: cfg.error });
  };
  const client = {
    from: (t: string) => {
      cfg.table = t;
      return chain;
    },
  };
  return { createClient: vi.fn(async () => client) };
});

import { loadVehicleTelematics } from "@/server/services/fleet-snapshot";

const ORG = "org-aaaa";
const VEH = "veh-1111";

beforeEach(() => {
  cfg.rows = [];
  cfg.error = null;
  cfg.eqs = [];
  cfg.orders = [];
  cfg.table = "";
  cfg.limit = -1;
});

describe("loadVehicleTelematics — org scoping + ordering", () => {
  it("pins the read to org_id AND vehicle_id, newest-first with an id tiebreaker", async () => {
    cfg.rows = [
      { id: "r3", recorded_at: "2026-07-15T10:00:00Z", latitude: 51.5, longitude: -0.1, odometer_miles: 1002 },
      { id: "r2", recorded_at: "2026-07-15T09:00:00Z", latitude: null, longitude: null, odometer_miles: 1001 },
    ];

    const view = await loadVehicleTelematics(ORG, VEH);

    expect(cfg.table).toBe("telematics_readings");
    // ORG-PINNED: both predicates present.
    expect(cfg.eqs).toContainEqual(["org_id", ORG]);
    expect(cfg.eqs).toContainEqual(["vehicle_id", VEH]);
    // Latest-first on the index, id tiebreaker for a stable total order.
    expect(cfg.orders[0]).toEqual(["recorded_at", { ascending: false }]);
    expect(cfg.orders[1]).toEqual(["id", { ascending: false }]);
    // Bounded read.
    expect(cfg.limit).toBe(50);

    expect(view.track).toHaveLength(2);
    expect(view.latest!.id).toBe("r3");
    expect(view.latest!.odometerMiles).toBe(1002);
  });

  it("latestFix is the newest reading WITH a fix, even when the newest sample is odometer-only", async () => {
    cfg.rows = [
      // Newest overall is odometer-only (no fix).
      { id: "r3", recorded_at: "2026-07-15T10:00:00Z", latitude: null, longitude: null, odometer_miles: 1005 },
      // Older, but has a GPS fix.
      { id: "r2", recorded_at: "2026-07-15T09:00:00Z", latitude: 51.5074, longitude: -0.1278, odometer_miles: 1000 },
    ];

    const view = await loadVehicleTelematics(ORG, VEH);

    expect(view.latest!.id).toBe("r3");
    expect(view.latest!.latitude).toBeNull();
    expect(view.latestFix!.id).toBe("r2");
    expect(view.latestFix!.latitude).toBe(51.5074);
    expect(view.latestFix!.longitude).toBe(-0.1278);
  });
});

describe("loadVehicleTelematics — graceful degradation", () => {
  it("returns an empty view (no throw) when there are no readings", async () => {
    cfg.rows = [];
    const view = await loadVehicleTelematics(ORG, VEH);
    expect(view).toEqual({ latest: null, latestFix: null, track: [] });
  });

  it("returns an empty view when the read errors", async () => {
    cfg.rows = [];
    cfg.error = { message: "boom" };
    const view = await loadVehicleTelematics(ORG, VEH);
    expect(view).toEqual({ latest: null, latestFix: null, track: [] });
  });
});

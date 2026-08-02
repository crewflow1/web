import { describe, it, expect } from "vitest";
import type { SiteBalance } from "@/lib/stock/balance";
import {
  enableVanStockSchema,
  summariseVanStock,
  vanTransferSchema,
  vehiclesWithoutStock,
  type VanLocation,
  type VehicleOption,
} from "@/lib/stock/van";

/**
 * VAN / VEHICLE STOCK — pure helpers. These fold the SHARED (item, site)
 * balances into a per-van summary, so a van's total can never disagree with the
 * item and location pages, which fold the same map.
 */

const bal = (siteId: string, stockItemId: string, quantity: number): SiteBalance => ({
  siteId,
  stockItemId,
  quantity,
});

const vans: VanLocation[] = [
  { id: "van-1", name: "Transit (AA11AAA)", vehicleAssetId: "veh-1", active: true },
  { id: "van-2", name: "Sprinter (BB22BBB)", vehicleAssetId: "veh-2", active: true },
  { id: "van-3", name: "Old tipper", vehicleAssetId: "veh-3", active: false },
];

describe("summariseVanStock", () => {
  it("folds per-van totals and non-zero line counts from the shared balances", () => {
    const balances = new Map<string, SiteBalance>([
      ["a", bal("van-1", "cement", 10)],
      ["b", bal("van-1", "sand", 5)],
      ["c", bal("van-2", "cement", 3)],
      // a depot balance must never be counted against a van
      ["d", bal("depot-1", "cement", 999)],
    ]);
    const out = summariseVanStock(vans, balances);
    const one = out.find((v) => v.id === "van-1");
    const two = out.find((v) => v.id === "van-2");
    expect(one).toMatchObject({ lines: 2, quantity: 15 });
    expect(two).toMatchObject({ lines: 1, quantity: 3 });
  });

  it("shows a van with no stock as lines 0, quantity 0 — 'holds nothing' is an answer", () => {
    const out = summariseVanStock(vans, new Map());
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v.lines).toBe(0);
      expect(v.quantity).toBe(0);
    }
  });

  it("excludes items folded to exactly zero from the line count", () => {
    const balances = new Map<string, SiteBalance>([
      ["a", bal("van-1", "cement", 0)],
      ["b", bal("van-1", "sand", 4)],
    ]);
    const one = summariseVanStock(vans, balances).find((v) => v.id === "van-1");
    expect(one).toMatchObject({ lines: 1, quantity: 4 });
  });

  it("keeps 2dp discipline when summing several lines", () => {
    const balances = new Map<string, SiteBalance>([
      ["a", bal("van-1", "x", 1.1)],
      ["b", bal("van-1", "y", 2.2)],
    ]);
    expect(summariseVanStock(vans, balances).find((v) => v.id === "van-1")?.quantity).toBe(3.3);
  });

  it("orders by name then id, deterministically", () => {
    // By name: "Old tipper", "Sprinter (BB22BBB)", "Transit (AA11AAA)".
    const out = summariseVanStock(vans, new Map());
    expect(out.map((v) => v.id)).toEqual(["van-3", "van-2", "van-1"]);
  });
});

describe("vehiclesWithoutStock", () => {
  const vehicles: VehicleOption[] = [
    { assetId: "veh-1", label: "Transit" },
    { assetId: "veh-2", label: "Sprinter" },
    { assetId: "veh-4", label: "Caddy" },
  ];

  it("filters out vehicles that already back a van location", () => {
    const out = vehiclesWithoutStock(vehicles, vans);
    // veh-1 and veh-2 are enabled; veh-4 is not (veh-3 has no matching vehicle here)
    expect(out.map((v) => v.assetId)).toEqual(["veh-4"]);
  });

  it("offers everything when no vans exist yet, sorted by label", () => {
    const out = vehiclesWithoutStock(vehicles, []);
    expect(out.map((v) => v.label)).toEqual(["Caddy", "Sprinter", "Transit"]);
  });

  it("ignores van locations whose vehicle link is null (a deleted vehicle)", () => {
    const orphaned: VanLocation[] = [{ id: "van-x", name: "Ghost", vehicleAssetId: null, active: true }];
    // Nothing is filtered; result is sorted by label: Caddy, Sprinter, Transit.
    expect(vehiclesWithoutStock(vehicles, orphaned).map((v) => v.label)).toEqual([
      "Caddy",
      "Sprinter",
      "Transit",
    ]);
  });
});

describe("enableVanStockSchema", () => {
  it("requires a vehicle and treats a blank name as absent", () => {
    const ok = enableVanStockSchema.safeParse({
      vehicle_asset_id: "11111111-1111-1111-1111-111111111111",
      name: "   ",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBeUndefined();

    expect(enableVanStockSchema.safeParse({ vehicle_asset_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("vanTransferSchema", () => {
  const base = {
    vehicle_site_id: "11111111-1111-1111-1111-111111111111",
    depot_site_id: "22222222-2222-2222-2222-222222222222",
    stock_item_id: "33333333-3333-3333-3333-333333333333",
    qty: "4",
  };

  it("accepts a well-formed load/return", () => {
    const r = vanTransferSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.qty).toBe(4);
  });

  it("refuses a zero or negative quantity", () => {
    expect(vanTransferSchema.safeParse({ ...base, qty: "0" }).success).toBe(false);
    expect(vanTransferSchema.safeParse({ ...base, qty: "-2" }).success).toBe(false);
  });

  it("refuses the van and the depot being the same place", () => {
    const r = vanTransferSchema.safeParse({ ...base, depot_site_id: base.vehicle_site_id });
    expect(r.success).toBe(false);
  });
});

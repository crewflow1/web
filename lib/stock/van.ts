import { z } from "zod";
import { round2 } from "@/lib/money";
import type { SiteBalance } from "./balance";
import { movementQuantitySchema } from "./schema";

/**
 * VAN / VEHICLE STOCK — pure helpers and input validation. No I/O, no
 * server-only imports, unit-tested directly.
 *
 * THE ACCOUNTING BOUNDARY (full statement in lib/stock/movements.ts and
 * supabase/migrations/20261102000000_van_stock_locations.sql): a van is a stock
 * LOCATION and everything here is QUANTITIES ONLY. Loading a van is a TRANSFER
 * depot → van; it posts no cost, because materials are already expensed by
 * recordSupplierBill and a second posting would double-count. Stock valuation is
 * CEO decision D1 and is UNDECIDED.
 *
 * A vehicle stock location is a `sites` row with kind = 'vehicle' and a
 * `vehicle_asset_id` back-link (20261102000000). Because it is a site, the
 * EXISTING movement ledger, balance fold and write RPCs accept it unchanged —
 * these helpers only shape reads and validate the two forms this surface adds.
 */

/** A vehicle stock location, as the vans board reads it. */
export interface VanLocation {
  /** The `sites.id` — this is what every stock RPC takes as a site id. */
  id: string;
  name: string;
  vehicleAssetId: string | null;
  active: boolean;
}

/** A fleet vehicle offered in the "enable stock on a van" picker. */
export interface VehicleOption {
  assetId: string;
  label: string;
}

/** A van location joined to its folded holding — one row on the vans board. */
export interface VanHolding extends VanLocation {
  /** Distinct items currently on the van with a non-zero balance. */
  lines: number;
  /** Total units on the van across all items. */
  quantity: number;
}

/**
 * Fold the shared (item, site) balances down to a per-van summary.
 *
 * Takes the SAME `Map<string, SiteBalance>` that `foldSiteBalances` produces for
 * every other stock surface, so a van's total can never disagree with the
 * item/location pages. A van with no movements still appears (lines 0, quantity
 * 0) — "this van holds nothing" is a real, useful answer.
 *
 * Total order by name then id, so the board renders identically for any
 * permutation the read returns (the compose.ts ordering discipline).
 */
export function summariseVanStock(
  vans: readonly VanLocation[],
  balances: ReadonlyMap<string, SiteBalance>,
): VanHolding[] {
  const perSite = new Map<string, { lines: number; quantity: number }>();
  for (const b of balances.values()) {
    if (b.quantity === 0) continue;
    const current = perSite.get(b.siteId) ?? { lines: 0, quantity: 0 };
    current.lines += 1;
    current.quantity = round2(current.quantity + b.quantity);
    perSite.set(b.siteId, current);
  }
  return vans
    .map((v): VanHolding => {
      const held = perSite.get(v.id) ?? { lines: 0, quantity: 0 };
      return { ...v, lines: held.lines, quantity: held.quantity };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The vehicles that do NOT yet have a stock location — the "enable" picker's
 * options. A vehicle whose asset id already backs a van site is filtered out, so
 * a van can never be enabled twice (the DB unique index is the real guard; this
 * keeps the offer honest). Sorted by label for a stable dropdown.
 */
export function vehiclesWithoutStock(
  vehicles: readonly VehicleOption[],
  vans: readonly VanLocation[],
): VehicleOption[] {
  const enabled = new Set(
    vans.map((v) => v.vehicleAssetId).filter((id): id is string => typeof id === "string"),
  );
  return vehicles
    .filter((v) => !enabled.has(v.assetId))
    .sort((a, b) => a.label.localeCompare(b.label, "en-GB", { sensitivity: "base" }));
}

/**
 * Enable a vehicle as a stock location. `name` is optional — the RPC defaults it
 * to the vehicle's own name when blank.
 */
export const enableVanStockSchema = z.object({
  vehicle_asset_id: z.string().uuid("Pick a vehicle"),
  name: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(160, "Keep the name under 160 characters").optional(),
  ),
});
export type EnableVanStockInput = z.infer<typeof enableVanStockSchema>;

/**
 * Load stock onto a van, or return it — the SAME shape either way, because both
 * are a transfer between the van and a depot; only the direction differs and the
 * two server actions set it. Refuses the same place at both ends, mirroring the
 * depot-to-depot transfer form.
 */
export const vanTransferSchema = z
  .object({
    vehicle_site_id: z.string().uuid("Pick a van"),
    depot_site_id: z.string().uuid("Pick where it is coming from or going to"),
    stock_item_id: z.string().uuid("Pick an item"),
    qty: movementQuantitySchema,
    notes: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(2000).optional(),
    ),
  })
  .refine((d) => d.vehicle_site_id !== d.depot_site_id, {
    message: "Pick two different places",
    path: ["depot_site_id"],
  });
export type VanTransferInput = z.infer<typeof vanTransferSchema>;

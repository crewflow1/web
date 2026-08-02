import "server-only";

import { readFailure } from "@/lib/supabase/read-failure";
import type { VanLocation, VehicleOption } from "@/lib/stock/van";

/**
 * VAN / VEHICLE STOCK — the read layer behind /stock/vans and the load/return
 * forms.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. Every read here returns QUANTITIES or the      ║
 * ║  IDENTITY of a place. There is no cost, no valuation and no `finances`   ║
 * ║  read anywhere on this surface: loading a van is a transfer, and         ║
 * ║  materials are already expensed by recordSupplierBill, so it posts no    ║
 * ║  new cost. Stock valuation is CEO decision D1 and is UNDECIDED.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A vehicle stock location is a `sites` row with kind = 'vehicle'
 * (20261102000000). Balances for a van are folded from the SAME movement rows as
 * every other location — this module only reads the van SITES and the vehicle
 * catalogue; the balances themselves come through server/services/stock.ts, so
 * the two surfaces can never print different numbers for the same van.
 *
 * TWO INVARIANTS, identical to server/services/stock.ts:
 *
 *   1. ORG-PINNED, not merely RLS-scoped. `sites_select` and
 *      `fleet_vehicles_select` are both `org_id in (select current_org_ids())`,
 *      which passes for EVERY org the viewer belongs to. Without the pin a
 *      dual-org member working in company A would see company B's vans on the
 *      board and the enable picker would OFFER a vehicle the RPC then refuses.
 *      Every query below therefore carries `.eq("org_id", orgId)`, and
 *      __tests__/security/van-stock.test.ts counts them against the `.select(`
 *      calls in this file.
 *
 *   2. LOUD READS (#480). Every read binds `error` and throws readFailure — a
 *      vans board that renders empty because a query was REJECTED is
 *      indistinguishable from a company with no vans, and the action it invites
 *      (issue stock you cannot see) is wrong.
 *
 * These take the Supabase client as an argument (the stock/sites idiom) so the
 * integration suite can drive the EXACT same queries with a real dual-org JWT.
 *
 * `sites` / `fleet_vehicles` are newer than the generated Supabase types, so the
 * client is accessed through the loose shape below — the assets/fleet/sites cast
 * style already used across the codebase.
 */

type Row = Record<string, unknown>;
type Err = { message?: string | null; code?: string | null } | null;

export type VanStockClient = { from: (t: string) => VanBuilder };

type VanBuilder = PromiseLike<{ data: Row[] | null; error: Err }> & {
  select: (c: string) => VanBuilder;
  eq: (k: string, v: unknown) => VanBuilder;
  order: (k: string, o: { ascending: boolean }) => VanBuilder;
  limit: (n: number) => VanBuilder;
};

/** Upper bound on a fleet/vehicle-location read. Far beyond any real fleet. */
export const VAN_SCAN_LIMIT = 2000;

/**
 * Every vehicle stock location in the ACTIVE org — the vans board and the
 * transfer-form pickers. Includes retired vans so their history stays reachable;
 * callers filter on `active` for a picker of live destinations.
 */
export async function listVanLocations(
  db: VanStockClient,
  orgId: string,
): Promise<VanLocation[]> {
  const { data, error } = await db
    .from("sites")
    .select("id, name, vehicle_asset_id, active")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("kind", "vehicle")
    .order("name", { ascending: true })
    .limit(VAN_SCAN_LIMIT);
  if (error) throw readFailure("van stock: locations", error);
  return (data ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    vehicleAssetId: typeof r.vehicle_asset_id === "string" ? r.vehicle_asset_id : null,
    active: r.active !== false,
  }));
}

/**
 * The fleet vehicles in the ACTIVE org, as picker options.
 *
 * Read from `fleet_vehicles` joined to `assets` in TWO org-pinned reads rather
 * than a PostgREST embed: the stock surface deliberately embeds nothing (the
 * postgrest-embed-ambiguity lesson), and two explicit reads cannot be
 * mis-resolved by the planner. The label is the asset name plus registration
 * when present, so a yard can tell two Transits apart.
 */
export async function listVehicleOptions(
  db: VanStockClient,
  orgId: string,
): Promise<VehicleOption[]> {
  const vehicles = await db
    .from("fleet_vehicles")
    .select("asset_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .limit(VAN_SCAN_LIMIT);
  if (vehicles.error) throw readFailure("van stock: fleet vehicles", vehicles.error);

  const assets = await db
    .from("assets")
    .select("id, name, registration")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .limit(VAN_SCAN_LIMIT);
  if (assets.error) throw readFailure("van stock: vehicle assets", assets.error);

  const assetById = new Map(
    (assets.data ?? []).map((a) => [
      String(a.id),
      {
        name: typeof a.name === "string" ? a.name.trim() : "",
        registration: typeof a.registration === "string" ? a.registration.trim() : "",
      },
    ]),
  );

  return (vehicles.data ?? []).map((v) => {
    const assetId = String(v.asset_id);
    const meta = assetById.get(assetId);
    const name = meta?.name || "Vehicle";
    const label = meta?.registration ? `${name} (${meta.registration})` : name;
    return { assetId, label };
  });
}

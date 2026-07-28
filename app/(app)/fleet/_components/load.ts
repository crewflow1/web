import "server-only";
import { createClient } from "@/lib/supabase/server";
import { loadFleetVehicles, type FleetVehicle } from "@/server/services/fleet-snapshot";
import type { SupplierOption } from "./vehicle-form";

/**
 * The shared scoped-read chokepoint for a SINGLE vehicle — the fleet analogue
 * of lib/jobs/load.ts, and it exists for the same reason.
 *
 * RLS's `current_org_ids()` returns EVERY org the viewer belongs to, so a bare
 * by-id read would happily return a vehicle from the user's OTHER org while
 * they are working in this one. Routing every by-id load through this one
 * function means the active-org predicate is applied in exactly one place and a
 * new page cannot forget it. Returns null rather than throwing, so callers
 * treat a foreign or missing id identically — `notFound()`.
 */
export async function loadVehicleForOrg(
  orgId: string,
  assetId: string,
): Promise<FleetVehicle | null> {
  const vehicles = await loadFleetVehicles(orgId);
  return vehicles.find((v) => v.assetId === assetId) ?? null;
}

/** Org-pinned supplier options for the form dropdowns. */
export async function loadSupplierOptions(orgId: string): Promise<SupplierOption[]> {
  try {
    const supabase = await createClient();
    const { data } = await (
      supabase.from("suppliers" as never) as unknown as {
        select: (c: string) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{ data: Array<{ id: string; name: string }> | null }>;
          };
        };
      }
    )
      .select("id, name")
      .eq("org_id", orgId)
      .order("name", { ascending: true });
    return (data ?? []).map((s) => ({ id: s.id, name: s.name }));
  } catch {
    // A missing supplier list must never block adding a vehicle — the field is
    // optional, so degrade to "no options" rather than failing the page.
    return [];
  }
}

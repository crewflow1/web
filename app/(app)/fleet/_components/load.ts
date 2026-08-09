import "server-only";
import { createClient } from "@/lib/supabase/server";
import { loadFleetVehicles, type FleetVehicle } from "@/server/services/fleet-snapshot";
import {
  listSiteOptionsForOrg,
  type SiteOption,
  type SitesClient,
} from "@/server/services/sites";
import { listSuppliersForOrg, type SuppliersClient } from "@/server/services/suppliers";
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
    // COMPLETE read (F-1 picker class). This used to be a bare
    // `.from("suppliers").select("id, name")` with NO paging, so PostgREST
    // silently clamped it at 1000 — an org past the cap dropped suppliers from
    // the vehicle form AND, worse, the record-service picker on the vehicle
    // detail page would NULL an out-of-cap saved provider on an untouched save.
    // Route through the paged chokepoint so every supplier is present.
    return await listSuppliersForOrg<SupplierOption>(
      supabase as unknown as SuppliersClient,
      orgId,
    );
  } catch {
    // A missing supplier list must never block adding a vehicle — the field is
    // optional, so degrade to "no options" rather than failing the page.
    return [];
  }
}

/**
 * Org-pinned site options for the "home site" picker.
 *
 * Active sites only, plus whatever the vehicle is CURRENTLY set to even if that
 * site has since been retired — otherwise opening the edit form on such a
 * vehicle would silently drop its home site the next time anyone pressed Save.
 */
export async function loadSiteOptions(
  orgId: string,
  currentSiteId?: string | null,
): Promise<SiteOption[]> {
  const supabase = await createClient();
  return listSiteOptionsForOrg(supabase as unknown as SitesClient, orgId, {
    keepId: currentSiteId ?? null,
  });
}

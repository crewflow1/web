"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { friendlyStockError } from "@/lib/stock/schema";
import { friendlySiteError } from "@/lib/sites/schema";
import { enableVanStockSchema, vanTransferSchema } from "@/lib/stock/van";
import { type FormState, formError, formSuccess } from "@/lib/forms/state";

/**
 * VAN / VEHICLE STOCK — server actions.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. NOTHING in this file touches `finances`.       ║
 * ║  Loading a van is a TRANSFER (record_stock_transfer), which posts no     ║
 * ║  cost — materials are already expensed by recordSupplierBill and a       ║
 * ║  second posting would double-count. No form here collects a price.       ║
 * ║  Stock valuation is CEO decision D1 and is UNDECIDED.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A van is a stock LOCATION (a `sites` row, kind = 'vehicle', 20261102000000).
 * So there is NO new movement path here: loading and returning stock reuse
 * `record_stock_transfer`, inheriting its per-(item, site) advisory lock, its
 * balance floor, its transfer conservation, the crewflow.stock_write write-path
 * gate and every composite FK. Enabling a van reuses
 * `ensure_vehicle_stock_location`, which writes only a `sites` row.
 *
 * ACTIVE-ORG PINNING: RLS admits every org the caller belongs to; `ctx.org.id`
 * narrows to the company they are WORKING IN, so every RPC call passes
 * `p_org_id: ctx.org.id`. __tests__/security/van-stock.test.ts pins that on
 * source. All writes use the tenant (user-JWT) client so RLS scopes them and the
 * admin-only sites_insert gate on ensure_vehicle_stock_location still applies —
 * never the service-role client, which would bypass it.
 *
 * NO cache revalidation, and every write hard-navigates — the same reasoning as
 * app/(app)/stock/actions.ts (the Next 15.5 deep-swap commit race): every stock
 * route is force-dynamic, so there is no cache entry to invalidate, and a
 * revalidatePath here stalls the action's state commit.
 */

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/**
 * Enable a fleet vehicle as a stock location.
 *
 * ADMIN ONLY — and the gate that matters is the database's: `sites_insert` is
 * `is_org_admin`, and ensure_vehicle_stock_location is SECURITY INVOKER, so a
 * member's insert is refused there. The check below only turns that raw refusal
 * into a sentence; removing it changes the message, never the outcome.
 */
export async function enableVanStock(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const isAdmin = ctx.membership.role === "owner" || ctx.membership.role === "admin";
  if (!isAdmin) {
    return formError("Only an owner or admin can set a van up for stock.");
  }

  const parsed = enableVanStockSchema.safeParse({
    vehicle_asset_id: formData.get("vehicle_asset_id") ?? "",
    name: formData.get("name") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Pick a vehicle.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("ensure_vehicle_stock_location", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_vehicle_asset_id: parsed.data.vehicle_asset_id,
    p_name: parsed.data.name ?? null,
  });

  if (error || typeof data !== "string") {
    console.error("[van-stock] enable failed", error);
    // A name clash comes back as 23505 → the sites wording; everything else
    // (a foreign vehicle, a member without the gate) → the stock wording.
    const message =
      error?.code === "23505"
        ? friendlySiteError(error.code, error.message)
        : friendlyStockError(error?.code, error?.message);
    return formError(message);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "van_stock.enabled",
    targetTable: "sites",
    targetId: data,
    metadata: { vehicle_asset_id: parsed.data.vehicle_asset_id },
  });

  return formSuccess({
    successMessage: "Van set up for stock.",
    redirectTo: `/stock/locations/${data}`,
  });
}

/**
 * Load stock ONTO a van — a transfer depot → van, through the shared authority.
 */
export async function issueToVan(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return moveVanStock(formData, "load");
}

/**
 * Return stock FROM a van to a depot — a transfer van → depot.
 */
export async function returnFromVan(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return moveVanStock(formData, "return");
}

/**
 * The one implementation both directions share. "load" is depot → van; "return"
 * is van → depot. Either way it is a single record_stock_transfer — the same
 * conserving pair as any other transfer — so a bare transfer_in that would
 * manufacture stock is never written here.
 */
async function moveVanStock(
  formData: FormData,
  direction: "load" | "return",
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = vanTransferSchema.safeParse({
    vehicle_site_id: formData.get("vehicle_site_id") ?? "",
    depot_site_id: formData.get("depot_site_id") ?? "",
    stock_item_id: formData.get("stock_item_id") ?? "",
    qty: formData.get("qty") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the details and try again.");
  }

  const fromSite =
    direction === "load" ? parsed.data.depot_site_id : parsed.data.vehicle_site_id;
  const toSite =
    direction === "load" ? parsed.data.vehicle_site_id : parsed.data.depot_site_id;

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("record_stock_transfer", {
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN
    p_item_id: parsed.data.stock_item_id,
    p_from_site_id: fromSite,
    p_to_site_id: toSite,
    p_qty: parsed.data.qty,
    p_notes: parsed.data.notes ?? null,
  });

  if (error || typeof data !== "string") {
    console.error(`[van-stock] ${direction} failed`, error);
    return formError(friendlyStockError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: direction === "load" ? "van_stock.loaded" : "van_stock.returned",
    targetTable: "stock_movements",
    targetId: data,
    metadata: {
      stock_item_id: parsed.data.stock_item_id,
      from_site_id: fromSite,
      to_site_id: toSite,
      qty: parsed.data.qty,
    },
  });

  return formSuccess({
    redirectTo: `/stock/locations/${parsed.data.vehicle_site_id}?saved=${
      direction === "load" ? "loaded" : "returned"
    }`,
  });
}

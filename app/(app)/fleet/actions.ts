"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { vehicleFormSchema, vehicleIdSchema } from "@/lib/fleet/schema";

/**
 * Fleet vehicle actions.
 *
 * ACTIVE-ORG PINNING is the invariant these actions exist to hold. RLS's
 * `current_org_ids()` passes for EVERY org the caller belongs to, so a by-id
 * write with no org predicate lets a user working in org A mutate org B's van.
 * Every write here therefore carries `ctx.org.id`:
 *   - create/update go through the save_fleet_vehicle RPC, which pins both of
 *     its UPDATEs with `and org_id = p_org_id` (20261056000000);
 *   - delete is count-gated on `.eq("asset_id", id).eq("org_id", ctx.org.id)`.
 * `__tests__/security/fleet-active-org-scoping.test.ts` pins that on source and
 * fails if any of it is removed; the integration tier proves it against a real
 * dual-org user.
 *
 * `fleet_vehicles` and the RPC are newer than the generated Supabase types, so
 * calls are cast through minimal precise shapes (the assets/snags idiom). All
 * writes use the tenant (user-JWT) client so RLS scopes them.
 */

type RpcChain = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

function formString(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

/** Map the form once — create and edit post the identical field set. */
function readVehicleForm(formData: FormData) {
  return vehicleFormSchema.safeParse({
    name: formString(formData, "name"),
    registration: formString(formData, "registration"),
    manufacturer: formString(formData, "manufacturer"),
    model: formString(formData, "model"),
    supplier_id: formString(formData, "supplier_id"),
    purchase_date: formString(formData, "purchase_date"),
    purchase_price: formString(formData, "purchase_price"),
    notes: formString(formData, "notes"),
    vin: formString(formData, "vin"),
    variant: formString(formData, "variant"),
    year_of_manufacture: formString(formData, "year_of_manufacture"),
    first_registered_on: formString(formData, "first_registered_on"),
    fuel_type: formString(formData, "fuel_type"),
    vehicle_class: formString(formData, "vehicle_class"),
    gross_weight_kg: formString(formData, "gross_weight_kg"),
    mot_exempt: formData.get("mot_exempt") ?? false,
    operational_status: formString(formData, "operational_status"),
    finance_type: formString(formData, "finance_type"),
    finance_provider_id: formString(formData, "finance_provider_id"),
    finance_agreement_ref: formString(formData, "finance_agreement_ref"),
    finance_monthly_payment: formString(formData, "finance_monthly_payment"),
    finance_end_date: formString(formData, "finance_end_date"),
    home_depot: formString(formData, "home_depot"),
    odometer_miles: formString(formData, "odometer_miles"),
  });
}

function rpcArgs(
  d: NonNullable<ReturnType<typeof readVehicleForm>["data"]>,
  orgId: string,
  assetId: string | null,
  userId: string,
  ownership: string,
) {
  return {
    p_asset_id: assetId,
    p_org_id: orgId,
    p_name: d.name,
    p_registration: d.registration ?? null,
    p_manufacturer: d.manufacturer ?? null,
    p_model: d.model ?? null,
    p_ownership: ownership,
    p_supplier_id: d.supplier_id ?? null,
    p_purchase_date: d.purchase_date ?? null,
    p_purchase_price: d.purchase_price ?? null,
    p_notes: d.notes ?? null,
    p_vin: d.vin ?? null,
    p_variant: d.variant ?? null,
    p_year_of_manufacture: d.year_of_manufacture ?? null,
    p_first_registered_on: d.first_registered_on ?? null,
    p_fuel_type: d.fuel_type ?? null,
    p_vehicle_class: d.vehicle_class ?? null,
    p_gross_weight_kg: d.gross_weight_kg ?? null,
    p_mot_exempt: d.mot_exempt === true,
    p_operational_status: d.operational_status,
    p_finance_type: d.finance_type,
    p_finance_provider_id: d.finance_provider_id ?? null,
    p_finance_agreement_ref: d.finance_agreement_ref ?? null,
    p_finance_monthly_payment: d.finance_monthly_payment ?? null,
    p_finance_end_date: d.finance_end_date ?? null,
    p_home_depot: d.home_depot ?? null,
    p_odometer_miles: d.odometer_miles ?? null,
    p_created_by: userId,
  };
}

/**
 * Translate the DB's own refusals into a sentence. The guards
 * (20261056000000) are the enforcement boundary; this only decides wording, so
 * a new guard failing loudly with a generic message is safe, never silent.
 */
function mapVehicleError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("cannot be in service")) return "asset_disposed";
  if (m.includes("not in org")) return "cross_org_reference";
  if (m.includes("not found in org")) return "not_found";
  if (m.includes("vin")) return "bad_vin";
  if (m.includes("finance")) return "finance_incoherent";
  return "record_failed";
}

export async function createVehicle(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = readVehicleForm(formData);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const first =
      Object.values(issues).flat()[0] ??
      parsed.error.flatten().formErrors[0] ??
      "Check the form and try again.";
    redirect(`/fleet/vehicles/new?error=${encodeURIComponent(first)}`);
  }

  const ownership = formString(formData, "ownership") === "hired" ? "hired" : "owned";
  const tenant = await createClient();
  const { data, error } = await (tenant as unknown as RpcChain).rpc(
    "save_fleet_vehicle",
    rpcArgs(parsed.data!, ctx.org.id, null, user.id, ownership),
  );
  if (error) {
    console.error("[fleet] createVehicle failed", error);
    redirect(`/fleet/vehicles/new?error=${mapVehicleError(error.message)}`);
  }

  const assetId = typeof data === "string" ? data : "";
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.vehicle.created",
    targetTable: "fleet_vehicles",
    targetId: assetId,
    metadata: {
      name: parsed.data!.name,
      registration: parsed.data!.registration ?? null,
      vehicle_class: parsed.data!.vehicle_class ?? null,
    },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/vehicles");
  redirect(`/fleet/vehicles/${assetId}?saved=created`);
}

export async function updateVehicle(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = formString(formData, "asset_id");
  if (!vehicleIdSchema.safeParse(id).success) redirect(`/fleet/vehicles?error=bad_id`);

  const parsed = readVehicleForm(formData);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const first =
      Object.values(issues).flat()[0] ??
      parsed.error.flatten().formErrors[0] ??
      "Check the form and try again.";
    redirect(`/fleet/vehicles/${id}/edit?error=${encodeURIComponent(first)}`);
  }

  const ownership = formString(formData, "ownership") === "hired" ? "hired" : "owned";
  const tenant = await createClient();
  const { error } = await (tenant as unknown as RpcChain).rpc(
    "save_fleet_vehicle",
    // p_org_id IS the active-org pin — the RPC's UPDATEs are scoped by it, so a
    // vehicle id belonging to another org updates zero rows and raises.
    rpcArgs(parsed.data!, ctx.org.id, id, user.id, ownership),
  );
  if (error) {
    console.error("[fleet] updateVehicle failed", error);
    redirect(`/fleet/vehicles/${id}/edit?error=${mapVehicleError(error.message)}`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.vehicle.updated",
    targetTable: "fleet_vehicles",
    targetId: id,
    metadata: {
      name: parsed.data!.name,
      operational_status: parsed.data!.operational_status,
    },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/vehicles");
  revalidatePath(`/fleet/vehicles/${id}`);
  redirect(`/fleet/vehicles/${id}?saved=updated`);
}

/**
 * Remove the VEHICLE PROFILE, not the asset.
 *
 * Deleting the extension row leaves the asset — with its custody history,
 * inspections, maintenance cases and documents — completely intact in
 * /assets. That is the honest semantics of "this isn't a fleet vehicle":
 * a fleet delete must never quietly destroy an asset's whole audit trail.
 * Disposal (sold / written off) is `assets.status`, on the asset's own page.
 */
export async function removeVehicleProfile(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = formString(formData, "asset_id");
  if (!vehicleIdSchema.safeParse(id).success) redirect(`/fleet/vehicles?error=bad_id`);

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("fleet_vehicles" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("asset_id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[fleet] removeVehicleProfile failed", error);
    redirect(`/fleet/vehicles/${id}?error=delete_failed`);
  }
  // Count-gated: RLS/role refusal returns no error and zero rows, so a silent
  // no-op must be reported as a refusal rather than a success.
  if (!count) redirect(`/fleet/vehicles/${id}?error=forbidden`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.vehicle.profile_removed",
    targetTable: "fleet_vehicles",
    targetId: id,
    metadata: { asset_retained: true },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/vehicles");
  redirect(`/fleet/vehicles?saved=removed`);
}

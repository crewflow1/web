"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { fuelLogSchema, vehicleIdSchema } from "@/lib/fleet/schema";

/**
 * Fuel log actions.
 *
 * ACTIVE-ORG PINNING: the insert stamps `org_id: ctx.org.id` and the composite
 * FK (asset_id, org_id) → assets(id, org_id) then makes a foreign asset_id
 * structurally unwritable — a forged id from the caller's OTHER org has no
 * matching row and the insert fails at the database, for every role. The delete
 * is count-gated on `.eq("id", id).eq("org_id", ctx.org.id)`.
 *
 * NOT A LEDGER: this records what went in the tank. It deliberately does not
 * post to `finances` — see the 20261058000000 header.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
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

function fs(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export async function createFuelLog(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = fs(formData, "asset_id");
  const returnTo = fs(formData, "return_to") === "fuel" ? "/fleet/fuel" : `/fleet/vehicles/${assetId}`;

  const parsed = fuelLogSchema.safeParse({
    asset_id: assetId,
    filled_on: fs(formData, "filled_on"),
    odometer_miles: fs(formData, "odometer_miles"),
    litres: fs(formData, "litres"),
    cost: fs(formData, "cost"),
    is_full_fill: formData.get("is_full_fill") ?? false,
    supplier_id: fs(formData, "supplier_id"),
    station: fs(formData, "station"),
    driver_id: fs(formData, "driver_id"),
    notes: fs(formData, "notes"),
  });
  if (!parsed.success) {
    const fields = parsed.error.flatten().fieldErrors;
    const first =
      Object.values(fields).flat()[0] ??
      parsed.error.flatten().formErrors[0] ??
      "validation";
    redirect(`${returnTo}?error=${encodeURIComponent(first)}#fuel`);
  }
  const d = parsed.data!;

  const tenant = await createClient();
  const { error } = await (
    tenant.from("asset_fuel_logs" as never) as unknown as InsertChain
  ).insert({
    org_id: ctx.org.id,
    asset_id: d.asset_id,
    filled_on: d.filled_on,
    odometer_miles: d.odometer_miles ?? null,
    litres: d.litres ?? null,
    cost: d.cost,
    is_full_fill: d.is_full_fill === true,
    supplier_id: d.supplier_id ?? null,
    station: d.station ?? null,
    driver_id: d.driver_id ?? null,
    notes: d.notes ?? null,
    created_by: user.id,
  });
  if (error) {
    console.error("[fleet] createFuelLog failed", error);
    const m = error.message.toLowerCase();
    const code = m.includes("in the future")
      ? "future_date"
      : m.includes("not in org") || m.includes("not a member")
        ? "cross_org_reference"
        : m.includes("foreign key")
          ? "not_found"
          : "fuel_failed";
    redirect(`${returnTo}?error=${code}#fuel`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.fuel.logged",
    targetTable: "asset_fuel_logs",
    targetId: d.asset_id,
    metadata: {
      filled_on: d.filled_on,
      litres: d.litres ?? null,
      cost: d.cost,
      is_full_fill: d.is_full_fill === true,
    },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/fuel");
  revalidatePath(`/fleet/vehicles/${d.asset_id}`);
  redirect(`${returnTo}?saved=fuel_logged#fuel`);
}

/** Delete is admin-only at the DB (fuel logs are expense evidence). */
export async function deleteFuelLog(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = fs(formData, "id");
  const assetId = fs(formData, "asset_id");
  const returnTo = fs(formData, "return_to") === "fuel" ? "/fleet/fuel" : `/fleet/vehicles/${assetId}`;
  if (!vehicleIdSchema.safeParse(id).success) redirect(`${returnTo}?error=bad_id#fuel`);

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_fuel_logs" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[fleet] deleteFuelLog failed", error);
    redirect(`${returnTo}?error=delete_failed#fuel`);
  }
  if (!count) redirect(`${returnTo}?error=forbidden#fuel`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.fuel.deleted",
    targetTable: "asset_fuel_logs",
    targetId: id,
    metadata: { asset_id: assetId },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/fuel");
  revalidatePath(`/fleet/vehicles/${assetId}`);
  redirect(`${returnTo}?saved=fuel_deleted#fuel`);
}

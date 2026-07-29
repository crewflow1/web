"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { fuelLogSchema, vehicleIdSchema } from "@/lib/fleet/schema";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";
import { FLEET_ERRORS } from "./_components/messages";

/** Sentence for a known code; unknown codes fall through readable, like errorMessage(). */
const fleetMsg = (code: string): string => FLEET_ERRORS[code] ?? code;

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
 *
 * These actions return `FormState` (client navigates via `redirectTo`) instead
 * of calling `redirect()` — see the header of ./actions.ts for the router race
 * that forbids Server-Action redirects between /fleet/vehicles/* routes.
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

export async function createFuelLog(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = fs(formData, "asset_id");
  const returnTo =
    fs(formData, "return_to") === "fuel" ? "/fleet/fuel" : `/fleet/vehicles/${assetId}`;

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
      "Check the fuel entry and try again.";
    return formError(first);
  }
  const d = parsed.data;

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
    return formError(fleetMsg(code));
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

  // No revalidatePath here, deliberately: every fleet surface is force-dynamic
  // and the client router treats dynamic content as immediately stale, so the
  // post-navigation fetch is always fresh. Revalidating also makes the action
  // response carry a full re-render of this deep route, which is exactly the
  // payload whose client-side commit can strand (see the header note).
  return formSuccess({ redirectTo: `${returnTo}?saved=fuel_logged#fuel` });
}

/** Delete is admin-only at the DB (fuel logs are expense evidence). */
export async function deleteFuelLog(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const id = fs(formData, "id");
  const assetId = fs(formData, "asset_id");
  const returnTo =
    fs(formData, "return_to") === "fuel" ? "/fleet/fuel" : `/fleet/vehicles/${assetId}`;
  if (!vehicleIdSchema.safeParse(id).success) return formError(fleetMsg("bad_id"));

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_fuel_logs" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[fleet] deleteFuelLog failed", error);
    return formError(fleetMsg("delete_failed"));
  }
  if (!count) return formError(fleetMsg("forbidden"));

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.fuel.deleted",
    targetTable: "asset_fuel_logs",
    targetId: id,
    metadata: { asset_id: assetId },
  });

  // No revalidatePath here, deliberately: every fleet surface is force-dynamic
  // and the client router treats dynamic content as immediately stale, so the
  // post-navigation fetch is always fresh. Revalidating also makes the action
  // response carry a full re-render of this deep route, which is exactly the
  // payload whose client-side commit can strand (see the header note).
  return formSuccess({ redirectTo: `${returnTo}?saved=fuel_deleted#fuel` });
}

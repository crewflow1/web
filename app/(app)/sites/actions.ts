"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { friendlySiteError, siteFormSchema, siteIdSchema } from "@/lib/sites/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * Sites — the company's own locations (depots, yards, warehouses, offices,
 * containers, lock-ups). CRUD for the reference-data register that
 * `fleet_vehicles.home_site_id` and `asset_assignments.site_id` point at.
 *
 * ACTIVE-ORG PINNING is the invariant these actions exist to hold. RLS gives
 * `sites_insert/update/delete` = `is_org_admin(org_id)`, which passes for EVERY
 * org the caller administers — it says nothing about the org they are currently
 * WORKING IN. So every by-id write here carries `.eq("org_id", ctx.org.id)` and
 * is COUNT-GATED: a row in the caller's other org matches zero rows and is
 * reported identically to a row that does not exist.
 * `__tests__/security/sites-active-org-scoping.test.ts` pins that on source and
 * fails if any of it is removed; `__tests__/integration/rls/sites-isolation.test.ts`
 * proves it against a real dual-org user.
 *
 * All writes use the tenant (user-JWT) client so RLS scopes them — never the
 * service-role client, which would bypass the admin-write policy entirely.
 *
 * `sites` is newer than the generated Supabase types, so calls are cast through
 * minimal precise shapes (the assets / fleet / snags idiom).
 */

type SiteValues = Record<string, unknown>;

type InsertChain = {
  insert: (row: unknown) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};
type UpdateChain = {
  update: (
    row: unknown,
    opts: { count: "exact" },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{
        error: { message: string; code?: string } | null;
        count: number | null;
      }>;
    };
  };
};
type DeleteChain = {
  delete: (opts: { count: "exact" }) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{
        error: { message: string; code?: string } | null;
        count: number | null;
      }>;
    };
  };
};

/** The columns the form owns. `active` is deliberately not one of them. */
function siteColumns(d: ReturnType<typeof siteFormSchema.parse>) {
  return {
    name: d.name,
    kind: d.kind,
    address_line1: d.address_line1 ?? null,
    address_line2: d.address_line2 ?? null,
    city: d.city ?? null,
    county: d.county ?? null,
    postcode: d.postcode ?? null,
    // The DB defaults this to 'United Kingdom' and the column is NOT NULL, so
    // an untouched field must fall back rather than send null.
    country: d.country ?? "United Kingdom",
    notes: d.notes ?? null,
  };
}

export async function createSite(
  _prev: FormState<SiteValues>,
  formData: FormData,
): Promise<FormState<SiteValues>> {
  const { ctx, user } = await requireOrgContext();
  const result = validateFormData(formData, siteFormSchema);
  if (!result.ok) return result.state as FormState<SiteValues>;

  const supabase = await createClient();
  const { data, error } = await (
    supabase.from("sites" as never) as unknown as InsertChain
  )
    .insert({
      org_id: ctx.org.id,
      ...siteColumns(result.data),
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[sites] create failed", error);
    return formError(
      friendlySiteError(error?.code, error?.message),
      result.data as SiteValues,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site.created",
    targetTable: "sites",
    targetId: data.id,
    metadata: { name: result.data.name, kind: result.data.kind },
  });

  revalidatePath("/sites");
  return formSuccess({ successMessage: "Site added.", redirectTo: "/sites" });
}

export async function updateSite(
  id: string,
  _prev: FormState<SiteValues>,
  formData: FormData,
): Promise<FormState<SiteValues>> {
  const { ctx, user } = await requireOrgContext();
  if (!siteIdSchema.safeParse(id).success) return formError("Invalid site id.");

  const result = validateFormData(formData, siteFormSchema);
  if (!result.ok) return result.state as FormState<SiteValues>;

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("sites" as never) as unknown as UpdateChain
  )
    .update(
      { ...siteColumns(result.data), updated_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", id)
    // ACTIVE-ORG SCOPE. `sites_update` only proves the caller ADMINISTERS the
    // site's own org — for an owner of two companies that passes for BOTH, so
    // without this predicate an edit issued while working in company A could
    // land on company B's depot and silently rename it everywhere.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[sites] update failed", error);
    return formError(
      friendlySiteError(error.code, error.message),
      result.data as SiteValues,
    );
  }
  if (count === 0) {
    // Not in the ACTIVE org, or the caller is not an admin of it. Identical
    // wording either way — a non-active org's site must be indistinguishable
    // from a missing one.
    return formError(
      "That site isn't in this organisation any more.",
      result.data as SiteValues,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site.updated",
    targetTable: "sites",
    targetId: id,
    metadata: { name: result.data.name, kind: result.data.kind },
  });

  revalidatePath("/sites");
  revalidatePath(`/sites/${id}`);
  return formSuccess({ successMessage: "Site updated." });
}

/**
 * Deactivate / reactivate — the ORDINARY way a site leaves service.
 *
 * A closed depot is still the truthful answer to "where was that van kept in
 * 2026", so retiring it must not rewrite history. Deactivating drops it out of
 * every picker while leaving every existing link intact and readable.
 */
export async function setSiteActive(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!siteIdSchema.safeParse(id).success) redirect("/sites?error=bad_id");
  const active = String(formData.get("active") ?? "") === "true";

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("sites" as never) as unknown as UpdateChain
  )
    .update({ active, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[sites] setSiteActive failed", error);
    redirect(`/sites/${id}?error=save_failed`);
  }
  // Count-gated: an RLS/role refusal returns no error and zero rows, so a
  // silent no-op must be reported as a refusal rather than as success.
  if (!count) redirect(`/sites/${id}?error=forbidden`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: active ? "site.reactivated" : "site.deactivated",
    targetTable: "sites",
    targetId: id,
    metadata: { active },
  });

  revalidatePath("/sites");
  revalidatePath(`/sites/${id}`);
  redirect(`/sites/${id}?saved=${active ? "reactivated" : "deactivated"}`);
}

/**
 * Hard delete — only ever possible for a site NOTHING points at.
 *
 * `tg_sites_delete_guard` (20261061000000) refuses the delete while any vehicle
 * or custody record still references it, so this is not a check-then-delete
 * race: the database is the gate and this only translates its refusal.
 */
export async function deleteSite(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const id = String(formData.get("id") ?? "");
  if (!siteIdSchema.safeParse(id).success) redirect("/sites?error=bad_id");

  const supabase = await createClient();
  const { error, count } = await (
    supabase.from("sites" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", id)
    // ACTIVE-ORG SCOPE. A delete is irreversible, so this is the single most
    // important predicate in this file: `sites_delete` is `is_org_admin(org_id)`,
    // which an owner of two companies satisfies for both.
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[sites] delete failed", error);
    redirect(`/sites/${id}?error=in_use`);
  }
  if (!count) redirect(`/sites/${id}?error=delete_denied`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "site.deleted",
    targetTable: "sites",
    targetId: id,
    metadata: {},
  });

  revalidatePath("/sites");
  redirect("/sites?saved=deleted");
}

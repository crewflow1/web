"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

/**
 * Settings page server actions.
 *
 *   updateProfile        — updates the signed-in user's own public.users row
 *                          (full_name, phone). Email comes from auth.users
 *                          and is read-only in the UI.
 *   updateOrganization   — updates the current org's name / phone /
 *                          vat_number / address jsonb. Admin-only at the
 *                          DB (organizations UPDATE policy is members-of-
 *                          org; we additionally enforce admin role here so
 *                          the form is consistent with the UI).
 */

const profileSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const orgSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  vat_number: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  address_line1: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  address_city: z
    .string()
    .trim()
    .max(100)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  address_postcode: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function updateProfile(formData: FormData) {
  const { user } = await requireOrgContext();

  const parsed = profileSchema.safeParse({
    full_name: formData.get("full_name") ?? "",
    phone: formData.get("phone") ?? "",
  });
  if (!parsed.success) {
    redirect(`/settings?error=invalid_profile`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("users")
    .update({
      full_name: parsed.data.full_name,
      phone: parsed.data.phone ?? null,
    })
    .eq("id", user.id);
  if (error) {
    console.error("[settings] profile update failed", error);
    redirect("/settings?error=profile_update_failed");
  }

  revalidatePath("/settings");
  redirect("/settings?saved=profile");
}

export async function updateOrganization(formData: FormData) {
  const { ctx } = await requireOrgContext();

  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect("/settings?error=not_admin");
  }

  const parsed = orgSchema.safeParse({
    name: formData.get("name") ?? "",
    phone: formData.get("phone") ?? "",
    vat_number: formData.get("vat_number") ?? "",
    address_line1: formData.get("address_line1") ?? "",
    address_city: formData.get("address_city") ?? "",
    address_postcode: formData.get("address_postcode") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings?error=invalid_org");
  }

  // Address is stored as jsonb; collapse empty subfields to null overall
  // so we don't write {} for orgs with no address.
  const addressEntries = [
    ["line1", parsed.data.address_line1],
    ["city", parsed.data.address_city],
    ["postcode", parsed.data.address_postcode],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  const address = addressEntries.length > 0 ? Object.fromEntries(addressEntries) : null;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("organizations")
    .update(
      {
        name: parsed.data.name,
        phone: parsed.data.phone ?? null,
        vat_number: parsed.data.vat_number ?? null,
        address,
      },
      { count: "exact" },
    )
    .eq("id", ctx.org.id);
  if (error) {
    console.error("[settings] org update failed", error);
    redirect("/settings?error=org_update_failed");
  }
  if (count === 0) {
    redirect("/settings?error=not_allowed");
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  redirect("/settings?saved=org");
}

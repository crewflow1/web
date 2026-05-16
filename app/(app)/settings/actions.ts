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

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

const orgSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: optional(50),
  vat_number: optional(50),
  address_line1: optional(200),
  address_city: optional(100),
  address_postcode: optional(20),
  // PDF branding (added in 4B / quotes module)
  logo_url: z
    .string()
    .trim()
    .url("Logo URL must be a full https://… URL")
    .max(500)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  default_terms: optional(20000),
  bank_name: optional(200),
  bank_sort_code: optional(20),
  bank_account_number: optional(30),
  bank_reference: optional(100),
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
    logo_url: formData.get("logo_url") ?? "",
    default_terms: formData.get("default_terms") ?? "",
    bank_name: formData.get("bank_name") ?? "",
    bank_sort_code: formData.get("bank_sort_code") ?? "",
    bank_account_number: formData.get("bank_account_number") ?? "",
    bank_reference: formData.get("bank_reference") ?? "",
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

  // Collapse the four bank fields into a single jsonb blob (null if all empty).
  const bankEntries = [
    ["name", parsed.data.bank_name],
    ["sort_code", parsed.data.bank_sort_code],
    ["account_number", parsed.data.bank_account_number],
    ["reference", parsed.data.bank_reference],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  const bank_details =
    bankEntries.length > 0 ? Object.fromEntries(bankEntries) : null;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("organizations")
    .update(
      {
        name: parsed.data.name,
        phone: parsed.data.phone ?? null,
        vat_number: parsed.data.vat_number ?? null,
        address,
        logo_url: parsed.data.logo_url ?? null,
        default_terms: parsed.data.default_terms ?? null,
        bank_details,
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

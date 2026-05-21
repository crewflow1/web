"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

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
  full_name: z.string().trim().min(1, "Name is required").max(100),
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
  name: z.string().trim().min(1, "Trading name is required").max(200),
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

type SettingsValues = Record<string, unknown>;

export async function updateProfile(
  _prevState: FormState<SettingsValues>,
  formData: FormData,
): Promise<FormState<SettingsValues>> {
  const { user } = await requireOrgContext();
  const result = validateFormData(formData, profileSchema);
  if (!result.ok) return result.state as FormState<SettingsValues>;

  const supabase = await createClient();
  const { error } = await supabase
    .from("users")
    .update({
      full_name: result.data.full_name,
      phone: result.data.phone ?? null,
    })
    .eq("id", user.id);
  if (error) {
    console.error("[settings] profile update failed", error);
    return formError(
      "Couldn't save your profile. Try again.",
      result.data as SettingsValues,
    );
  }

  revalidatePath("/settings");
  return formSuccess({ successMessage: "Profile saved." });
}

export async function updateOrganization(
  _prevState: FormState<SettingsValues>,
  formData: FormData,
): Promise<FormState<SettingsValues>> {
  const { ctx } = await requireOrgContext();

  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return formError("Only admins/owners can edit organisation details.");
  }

  const result = validateFormData(formData, orgSchema);
  if (!result.ok) return result.state as FormState<SettingsValues>;

  // Address is stored as jsonb; collapse empty subfields to null overall
  // so we don't write {} for orgs with no address.
  const addressEntries = [
    ["line1", result.data.address_line1],
    ["city", result.data.address_city],
    ["postcode", result.data.address_postcode],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  const address =
    addressEntries.length > 0 ? Object.fromEntries(addressEntries) : null;

  // Collapse the four bank fields into a single jsonb blob (null if all empty).
  const bankEntries = [
    ["name", result.data.bank_name],
    ["sort_code", result.data.bank_sort_code],
    ["account_number", result.data.bank_account_number],
    ["reference", result.data.bank_reference],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  const bank_details =
    bankEntries.length > 0 ? Object.fromEntries(bankEntries) : null;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("organizations")
    .update(
      {
        name: result.data.name,
        phone: result.data.phone ?? null,
        vat_number: result.data.vat_number ?? null,
        address,
        logo_url: result.data.logo_url ?? null,
        default_terms: result.data.default_terms ?? null,
        bank_details,
      },
      { count: "exact" },
    )
    .eq("id", ctx.org.id);
  if (error) {
    console.error("[settings] org update failed", error);
    return formError(
      "Couldn't save organisation. Try again.",
      result.data as SettingsValues,
    );
  }
  if (count === 0) {
    return formError(
      "You don't have permission to edit organisation details.",
      result.data as SettingsValues,
    );
  }

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return formSuccess({ successMessage: "Organisation saved." });
}

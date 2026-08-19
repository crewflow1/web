"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  formError,
  formSuccess,
  validateFormData,
  type FormState,
} from "@/lib/forms/state";
import {
  WEEKDAYS,
  taxDefaultsSchema,
  flatRateConfigSchema,
  type WorkingHours,
} from "@/lib/org-config/schema";

/**
 * Settings → Org config — save actions for the two P3W2 panels.
 *
 *   saveWorkingHours  — per-org structured working hours / working days.
 *   saveTaxDefaults   — default VAT rate, CIS default rate, financial-year
 *                       start month, default payment terms.
 *
 * AUTHORISATION. org_id comes from requireOrgContext (the session), never from
 * client input. Admin (owner/admin) is enforced here AND at the DB — org_settings
 * RLS is admin-write (is_org_admin) — so a non-admin calling the action directly
 * is refused twice: the role check below returns an error, and even if that were
 * bypassed the RLS with-check makes the upsert write zero rows. Route depth is 2
 * (/settings), so returning a FormState (no redirect) is safe.
 *
 * Both actions UPSERT the single org row (one row per org, unique org_id).
 */

type SettingsValues = Record<string, unknown>;

async function requireAdmin() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  return { ctx, isAdmin };
}

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

/**
 * The working-hours form submits, per weekday: a checkbox `open_<day>` (present
 * only when the day is a working day) plus `<day>_open` / `<day>_close` "HH:MM"
 * times. We assemble the structured jsonb here and validate the whole thing so a
 * closing-before-opening window is rejected inline.
 */
const dayFormSchema = z
  .object({
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:00"),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:00"),
  })
  .refine((d) => d.open < d.close, {
    message: "Closing time must be after opening time",
  });

export async function saveWorkingHours(
  _prev: FormState<SettingsValues>,
  formData: FormData,
): Promise<FormState<SettingsValues>> {
  const { ctx, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return formError("Only admins/owners can change working hours.");
  }

  const working_hours: WorkingHours = {
    mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
  };
  const fieldErrors: Record<string, string> = {};

  for (const day of WEEKDAYS) {
    const isWorking = formData.get(`open_${day}`) === "on";
    if (!isWorking) {
      working_hours[day] = null;
      continue;
    }
    const open = String(formData.get(`${day}_open`) ?? "");
    const close = String(formData.get(`${day}_close`) ?? "");
    const parsed = dayFormSchema.safeParse({ open, close });
    if (!parsed.success) {
      fieldErrors[day] = parsed.error.issues[0]?.message ?? "Invalid hours";
      working_hours[day] = null;
      continue;
    }
    working_hours[day] = { open: parsed.data.open, close: parsed.data.close };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      error: "Fix the highlighted days and try again.",
      fieldErrors,
      values: {},
      submittedAt: Date.now(),
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("org_settings" as never)
    .upsert(
      { org_id: ctx.org.id, working_hours } as never,
      { onConflict: "org_id" } as never,
    );
  if (error) {
    console.error("[org-config] working hours save failed", error);
    return formError("Couldn't save working hours. Try again.");
  }

  revalidatePath("/settings");
  return formSuccess({ successMessage: "Working hours saved." });
}

// ---------------------------------------------------------------------------
// Tax & defaults
// ---------------------------------------------------------------------------

export async function saveTaxDefaults(
  _prev: FormState<SettingsValues>,
  formData: FormData,
): Promise<FormState<SettingsValues>> {
  const { ctx, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return formError("Only admins/owners can change tax defaults.");
  }

  const result = validateFormData(formData, taxDefaultsSchema);
  if (!result.ok) return result.state as FormState<SettingsValues>;

  const supabase = await createClient();
  const { error } = await supabase
    .from("org_settings" as never)
    .upsert(
      {
        org_id: ctx.org.id,
        default_vat_rate: result.data.default_vat_rate,
        cis_default_rate: result.data.cis_default_rate,
        financial_year_start_month: result.data.financial_year_start_month,
        default_payment_terms_days: result.data.default_payment_terms_days,
        vat_stagger: result.data.vat_stagger,
        vat_scheme: result.data.vat_scheme,
      } as never,
      { onConflict: "org_id" } as never,
    );
  if (error) {
    console.error("[org-config] tax defaults save failed", error);
    return formError(
      "Couldn't save tax defaults. Try again.",
      result.data as SettingsValues,
    );
  }

  revalidatePath("/settings");
  return formSuccess({ successMessage: "Tax & defaults saved." });
}

// ---------------------------------------------------------------------------
// Flat Rate Scheme (FRS)
// ---------------------------------------------------------------------------

/**
 * Save the org's VAT Flat Rate Scheme config. Validated through the SAME
 * `flatRateConfigSchema` the read path coerces with, so the form and reader can
 * never disagree. Stored as the `flat_rate_config` jsonb blob on org_settings
 * (admin-write / member-read at the DB). Absent/disabled ⇒ FRS never applies, so a
 * non-opted org's VAT figures are unchanged.
 *
 * Checkboxes submit their value only when ticked, so `enabled` / `first_year_discount`
 * are read as presence booleans; the empty date fields coerce to null in the schema.
 */
export async function saveFlatRateConfig(
  _prev: FormState<SettingsValues>,
  formData: FormData,
): Promise<FormState<SettingsValues>> {
  const { ctx, isAdmin } = await requireAdmin();
  if (!isAdmin) {
    return formError("Only admins/owners can change the Flat Rate Scheme.");
  }

  const parsed = flatRateConfigSchema.safeParse({
    enabled: formData.get("frs_enabled") === "on",
    sector_percent: formData.get("frs_sector_percent"),
    registration_date: formData.get("frs_registration_date"),
    first_year_discount: formData.get("frs_first_year_discount") === "on",
    effective_from: formData.get("frs_effective_from"),
    effective_to: formData.get("frs_effective_to"),
    limited_cost: formData.get("frs_limited_cost") ?? "auto",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: "Fix the highlighted Flat Rate Scheme fields and try again.",
      fieldErrors,
      values: {},
      submittedAt: Date.now(),
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("org_settings" as never)
    .upsert(
      { org_id: ctx.org.id, flat_rate_config: parsed.data } as never,
      { onConflict: "org_id" } as never,
    );
  if (error) {
    console.error("[org-config] flat rate config save failed", error);
    return formError("Couldn't save the Flat Rate Scheme. Try again.");
  }

  revalidatePath("/settings");
  return formSuccess({ successMessage: "Flat Rate Scheme saved." });
}

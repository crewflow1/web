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

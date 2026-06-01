"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { jobFormSchema, type JobFormInput } from "@/lib/jobs/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * Job CRUD server actions.
 *
 * RLS posture on `jobs` (from migration 20260515150000):
 *   - SELECT / INSERT: org members
 *   - UPDATE / DELETE: admins/owners only
 *
 * Non-admins who attempt update/delete will see RLS silently filter the
 * row out (zero rows affected). We surface this as a generic error
 * message — the form re-renders and the user can ask an admin.
 *
 * customer_id and assigned_to are optional (nullable in schema):
 *   - assigned_to: empty string from <select> -> null
 *   - customer_id: empty string -> null (job not yet linked to a customer)
 */

type JobValues = Record<string, unknown>;

function buildRecurring(
  pattern: string | undefined,
  endDate: string | undefined,
): { pattern: string; end_date?: string } | null {
  if (!pattern) return null;
  return endDate ? { pattern, end_date: endDate } : { pattern };
}

export async function createJob(
  _prevState: FormState<JobValues>,
  formData: FormData,
): Promise<FormState<JobValues>> {
  const { ctx } = await requireOrgContext();
  const result = validateFormData(formData, jobFormSchema);
  if (!result.ok) return result.state as FormState<JobValues>;

  const supabase = await createClient();
  const recurring = buildRecurring(
    result.data.recurring_pattern,
    result.data.recurring_end_date,
  );
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      org_id: ctx.org.id,
      customer_id: result.data.customer_id ?? null,
      assigned_to: result.data.assigned_to ?? null,
      status: result.data.status,
      scheduled_date: result.data.scheduled_date ?? null,
      notes: result.data.notes ?? null,
      recurring,
      site_address_line1: result.data.site_address_line1 ?? null,
      site_address_line2: result.data.site_address_line2 ?? null,
      site_city: result.data.site_city ?? null,
      site_county: result.data.site_county ?? null,
      site_postcode: result.data.site_postcode ?? null,
      site_country: result.data.site_country ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[jobs] create failed", error);
    return formError("Couldn't save the job. Try again.", result.data as JobValues);
  }

  revalidatePath("/jobs");
  return formSuccess({
    successMessage: "Job created.",
    redirectTo: `/jobs/${data.id}`,
  });
}

export async function updateJob(
  id: string,
  _prevState: FormState<JobValues>,
  formData: FormData,
): Promise<FormState<JobValues>> {
  await requireOrgContext();
  const result = validateFormData(formData, jobFormSchema);
  if (!result.ok) return result.state as FormState<JobValues>;

  const supabase = await createClient();
  const recurring = buildRecurring(
    result.data.recurring_pattern,
    result.data.recurring_end_date,
  );
  const { error, count } = await supabase
    .from("jobs")
    .update(
      {
        customer_id: result.data.customer_id ?? null,
        assigned_to: result.data.assigned_to ?? null,
        status: result.data.status,
        scheduled_date: result.data.scheduled_date ?? null,
        notes: result.data.notes ?? null,
        recurring,
        site_address_line1: result.data.site_address_line1 ?? null,
        site_address_line2: result.data.site_address_line2 ?? null,
        site_city: result.data.site_city ?? null,
        site_county: result.data.site_county ?? null,
        site_postcode: result.data.site_postcode ?? null,
        site_country: result.data.site_country ?? null,
      },
      { count: "exact" },
    )
    .eq("id", id);

  if (error) {
    console.error("[jobs] update failed", error);
    return formError("Couldn't save changes. Try again.", result.data as JobValues);
  }
  if (count === 0) {
    return formError(
      "Only admins/owners can edit jobs.",
      result.data as JobValues,
    );
  }

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  return formSuccess({ successMessage: "Saved." });
}

export async function deleteJob(id: string) {
  await requireOrgContext();
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("jobs")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    console.error("[jobs] delete failed", error);
    redirect(`/jobs/${id}?error=delete_failed`);
  }
  if (count === 0) {
    redirect(`/jobs/${id}?error=delete_denied`);
  }
  revalidatePath("/jobs");
  redirect("/jobs");
}

// Re-exported for tests that previously imported the shape.
export type { JobFormInput };

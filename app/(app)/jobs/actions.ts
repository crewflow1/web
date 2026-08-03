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
import { bestEffortPushJob } from "@/server/services/calendar-connections";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";

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

  // Best-effort one-way push to a connected calendar. A no-op while the calendar
  // integration is dark (the flag is off, so no DB/network happens); once live it
  // creates/updates the external event and never blocks or fails the save.
  if (result.data.scheduled_date) {
    await bestEffortPushJob(ctx.org.id, data.id);
  }

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
  const { ctx } = await requireOrgContext();
  const result = validateFormData(formData, jobFormSchema);
  if (!result.ok) return result.state as FormState<JobValues>;

  const supabase = await createClient();
  const recurring = buildRecurring(
    result.data.recurring_pattern,
    result.data.recurring_end_date,
  );

  // Read the CURRENT status (org-pinned) so we can fire `job.completed` only on a
  // real transition INTO "completed", not on every save of an already-completed
  // job. Best-effort — a failed read simply skips the transition detection; it
  // never blocks the save. The dispatch below is idempotent regardless (keyed on
  // the job id), so this read is an efficiency + honesty guard, not correctness.
  const { data: priorRow } = await supabase
    .from("jobs")
    .select("status")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  const priorStatus = priorRow?.status ?? null;

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
    .eq("id", id)
    // Active-org scope. RLS (`is_org_admin(org_id)`) only proves the caller is
    // an admin of the job's OWN org — for a user who owns two orgs that passes
    // for BOTH, so without this predicate a write issued while working in org A
    // could land on an org B job. See lib/jobs/load.
    .eq("org_id", ctx.org.id);

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

  // Automation OS — a job flipping INTO "completed" fires `job.completed` so the
  // "job completed → suggest invoice" rule can run. Only on a real transition
  // (prior status was not already "completed"), mirroring how quote.accepted /
  // payment.recorded are dispatched: org-pinned, keyed on the job id, idempotent
  // via (rule_id, correlation_id) in automation_runs, and best-effort — a dispatch
  // failure never derails the save.
  if (result.data.status === "completed" && priorStatus !== "completed") {
    await dispatchAutomation({
      type: "job.completed",
      org_id: ctx.org.id,
      source_table: "jobs",
      source_id: id,
      payload: { from: priorStatus, to: "completed" },
    }).catch((e) => {
      console.error("[jobs] automation dispatch failed", e);
    });
  }

  // Best-effort one-way push to a connected calendar (see createJob). A no-op
  // while dark; on a re-save it updates the SAME event via calendar_event_links.
  if (result.data.scheduled_date) {
    await bestEffortPushJob(ctx.org.id, id);
  }

  return formSuccess({ successMessage: "Job updated." });
}

export async function deleteJob(id: string) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("jobs")
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see the note in updateJob. A delete is irreversible,
    // so this is the single most important predicate in this file.
    .eq("org_id", ctx.org.id);

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

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
import {
  bestEffortPushJob,
  bestEffortDeleteJobEvent,
} from "@/server/services/calendar-connections";
import { dispatchAutomation } from "@/server/services/automation-dispatcher";
import { verifyCrmReferences } from "@/lib/crm/reference-integrity";

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

/**
 * Cross-field span rule (mirrors the jobs_span_forward CHECK). Returns an error
 * sentence or null. An end date without a start, or before the start, is refused.
 */
function validateSpan(
  start: string | undefined,
  end: string | undefined,
): string | null {
  if (!end) return null;
  if (!start) return "Set a scheduled date before adding an end date.";
  if (end < start) return "The end date can't be before the scheduled date.";
  return null;
}

export async function createJob(
  _prevState: FormState<JobValues>,
  formData: FormData,
): Promise<FormState<JobValues>> {
  const { ctx } = await requireOrgContext();
  const result = validateFormData(formData, jobFormSchema);
  if (!result.ok) return result.state as FormState<JobValues>;

  const supabase = await createClient();

  // Cross-tenant reference integrity (defence in depth over the DB composite FK
  // + membership trigger from 20261112000000): a caller must not attach another
  // org's customer or a non-member as the assignee. Rejected with a clean
  // validation error rather than surfacing a raw FK/trigger failure as a 500.
  const refs = await verifyCrmReferences(supabase, ctx.org.id, {
    customerId: result.data.customer_id ?? null,
    assignedTo: result.data.assigned_to ?? null,
  });
  if (!refs.ok) return formError(refs.message, result.data as JobValues);

  // Multi-day span: an end date is only meaningful alongside a start, and must
  // not precede it (mirrors the jobs_span_forward CHECK; refused here with a
  // sentence rather than surfacing a raw constraint error).
  const spanError = validateSpan(
    result.data.scheduled_date,
    result.data.scheduled_end_date,
  );
  if (spanError) return formError(spanError, result.data as JobValues);

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
      scheduled_end_date: result.data.scheduled_end_date ?? null,
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

  // Clone a job template's checklist (and, for admins with a scheduled date, its
  // programme baseline) onto the new job. Best-effort: the job is already saved,
  // so a template that no longer exists or a partial clone must never fail the
  // create. The RPC is atomic and org-pinned; a member's clone silently skips
  // the admin-only baseline (see clone_job_template, 20261132000001).
  if (result.data.template_id) {
    const { error: cloneError } = await supabase.rpc("clone_job_template", {
      p_job_id: data.id,
      p_org_id: ctx.org.id,
      p_template_id: result.data.template_id,
      // `p_anchor_date date` has no DEFAULT, so supabase-gen-types types it as a
      // non-null `string` — but the function body explicitly handles NULL
      // (`if p_anchor_date is not null …`, 20261132000001) and the member path
      // (no scheduled date) legitimately passes null. Narrow cast bridges that
      // generator gap; the DB accepts and handles the null. (Follow-up: give the
      // param `default null` so the generated type is nullable.)
      p_anchor_date: (result.data.scheduled_date ?? null) as string,
    });
    if (cloneError) {
      console.error("[jobs] template clone failed", cloneError);
    }
  }

  revalidatePath("/jobs");

  // Automation OS — the create form (app/(app)/jobs/_form.tsx) offers a Status
  // select that includes "Completed", so a job can be logged already-completed
  // from /jobs/new (retroactively recording a finished job). That is the SAME
  // terminal state updateJob fires `job.completed` on, so it must fire here too —
  // otherwise a job that reaches "completed" via the create path never emits the
  // event and the "job completed → suggest invoice" owner prompt silently never
  // runs. Mirrors updateJob exactly: org-pinned, keyed on the job id, best-effort.
  // Idempotent via (rule_id, correlation_id = `job.completed:jobs:<id>`) in
  // automation_runs, so a later re-save that also dispatches is at-most-once.
  if (result.data.status === "completed") {
    await dispatchAutomation({
      type: "job.completed",
      org_id: ctx.org.id,
      source_table: "jobs",
      source_id: data.id,
      payload: { to: "completed" },
    }).catch((e) => {
      console.error("[jobs] automation dispatch failed", e);
    });
  }

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

  // Cross-tenant reference integrity — see createJob. Verified before the write
  // so a forged customer_id / assigned_to is a clean validation error, not a 500.
  const refs = await verifyCrmReferences(supabase, ctx.org.id, {
    customerId: result.data.customer_id ?? null,
    assignedTo: result.data.assigned_to ?? null,
  });
  if (!refs.ok) return formError(refs.message, result.data as JobValues);

  const spanError = validateSpan(
    result.data.scheduled_date,
    result.data.scheduled_end_date,
  );
  if (spanError) return formError(spanError, result.data as JobValues);

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
        scheduled_end_date: result.data.scheduled_end_date ?? null,
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

  // Automation OS — a completed job fires `job.completed` so the "job completed →
  // suggest invoice" rule can run. Dispatched whenever the saved status is
  // "completed"; the dispatcher claims (rule_id, correlation_id) against a unique
  // constraint in automation_runs (correlation = `job.completed:jobs:<id>`), so
  // each rule fires exactly once per job no matter how many times a completed job
  // is re-saved — no prior-status read needed. Mirrors quote.accepted /
  // payment.recorded: org-pinned, keyed on the job id, best-effort (a dispatch
  // failure never derails the save).
  if (result.data.status === "completed") {
    await dispatchAutomation({
      type: "job.completed",
      org_id: ctx.org.id,
      source_table: "jobs",
      source_id: id,
      payload: { to: "completed" },
    }).catch((e) => {
      console.error("[jobs] automation dispatch failed", e);
    });
  }

  // Best-effort one-way push to a connected calendar (see createJob). A no-op
  // while dark; on a re-save it updates the SAME event via calendar_event_links.
  // When scheduled_date is CLEARED (now null) we instead delete any external
  // event so a de-scheduled job does not strand an orphan on the calendar. The
  // delete composer is read-free here: it is a no-op when no link exists and is
  // idempotent/404-tolerant, so we always attempt it on null WITHOUT reading the
  // prior scheduled_date (no extra loud read needed).
  if (result.data.scheduled_date) {
    await bestEffortPushJob(ctx.org.id, id);
  } else {
    await bestEffortDeleteJobEvent(ctx.org.id, id);
  }

  return formSuccess({ successMessage: "Job updated." });
}

export async function deleteJob(id: string) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // Best-effort: remove any external calendar event BEFORE the job row goes away
  // (so the mapping is still resolvable), so a deleted job does not strand an
  // orphan event forever. A no-op while dark; never blocks or fails the delete.
  await bestEffortDeleteJobEvent(ctx.org.id, id);

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

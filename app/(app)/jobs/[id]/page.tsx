import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateJob, deleteJob } from "../actions";
import { listCustomersForOrg, listStaffForOrg } from "../_form-helpers";
import { Field, TextareaField, SelectField } from "../../_components/field";
import { PhotoGallery } from "./_photo-gallery";

/**
 * Job edit page.
 *
 * Update + delete are admin-only at the DB (RLS). If a non-admin submits
 * the form, RLS returns 0 rows affected and the action redirects with
 * `?error=update_denied`.
 */
export default async function EditJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, saved } = await searchParams;

  await requireOrgContext();
  const supabase = await createClient();
  const { data: job } = await supabase
    .from("jobs")
    .select(
      `
        id, status, scheduled_date, notes, customer_id, assigned_to,
        customer:customers ( id, name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!job) notFound();

  const [customers, staff] = await Promise.all([
    listCustomersForOrg(),
    listStaffForOrg(),
  ]);

  const errorMessage = error
    ? error === "update_failed"
      ? "Couldn't save the job. Try again."
      : error === "update_denied"
        ? "Only admins/owners can update jobs."
        : error === "delete_failed"
          ? "Couldn't delete the job."
          : error === "delete_denied"
            ? "Only admins/owners can delete jobs."
            : decodeURIComponent(error)
    : null;

  const updateAction = updateJob.bind(null, job.id);
  const deleteAction = deleteJob.bind(null, job.id);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs" className="hover:text-slate-900">
          Jobs
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-900">
          {job.customer?.name ?? "Job"}
        </span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">Edit job</h1>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          Saved.
        </div>
      ) : null}

      <form
        action={updateAction}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <SelectField
          name="customer_id"
          label="Customer"
          defaultValue={job.customer_id ?? ""}
          options={[
            { value: "", label: "— None —" },
            ...customers.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <SelectField
          name="assigned_to"
          label="Assigned to"
          defaultValue={job.assigned_to ?? ""}
          options={[
            { value: "", label: "— Unassigned —" },
            ...staff.map((s) => ({
              value: s.id,
              label: s.full_name ?? s.email,
            })),
          ]}
        />
        <SelectField
          name="status"
          label="Status"
          required
          defaultValue={job.status}
          options={[
            { value: "new", label: "New" },
            { value: "in-progress", label: "In progress" },
            { value: "completed", label: "Completed" },
            { value: "blocked", label: "Blocked" },
          ]}
        />
        <Field
          name="scheduled_date"
          label="Scheduled date"
          type="date"
          optional
          defaultValue={job.scheduled_date ?? ""}
        />
        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={4}
          defaultValue={job.notes ?? ""}
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Save changes
          </button>
          <Link
            href="/jobs"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>

      <PhotoGallery jobId={job.id} />

      <form
        action={deleteAction}
        className="rounded-xl border border-red-200 bg-red-50/50 p-4"
      >
        <p className="text-sm font-medium text-red-900">Delete this job</p>
        <p className="mt-1 text-xs text-red-700">
          Removes the job and any linked photo references. Only admins/owners
          can delete.
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
        >
          Delete job
        </button>
      </form>
    </div>
  );
}

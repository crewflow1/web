import Link from "next/link";
import { createJob } from "../actions";
import { listCustomersForOrg, listStaffForOrg } from "../_form-helpers";
import { Field, TextareaField, SelectField } from "../../_components/field";

/**
 * Create-job page.
 *
 * Both dropdown sources are fetched under user JWT; RLS filters to the
 * caller's org. If there are no customers yet, we link out to /customers/new.
 */
export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error
    ? error === "create_failed"
      ? "Couldn't save the job. Try again."
      : decodeURIComponent(error)
    : null;

  const [customers, staff] = await Promise.all([
    listCustomersForOrg(),
    listStaffForOrg(),
  ]);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/jobs" className="hover:text-slate-900">
          Jobs
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <header>
        <h1 className="text-2xl font-bold text-slate-900">New job</h1>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createJob}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <SelectField
          name="customer_id"
          label="Customer"
          options={[
            { value: "", label: customers.length === 0 ? "— No customers yet —" : "— None —" },
            ...customers.map((c) => ({ value: c.id, label: c.name })),
          ]}
          help={
            customers.length === 0 ? (
              "Add a customer first via the Customers tab."
            ) : undefined as unknown as string
          }
        />
        <SelectField
          name="assigned_to"
          label="Assigned to"
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
          defaultValue="new"
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
        />
        <TextareaField
          name="notes"
          label="Notes"
          optional
          rows={4}
          placeholder="Scope, materials, access notes…"
        />

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Create job
          </button>
          <Link
            href="/jobs"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

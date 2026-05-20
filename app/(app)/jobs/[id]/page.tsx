import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { updateJob, deleteJob } from "../actions";
import { listCustomersForOrg, listStaffForOrg } from "../_form-helpers";
import { Field, TextareaField, SelectField } from "../../_components/field";
import { PhotoGallery } from "./_photo-gallery";
import {
  computeJobProfitability,
  marginPillClass,
} from "@/lib/profitability/compute";

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

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
        id, status, scheduled_date, notes, customer_id, assigned_to, recurring,
        customer:customers ( id, name )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (!job) notFound();

  const [customers, staff, invoicesForJob, financesForJob] = await Promise.all([
    listCustomersForOrg(),
    listStaffForOrg(),
    // Cast: job_id is in the 20260520150000 migration but not yet in
    // the generated Supabase types. Force the column-typed eq().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("invoices")
      .select("id, number, status, amount, vat_total, total, job_id")
      .eq("job_id", job.id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("finances")
      .select("id, amount, vat_total, category, created_at, job_id")
      .eq("job_id", job.id),
  ]);

  // Cast: job_id is in the 20260520150000 migration but not yet in
  // the generated Supabase types.
  type InvRow = { job_id: string | null; amount: number | string | null };
  type FinRow = {
    job_id: string | null;
    amount: number | string | null;
    category: string | null;
  };
  const profit = computeJobProfitability(
    job.id,
    (invoicesForJob.data ?? []) as unknown as InvRow[],
    (financesForJob.data ?? []) as unknown as FinRow[],
  );

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

        {(() => {
          const recurring =
            (job.recurring as { pattern?: string; end_date?: string } | null) ??
            null;
          return (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField
                name="recurring_pattern"
                label="Recurring"
                defaultValue={recurring?.pattern ?? ""}
                options={[
                  { value: "", label: "One-off" },
                  { value: "weekly", label: "Weekly" },
                  { value: "biweekly", label: "Every 2 weeks" },
                  { value: "monthly", label: "Monthly" },
                  { value: "quarterly", label: "Quarterly" },
                ]}
                help="Shows extra occurrences on the calendar from the scheduled date."
              />
              <Field
                name="recurring_end_date"
                label="Repeat until"
                type="date"
                optional
                defaultValue={recurring?.end_date ?? ""}
              />
            </div>
          );
        })()}

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

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">Profitability</h2>
          {profit ? (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${marginPillClass(profit.band)}`}
            >
              {profit.margin_pct === null ? "no revenue yet" : `${profit.margin_pct}% margin`}
            </span>
          ) : null}
        </div>
        {!profit ? (
          <p className="mt-3 text-sm text-slate-500">
            No invoices or finance entries linked to this job yet. Open an
            invoice and pick this job under <em>Link to job</em>, and log
            finances against this job, to see profitability.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Revenue</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {GBP.format(profit.revenue)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Costs</div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  {GBP.format(profit.costs_total)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Gross profit</div>
                <div
                  className={`mt-1 text-lg font-semibold ${profit.gross_profit < 0 ? "text-red-700" : "text-slate-900"}`}
                >
                  {GBP.format(profit.gross_profit)}
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Costs by category
              </div>
              <ul className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Labour</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.labour)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Materials</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.materials)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Subcontractors</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.subcontractors)}
                  </div>
                </li>
                <li className="rounded border border-slate-200 p-2">
                  <div className="text-[11px] text-slate-500">Misc</div>
                  <div className="font-medium text-slate-900">
                    {GBP.format(profit.costs_by_bucket.misc)}
                  </div>
                </li>
              </ul>
            </div>
            <p className="text-[11px] text-slate-500">
              Revenue and costs are net of VAT. Margin bands: green &gt; 30%,
              amber 15–30%, red &lt; 15%.
            </p>
          </div>
        )}
      </section>

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

import Link from "next/link";
import { createJob } from "../actions";
import { listCustomersForOrg, listStaffForOrg } from "../_form-helpers";
import { JobForm } from "../_form";

/**
 * Create-job page.
 *
 * Both dropdown sources are fetched under user JWT; RLS filters to the
 * caller's org. If there are no customers yet, the form helper text
 * links out to /customers/new. Form-level + per-field errors render
 * inline via useActionState.
 */
export default async function NewJobPage() {
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

      <JobForm
        action={createJob}
        submitLabel="Create job"
        cancelHref="/jobs"
        customers={customers}
        staff={staff}
      />
    </div>
  );
}

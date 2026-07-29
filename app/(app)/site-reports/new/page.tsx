import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createSiteReport } from "../actions";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't create the report. Try again.",
  bad_job: "Pick a valid job.",
  validation: "Please check the form and try again.",
};

type JobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

type SP = Promise<{ error?: string; job?: string }>;

export default async function NewSiteReportPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: jobsRaw } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    // ACTIVE-org pin — the job picker must not offer the other org's jobs.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(200);
  const jobs = (jobsRaw ?? []) as unknown as JobOption[];

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;

  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/site-reports" className="hover:text-slate-900">
          Site reports
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-slate-900">New site report</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a job and a reporting period. CrewFlow gathers that period&rsquo;s
          diary entries, snags and toolbox talks into a draft you can review and
          edit before issuing.
        </p>
      </div>

      {errorMessage ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createSiteReport}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-slate-800">
            Report title<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            autoFocus
            placeholder="Weekly progress report — week 12"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>

        <div>
          <label htmlFor="job_id" className="block text-sm font-medium text-slate-800">
            Job / site<span className="ml-0.5 text-red-500">*</span>
          </label>
          <select
            id="job_id"
            name="job_id"
            required
            defaultValue={sp.job ?? ""}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="" disabled>
              Choose a job…
            </option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {(j.customer?.name ?? "Job") +
                  (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
                  (j.status ? ` · ${j.status}` : "")}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="period_start" className="block text-sm font-medium text-slate-800">
              Period start<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="period_start"
              name="period_start"
              type="date"
              required
              defaultValue={start}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label htmlFor="period_end" className="block text-sm font-medium text-slate-800">
              Period end<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="period_end"
              name="period_end"
              type="date"
              required
              defaultValue={end}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Gather &amp; create draft
          </button>
          <Link
            href="/site-reports"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

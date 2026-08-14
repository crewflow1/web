import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createSiteReport } from "../actions";
import { SiteReportForm } from "../_form";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

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
  const { ctx, user } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  // PAGED (F-1 picker-completion class). This feeds the site report's REQUIRED
  // job <select> and is deep-linked with `?job=<id>`. The old 200-row cap
  // silently dropped every job older than the 200 newest, so a deep-linked job
  // past the cap had no matching <option> and the required select fell to the
  // first enabled option — a DIFFERENT job — mis-attributing the report. Page
  // the complete set on a stable, unique order (created_at desc + id desc).
  const { data: jobsRaw, error: jobsError } = await fetchAllRows<JobOption>((from, to) =>
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      // ACTIVE-org pin — the job picker must not offer the other org's jobs.
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{ data: JobOption[] | null; error: unknown }>,
  );
  if (jobsError) throw readFailure("site reports: job picker", jobsError as SupabaseReadError);
  const jobs = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));
  // Preserve the deep-linked ?job= preset as a selectable option even if a
  // future cap/filter would drop it, and hand the form the RESOLVED id so an
  // untouched submit attributes to the CORRECT job. (A preset that isn't a real
  // job in this org is rejected LOUDLY by the action's job guard.)
  const presetJobId = sp.job ?? "";
  const jobOptions = withPreservedOption(jobs, presetJobId || null, (id) => ({
    id,
    label: "Selected job",
  }));

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

      {/* CREATE is offline-writable (lib/offline/registry.ts — site_report.create).
          The identity handed to the form is the one the SERVER just resolved for
          this request — newly authored work is never attributed from a client-side
          marker on a shared tablet (#456). */}
      <SiteReportForm
        action={createSiteReport}
        jobs={jobOptions}
        presetJob={presetJobId}
        defaultPeriodStart={start}
        defaultPeriodEnd={end}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { createSiteReport } from "../actions";
import { SiteReportForm } from "../_form";
import { readFailure } from "@/lib/supabase/read-failure";

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

  const { data: jobsRaw, error: jobsError } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    // ACTIVE-org pin — the job picker must not offer the other org's jobs.
    .eq("org_id", ctx.org.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (jobsError) throw readFailure("site reports: job picker", jobsError);
  const jobs = ((jobsRaw ?? []) as unknown as JobOption[]).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
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
        jobs={jobs}
        presetJob={sp.job ?? ""}
        defaultPeriodStart={start}
        defaultPeriodEnd={end}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}

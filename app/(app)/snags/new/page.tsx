import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { createSnag } from "../actions";
import { SnagForm } from "../_form";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the snag. Try again.",
  validation: "Please check the form and try again.",
  job_missing:
    "That job no longer exists in this company. Pick a current job and save again.",
  assignee_missing:
    "That person is no longer a member of this company. Pick someone else and save again.",
};

type JobOption = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

type SP = Promise<{ error?: string; job?: string }>;

export default async function NewSnagPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx, user } = await requireOrgContext();
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: jobsRaw, error: jobsError }, staff] = await Promise.all([
    // PAGED (F-1 picker-completion class). This feeds the snag's OPTIONAL job
    // <select>, which is deep-linked with `?job=<id>` from every job detail page
    // (jobs/[id]/_job-snags.tsx → /snags/new?job=<id>). The old 200-row cap
    // silently dropped every job older than the 200 newest, so a deep-linked job
    // past the cap had no matching <option>; the browser fell back to the leading
    // "No job (general)" empty option and `optionalUuid` coerced "" → NULL — the
    // snag was filed against NO job, silently. Unlike the required delay/report
    // pickers, this one can't lean on `required` (a snag need not have a job), so
    // the complete set is paged on a stable, unique order (created_at desc + id
    // desc) and the form preserve-injects the preset (withPreservedOption).
    // ACTIVE-org pin — the job picker must not offer the other org's jobs.
    fetchAllRows<JobOption>((from, to) =>
      supabase
        .from("jobs")
        .select("id, status, scheduled_date, customer:customers ( name )")
        .eq("org_id", ctx.org.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to) as unknown as PromiseLike<{
        data: JobOption[] | null;
        error: unknown;
      }>,
    ),
    listStaffForOrg(ctx.org.id),
  ]);
  if (jobsError) throw readFailure("snags: job picker", jobsError as SupabaseReadError);
  const jobs = (jobsRaw ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;
  // Deep-linking a job is LIVE: every job detail page renders a "Log a snag"
  // button (jobs/[id]/_job-snags.tsx → /snags/new?job=<id>). The form
  // preserve-injects this preset so an out-of-list id is always a selectable
  // option and an untouched submit round-trips it, never silently "No job".
  const presetJob = sp.job ?? "";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/snags" className="hover:text-slate-900">
          Snagging
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Log a snag</h1>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {/* CREATE is offline-writable (lib/offline/registry.ts — snag.create).
          The identity handed to the form is the one the SERVER just resolved
          for this request — newly authored work is never attributed from a
          client-side marker on a shared tablet. */}
      <SnagForm
        action={createSnag}
        jobs={jobs}
        staff={staff.map((s) => ({ id: s.id, label: s.full_name || s.email || "—" }))}
        presetJob={presetJob}
        offline={{ userId: user.id, orgId: ctx.org.id }}
      />
    </div>
  );
}

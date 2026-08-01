import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { createSnag } from "../actions";
import { SnagForm } from "../_form";
import { readFailure } from "@/lib/supabase/read-failure";

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
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      // ACTIVE-org pin — the staff picker beside it was pinned in #456; the
      // job picker was left on RLS alone.
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .limit(200),
    listStaffForOrg(ctx.org.id),
  ]);
  if (jobsError) throw readFailure("snags: job picker", jobsError);
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
  // Allow deep-linking a job in (e.g. from a future "log snag" button on a job).
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

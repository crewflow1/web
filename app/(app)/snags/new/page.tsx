import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listStaffForOrg } from "../../jobs/_form-helpers";
import { SNAG_PRIORITIES, SNAG_PRIORITY_LABELS } from "@/lib/snags/schema";
import { createSnag } from "../actions";
import { readFailure } from "@/lib/supabase/read-failure";

const ERROR_MAP: Record<string, string> = {
  record_failed: "Couldn't save the snag. Try again.",
  validation: "Please check the form and try again.",
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
  const { ctx } = await requireOrgContext();
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
  const jobs = (jobsRaw ?? []) as unknown as JobOption[];

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

      <form
        action={createSnag}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-slate-800">
            What&rsquo;s the defect?<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            autoFocus
            placeholder="Cracked tile in the ensuite"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="priority" className="block text-sm font-medium text-slate-800">
              Priority
            </label>
            <select
              id="priority"
              name="priority"
              defaultValue="medium"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              {SNAG_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {SNAG_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="due_date" className="block text-sm font-medium text-slate-800">
              Target fix date
            </label>
            <input
              id="due_date"
              name="due_date"
              type="date"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="job_id" className="block text-sm font-medium text-slate-800">
              Job / site
            </label>
            <select
              id="job_id"
              name="job_id"
              defaultValue={presetJob}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="">No job (general)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {(j.customer?.name ?? "Job") +
                    (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
                    (j.status ? ` · ${j.status}` : "")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="assigned_to" className="block text-sm font-medium text-slate-800">
              Assign to
            </label>
            <select
              id="assigned_to"
              name="assigned_to"
              defaultValue=""
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="">Unassigned</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name || s.email}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="location" className="block text-sm font-medium text-slate-800">
              Location on site
            </label>
            <input
              id="location"
              name="location"
              type="text"
              placeholder="Kitchen, north wall"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
          <div>
            <label htmlFor="trade" className="block text-sm font-medium text-slate-800">
              Trade responsible
            </label>
            <input
              id="trade"
              name="trade"
              type="text"
              placeholder="Plumbing"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-slate-800">
            Details
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            placeholder="Anything the trade needs to know to put it right."
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            You can add photos once the snag is saved.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Log snag
          </button>
          <Link
            href="/snags"
            className="text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

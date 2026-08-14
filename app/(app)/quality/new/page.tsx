import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions, listMembers } from "../_data";
import { createInspectionPlan } from "../actions";
import { withPreservedOption } from "@/lib/quotes/preserve-option";

/**
 * /quality/new — draft a new inspection & test plan header.
 *
 * The job is REQUIRED here, not optional: an ITP governs the works on a specific
 * job, and the DB issue gate refuses a plan that doesn't name one. Asking for it
 * up front is kinder than refusing it at issue.
 *
 * Posts to createInspectionPlan, which redirects to the new draft's detail page
 * where the ordered checks are added and the plan is later issued.
 */

const ERROR_MAP: Record<string, string> = {
  validation: "Please check the form and try again.",
};

type SP = Promise<{ error?: string; jobId?: string }>;

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";
const hintClass = "mt-1 text-xs text-slate-500";

export default async function NewInspectionPlanPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const [jobs, members] = await Promise.all([
    listJobOptions(ctx.org.id),
    listMembers(ctx.org.id),
  ]);

  // PICKER-COMPLETION (F-1). The reader is paged so a ?jobId= preset is present,
  // and this preserves that preset as a selectable <option> even if a future
  // cap/filter would drop it — belt-and-braces, so the REQUIRED select never
  // silently discards the preset and falls to a different job on an untouched
  // submit. (A preset that isn't a real job in this org is rejected LOUDLY by
  // the action's job guard, not silently mis-attributed.)
  const jobOptions = withPreservedOption(jobs, sp.jobId || null, (id) => ({
    id,
    label: "Selected job",
  }));

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900">New inspection &amp; test plan</h1>

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-medium">There are no jobs to plan against yet.</p>
          <p className="mt-1 text-xs">
            An inspection plan governs the works on a specific job.{" "}
            <Link href="/jobs" className="font-medium underline">
              Create a job
            </Link>{" "}
            first.
          </p>
        </div>
      ) : (
        <form
          action={createInspectionPlan}
          className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div>
            <label htmlFor="jobId" className={labelClass}>
              Job<span className="ml-0.5 text-red-500">*</span>
            </label>
            <select
              id="jobId"
              name="jobId"
              required
              defaultValue={sp.jobId ?? ""}
              className={inputClass}
            >
              <option value="">Select a job…</option>
              {jobOptions.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
            <p className={hintClass}>The job whose works this plan governs.</p>
          </div>

          <div>
            <label htmlFor="workPackage" className={labelClass}>
              Work package<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="workPackage"
              name="workPackage"
              type="text"
              required
              autoFocus
              maxLength={200}
              placeholder="Below-ground drainage, Plots 1–4"
              className={inputClass}
            />
            <p className={hintClass}>
              The scope this plan covers. One current plan per work package per job.
            </p>
          </div>

          <div>
            <label htmlFor="title" className={labelClass}>
              Title<span className="ml-0.5 text-red-500">*</span>
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              maxLength={200}
              placeholder="ITP — foul and surface water drainage"
              className={inputClass}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="specificationRef" className={labelClass}>
                Specification / drawing reference
              </label>
              <input
                id="specificationRef"
                name="specificationRef"
                type="text"
                maxLength={200}
                placeholder="D-101 rev C · NBS R12"
                className={inputClass}
              />
              <p className={hintClass}>What &ldquo;acceptable&rdquo; is measured against.</p>
            </div>
            <div>
              <label htmlFor="location" className={labelClass}>
                Location
              </label>
              <input
                id="location"
                name="location"
                type="text"
                maxLength={200}
                placeholder="Plots 1–4, rear gardens"
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="preparedBy" className={labelClass}>
                Prepared by
              </label>
              <select id="preparedBy" name="preparedBy" defaultValue="" className={inputClass}>
                <option value="">Not set</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="planDate" className={labelClass}>
                Plan date
              </label>
              <input id="planDate" name="planDate" type="date" className={inputClass} />
            </div>
          </div>

          <div>
            <label htmlFor="notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={4}
              maxLength={20000}
              placeholder="Anything the site team needs to know about how these checks are run."
              className={inputClass}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
            >
              Create draft
            </button>
            <Link
              href="/quality"
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

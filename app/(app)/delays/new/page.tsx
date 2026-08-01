import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import {
  listDiaryOptionsForJob,
  listJobOptions,
  listVariationOptionsForJob,
} from "../_data";
import { createDelayEvent } from "../actions";
import { DelayEventFields, hintClass, inputClass, labelClass } from "../_form-fields";

/**
 * /delays/new — draft a delay event.
 *
 * The job is REQUIRED: a delay with no job it delayed is meaningless (the
 * schema makes it NOT NULL), so it is asked for up front. Evidence pickers
 * (diary entry / variation) are job-scoped — the DB guard refuses a link to
 * another job's records — so they render only once a job is known
 * (?jobId=…, e.g. arriving from the job page). Creating first and linking
 * while editing the draft is equally supported.
 */

type SP = Promise<{ error?: string; jobId?: string }>;

export default async function NewDelayEventPage({ searchParams }: { searchParams: SP }) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;
  const jobs = await listJobOptions(ctx.org.id);
  const preselectedJob = jobs.find((j) => j.id === sp.jobId) ?? null;

  const [diaryOptions, variationOptions] = preselectedJob
    ? await Promise.all([
        listDiaryOptionsForJob(ctx.org.id, preselectedJob.id),
        listVariationOptionsForJob(ctx.org.id, preselectedJob.id),
      ])
    : [null, null];

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/delays" className="hover:text-slate-900">
          Delays &amp; EOT
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900">Log a delay</h1>
      <p className="text-sm text-slate-600">
        This drafts the record — nothing is claimed or sent anywhere. Record it once
        it is right, and it becomes frozen evidence for any future extension of time.
      </p>

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
          <p className="font-medium">There are no jobs to log a delay against yet.</p>
          <p className="mt-1 text-xs">
            A delay event records what stopped a specific job.{" "}
            <Link href="/jobs" className="font-medium underline">
              Create a job
            </Link>{" "}
            first.
          </p>
        </div>
      ) : (
        <form
          action={createDelayEvent}
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
              defaultValue={preselectedJob?.id ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                Choose a job…
              </option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
            {!preselectedJob ? (
              <p className={hintClass}>
                Diary and variation links are job-specific — you can add them while
                editing the draft after saving.
              </p>
            ) : null}
          </div>

          <DelayEventFields diaryOptions={diaryOptions} variationOptions={variationOptions} />

          <div className="flex items-center justify-end gap-3 pt-2">
            <Link href="/delays" className="text-sm text-slate-600 hover:text-slate-900">
              Cancel
            </Link>
            <button
              type="submit"
              className="inline-flex min-h-[44px] items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Save draft
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

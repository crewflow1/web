import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { listAssessors } from "../_data";
import { createRiskAssessment } from "../actions";

/**
 * /health-safety/new — draft a new RAMS header.
 *
 * Posts to createRiskAssessment, which redirects to the new draft's detail
 * page (where hazards are added and the document is later issued). PPE is a
 * set of repeatable text inputs all named `ppe`; the action reads every
 * non-empty one via formData.getAll("ppe").
 */

const ERROR_MAP: Record<string, string> = {
  validation: "Please check the form and try again.",
};

/** Blank PPE rows on the create form — the action drops the empty ones. */
const PPE_SLOTS = 6;

type SP = Promise<{ error?: string }>;

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

export default async function NewRiskAssessmentPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireOrgContext();
  const sp = await searchParams;
  const assessors = await listAssessors();

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/health-safety" className="hover:text-slate-900">
          Health &amp; safety
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">New</span>
      </nav>

      <h1 className="text-2xl font-bold text-slate-900">New risk assessment</h1>

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      <form
        action={createRiskAssessment}
        className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <label htmlFor="title" className={labelClass}>
            Title<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            autoFocus
            maxLength={200}
            placeholder="Working at height — scaffold erection"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="activity" className={labelClass}>
            Activity / task being assessed<span className="ml-0.5 text-red-500">*</span>
          </label>
          <textarea
            id="activity"
            name="activity"
            rows={2}
            required
            maxLength={500}
            placeholder="What work does this RAMS cover?"
            className={inputClass}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="location" className={labelClass}>
              Location on site
            </label>
            <input
              id="location"
              name="location"
              type="text"
              maxLength={200}
              placeholder="Plot 4, rear elevation"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="assessorId" className={labelClass}>
              Assessor
            </label>
            <select id="assessorId" name="assessorId" defaultValue="" className={inputClass}>
              <option value="">Not yet assigned</option>
              {assessors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              An assessor must be named before the RAMS can be issued.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="assessmentDate" className={labelClass}>
              Assessment date
            </label>
            <input
              id="assessmentDate"
              name="assessmentDate"
              type="date"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="reviewDate" className={labelClass}>
              Review date
            </label>
            <input
              id="reviewDate"
              name="reviewDate"
              type="date"
              className={inputClass}
            />
          </div>
        </div>

        <fieldset>
          <legend className={labelClass}>PPE required</legend>
          <p className="mt-1 text-xs text-slate-500">
            One item per box — e.g. hard hat, hi-vis, gloves. Leave the rest blank.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {Array.from({ length: PPE_SLOTS }).map((_, i) => (
              <input
                key={i}
                name="ppe"
                type="text"
                maxLength={60}
                aria-label={`PPE item ${i + 1}`}
                placeholder={i === 0 ? "Hard hat" : i === 1 ? "Hi-vis vest" : "Add PPE…"}
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="methodStatement" className={labelClass}>
            Method statement
          </label>
          <textarea
            id="methodStatement"
            name="methodStatement"
            rows={6}
            maxLength={20000}
            placeholder="Describe, step by step, how the work will be carried out safely."
            className={inputClass}
          />
          <p className="mt-1 text-xs text-slate-500">
            You can add hazards and issue the RAMS once it&rsquo;s saved.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          >
            Save draft
          </button>
          <Link
            href="/health-safety"
            className="inline-flex min-h-[44px] items-center text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

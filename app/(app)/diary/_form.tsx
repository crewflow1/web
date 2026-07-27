import Link from "next/link";
import type { JobOption } from "./_data";

/**
 * Shared diary entry form — used by both the new and edit pages so the field
 * set can never drift between them. Server component: posts straight to a
 * server action, no client state.
 */

export type DiaryDefaults = {
  entry_date?: string;
  job_id?: string | null;
  weather?: string | null;
  labour_count?: number | null;
  work_summary?: string | null;
  delays?: string | null;
  notes?: string | null;
};

export function DiaryForm({
  action,
  jobs,
  defaults,
  submitLabel,
  cancelHref,
  hiddenId,
}: {
  action: (formData: FormData) => void | Promise<void>;
  jobs: JobOption[];
  defaults?: DiaryDefaults;
  submitLabel: string;
  cancelHref: string;
  hiddenId?: string;
}) {
  const d = defaults ?? {};
  return (
    <form
      action={action}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      {hiddenId ? <input type="hidden" name="id" value={hiddenId} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="entry_date" className="block text-sm font-medium text-slate-800">
            Date<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="entry_date"
            name="entry_date"
            type="date"
            required
            defaultValue={d.entry_date ?? ""}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div>
          <label htmlFor="job_id" className="block text-sm font-medium text-slate-800">
            Job / site
          </label>
          <select
            id="job_id"
            name="job_id"
            defaultValue={d.job_id ?? ""}
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">No job (general)</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="weather" className="block text-sm font-medium text-slate-800">
            Weather
          </label>
          <input
            id="weather"
            name="weather"
            type="text"
            defaultValue={d.weather ?? ""}
            placeholder="Dry am, heavy rain pm"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div>
          <label htmlFor="labour_count" className="block text-sm font-medium text-slate-800">
            People on site
          </label>
          <input
            id="labour_count"
            name="labour_count"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={d.labour_count ?? ""}
            placeholder="4"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
      </div>

      <div>
        <label htmlFor="work_summary" className="block text-sm font-medium text-slate-800">
          Work done today
        </label>
        <textarea
          id="work_summary"
          name="work_summary"
          rows={4}
          defaultValue={d.work_summary ?? ""}
          placeholder="First fix plumbing complete on plots 3-5; kitchen units delivered."
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label htmlFor="delays" className="block text-sm font-medium text-slate-800">
          Delays / issues
        </label>
        <textarea
          id="delays"
          name="delays"
          rows={2}
          defaultValue={d.delays ?? ""}
          placeholder="Concrete pour delayed by rain — rescheduled to Thursday."
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          defaultValue={d.notes ?? ""}
          placeholder="Deliveries, visitors, inspections booked…"
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          You can add site photos once the entry is saved.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          {submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

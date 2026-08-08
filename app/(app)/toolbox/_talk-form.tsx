import Link from "next/link";
import type { ToolboxFormOptions } from "./_form-options";

/**
 * Shared draft form for creating and editing a toolbox talk (a plain server-action
 * form — no client JS). "Deliver" (issue) is a separate action on the detail page,
 * never a form field here: this screen only ever writes a draft.
 */

export type TalkFormDefaults = {
  id?: string;
  talk_date?: string | null;
  topic?: string | null;
  key_points?: string | null;
  location?: string | null;
  job_id?: string | null;
  risk_assessment_id?: string | null;
  permit_to_work_id?: string | null;
  presenter?: string | null;
  ppe?: string[] | null;
  attendees?: string | null;
  attendee_count?: number | null;
  notes?: string | null;
};

const inputClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

export function TalkForm({
  action,
  options,
  defaults,
  submitLabel,
  cancelHref,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: ToolboxFormOptions;
  defaults?: TalkFormDefaults;
  submitLabel: string;
  cancelHref: string;
}) {
  const d = defaults ?? {};
  const today = new Date().toISOString().slice(0, 10);

  // DEFENCE-IN-DEPTH against the picker-class silent-null (F-1). The option
  // lists are bounded/filtered: jobs is a recent-200 sample, and RAMS/permits
  // are deliberately restricted to CURRENT controls (issued RAMS, issued/active
  // permits). So when EDITING a talk, a saved link can be absent from its list —
  // an old job, or a RAMS/permit that has since been superseded. Without a
  // matching <option> the <select> falls back to value="" and updateToolboxTalk
  // then writes the id as null on ANY save. Pre-inject the saved id as a
  // preserved option so an edit can never silently drop the reference.
  const jobOptions =
    d.job_id && !options.jobs.some((j) => j.id === d.job_id)
      ? [
          { id: d.job_id, status: null, scheduled_date: null, customer: { name: "Current job" } },
          ...options.jobs,
        ]
      : options.jobs;
  const ramsOptions =
    d.risk_assessment_id && !options.rams.some((r) => r.id === d.risk_assessment_id)
      ? [{ id: d.risk_assessment_id, reference: null, title: "Current RAMS" }, ...options.rams]
      : options.rams;
  const permitOptions =
    d.permit_to_work_id && !options.permits.some((p) => p.id === d.permit_to_work_id)
      ? [
          { id: d.permit_to_work_id, reference: null, title: "Current permit", status: "linked" },
          ...options.permits,
        ]
      : options.permits;

  return (
    <form action={action} className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      {d.id ? <input type="hidden" name="id" value={d.id} /> : null}

      <div>
        <label htmlFor="topic" className={labelClass}>
          Topic<span className="ml-0.5 text-red-500">*</span>
        </label>
        <input
          id="topic"
          name="topic"
          type="text"
          required
          autoFocus
          defaultValue={d.topic ?? ""}
          placeholder="Working at height"
          className={inputClass}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="talk_date" className={labelClass}>
            Date<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input id="talk_date" name="talk_date" type="date" required defaultValue={d.talk_date ?? today} className={inputClass} />
        </div>
        <div>
          <label htmlFor="location" className={labelClass}>
            Location / area
          </label>
          <input id="location" name="location" type="text" defaultValue={d.location ?? ""} placeholder="Plot 4, mansard roof" className={inputClass} />
        </div>
      </div>

      <div>
        <label htmlFor="key_points" className={labelClass}>
          Key points briefed
        </label>
        <textarea
          id="key_points"
          name="key_points"
          rows={4}
          defaultValue={d.key_points ?? ""}
          placeholder="The safety points you actually covered — edge protection checked, harness clipped on above 2m, exclusion zone below…"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-500">This is what an inspector reads. Required before you can deliver the talk.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="job_id" className={labelClass}>
            Job / site
          </label>
          <select id="job_id" name="job_id" defaultValue={d.job_id ?? ""} className={inputClass}>
            <option value="">No job (general)</option>
            {jobOptions.map((j) => (
              <option key={j.id} value={j.id}>
                {(j.customer?.name ?? "Job") + (j.scheduled_date ? ` · ${j.scheduled_date}` : "") + (j.status ? ` · ${j.status}` : "")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="presenter" className={labelClass}>
            Delivered by
          </label>
          <input id="presenter" name="presenter" type="text" defaultValue={d.presenter ?? ""} placeholder="Site supervisor's name" className={inputClass} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="risk_assessment_id" className={labelClass}>
            Linked RAMS
          </label>
          <select id="risk_assessment_id" name="risk_assessment_id" defaultValue={d.risk_assessment_id ?? ""} className={inputClass}>
            <option value="">None</option>
            {ramsOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.reference ? `${r.reference} · ` : "") + r.title}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">Only issued risk assessments are listed.</p>
        </div>
        <div>
          <label htmlFor="permit_to_work_id" className={labelClass}>
            Linked permit
          </label>
          <select id="permit_to_work_id" name="permit_to_work_id" defaultValue={d.permit_to_work_id ?? ""} className={inputClass}>
            <option value="">None</option>
            {permitOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {(p.reference ? `${p.reference} · ` : "") + p.title + ` · ${p.status}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="ppe" className={labelClass}>
            PPE required
          </label>
          <input id="ppe" name="ppe" type="text" defaultValue={(d.ppe ?? []).join(", ")} placeholder="Hard hat, Harness, Hi-vis" className={inputClass} />
          <p className="mt-1 text-xs text-slate-500">Comma-separated.</p>
        </div>
        <div>
          <label htmlFor="attendee_count" className={labelClass}>
            Number who attended
          </label>
          <input
            id="attendee_count"
            name="attendee_count"
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={d.attendee_count ?? ""}
            placeholder="6"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="attendees" className={labelClass}>
          Who attended
        </label>
        <textarea
          id="attendees"
          name="attendees"
          rows={2}
          defaultValue={d.attendees ?? ""}
          placeholder="Names or trades — J. Smith, K. Patel, the groundworks crew…"
          className={inputClass}
        />
        <p className="mt-1 text-xs text-slate-500">
          Free-text record. Operatives on the org can also sign an acknowledgement once the talk is delivered.
        </p>
      </div>

      <div>
        <label htmlFor="notes" className={labelClass}>
          Notes
        </label>
        <textarea id="notes" name="notes" rows={2} defaultValue={d.notes ?? ""} placeholder="Any actions raised, follow-ups…" className={inputClass} />
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
          {submitLabel}
        </button>
        <Link href={cancelHref} className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}

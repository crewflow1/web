import {
  PERMIT_TYPES,
  PERMIT_TYPE_LABELS,
} from "@/lib/health-safety/permits";
import { PermitDateTimeField } from "./_datetime-field";
import { inputClass, labelClass } from "./_meta";

/**
 * The shared permit field set, rendered inside both the create form
 * (→ createPermit) and the draft edit form (→ updatePermit). Keeping it in one
 * place guarantees the two forms post an identical set of field NAMES, which is
 * exactly what the actions' permitFields() reads:
 *   permitType, title, scope, location, jobId, riskAssessmentId,
 *   responsiblePerson, isolationDetails, emergencyArrangements,
 *   validFrom, validUntil
 * The parent owns the <form> (and its action + submit + any hidden id).
 */

export type PermitDefaults = {
  permitType?: string | null;
  title?: string | null;
  scope?: string | null;
  location?: string | null;
  jobId?: string | null;
  riskAssessmentId?: string | null;
  responsiblePerson?: string | null;
  isolationDetails?: string | null;
  emergencyArrangements?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
};

const Req = () => <span className="ml-0.5 text-red-500">*</span>;

export function PermitFormFields({
  defaults = {},
  jobs,
  ramsOptions,
  autoFocusTitle = false,
}: {
  defaults?: PermitDefaults;
  jobs: { id: string; label: string }[];
  ramsOptions: { id: string; label: string; job_id: string | null }[];
  autoFocusTitle?: boolean;
}) {
  // Preserve links to records outside the fetched option lists (a superseded
  // RAMS, or a job beyond the fetch window) so editing + re-saving a draft never
  // silently drops an existing link.
  const rams = [...ramsOptions];
  if (
    defaults.riskAssessmentId &&
    !rams.some((r) => r.id === defaults.riskAssessmentId)
  ) {
    rams.unshift({
      id: defaults.riskAssessmentId,
      label: "Currently linked risk assessment",
      job_id: null,
    });
  }
  const jobList = [...jobs];
  if (defaults.jobId && !jobList.some((j) => j.id === defaults.jobId)) {
    jobList.unshift({ id: defaults.jobId, label: "Currently linked job" });
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="permitType" className={labelClass}>
            Permit type
            <Req />
          </label>
          <select
            id="permitType"
            name="permitType"
            required
            defaultValue={defaults.permitType ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              Select a permit type…
            </option>
            {PERMIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {PERMIT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="location" className={labelClass}>
            Location on site
          </label>
          <input
            id="location"
            name="location"
            type="text"
            maxLength={200}
            defaultValue={defaults.location ?? ""}
            placeholder="Plot 4, Level 3 plant room"
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="title" className={labelClass}>
          Title
          <Req />
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          autoFocus={autoFocusTitle}
          maxLength={200}
          defaultValue={defaults.title ?? ""}
          placeholder="Hot works — welding to steel frame, Level 3"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="scope" className={labelClass}>
          Scope of work
          <Req />
        </label>
        <textarea
          id="scope"
          name="scope"
          rows={3}
          required
          maxLength={4000}
          defaultValue={defaults.scope ?? ""}
          placeholder="Exactly what work this permit authorises — and where it stops."
          className={inputClass}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <PermitDateTimeField
          id="validFrom"
          name="validFrom"
          label="Valid from"
          defaultValue={defaults.validFrom ?? ""}
          hint="When the permit becomes valid."
        />
        <PermitDateTimeField
          id="validUntil"
          name="validUntil"
          label="Valid until"
          defaultValue={defaults.validUntil ?? ""}
          hint="When it expires — must be after ‘valid from’."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="jobId" className={labelClass}>
            Job / site
          </label>
          <select
            id="jobId"
            name="jobId"
            defaultValue={defaults.jobId ?? ""}
            className={inputClass}
          >
            <option value="">Not linked to a job</option>
            {jobList.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="riskAssessmentId" className={labelClass}>
            Risk assessment (RAMS)
          </label>
          <select
            id="riskAssessmentId"
            name="riskAssessmentId"
            defaultValue={defaults.riskAssessmentId ?? ""}
            className={inputClass}
          >
            <option value="">Not linked to a RAMS</option>
            {rams.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="responsiblePerson" className={labelClass}>
          Responsible person
        </label>
        <input
          id="responsiblePerson"
          name="responsiblePerson"
          type="text"
          maxLength={200}
          defaultValue={defaults.responsiblePerson ?? ""}
          placeholder="Who supervises the work and holds this permit"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="isolationDetails" className={labelClass}>
          Isolation details
        </label>
        <textarea
          id="isolationDetails"
          name="isolationDetails"
          rows={3}
          maxLength={4000}
          defaultValue={defaults.isolationDetails ?? ""}
          placeholder="Energy sources isolated, lock-off references, who holds the keys."
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="emergencyArrangements" className={labelClass}>
          Emergency arrangements
        </label>
        <textarea
          id="emergencyArrangements"
          name="emergencyArrangements"
          rows={3}
          maxLength={4000}
          defaultValue={defaults.emergencyArrangements ?? ""}
          placeholder="Rescue plan, first aid, raising the alarm, muster point."
          className={inputClass}
        />
      </div>
    </>
  );
}

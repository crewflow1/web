import { StateForm } from "@/components/forms/StateForm";
import {
  CALIBRATION_RESULTS,
  CALIBRATION_RESULT_LABELS,
  CALIBRATION_EXPIRY_LABELS,
  classifyCalibrationExpiry,
  currentCalibrationStatus,
  type CalibrationResult,
  type CalibrationExpiryState,
} from "@/lib/assets/calibration";
import { recordCalibrationCertificate, deleteCalibrationCertificate } from "../calibration-actions";

export type CalibrationCertRow = {
  id: string;
  schedule_id: string | null;
  certificate_number: string;
  calibrated_by: string;
  calibration_date: string;
  next_due_date: string | null;
  result: CalibrationResult;
  standard: string | null;
  notes: string | null;
};

/** Calibration schedules on this asset the cert can be linked to (re-arm nudge). */
export type CalibrationScheduleOption = { id: string; title: string | null; next_due: string };

const EXPIRY_STYLES: Record<CalibrationExpiryState, string> = {
  no_expiry: "bg-slate-100 text-slate-600",
  valid: "bg-emerald-100 text-emerald-800",
  due_soon: "bg-amber-100 text-amber-800",
  expired: "bg-red-100 text-red-800",
};

const RESULT_STYLES: Record<CalibrationResult, string> = {
  pass: "bg-emerald-100 text-emerald-800",
  pass_with_adjustment: "bg-emerald-100 text-emerald-800",
  fail: "bg-red-100 text-red-800",
  limited: "bg-amber-100 text-amber-800",
  indicative: "bg-slate-100 text-slate-600",
};

/**
 * Calibration certificate register (P3W2). RECORDS certificates issued by an
 * external lab — CrewFlow never issues one. When a certificate has a next-due
 * and is linked to a calibration schedule, the DB re-arms that schedule so the
 * expiry surfaces through the existing maintenance-due nudges.
 */
export function CalibrationSection({
  assetId,
  certs,
  schedules,
  isAdmin,
  today,
}: {
  assetId: string;
  certs: CalibrationCertRow[];
  schedules: CalibrationScheduleOption[];
  isAdmin: boolean;
  today: string;
}) {
  const status = currentCalibrationStatus(certs, today);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Calibration certificates</h2>
        {certs.length > 0 ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${EXPIRY_STYLES[status.state]}`}>
            {status.latestFailed ? "Last result: not fit" : CALIBRATION_EXPIRY_LABELS[status.state]}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        A record of calibration certificates issued by an external lab. CrewFlow never issues a certificate — attach the
        lab&rsquo;s PDF below. A next-due date re-arms the linked calibration schedule so its expiry appears in your alerts.
      </p>

      {certs.length > 0 ? (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {certs.map((c) => {
            const expiry = classifyCalibrationExpiry(c.next_due_date, today);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="font-medium text-slate-900">{c.certificate_number}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RESULT_STYLES[c.result]}`}>
                  {CALIBRATION_RESULT_LABELS[c.result]}
                </span>
                <span className="text-xs text-slate-500">by {c.calibrated_by}</span>
                <span className="text-xs text-slate-500">cal {c.calibration_date}</span>
                {c.next_due_date ? (
                  <span
                    className={`text-xs ${
                      expiry.state === "expired"
                        ? "font-semibold text-red-700"
                        : expiry.state === "due_soon"
                          ? "font-semibold text-amber-700"
                          : "text-slate-500"
                    }`}
                  >
                    next due {c.next_due_date}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">no next-due</span>
                )}
                {c.standard ? <span className="text-xs text-slate-400">{c.standard}</span> : null}
                {isAdmin ? (
                  <span className="ml-auto">
                    <StateForm action={deleteCalibrationCertificate}>
                      <input type="hidden" name="asset_id" value={assetId} />
                      <input type="hidden" name="cert_id" value={c.id} />
                      <button type="submit" className="rounded-md border border-red-300 px-2 py-1 text-[11px] text-red-700 hover:bg-red-50">
                        Delete
                      </button>
                    </StateForm>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No calibration certificates recorded yet.</p>
      )}

      <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-700">+ Record a certificate</summary>
        <StateForm action={recordCalibrationCertificate} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="asset_id" value={assetId} />
          <label className="text-xs font-medium text-slate-600">
            Certificate number
            <input name="certificate_number" required maxLength={120} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Calibrated by (external lab)
            <input name="calibrated_by" required maxLength={200} placeholder="e.g. Acme Metrology Ltd" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Calibration date
            <input name="calibration_date" type="date" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Next due (optional)
            <input name="next_due_date" type="date" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Result
            <select name="result" defaultValue="pass" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
              {CALIBRATION_RESULTS.map((r) => (
                <option key={r} value={r}>
                  {CALIBRATION_RESULT_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Standard / accreditation (optional)
            <input name="standard" maxLength={200} placeholder="e.g. UKAS 0123, ISO 6789" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          {schedules.length > 0 ? (
            <label className="text-xs font-medium text-slate-600 sm:col-span-2">
              Link to a calibration schedule (re-arms its next-due nudge)
              <select name="schedule_id" defaultValue="" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
                <option value="">— None —</option>
                {schedules.map((s) => (
                  <option key={s.id} value={s.id}>
                    {(s.title?.trim() || "Calibration")} · due {s.next_due}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Notes (optional)
            <textarea name="notes" maxLength={4000} rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              Record certificate
            </button>
          </div>
        </StateForm>
      </details>
    </section>
  );
}

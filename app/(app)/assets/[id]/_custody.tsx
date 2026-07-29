import {
  ASSIGNMENT_TYPES,
  ASSIGNMENT_TYPE_LABELS,
  CONDITIONS,
  CONDITION_LABELS,
  isOverdue,
} from "@/lib/assets/assignment";
import { checkOutAsset, returnAsset, transferAsset } from "../assignment-actions";
import { StateForm } from "@/components/forms/StateForm";
import type { FormState } from "@/lib/forms/state";

/**
 * Custody section on the asset detail page. Shows the current open assignment
 * (who/where, since, due back, overdue) with Return + Transfer, or a Check-out
 * form when the asset is free. Server-rendered; posts to the server actions,
 * whose DB invariant is the real gate.
 */

export type CurrentAssignment = {
  id: string;
  assignment_type: string;
  job_name: string | null;
  assignee_name: string | null;
  location: string | null;
  assigned_at: string;
  expected_return_at: string | null;
  issue_condition: string | null;
};

type JobOpt = { id: string; label: string };
type StaffOpt = { id: string; name: string };

const fieldCls =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelCls = "block text-xs font-medium text-slate-600";

export function CustodySection({
  assetId,
  assetActive,
  current,
  jobs,
  staff,
  today,
}: {
  assetId: string;
  assetActive: boolean;
  current: CurrentAssignment | null;
  jobs: JobOpt[];
  staff: StaffOpt[];
  today: string;
}) {
  const overdue = current
    ? isOverdue(current.expected_return_at, "open", today)
    : false;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Custody</h2>

      {current ? (
        <>
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white">
                {ASSIGNMENT_TYPE_LABELS[
                  current.assignment_type as keyof typeof ASSIGNMENT_TYPE_LABELS
                ] ?? current.assignment_type}
              </span>
              {overdue ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                  Overdue
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-slate-900">
              {current.assignee_name ?? current.job_name ?? current.location ?? "—"}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Since {current.assigned_at.slice(0, 10)}
              {current.expected_return_at ? ` · due back ${current.expected_return_at}` : ""}
              {current.issue_condition ? ` · issued ${current.issue_condition}` : ""}
            </p>
          </div>

          <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 lg:grid-cols-2">
            <StateForm action={returnAsset} className="space-y-2">
              <input type="hidden" name="id" value={current.id} />
              <input type="hidden" name="asset_id" value={assetId} />
              <p className="text-sm font-medium text-slate-800">Return</p>
              <div className="grid grid-cols-2 gap-2">
                <select name="return_condition" defaultValue="" className={fieldCls} aria-label="Return condition">
                  <option value="">Condition…</option>
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
                  ))}
                </select>
                <input name="return_meter_reading" type="number" min={0} step="0.1" placeholder="Meter" className={fieldCls} />
              </div>
              <input name="return_notes" type="text" placeholder="Return notes" className={fieldCls} />
              <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                Return asset
              </button>
            </StateForm>

            <AssignForm
              action={transferAsset}
              assetId={assetId}
              jobs={jobs}
              staff={staff}
              title="Transfer"
              submit="Transfer"
            />
          </div>
        </>
      ) : assetActive ? (
        <div className="mt-3">
          <p className="text-sm text-slate-500">This asset is available.</p>
          <div className="mt-3">
            <AssignForm
              action={checkOutAsset}
              assetId={assetId}
              jobs={jobs}
              staff={staff}
              title="Check out"
              submit="Check out"
            />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          This asset isn&rsquo;t active, so it can&rsquo;t be assigned.
        </p>
      )}
    </section>
  );
}

function AssignForm({
  action,
  assetId,
  jobs,
  staff,
  title,
  submit,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  assetId: string;
  jobs: JobOpt[];
  staff: StaffOpt[];
  title: string;
  submit: string;
}) {
  return (
    <StateForm action={action} className="space-y-2">
      <input type="hidden" name="asset_id" value={assetId} />
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <div>
        <label className={labelCls}>Where to</label>
        <select name="assignment_type" defaultValue="allocated_to_job" className={fieldCls}>
          {ASSIGNMENT_TYPES.map((t) => (
            <option key={t} value={t}>{ASSIGNMENT_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <select name="job_id" defaultValue="" className={fieldCls} aria-label="Job">
          <option value="">Job…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.label}</option>
          ))}
        </select>
        <select name="assignee_id" defaultValue="" className={fieldCls} aria-label="Staff">
          <option value="">Staff…</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <input name="location" type="text" placeholder="Depot / yard / location" className={fieldCls} />
        <input name="expected_return_at" type="date" className={fieldCls} aria-label="Expected return" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select name="issue_condition" defaultValue="good" className={fieldCls} aria-label="Issue condition">
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
          ))}
        </select>
        <input name="issue_meter_reading" type="number" min={0} step="0.1" placeholder="Meter" className={fieldCls} />
      </div>
      <input name="issue_notes" type="text" placeholder="Handover notes" className={fieldCls} />
      <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
        {submit}
      </button>
    </StateForm>
  );
}

import type { SafetyBlock } from "@/lib/assets/inspection-override";
import { startReinspection } from "../inspection-actions";
import { reportMaintenanceCase } from "../maintenance-actions";
import { createInspectionOverride, revokeInspectionOverride } from "../override-actions";

/**
 * Safety blocks (M4d). One row per CURRENT blocking fail: what failed, the
 * honest override state ("operational override recorded", never "cleared" or
 * "certified safe"), Record re-inspection for every member, and the tightly
 * permissioned admin override / revoke forms.
 */
export function SafetyBlocksSection({
  assetId,
  blocks,
  isAdmin,
}: {
  assetId: string;
  blocks: SafetyBlock[];
  isAdmin: boolean;
}) {
  if (blocks.length === 0) return null;

  return (
    <section className="rounded-xl border border-red-300 bg-red-50 p-6 shadow-sm">
      <h2 className="text-base font-semibold text-red-900">Safety blocks</h2>
      <p className="mt-0.5 text-xs text-red-800">
        Safety-critical defects recorded on this asset. It cannot be issued until each is
        cleared by a passing re-inspection — or bypassed by a formal, audited override.
      </p>

      <ul className="mt-3 space-y-3">
        {blocks.map(({ inspection, activeOverride }) => (
          <li key={inspection.id} className="rounded-md border border-red-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-slate-900">{inspection.title}</span>
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
                Failed {(inspection.inspected_at ?? inspection.created_at).slice(0, 10)}
              </span>
              {activeOverride ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                  Operational override recorded
                  {activeOverride.expires_at ? ` — expires ${activeOverride.expires_at.slice(0, 16).replace("T", " ")}` : ""}
                </span>
              ) : (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                  Blocked from issue
                </span>
              )}
            </div>

            {activeOverride ? (
              <p className="mt-1.5 text-xs text-slate-600">
                This records a management decision to keep the asset in service; it is{" "}
                <strong>not</strong> a record that the defect has been rectified. Reason:{" "}
                {activeOverride.reason}
              </p>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <form action={startReinspection}>
                <input type="hidden" name="inspection_id" value={inspection.id} />
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  Record re-inspection
                </button>
              </form>

              <form action={reportMaintenanceCase}>
                <input type="hidden" name="asset_id" value={assetId} />
                <input type="hidden" name="source_inspection_id" value={inspection.id} />
                <input type="hidden" name="case_type" value="corrective" />
                <input type="hidden" name="priority" value="high" />
                <input type="hidden" name="title" value={`Repair: ${inspection.title}`.slice(0, 200)} />
                <input type="hidden" name="out_of_service" value="on" />
                <button
                  type="submit"
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Create repair case
                </button>
              </form>

              {isAdmin && activeOverride ? (
                <form action={revokeInspectionOverride} className="flex items-center gap-2">
                  <input type="hidden" name="asset_id" value={assetId} />
                  <input type="hidden" name="override_id" value={activeOverride.id} />
                  <button
                    type="submit"
                    className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    Revoke override
                  </button>
                </form>
              ) : null}
            </div>

            {isAdmin && !activeOverride ? (
              <details className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-amber-900">
                  Record operational override (admin)
                </summary>
                <form action={createInspectionOverride} className="mt-2 space-y-2">
                  <input type="hidden" name="asset_id" value={assetId} />
                  <input type="hidden" name="inspection_id" value={inspection.id} />
                  <label className="block text-xs font-medium text-slate-700">
                    Reason (mandatory — this is an audited management decision)
                    <textarea
                      name="reason"
                      required
                      minLength={10}
                      maxLength={2000}
                      rows={2}
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs font-medium text-slate-700">
                    Expires (recommended — blocking resumes automatically)
                    <input
                      type="datetime-local"
                      name="expires_at"
                      className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-md bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800"
                  >
                    Record authorised override
                  </button>
                </form>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

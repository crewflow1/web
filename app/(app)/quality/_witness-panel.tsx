import { WITNESS_STATUS_META, canInviteWitness, type ControlPoint, type WitnessStatus } from "@/lib/quality/itp";
import type { PlanItemRow, WitnessInvitationRow } from "@/lib/quality/schema";
import { inviteWitness, recordWitnessOutcome } from "./actions";

/**
 * Witness invitations for a plan's witness/approve control points (M2).
 *
 * Staff invite a NAMED third party (client's clerk of works, CA, building
 * control) and staff record whether they attended — the witness never writes.
 * Attendance provenance is server-pinned by the DB. Portal visibility for the
 * customer is deferred (migration 20261081 header).
 *
 * Rendered only on an ISSUED plan: the DB refuses invitations against drafts
 * and history, so the surface simply doesn't appear there.
 */

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

export function WitnessPanel({
  planId,
  items,
  invitations,
  userNames,
}: {
  planId: string;
  items: PlanItemRow[];
  invitations: WitnessInvitationRow[];
  userNames: Map<string, string>;
}) {
  const witnessItems = items.filter((i) => canInviteWitness(i.control_point as ControlPoint));
  if (witnessItems.length === 0) return null;

  const byItem = new Map<string, WitnessInvitationRow[]>();
  for (const inv of invitations) {
    const arr = byItem.get(inv.inspection_plan_item_id) ?? [];
    arr.push(inv);
    byItem.set(inv.inspection_plan_item_id, arr);
  }

  return (
    <section
      aria-labelledby="quality-witness-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <h2 id="quality-witness-heading" className="text-base font-semibold text-slate-900">
        Witness invitations
      </h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Who was invited to attend each witness or approval point, and whether
        they came. Recording a sign-off on the item can then name the honoured
        invitation.
      </p>

      <ul className="mt-4 space-y-4">
        {witnessItems.map((item) => {
          const invs = byItem.get(item.id) ?? [];
          return (
            <li key={item.id} className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-semibold text-slate-900">
                Item {item.item_number} — {item.title}
              </p>

              {invs.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {invs.map((inv) => (
                    <li key={inv.id} className="rounded-md border border-slate-200 bg-slate-50 p-2.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{inv.witness_name}</span>
                        <span className="text-xs text-slate-600">{inv.witness_organisation}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${WITNESS_STATUS_META[inv.status as WitnessStatus].tone}`}
                        >
                          {WITNESS_STATUS_META[inv.status as WitnessStatus].label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-600">
                        {inv.scheduled_for ? `Expected ${inv.scheduled_for} · ` : ""}
                        {inv.witness_email ? `${inv.witness_email} · ` : ""}
                        Invited{inv.invited_by ? ` by ${userNames.get(inv.invited_by) ?? "a member"}` : ""}
                      </p>
                      {inv.attendance_recorded_at ? (
                        <p className="mt-1 text-xs text-slate-600">
                          Recorded {new Date(inv.attendance_recorded_at).toLocaleString("en-GB")}
                          {inv.attendance_recorded_by
                            ? ` by ${userNames.get(inv.attendance_recorded_by) ?? "a member"}`
                            : ""}
                        </p>
                      ) : null}

                      {inv.status === "invited" ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(
                            [
                              ["attended", "Attended"],
                              ["not_attended", "Did not attend"],
                              ["cancelled", "Cancel invitation"],
                            ] as const
                          ).map(([outcome, label]) => (
                            <form key={outcome} action={recordWitnessOutcome}>
                              <input type="hidden" name="id" value={inv.id} />
                              <input type="hidden" name="planId" value={planId} />
                              <input type="hidden" name="outcome" value={outcome} />
                              <button
                                type="submit"
                                className={`inline-flex min-h-[44px] items-center justify-center rounded-md border px-3 text-sm font-medium ${
                                  outcome === "attended"
                                    ? "border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50"
                                    : outcome === "not_attended"
                                      ? "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
                                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                                }`}
                              >
                                {label}
                              </button>
                            </form>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-slate-500">Nobody invited yet.</p>
              )}

              <details className="mt-2">
                <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-slate-700 hover:text-slate-900">
                  Invite a witness to item {item.item_number}
                </summary>
                <form action={inviteWitness} className="mt-2 space-y-3">
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="planId" value={planId} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`wname-${item.id}`} className={labelClass}>
                        Name<span className="ml-0.5 text-red-500">*</span>
                      </label>
                      <input
                        id={`wname-${item.id}`}
                        name="witnessName"
                        type="text"
                        required
                        maxLength={120}
                        placeholder="J. Carter"
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor={`worg-${item.id}`} className={labelClass}>
                        Organisation<span className="ml-0.5 text-red-500">*</span>
                      </label>
                      <input
                        id={`worg-${item.id}`}
                        name="witnessOrganisation"
                        type="text"
                        required
                        maxLength={160}
                        placeholder="Client, CA, building control…"
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`wemail-${item.id}`} className={labelClass}>
                        Email
                      </label>
                      <input
                        id={`wemail-${item.id}`}
                        name="witnessEmail"
                        type="email"
                        maxLength={200}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor={`wdate-${item.id}`} className={labelClass}>
                        Expected on site
                      </label>
                      <input
                        id={`wdate-${item.id}`}
                        name="scheduledFor"
                        type="date"
                        className={inputClass}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    CrewFlow records the invitation; contacting the witness
                    stays with you. They never sign in — your team records
                    whether they attended.
                  </p>
                  <button
                    type="submit"
                    className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
                  >
                    Record invitation
                  </button>
                </form>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

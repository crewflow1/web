import type { ReactNode } from "react";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import {
  CONTROL_POINT_META,
  SIGNOFF_RESULT_META,
  type ControlPoint,
  type SignoffResult,
} from "@/lib/quality/itp";
import type { PlanItemRow, SignoffRow } from "@/lib/quality/schema";
import { deletePlanItem, recordSignoff, voidSignoff } from "./actions";

/**
 * One ITP item, as a card — the primary layout, not a mobile fallback.
 *
 * This is used on site, on a phone, by someone in gloves. An ITP item carries
 * acceptance criteria and a method that are prose, not values, so a table would
 * push the two most important columns off a 375px screen (the failure the RAMS
 * M6c hazard table had to solve with a second stacked layout). A card reads the
 * same at 375px and 1280px, so there is one layout to keep correct — a
 * deliberate divergence from the RAMS/permit table+cards pair, for that reason.
 *
 * Every control is >= 44px tall (gloves), and the sign-off form is inline: no
 * modal, because a modal on a phone in bright sunlight over a trench is worse
 * than a form you scroll to.
 */

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

export function ItemCard({
  item,
  live,
  history,
  planId,
  planStatus,
  planVersion,
  editable,
  canSignOff,
  defaultSignedName,
  userNames,
  openHoldItemNumber,
  today,
}: {
  item: PlanItemRow;
  /** The single non-void sign-off, if any. */
  live: SignoffRow | null;
  /** Voided sign-offs, newest first — the audit trail. */
  history: SignoffRow[];
  planId: string;
  planStatus: string;
  planVersion: string | null;
  editable: boolean;
  canSignOff: boolean;
  defaultSignedName: string;
  userNames: Map<string, string>;
  openHoldItemNumber: number | null;
  today: string;
}) {
  const cp = CONTROL_POINT_META[item.control_point as ControlPoint];
  const liveMeta = live ? SIGNOFF_RESULT_META[live.result as SignoffResult] : null;
  const released = Boolean(liveMeta?.accepts);
  // Is THIS item the open gate? Only true for the lowest unreleased hold point.
  const isTheGate = item.is_hold_point && openHoldItemNumber === item.item_number;
  // Would signing this off now be recorded as out of sequence? Shown as a
  // heads-up on the form — it never disables the form.
  const wouldBreach =
    openHoldItemNumber !== null && openHoldItemNumber < item.item_number;

  return (
    <li
      className={`rounded-xl border p-4 ${
        isTheGate ? "border-red-300 bg-red-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-slate-900 px-1.5 text-xs font-semibold text-white">
          {item.item_number}
        </span>
        <h3 className="min-w-0 flex-1 text-base font-semibold text-slate-900">{item.title}</h3>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cp.tone}`}>
          {cp.label}
        </span>
        {item.is_hold_point ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
            Hold point
          </span>
        ) : null}
        {!item.required ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            Optional
          </span>
        ) : null}
        {liveMeta ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${liveMeta.tone}`}>
            {liveMeta.label}
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            Not inspected
          </span>
        )}
      </div>

      {isTheGate ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
          Work should not proceed past this item until it is signed off.
        </p>
      ) : null}

      <dl className="mt-3 space-y-2 text-sm">
        <Field label="Acceptance criteria">
          <span className="whitespace-pre-wrap text-slate-700">{item.acceptance_criteria}</span>
        </Field>
        {item.inspection_method ? (
          <Field label="Method">
            <span className="text-slate-700">{item.inspection_method}</span>
          </Field>
        ) : null}
        {item.specification_ref ? (
          <Field label="Specification">
            <span className="text-slate-700">{item.specification_ref}</span>
          </Field>
        ) : null}
      </dl>

      {/* ── The live sign-off, if there is one ─────────────────────────────── */}
      {live ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm font-semibold text-slate-900">
            {liveMeta?.label} — {live.signed_name}
          </p>
          <dl className="mt-1.5 space-y-1 text-xs text-slate-600">
            <div>
              <dt className="sr-only">Inspected</dt>
              <dd>
                Inspected {live.inspected_at} · recorded{" "}
                {new Date(live.recorded_at).toLocaleString("en-GB")} by{" "}
                {userNames.get(live.inspected_by) ?? "a member"}
              </dd>
            </div>
            <div>
              <dt className="sr-only">Plan version</dt>
              <dd>Against plan version {live.plan_version}</dd>
            </div>
            {live.witness_name ? (
              <div>
                <dt className="sr-only">Witness</dt>
                <dd>
                  Witnessed by {live.witness_name}
                  {live.witness_organisation ? ` (${live.witness_organisation})` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          {live.comments ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{live.comments}</p>
          ) : null}
          {live.hold_point_breach ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-900">
              Recorded while hold point {live.open_hold_item_number} was still open.
            </p>
          ) : null}

          {/* Evidence. Append-only: a recorded sign-off is immutable, so its
              evidence is too (DB-enforced by tg_tenant_attachment_freeze_signoff
              for DELETE and tg_tenant_attachment_evidence_immutable, 20261033,
              for the bytes). `frozen` hides the Delete control so the affordance
              never lies. */}
          <div className="mt-3">
            <AttachmentsPanel targetTable="inspection_signoffs" targetId={live.id} frozen />
          </div>

          {canSignOff ? (
            <details className="mt-3">
              <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-slate-700 hover:text-slate-900">
                Void this sign-off
              </summary>
              <form action={voidSignoff} className="mt-2 space-y-2">
                <input type="hidden" name="id" value={live.id} />
                <input type="hidden" name="planId" value={planId} />
                <label htmlFor={`void-${live.id}`} className={labelClass}>
                  Why is it being voided?<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id={`void-${live.id}`}
                  name="voidReason"
                  type="text"
                  required
                  maxLength={500}
                  placeholder="Wrong item signed off; re-inspected after rework"
                  className={inputClass}
                />
                <p className="text-xs text-slate-500">
                  A recorded sign-off is never edited. Voiding keeps it in the
                  audit trail and lets you record a fresh one.
                </p>
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 sm:w-auto"
                >
                  Void sign-off
                </button>
              </form>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* ── Record a sign-off ──────────────────────────────────────────────── */}
      {canSignOff && !live && planVersion ? (
        <details className="mt-4">
          <summary className="inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            Record sign-off for item {item.item_number}
          </summary>
          <form action={recordSignoff} className="mt-3 space-y-4">
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="planId" value={planId} />

            {wouldBreach ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                Hold point {openHoldItemNumber} is still open. You can record this
                — it will be marked as out of sequence on the record.
              </p>
            ) : null}

            <fieldset>
              <legend className={labelClass}>
                Result<span className="ml-0.5 text-red-500">*</span>
              </legend>
              <div className="mt-1.5 space-y-2">
                {(["pass", "pass_with_comment", "fail"] as SignoffResult[]).map((r) => (
                  <label
                    key={r}
                    className="flex min-h-[44px] items-center gap-3 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  >
                    <input
                      type="radio"
                      name="result"
                      value={r}
                      required
                      className="h-5 w-5"
                    />
                    <span className="font-medium text-slate-800">
                      {SIGNOFF_RESULT_META[r].label}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label htmlFor={`comments-${item.id}`} className={labelClass}>
                Comments
              </label>
              <textarea
                id={`comments-${item.id}`}
                name="comments"
                rows={3}
                maxLength={4000}
                placeholder="Required for a fail or a pass with comment."
                className={inputClass}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`signedName-${item.id}`} className={labelClass}>
                  Signed by<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id={`signedName-${item.id}`}
                  name="signedName"
                  type="text"
                  required
                  maxLength={120}
                  defaultValue={defaultSignedName}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor={`inspectedAt-${item.id}`} className={labelClass}>
                  Date inspected<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id={`inspectedAt-${item.id}`}
                  name="inspectedAt"
                  type="date"
                  required
                  max={today}
                  defaultValue={today}
                  className={inputClass}
                />
              </div>
            </div>

            {item.control_point !== "inspect" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor={`witnessName-${item.id}`} className={labelClass}>
                    Witness present
                  </label>
                  <input
                    id={`witnessName-${item.id}`}
                    name="witnessName"
                    type="text"
                    maxLength={120}
                    placeholder="Name of the person who attended"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`witnessOrg-${item.id}`} className={labelClass}>
                    Witness organisation
                  </label>
                  <input
                    id={`witnessOrg-${item.id}`}
                    name="witnessOrganisation"
                    type="text"
                    maxLength={160}
                    placeholder="Client, CA, building control…"
                    className={inputClass}
                  />
                </div>
              </div>
            ) : null}

            <p className="text-xs text-slate-500">
              You are signing as yourself: the record is bound to your account and
              cannot be edited afterwards. Attach photos or test certificates once
              it is saved.
            </p>

            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
            >
              Save sign-off
            </button>
          </form>
        </details>
      ) : null}

      {!released && live ? (
        <p className="mt-2 text-xs text-slate-600">
          {item.is_hold_point
            ? "This hold point stays open until the works are corrected and a fresh sign-off accepts them."
            : "This check stays outstanding until a fresh sign-off accepts the works."}
        </p>
      ) : null}

      {/* ── Voided history ─────────────────────────────────────────────────── */}
      {history.length > 0 ? (
        <details className="mt-3">
          <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-xs font-medium text-slate-600 hover:text-slate-900">
            {history.length} voided sign-off{history.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2">
            {history.map((h) => (
              <li key={h.id} className="rounded-md border border-slate-200 bg-slate-50 p-2.5 text-xs">
                <p className="font-medium text-slate-700">
                  {SIGNOFF_RESULT_META[h.result as SignoffResult].label} — {h.signed_name} ·{" "}
                  {h.inspected_at}
                </p>
                <p className="mt-1 text-slate-600">
                  Voided {h.voided_at ? new Date(h.voided_at).toLocaleString("en-GB") : ""}
                  {h.voided_by ? ` by ${userNames.get(h.voided_by) ?? "a member"}` : ""}
                  {h.void_reason ? ` — ${h.void_reason}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* ── Remove the item (drafts only; the DB freezes issued plans) ─────── */}
      {editable ? (
        <form action={deletePlanItem} className="mt-3">
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="planId" value={planId} />
          <button
            type="submit"
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 sm:w-auto"
          >
            Remove item<span className="sr-only">: {item.title}</span>
          </button>
        </form>
      ) : null}

      {planStatus === "superseded" || planStatus === "withdrawn" ? (
        <p className="sr-only">This plan is no longer current.</p>
      ) : null}
    </li>
  );
}

/** A labelled field inside an item card (label above, value below). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

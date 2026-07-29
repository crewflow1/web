import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireOrgContext } from "@/server/auth/session";
import { listJobOptions } from "@/app/(app)/diary/_data";
import {
  canIssue,
  canTransition,
  DEFAULT_CONDITIONS,
  effectiveStatus,
  isEditable,
  isNotYetValid,
  isTerminal,
  PERMIT_TYPE_LABELS,
  type PermitStatus,
  type PermitType,
} from "@/lib/health-safety/permits";
import { getPermit, listRamsOptions } from "../_data";
import { SignoffPanel } from "../../_signoff-panel";
import { listAcknowledgements, requiredOperatives } from "../../_signoff-data";
import { summariseSignoff } from "@/lib/health-safety/acknowledgements";
import {
  addPermitCondition,
  confirmPermitCondition,
  deletePermitCondition,
  issuePermit,
  transitionPermit,
  updatePermit,
} from "../actions";
import { PermitFormFields } from "../_fields";
import { StateForm } from "@/components/forms/StateForm";
import {
  dangerBtn,
  disabledBtn,
  errorMessage,
  formatDateTime,
  formatWindow,
  inputClass,
  labelClass,
  primaryBtn,
  savedMessage,
  secondaryBtn,
  StatusPill,
  TypePill,
  warnBtn,
} from "../_meta";

/**
 * /health-safety/permits/[id] — a single permit to work.
 *
 * A draft is fully editable: its details, its control conditions (add / confirm
 * / remove) and the gated Issue action, which only lights up once canIssue() is
 * satisfied. Once issued the contractual fields freeze and the page becomes an
 * operational control panel — activate / suspend / close / cancel, each offered
 * only when canTransition() allows it. Closed and cancelled permits are frozen
 * records. The effective status (which shows "Expired" for a live permit past
 * its window) is surfaced throughout; the DB is the real gate — the UI mirrors it.
 */

const conditionActionBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border px-3 py-2 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
const confirmBtn = `${conditionActionBtn} border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50 focus-visible:ring-emerald-400`;
const unconfirmBtn = `${conditionActionBtn} border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400`;
const removeBtn = `${conditionActionBtn} border-red-300 bg-white text-red-700 hover:bg-red-50 focus-visible:ring-red-400`;
const suggestBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2";

export default async function PermitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { user, ctx } = await requireOrgContext();
  const userId = user.id;

  const result = await getPermit(ctx.org.id, id);
  if (!result) notFound();
  const { permit, conditions } = result;

  const [jobs, ramsOptions] = await Promise.all([
    listJobOptions(ctx.org.id),
    listRamsOptions(ctx.org.id),
  ]);
  const live = permit.status === "issued" || permit.status === "active";
  const acks = live ? await listAcknowledgements("permit_to_work", permit.id) : [];
  // Required operatives = the crew rota'd to this permit's job (M6b). No job → not tracked.
  const required = live ? await requiredOperatives(permit.job_id) : [];
  const signoff = summariseSignoff(required.map((o) => o.id), acks.map((a) => a.user_id));
  const outstanding = required.filter((o) => signoff.outstanding.includes(o.id));

  const status = permit.status as PermitStatus;
  const editable = isEditable(status);
  const terminal = isTerminal(status);
  const now = new Date();
  const eff = effectiveStatus(status, permit.valid_until, now);
  const expired = eff === "expired";
  // M6c safety: a live permit whose window hasn't opened yet must NOT read as valid.
  const notYetValid = live && isNotYetValid(permit.valid_from, now);

  const conditionStates = conditions.map((c) => ({
    required: c.required,
    confirmed: c.confirmed,
  }));
  const gate = canIssue(permit, conditionStates);

  const jobLabel = permit.job_id
    ? (jobs.find((j) => j.id === permit.job_id)?.label ?? "Linked job")
    : null;
  const ramsLabel = permit.risk_assessment_id
    ? (ramsOptions.find((r) => r.id === permit.risk_assessment_id)?.label ??
      "Linked risk assessment")
    : null;

  const suggestedType = permit.permit_type as PermitType;
  const existingLabels = new Set(
    conditions.map((c) => c.label.trim().toLowerCase()),
  );
  const suggestions = (DEFAULT_CONDITIONS[suggestedType] ?? []).filter(
    (s) => !existingLabels.has(s.trim().toLowerCase()),
  );

  const error = errorMessage(sp.error);
  const saved = savedMessage(sp.saved);

  // Which lifecycle moves are legal from the stored status.
  const canActivate = canTransition(status, "active");
  const canSuspend = canTransition(status, "suspended");
  const canClose = canTransition(status, "closed");
  const canCancel = canTransition(status, "cancelled");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link
          href="/health-safety/permits"
          className="mb-1 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Permits
        </Link>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono font-medium text-slate-500">
              {permit.reference ?? "Draft (unissued)"}
            </span>
            <StatusPill status={eff} />
            <TypePill type={permit.permit_type} />
          </div>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">
            {permit.title}
          </h1>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
            {permit.scope}
          </p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {saved}
        </div>
      ) : null}

      {expired ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <p className="font-semibold">This permit has expired.</p>
          <p className="mt-0.5">
            Its validity window closed on {formatDateTime(permit.valid_until)}.
            Work authorised under it must stop — suspend or close the permit, or
            issue a new one.
          </p>
        </div>
      ) : null}

      {notYetValid ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">This permit is not valid yet.</p>
          <p className="mt-0.5">
            It becomes valid on {formatDateTime(permit.valid_from)}. Do not start the
            work authorised under it until then.
          </p>
        </div>
      ) : null}

      {terminal ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <p className="font-medium text-slate-700">This is a frozen record.</p>
          <p className="mt-0.5">
            {status === "closed"
              ? "The permit was closed and is retained for the audit trail."
              : "The permit was cancelled and is retained for the audit trail."}
            {permit.closed_at
              ? ` Closed ${formatDateTime(permit.closed_at)}.`
              : permit.cancelled_at
                ? ` Cancelled ${formatDateTime(permit.cancelled_at)}.`
                : ""}
          </p>
          {permit.closeout_notes ? (
            <p className="mt-1 whitespace-pre-wrap">
              <span className="font-medium text-slate-700">Close-out notes: </span>
              {permit.closeout_notes}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Details: edit form on a draft, read-only summary once issued ---- */}
      <section
        aria-labelledby="details-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2
          id="details-heading"
          className="text-base font-semibold text-slate-900"
        >
          Permit details
        </h2>

        {editable ? (
          <StateForm action={updatePermit} className="mt-4 space-y-5">
            <input type="hidden" name="id" value={permit.id} />
            <PermitFormFields
              jobs={jobs}
              ramsOptions={ramsOptions}
              defaults={{
                permitType: permit.permit_type,
                title: permit.title,
                scope: permit.scope,
                location: permit.location,
                jobId: permit.job_id,
                riskAssessmentId: permit.risk_assessment_id,
                responsiblePerson: permit.responsible_person,
                isolationDetails: permit.isolation_details,
                emergencyArrangements: permit.emergency_arrangements,
                validFrom: permit.valid_from,
                validUntil: permit.valid_until,
              }}
            />
            <div className="pt-1">
              <button type="submit" className={primaryBtn}>
                Save changes
              </button>
            </div>
          </StateForm>
        ) : (
          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Detail label="Permit type">
              {PERMIT_TYPE_LABELS[suggestedType] ?? permit.permit_type}
            </Detail>
            <Detail label="Location">{permit.location ?? "—"}</Detail>
            <Detail label="Responsible person">
              {permit.responsible_person ?? "—"}
            </Detail>
            <Detail label="Validity window">
              {formatWindow(permit.valid_from, permit.valid_until)}
            </Detail>
            <Detail label="Job / site">{jobLabel ?? "Not linked"}</Detail>
            <Detail label="Risk assessment">{ramsLabel ?? "Not linked"}</Detail>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Isolation details
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-slate-900">
                {permit.isolation_details ?? (
                  <span className="italic text-slate-500">None recorded</span>
                )}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Emergency arrangements
              </dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-slate-900">
                {permit.emergency_arrangements ?? (
                  <span className="italic text-slate-500">None recorded</span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* ---- Control conditions ---- */}
      <section
        aria-labelledby="conditions-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2
          id="conditions-heading"
          className="text-base font-semibold text-slate-900"
        >
          Control conditions{" "}
          <span className="font-normal text-slate-500">
            ({conditions.length})
          </span>
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          The controls that must be in place for this work. Every condition
          marked <span className="font-medium">required</span> must be confirmed
          before the permit can be issued.
        </p>

        {conditions.length === 0 ? (
          <p className="mt-4 text-sm italic text-slate-500">
            {editable
              ? "No conditions yet. Add them below, or start from the suggested set for this permit type."
              : "No control conditions were recorded on this permit."}
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {conditions.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{c.label}</p>
                  <p className="mt-0.5 text-xs">
                    <span
                      className={
                        c.required
                          ? "font-medium text-slate-600"
                          : "text-slate-500"
                      }
                    >
                      {c.required ? "Required to issue" : "Optional"}
                    </span>
                    <span aria-hidden> · </span>
                    <span
                      className={
                        c.confirmed
                          ? "font-medium text-emerald-700"
                          : "font-medium text-amber-700"
                      }
                    >
                      {c.confirmed ? "Confirmed" : "Not confirmed"}
                    </span>
                    {c.confirmed && c.confirmed_at ? (
                      <span className="text-slate-500">
                        {" "}
                        · {formatDateTime(c.confirmed_at)}
                      </span>
                    ) : null}
                  </p>
                </div>
                {editable ? (
                  <div className="flex items-center gap-2">
                    {c.confirmed ? (
                      <StateForm action={confirmPermitCondition}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="permitId" value={permit.id} />
                        <input type="hidden" name="confirmed" value="off" />
                        <button type="submit" className={unconfirmBtn}>
                          Unconfirm
                          <span className="sr-only"> condition: {c.label}</span>
                        </button>
                      </StateForm>
                    ) : (
                      <StateForm action={confirmPermitCondition}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="permitId" value={permit.id} />
                        <button type="submit" className={confirmBtn}>
                          Confirm
                          <span className="sr-only"> condition: {c.label}</span>
                        </button>
                      </StateForm>
                    )}
                    <StateForm action={deletePermitCondition}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="permitId" value={permit.id} />
                      <button type="submit" className={removeBtn}>
                        Remove
                        <span className="sr-only"> condition: {c.label}</span>
                      </button>
                    </StateForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <div className="mt-6 space-y-6 border-t border-slate-100 pt-6">
            {suggestions.length > 0 ? (
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Suggested for {PERMIT_TYPE_LABELS[suggestedType]}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Starting points — a competent person should tailor them. Each
                  adds as a required condition.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <StateForm key={s} action={addPermitCondition}>
                      <input type="hidden" name="permitId" value={permit.id} />
                      <input type="hidden" name="label" value={s} />
                      <input type="hidden" name="required" value="on" />
                      <input
                        type="hidden"
                        name="sortOrder"
                        value={conditions.length}
                      />
                      <button type="submit" className={suggestBtn}>
                        + {s}
                      </button>
                    </StateForm>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Add a condition
              </h3>
              <StateForm action={addPermitCondition} className="mt-3 space-y-4">
                <input type="hidden" name="permitId" value={permit.id} />
                <input
                  type="hidden"
                  name="sortOrder"
                  value={conditions.length}
                />
                <div>
                  <label htmlFor="label" className={labelClass}>
                    Condition
                    <span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <input
                    id="label"
                    name="label"
                    type="text"
                    required
                    maxLength={300}
                    placeholder="Fire watch posted for the duration and 60 min after"
                    className={inputClass}
                  />
                </div>
                <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="required"
                    defaultChecked
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                  />
                  Required before the permit can be issued
                </label>
                <div>
                  <button type="submit" className={secondaryBtn}>
                    Add condition
                  </button>
                </div>
              </StateForm>
            </div>
          </div>
        ) : null}
      </section>

      {/* ---- Status & lifecycle ---- */}
      <section
        aria-labelledby="lifecycle-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2
          id="lifecycle-heading"
          className="text-base font-semibold text-slate-900"
        >
          {status === "draft" ? "Issue this permit" : "Status & actions"}
        </h2>

        {status !== "draft" ? (
          <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Detail label="Current status">
              <span className="inline-flex items-center gap-2">
                <StatusPill status={eff} />
                {expired ? (
                  <span className="text-xs text-red-700">(past its window)</span>
                ) : null}
              </span>
            </Detail>
            <Detail label="Validity window">
              {formatWindow(permit.valid_from, permit.valid_until)}
            </Detail>
            {permit.issued_at ? (
              <Detail label="Issued">{formatDateTime(permit.issued_at)}</Detail>
            ) : null}
            {permit.activated_at ? (
              <Detail label="Activated">
                {formatDateTime(permit.activated_at)}
              </Detail>
            ) : null}
          </dl>
        ) : null}

        {status === "draft" ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-600">
              Issuing allocates a permanent reference and freezes the permit&rsquo;s
              details as the authorised version. It stays valid only within its
              window, and can be suspended or closed afterwards.
            </p>
            {!gate.ok ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                <p className="font-medium">Before you can issue this permit:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {gate.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <StateForm action={issuePermit}>
              <input type="hidden" name="id" value={permit.id} />
              <button
                type="submit"
                disabled={!gate.ok}
                aria-disabled={!gate.ok}
                className={gate.ok ? primaryBtn : disabledBtn}
              >
                Issue permit
              </button>
            </StateForm>
            {canCancel ? (
              <StateForm action={transitionPermit} className="pt-1">
                <input type="hidden" name="id" value={permit.id} />
                <input type="hidden" name="verb" value="cancel" />
                <button type="submit" className={dangerBtn}>
                  Cancel this draft
                </button>
              </StateForm>
            ) : null}
          </div>
        ) : terminal ? (
          <p className="mt-3 text-sm text-slate-600">
            This permit is {eff === "expired" ? status : eff} and is retained as a
            read-only record. Start a new permit for current work.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-600">
              {status === "suspended"
                ? "This permit is suspended — reactivate it to let work resume, or close it out."
                : "Keep the permit in step with what's happening on site."}
            </p>
            <div className="flex flex-wrap gap-3">
              {canActivate ? (
                <StateForm action={transitionPermit}>
                  <input type="hidden" name="id" value={permit.id} />
                  <input type="hidden" name="verb" value="activate" />
                  <button type="submit" className={primaryBtn}>
                    {status === "suspended" ? "Resume work" : "Activate"}
                  </button>
                </StateForm>
              ) : null}
              {canSuspend ? (
                <StateForm action={transitionPermit}>
                  <input type="hidden" name="id" value={permit.id} />
                  <input type="hidden" name="verb" value="suspend" />
                  <button type="submit" className={warnBtn}>
                    Suspend
                  </button>
                </StateForm>
              ) : null}
              {canCancel ? (
                <StateForm action={transitionPermit}>
                  <input type="hidden" name="id" value={permit.id} />
                  <input type="hidden" name="verb" value="cancel" />
                  <button type="submit" className={dangerBtn}>
                    Cancel permit
                  </button>
                </StateForm>
              ) : null}
            </div>
            {canClose ? (
              <StateForm action={transitionPermit}
                className="rounded-lg border border-slate-200 bg-slate-50 p-4"
              >
                <input type="hidden" name="id" value={permit.id} />
                <input type="hidden" name="verb" value="close" />
                <label htmlFor="closeoutNotes" className={labelClass}>
                  Close out the permit
                </label>
                <p className="mt-0.5 text-xs text-slate-500">
                  Record how the work finished and that the area was left safe.
                  Optional, but recommended.
                </p>
                <textarea
                  id="closeoutNotes"
                  name="closeoutNotes"
                  rows={3}
                  maxLength={4000}
                  placeholder="Work complete, area cleared, isolations removed, post-work checks done."
                  className={inputClass}
                />
                <div className="mt-3">
                  <button type="submit" className={secondaryBtn}>
                    Close permit
                  </button>
                </div>
              </StateForm>
            ) : null}
          </div>
        )}
      </section>

      {(status === "issued" || status === "active") ? (
        <SignoffPanel
          subjectType="permit_to_work"
          subjectId={permit.id}
          reference={permit.reference ?? ""}
          docTitle={permit.title}
          revisionLabel={null}
          isCurrent={!expired && !notYetValid}
          acks={acks}
          currentUserId={userId}
          summary={signoff}
          outstanding={outstanding}
          priorSignoff={null}
          pdfHref={`/api/health-safety/permits/${permit.id}/pdf`}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import { getRiskAssessment, listAssessors } from "../_data";
import { SignoffPanel } from "../_signoff-panel";
import { listAcknowledgements, countOrgMembers } from "../_signoff-data";
import {
  canIssue,
  isEditable,
  overallRiskBand,
  riskBand,
  riskRating,
  RISK_BAND_META,
  type RaStatus,
  type RiskBand,
} from "@/lib/health-safety/rams";
import {
  addHazard,
  deleteHazard,
  issueRiskAssessment,
  supersedeRiskAssessment,
  updateRiskAssessment,
  withdrawRiskAssessment,
} from "../actions";

/**
 * /health-safety/[id] — a single RAMS.
 *
 * A draft is fully editable: its header, its hazards (each scored on a 5×5
 * matrix, initial and residual), and the gated Issue action. Once issued the
 * document is a frozen legal record — read-only, with only Supersede / Withdraw
 * left. Editability is driven entirely by isEditable(status); the DB is the real
 * gate, so the UI simply mirrors it.
 */

const RA_STATUS_LABELS: Record<RaStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  superseded: "Superseded",
  withdrawn: "Withdrawn",
};

const RA_STATUS_STYLES: Record<RaStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-amber-100 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-500",
};

/** Band → pill classes. Colour reinforces the label; the label carries the meaning. */
const BAND_STYLES: Record<RiskBand, string> = {
  low: "bg-emerald-100 text-emerald-800",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-orange-100 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That risk assessment reference was invalid.",
  not_found: "That risk assessment no longer exists.",
  not_editable: "This risk assessment is issued and can no longer be edited.",
  numbering_failed: "Couldn't allocate a reference number. Try again.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Draft created — add hazards, then issue it.",
  updated: "Risk assessment saved.",
  issued: "Risk assessment issued. It's now a frozen record.",
  superseded: "Risk assessment superseded.",
  withdrawn: "Risk assessment withdrawn.",
  hazard: "Hazard added.",
  hazard_removed: "Hazard removed.",
};

const LS_OPTIONS = [1, 2, 3, 4, 5] as const;

const inputClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";
const primaryBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2";
const secondaryBtn =
  "inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2";

export default async function RiskAssessmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { user } = await requireOrgContext();
  const userId = user.id;

  const result = await getRiskAssessment(id);
  if (!result) notFound();
  const { ra, hazards } = result;
  const acks = ra.status === "issued" ? await listAcknowledgements("risk_assessment", ra.id) : [];
  const memberCount = ra.status === "issued" ? await countOrgMembers() : 0;

  const assessors = await listAssessors();
  const assessorName = ra.assessor_id
    ? (assessors.find((a) => a.id === ra.assessor_id)?.name ?? "Assigned")
    : null;

  const status = ra.status as RaStatus;
  const editable = isEditable(status);
  const overall = overallRiskBand(
    hazards.map((h) => ({
      likelihood: h.likelihood,
      severity: h.severity,
      residualLikelihood: h.residual_likelihood,
      residualSeverity: h.residual_severity,
    })),
  );
  const gate = canIssue({
    status,
    title: ra.title,
    activity: ra.activity,
    assessorId: ra.assessor_id,
    hazardCount: hazards.length,
  });

  const errorMessage = sp.error
    ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error))
    : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  const ppeSlots = editable ? [...ra.ppe, "", "", "", ""] : ra.ppe;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link
          href="/health-safety"
          className="mb-1 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-slate-900"
        >
          ← Health &amp; safety
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-medium text-slate-500">
                {ra.reference ?? "Draft (unissued)"}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${RA_STATUS_STYLES[status]}`}
              >
                {RA_STATUS_LABELS[status]}
              </span>
              {overall ? (
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${BAND_STYLES[overall]}`}
                >
                  Overall risk: {RISK_BAND_META[overall].label}
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 text-2xl font-bold text-slate-900">{ra.title}</h1>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
              {ra.activity}
            </p>
          </div>
        </div>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {savedMessage}
        </div>
      ) : null}

      {!editable ? (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <p className="font-medium text-slate-700">This is a frozen record.</p>
          <p className="mt-0.5">
            {status === "issued"
              ? "It was issued and can no longer be changed. Supersede it to publish a revised version, or withdraw it if the work is no longer being done."
              : status === "superseded"
                ? "It has been superseded by a newer version and is kept for the audit trail."
                : "It has been withdrawn and is kept for the audit trail."}
            {ra.issued_at ? ` Issued ${ra.issued_at.slice(0, 10)}.` : ""}
          </p>
        </div>
      ) : null}

      {/* ---- Details: an edit form on a draft, a read-only summary once issued ---- */}
      <section
        aria-labelledby="details-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 id="details-heading" className="text-base font-semibold text-slate-900">
          Assessment details
        </h2>

        {editable ? (
          <form action={updateRiskAssessment} className="mt-4 space-y-5">
            <input type="hidden" name="id" value={ra.id} />
            <div>
              <label htmlFor="title" className={labelClass}>
                Title<span className="ml-0.5 text-red-500">*</span>
              </label>
              <input
                id="title"
                name="title"
                type="text"
                required
                maxLength={200}
                defaultValue={ra.title}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="activity" className={labelClass}>
                Activity / task<span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                id="activity"
                name="activity"
                rows={2}
                required
                maxLength={500}
                defaultValue={ra.activity}
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
                  defaultValue={ra.location ?? ""}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="assessorId" className={labelClass}>
                  Assessor
                </label>
                <select
                  id="assessorId"
                  name="assessorId"
                  defaultValue={ra.assessor_id ?? ""}
                  className={inputClass}
                >
                  <option value="">Not yet assigned</option>
                  {assessors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
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
                  defaultValue={(ra.assessment_date ?? "").slice(0, 10)}
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
                  defaultValue={(ra.review_date ?? "").slice(0, 10)}
                  className={inputClass}
                />
              </div>
            </div>
            <fieldset>
              <legend className={labelClass}>PPE required</legend>
              <p className="mt-1 text-xs text-slate-500">
                One item per box. Leave the rest blank.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {ppeSlots.map((val, i) => (
                  <input
                    key={i}
                    name="ppe"
                    type="text"
                    maxLength={60}
                    defaultValue={val}
                    aria-label={`PPE item ${i + 1}`}
                    placeholder="Add PPE…"
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
                defaultValue={ra.method_statement ?? ""}
                className={inputClass}
              />
            </div>
            <div className="pt-1">
              <button type="submit" className={primaryBtn}>
                Save changes
              </button>
            </div>
          </form>
        ) : (
          <>
            <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Detail label="Location">{ra.location ?? "—"}</Detail>
              <Detail label="Assessor">{assessorName ?? "Not named"}</Detail>
              <Detail label="Assessment date">{ra.assessment_date ?? "—"}</Detail>
              <Detail label="Review date">{ra.review_date ?? "—"}</Detail>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  PPE required
                </dt>
                <dd className="mt-1">
                  {ra.ppe.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {ra.ppe.map((p, i) => (
                        <li
                          key={i}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                        >
                          {p}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-slate-400">None specified</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Method statement
              </h3>
              {ra.method_statement ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
                  {ra.method_statement}
                </p>
              ) : (
                <p className="mt-1 text-sm italic text-slate-400">
                  No method statement recorded.
                </p>
              )}
            </div>
          </>
        )}
      </section>

      {/* ---- Hazards ---- */}
      <section
        aria-labelledby="hazards-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="hazards-heading" className="text-base font-semibold text-slate-900">
            Hazards{" "}
            <span className="font-normal text-slate-400">({hazards.length})</span>
          </h2>
          {overall ? (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_STYLES[overall]}`}
            >
              Overall risk: {RISK_BAND_META[overall].label}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Scored on a 5×5 matrix — likelihood 1 (rare) to 5 (almost certain) ×
          severity 1 (minor) to 5 (fatal). Residual risk is the score once the
          controls are in place.
        </p>

        {hazards.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon="⚠️"
              title="No hazards assessed yet"
              body={
                editable
                  ? "Add each hazard below — who it puts at risk, its likelihood and severity, and the controls that bring the residual risk down."
                  : "No hazards were recorded on this assessment."
              }
            />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Hazard
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Who&rsquo;s at risk
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Initial risk
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Controls
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Residual risk
                  </th>
                  {editable ? (
                    <th scope="col" className="py-2 pl-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {hazards.map((h) => {
                  const initial = riskRating(h.likelihood, h.severity);
                  const hasResidual =
                    h.residual_likelihood != null && h.residual_severity != null;
                  const residual = hasResidual
                    ? riskRating(h.residual_likelihood!, h.residual_severity!)
                    : null;
                  return (
                    <tr key={h.id}>
                      <td className="py-3 pr-3 font-medium text-slate-900">
                        {h.hazard}
                      </td>
                      <td className="px-3 py-3 text-slate-700">
                        {h.who_at_risk ?? "—"}
                      </td>
                      <td className="px-3 py-3">
                        <div className="text-slate-700">
                          {h.likelihood} × {h.severity} ={" "}
                          <span className="font-semibold text-slate-900">
                            {initial}
                          </span>
                        </div>
                        <BandPill rating={initial} className="mt-1" />
                      </td>
                      <td className="px-3 py-3 text-slate-700">
                        <span className="whitespace-pre-wrap">
                          {h.control_measures}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {residual != null ? (
                          <>
                            <div className="text-slate-700">
                              {h.residual_likelihood} × {h.residual_severity} ={" "}
                              <span className="font-semibold text-slate-900">
                                {residual}
                              </span>
                            </div>
                            <BandPill rating={residual} className="mt-1" />
                          </>
                        ) : (
                          <span className="text-slate-400">Not assessed</span>
                        )}
                      </td>
                      {editable ? (
                        <td className="py-3 pl-3">
                          <form action={deleteHazard}>
                            <input type="hidden" name="id" value={h.id} />
                            <input
                              type="hidden"
                              name="riskAssessmentId"
                              value={ra.id}
                            />
                            <button
                              type="submit"
                              className="inline-flex min-h-[44px] items-center rounded-md border border-red-300 bg-white px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
                            >
                              Remove
                              <span className="sr-only"> hazard: {h.hazard}</span>
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {editable ? (
          <div className="mt-6 border-t border-slate-100 pt-6">
            <h3 className="text-sm font-semibold text-slate-900">Add a hazard</h3>
            <form action={addHazard} className="mt-3 space-y-4">
              <input type="hidden" name="riskAssessmentId" value={ra.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="hazard" className={labelClass}>
                    Hazard<span className="ml-0.5 text-red-500">*</span>
                  </label>
                  <input
                    id="hazard"
                    name="hazard"
                    type="text"
                    required
                    maxLength={500}
                    placeholder="Fall from height"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="whoAtRisk" className={labelClass}>
                    Who&rsquo;s at risk
                  </label>
                  <input
                    id="whoAtRisk"
                    name="whoAtRisk"
                    type="text"
                    maxLength={300}
                    placeholder="Operatives, passers-by"
                    className={inputClass}
                  />
                </div>
              </div>
              <fieldset>
                <legend className={labelClass}>
                  Initial risk (before controls)
                  <span className="ml-0.5 text-red-500">*</span>
                </legend>
                <div className="mt-1.5 grid gap-4 sm:grid-cols-2">
                  <ScoreSelect
                    id="likelihood"
                    name="likelihood"
                    label="Likelihood"
                    required
                  />
                  <ScoreSelect
                    id="severity"
                    name="severity"
                    label="Severity"
                    required
                  />
                </div>
              </fieldset>
              <div>
                <label htmlFor="controlMeasures" className={labelClass}>
                  Control measures<span className="ml-0.5 text-red-500">*</span>
                </label>
                <textarea
                  id="controlMeasures"
                  name="controlMeasures"
                  rows={3}
                  required
                  maxLength={4000}
                  placeholder="Edge protection, harness clipped to anchor point, trained operatives only."
                  className={inputClass}
                />
              </div>
              <fieldset>
                <legend className={labelClass}>Residual risk (after controls)</legend>
                <p className="mt-1 text-xs text-slate-500">
                  Optional, but recommended — leave both blank if not yet assessed.
                  It can never be higher than the initial risk.
                </p>
                <div className="mt-1.5 grid gap-4 sm:grid-cols-2">
                  <ScoreSelect
                    id="residualLikelihood"
                    name="residualLikelihood"
                    label="Residual likelihood"
                    optional
                  />
                  <ScoreSelect
                    id="residualSeverity"
                    name="residualSeverity"
                    label="Residual severity"
                    optional
                  />
                </div>
              </fieldset>
              <div className="pt-1">
                <button type="submit" className={primaryBtn}>
                  Add hazard
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>

      {/* ---- Lifecycle ---- */}
      <section
        aria-labelledby="lifecycle-heading"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 id="lifecycle-heading" className="text-base font-semibold text-slate-900">
          {editable ? "Issue this RAMS" : "Lifecycle"}
        </h2>

        {status === "draft" ? (
          <div className="mt-2">
            <p className="text-sm text-slate-600">
              Issuing allocates a permanent reference and freezes the document as
              the version the site works to. It can&rsquo;t be edited afterwards.
            </p>
            {!gate.ok ? (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                <p className="font-medium">Before you can issue this RAMS:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {gate.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <form action={issueRiskAssessment} className="mt-3">
              <input type="hidden" name="id" value={ra.id} />
              <button
                type="submit"
                disabled={!gate.ok}
                aria-disabled={!gate.ok}
                className={
                  gate.ok
                    ? primaryBtn
                    : "inline-flex min-h-[44px] cursor-not-allowed items-center justify-center rounded-md bg-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-400"
                }
              >
                Issue risk assessment
              </button>
            </form>
          </div>
        ) : status === "issued" ? (
          <div className="mt-2 space-y-3">
            <p className="text-sm text-slate-600">
              Publish a revised version by superseding this one, or withdraw it if
              the work is no longer going ahead. Both keep this record for the
              audit trail.
            </p>
            <div className="flex flex-wrap gap-3">
              <form action={supersedeRiskAssessment}>
                <input type="hidden" name="id" value={ra.id} />
                <button type="submit" className={secondaryBtn}>
                  Supersede
                </button>
              </form>
              <form action={withdrawRiskAssessment}>
                <input type="hidden" name="id" value={ra.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-red-300 bg-white px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
                >
                  Withdraw
                </button>
              </form>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            This risk assessment is {RA_STATUS_LABELS[status].toLowerCase()} and is
            retained as a read-only record. Start a new risk assessment for current
            work.
          </p>
        )}
      </section>

      {status === "issued" ? (
        <SignoffPanel
          subjectType="risk_assessment"
          subjectId={ra.id}
          reference={ra.reference ?? ""}
          acks={acks}
          currentUserId={userId}
          memberCount={memberCount}
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

/** Risk band pill — the label text is what carries the meaning; colour reinforces it. */
function BandPill({ rating, className = "" }: { rating: number; className?: string }) {
  const band = riskBand(rating);
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${BAND_STYLES[band]} ${className}`}
    >
      {RISK_BAND_META[band].label}
    </span>
  );
}

function ScoreSelect({
  id,
  name,
  label,
  required = false,
  optional = false,
}: {
  id: string;
  name: string;
  label: string;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue=""
        className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      >
        <option value="">{optional ? "Not assessed" : "Choose 1–5"}</option>
        {LS_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}

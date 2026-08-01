import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { EmptyState } from "../../_components/empty-state";
import {
  getPlan,
  listJobOptions,
  listMembers,
  listPlanNcrs,
  listWitnessInvitations,
  loadUserNames,
} from "../_data";
import { HoldPointWarnings } from "../_hold-point-warnings";
import { ItemCard } from "../_item-card";
import { WitnessPanel } from "../_witness-panel";
import {
  addPlanItem,
  createPlanRevision,
  issuePlan,
  updateInspectionPlan,
  withdrawPlan,
} from "../actions";
import { isLive } from "@/lib/quality/ncr";
import {
  CONTROL_POINTS,
  CONTROL_POINT_META,
  ITP_STATUS_LABELS,
  canIssue,
  completionPercent,
  holdPointWarnings,
  isEditable,
  isFullyAccepted,
  type ItpStatus,
} from "@/lib/quality/itp";
import type { SignoffRow } from "@/lib/quality/schema";

/**
 * /quality/[id] — one inspection & test plan.
 *
 * Layout order is the site's order of concern: what is holding work up (the WARN
 * seam), then the ordered checks with their sign-offs and evidence, then the
 * document metadata, then (for a draft) the editing surface.
 *
 * ACTIVE-org pinned via getPlan: a plan in a non-active org is
 * INDISTINGUISHABLE from a missing one, so a dual-org member can never open the
 * other company's plan inside this org's shell (#456/#463).
 */

const STATUS_STYLES: Record<ItpStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  issued: "bg-emerald-100 text-emerald-800",
  superseded: "bg-amber-100 text-amber-800",
  withdrawn: "bg-slate-100 text-slate-600",
};

const ERROR_MAP: Record<string, string> = {
  bad_id: "That inspection plan reference was invalid.",
  not_found: "That record no longer exists.",
  not_editable: "An issued plan is frozen. Supersede it with a new plan instead.",
  not_issued: "Sign-offs can only be recorded against an issued plan.",
  issue_failed: "Couldn't issue the plan. Try again.",
  duplicate_item_number: "That item number is already used in this plan.",
  already_signed_off: "That item already has a sign-off. Void it before recording a new one.",
  revision_source_not_issued: "Only the current (issued) plan can be revised.",
  revision_already_in_progress:
    "A revision draft already exists for this plan. Finish or withdraw it first.",
};

const SAVED_MAP: Record<string, string> = {
  created: "Draft created. Add the checks, then issue it.",
  updated: "Inspection plan saved.",
  issued: "Inspection plan issued. It is now the current plan for this work package.",
  withdrawn: "Inspection plan withdrawn.",
  item_added: "Inspection item added.",
  item_removed: "Inspection item removed.",
  signed_off: "Sign-off recorded.",
  voided: "Sign-off voided. Record the re-inspection when the works are corrected.",
  witness_invited: "Witness invitation recorded.",
  witness_recorded: "Witness attendance recorded.",
  revision_created:
    "Revision draft created with every check carried forward. Edit it, then issue it to supersede the current plan.",
};

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

type SP = Promise<{ saved?: string; error?: string }>;

export default async function InspectionPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { user, ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const loaded = await getPlan(ctx.org.id, id);
  if (!loaded) notFound();
  const { plan, items, signoffs, progress, jobLabel, priorReference } = loaded;

  const editable = isEditable(plan.status);
  const canSignOff = plan.status === "issued";
  const warnings = holdPointWarnings(progress);
  const gate = canIssue({
    status: plan.status,
    title: plan.title,
    workPackage: plan.work_package,
    jobId: plan.job_id,
    itemCount: items.length,
  });

  // Group sign-offs by item: one live row (the partial unique index guarantees
  // at most one) plus the voided audit trail.
  const liveByItem = new Map<string, SignoffRow>();
  const historyByItem = new Map<string, SignoffRow[]>();
  for (const s of signoffs) {
    if (s.voided_at === null) {
      liveByItem.set(s.inspection_plan_item_id, s);
    } else {
      const arr = historyByItem.get(s.inspection_plan_item_id) ?? [];
      arr.push(s);
      historyByItem.set(s.inspection_plan_item_id, arr);
    }
  }

  // M2: witness invitations + the plan's NCR register (both ACTIVE-org pinned).
  const itemIds = items.map((i) => i.id);
  const [invitations, ncrs] = await Promise.all([
    listWitnessInvitations(ctx.org.id, itemIds),
    listPlanNcrs(ctx.org.id, itemIds),
  ]);
  const liveNcrCountByItem = new Map<string, number>();
  for (const n of ncrs) {
    if (isLive(n.status)) {
      liveNcrCountByItem.set(
        n.inspection_plan_item_id,
        (liveNcrCountByItem.get(n.inspection_plan_item_id) ?? 0) + 1,
      );
    }
  }
  const invitationsByItem = new Map<string, typeof invitations>();
  for (const inv of invitations) {
    const arr = invitationsByItem.get(inv.inspection_plan_item_id) ?? [];
    arr.push(inv);
    invitationsByItem.set(inv.inspection_plan_item_id, arr);
  }

  const userNames = await loadUserNames([
    ...signoffs.map((s) => s.inspected_by),
    ...signoffs.map((s) => s.voided_by).filter((v): v is string => Boolean(v)),
    ...(plan.prepared_by ? [plan.prepared_by] : []),
    ...(plan.issued_by ? [plan.issued_by] : []),
    ...invitations.flatMap((w) =>
      [w.invited_by, w.attendance_recorded_by].filter((u): u is string => Boolean(u)),
    ),
  ]);

  // The pickers are only rendered on a draft, so don't pay for them otherwise.
  const [jobs, members]: [Array<{ id: string; label: string }>, Array<{ id: string; name: string }>] =
    editable
      ? await Promise.all([listJobOptions(ctx.org.id), listMembers(ctx.org.id)])
      : [[], []];

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;
  const today = new Date().toISOString().slice(0, 10);
  const nextItemNumber = items.reduce((n, i) => Math.max(n, i.item_number), 0) + 1;
  const pc = completionPercent(progress);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{plan.reference ?? "Draft"}</span>
      </nav>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-slate-600">
            {plan.reference ?? "Draft"}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[plan.status]}`}
          >
            {ITP_STATUS_LABELS[plan.status]}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
            Revision {plan.revision_number}
          </span>
          {isFullyAccepted(progress) && plan.status === "issued" ? (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
              All checks accepted
            </span>
          ) : null}
        </div>
        <h1 className="text-2xl font-bold text-slate-900">{plan.work_package}</h1>
        <p className="text-sm text-slate-600">{plan.title}</p>
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

      {/* THE WARN SEAM. Warnings only — no action on this page is disabled or
          refused because a hold point is open. */}
      <HoldPointWarnings warnings={warnings} />

      {plan.status === "superseded" ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This plan has been superseded by a newer plan for the same work package.
          It stays here as the record of what was inspected against it.
        </p>
      ) : null}
      {plan.status === "withdrawn" ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          This plan has been withdrawn. It is no longer the current plan for this
          work package.
        </p>
      ) : null}

      {/* ── Progress ──────────────────────────────────────────────────────── */}
      {items.length > 0 ? (
        <section
          aria-labelledby="quality-progress-heading"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
        >
          <h2 id="quality-progress-heading" className="text-sm font-semibold text-slate-900">
            Progress
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Checks" value={`${progress.signedOffItems}/${progress.totalItems}`} />
            <Stat label="Complete" value={`${pc}%`} />
            <Stat
              label="Hold points"
              value={
                progress.holdPointItems === 0
                  ? "None"
                  : `${progress.holdPointItems - progress.openHoldPoints}/${progress.holdPointItems} released`
              }
            />
            <Stat
              label="Outstanding"
              value={String(progress.outstandingRequiredItems)}
            />
          </dl>
        </section>
      ) : null}

      {/* ── The checks ────────────────────────────────────────────────────── */}
      <section aria-labelledby="quality-items-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="quality-items-heading" className="text-base font-semibold text-slate-900">
            Inspection items
          </h2>
          <span className="text-xs text-slate-500">
            {items.length} check{items.length === 1 ? "" : "s"} in order
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Each check names what &ldquo;acceptable&rdquo; means for it. A{" "}
          <strong className="font-semibold">hold point</strong> is a check work
          must not pass until it has been signed off.
        </p>

        {items.length === 0 ? (
          <div className="mt-3 rounded-xl border border-slate-200 bg-white shadow-sm">
            <EmptyState
              icon="🧾"
              title="No checks yet"
              body={
                editable
                  ? "Add each check in the order it happens on site, with the acceptance criteria that decide a pass. Flag the ones work must not proceed past."
                  : "No checks were recorded on this plan."
              }
            />
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                live={liveByItem.get(item.id) ?? null}
                history={historyByItem.get(item.id) ?? []}
                planId={plan.id}
                planStatus={plan.status}
                planVersion={plan.reference}
                editable={editable}
                canSignOff={canSignOff}
                defaultSignedName={user.email ?? ""}
                userNames={userNames}
                openHoldItemNumber={progress.openHoldItemNumber}
                today={today}
                invitations={invitationsByItem.get(item.id) ?? []}
                liveNcrCount={liveNcrCountByItem.get(item.id) ?? 0}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Witness invitations (issued plans — the DB refuses the rest) ───── */}
      {plan.status === "issued" ? (
        <WitnessPanel
          planId={plan.id}
          items={items}
          invitations={invitations}
          userNames={userNames}
        />
      ) : null}

      {/* ── Add a check (drafts only — the DB freezes an issued plan) ──────── */}
      {editable ? (
        <section
          aria-labelledby="quality-add-item-heading"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
        >
          <h2 id="quality-add-item-heading" className="text-base font-semibold text-slate-900">
            Add an inspection item
          </h2>
          <form action={addPlanItem} className="mt-4 space-y-4">
            <input type="hidden" name="planId" value={plan.id} />

            <div className="grid gap-4 sm:grid-cols-[7rem_1fr]">
              <div>
                <label htmlFor="itemNumber" className={labelClass}>
                  Item no.<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="itemNumber"
                  name="itemNumber"
                  type="number"
                  min={1}
                  max={9999}
                  required
                  defaultValue={nextItemNumber}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="itemTitle" className={labelClass}>
                  What is checked<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="itemTitle"
                  name="title"
                  type="text"
                  required
                  maxLength={300}
                  placeholder="Reinforcement fixed — Plot 1 ground slab"
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="acceptanceCriteria" className={labelClass}>
                Acceptance criteria<span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                id="acceptanceCriteria"
                name="acceptanceCriteria"
                required
                rows={3}
                maxLength={4000}
                placeholder="Bar size, spacing and cover to drawing S-204 rev B. Cover 40mm ±5mm."
                className={inputClass}
              />
              <p className="mt-1 text-xs text-slate-500">
                What decides a pass. Without this the record is an opinion, not a
                verification.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="inspectionMethod" className={labelClass}>
                  Method
                </label>
                <input
                  id="inspectionMethod"
                  name="inspectionMethod"
                  type="text"
                  maxLength={300}
                  placeholder="Visual + tape measure"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="itemSpecRef" className={labelClass}>
                  Specification clause
                </label>
                <input
                  id="itemSpecRef"
                  name="specificationRef"
                  type="text"
                  maxLength={200}
                  placeholder="S-204 rev B"
                  className={inputClass}
                />
              </div>
            </div>

            <div>
              <label htmlFor="controlPoint" className={labelClass}>
                Control point<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select id="controlPoint" name="controlPoint" defaultValue="inspect" className={inputClass}>
                {CONTROL_POINTS.map((c) => (
                  <option key={c} value={c}>
                    {CONTROL_POINT_META[c].label} — {CONTROL_POINT_META[c].help}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-slate-300 bg-white px-3 text-sm">
              <input id="isHoldPoint" name="isHoldPoint" type="checkbox" className="h-5 w-5" />
              <span className="font-medium text-slate-800">
                Hold point — work must not proceed past this check until it is
                signed off
              </span>
            </label>
            <p className="text-xs text-slate-500">
              A hold point is always a required check. CrewFlow warns loudly about
              an open hold point and records anything signed off past it; it does
              not stop anyone working.
            </p>

            {/* An unchecked checkbox sends NOTHING, so a bare `name="required"`
                would read as absent-and-therefore-default-true and make the box
                impossible to turn off. The hidden "off" is always sent; the
                action asks whether "on" is ALSO present. */}
            <input type="hidden" name="required" value="off" />
            <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-slate-300 bg-white px-3 text-sm">
              <input
                id="required"
                name="required"
                type="checkbox"
                defaultChecked
                value="on"
                className="h-5 w-5"
              />
              <span className="font-medium text-slate-800">Required check</span>
            </label>

            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 sm:w-auto"
            >
              Add item
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Issue / withdraw ──────────────────────────────────────────────── */}
      <section
        aria-labelledby="quality-lifecycle-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <h2 id="quality-lifecycle-heading" className="text-base font-semibold text-slate-900">
          Document control
        </h2>
        {plan.status === "draft" ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              Issuing freezes the plan and makes it the current plan for this work
              package. Any plan already current for it is superseded in the same
              step. After that, changes mean a new plan.
            </p>
            {!gate.ok ? (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800">
                {gate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={issuePlan}>
                <input type="hidden" name="id" value={plan.id} />
                <button
                  type="submit"
                  disabled={!gate.ok}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
                >
                  Issue plan
                </button>
              </form>
              <form action={withdrawPlan}>
                <input type="hidden" name="id" value={plan.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Withdraw draft
                </button>
              </form>
            </div>
          </>
        ) : plan.status === "issued" ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              This plan is frozen. To change it, start revision{" "}
              {plan.revision_number + 1}: every check — hold points included —
              is carried into a new draft, and issuing that draft supersedes
              this plan automatically. Everything signed off here stays
              attached to this version.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <form action={createPlanRevision}>
                <input type="hidden" name="id" value={plan.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Start revision {plan.revision_number + 1}
                </button>
              </form>
              <a
                href={`/api/quality/${plan.id}/pdf`}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Download evidence PDF
              </a>
              <form action={withdrawPlan}>
                <input type="hidden" name="id" value={plan.id} />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Withdraw plan
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-slate-600">
              This plan is no longer current, and is kept unchanged as a record.
            </p>
            {plan.reference ? (
              <div className="mt-4">
                <a
                  href={`/api/quality/${plan.id}/pdf`}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Download evidence PDF
                </a>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* ── Document metadata ─────────────────────────────────────────────── */}
      <section
        aria-labelledby="quality-meta-heading"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <h2 id="quality-meta-heading" className="text-base font-semibold text-slate-900">
          Plan details
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Meta label="Job">
            {plan.job_id ? (
              <Link href={`/jobs/${plan.job_id}`} className="text-slate-800 hover:underline">
                {jobLabel ?? "View job"}
              </Link>
            ) : (
              <span className="text-slate-500">Job record removed</span>
            )}
          </Meta>
          <Meta label="Specification">{plan.specification_ref ?? "—"}</Meta>
          <Meta label="Location">{plan.location ?? "—"}</Meta>
          <Meta label="Plan date">{plan.plan_date ?? "—"}</Meta>
          <Meta label="Prepared by">
            {plan.prepared_by ? (userNames.get(plan.prepared_by) ?? "Member") : "—"}
          </Meta>
          <Meta label="Issued">
            {plan.issued_at
              ? `${new Date(plan.issued_at).toLocaleString("en-GB")}${
                  plan.issued_by ? ` by ${userNames.get(plan.issued_by) ?? "a member"}` : ""
                }`
              : "Not issued"}
          </Meta>
          {plan.supersedes_id ? (
            <Meta label="Supersedes">
              <Link href={`/quality/${plan.supersedes_id}`} className="text-slate-800 hover:underline">
                {priorReference ?? "Previous plan"}
              </Link>
            </Meta>
          ) : null}
          {plan.notes ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Notes</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-slate-700">{plan.notes}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {/* ── Edit the header (drafts only) ─────────────────────────────────── */}
      {editable ? (
        <section
          aria-labelledby="quality-edit-heading"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
        >
          <h2 id="quality-edit-heading" className="text-base font-semibold text-slate-900">
            Edit plan details
          </h2>
          <form action={updateInspectionPlan} className="mt-4 space-y-4">
            <input type="hidden" name="id" value={plan.id} />
            <div>
              <label htmlFor="edit-jobId" className={labelClass}>
                Job<span className="ml-0.5 text-red-500">*</span>
              </label>
              <select
                id="edit-jobId"
                name="jobId"
                required
                defaultValue={plan.job_id ?? ""}
                className={inputClass}
              >
                <option value="">Select a job…</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-workPackage" className={labelClass}>
                  Work package<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="edit-workPackage"
                  name="workPackage"
                  type="text"
                  required
                  maxLength={200}
                  defaultValue={plan.work_package}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="edit-title" className={labelClass}>
                  Title<span className="ml-0.5 text-red-500">*</span>
                </label>
                <input
                  id="edit-title"
                  name="title"
                  type="text"
                  required
                  maxLength={200}
                  defaultValue={plan.title}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-specRef" className={labelClass}>
                  Specification / drawing reference
                </label>
                <input
                  id="edit-specRef"
                  name="specificationRef"
                  type="text"
                  maxLength={200}
                  defaultValue={plan.specification_ref ?? ""}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="edit-location" className={labelClass}>
                  Location
                </label>
                <input
                  id="edit-location"
                  name="location"
                  type="text"
                  maxLength={200}
                  defaultValue={plan.location ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-preparedBy" className={labelClass}>
                  Prepared by
                </label>
                <select
                  id="edit-preparedBy"
                  name="preparedBy"
                  defaultValue={plan.prepared_by ?? ""}
                  className={inputClass}
                >
                  <option value="">Not set</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="edit-planDate" className={labelClass}>
                  Plan date
                </label>
                <input
                  id="edit-planDate"
                  name="planDate"
                  type="date"
                  defaultValue={plan.plan_date ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label htmlFor="edit-notes" className={labelClass}>
                Notes
              </label>
              <textarea
                id="edit-notes"
                name="notes"
                rows={4}
                maxLength={20000}
                defaultValue={plan.notes ?? ""}
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 sm:w-auto"
            >
              Save details
            </button>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-700">{children}</dd>
    </div>
  );
}

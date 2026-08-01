import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { AttachmentsPanel } from "@/components/attachments/AttachmentsPanel";
import { loadUserNames, listMembers } from "../../_data";
import { getNcr } from "../_data";
import {
  cancelNcr,
  closeNcr,
  completeCorrectiveAction,
  decideCorrectiveAction,
  proposeCorrectiveAction,
  updateNcr,
} from "../actions";
import {
  NCR_SEVERITIES,
  NCR_SEVERITY_META,
  NCR_STATUS_META,
  nextSteps,
  type NcrSeverity,
  type NcrStatus,
} from "@/lib/quality/ncr";

/**
 * /quality/ncrs/[id] — one non-conformance report.
 *
 * Layout order is the order of concern: where the NCR is in its life (and what
 * happens next), the corrective-action record, the evidence, then the detail.
 * The middle statuses are DERIVED by the database from the corrective-action
 * rows — this page never offers them as buttons; it offers the corrective
 * action forms, and the DB moves the NCR.
 *
 * ACTIVE-org pinned via getNcr: an NCR in a non-active org is INDISTINGUISHABLE
 * from a missing one (#456/#463).
 */

const ERROR_MAP: Record<string, string> = {
  bad_id: "That NCR reference was invalid.",
  not_found: "That record no longer exists.",
  not_editable: "An NCR under corrective action is frozen. The corrective-action record carries what changed.",
  proposal_already_pending: "A corrective action is already awaiting review on this NCR.",
  already_decided: "That corrective action has already been decided.",
  not_completable: "Only an accepted, not-yet-completed corrective action can be completed.",
  not_closable: "An NCR closes only after its corrective action is completed.",
};

const SAVED_MAP: Record<string, string> = {
  raised: "NCR raised. Propose the corrective action when the fix is known.",
  updated: "NCR saved.",
  action_proposed: "Corrective action proposed. It is now awaiting review.",
  action_accepted: "Corrective action accepted. Record completion when the works are corrected.",
  action_rejected: "Corrective action rejected. Propose a new one.",
  action_completed: "Corrective work recorded as completed. Verify and close the NCR.",
  closed: "NCR closed with verification.",
  cancelled: "NCR cancelled.",
};

const inputClass =
  "mt-1.5 block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelClass = "block text-sm font-medium text-slate-800";

type SP = Promise<{ saved?: string; error?: string }>;

export default async function NcrDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const sp = await searchParams;

  const loaded = await getNcr(ctx.org.id, id);
  if (!loaded) notFound();
  const { ncr, actions, item, plan, sourceSignoff } = loaded;

  const status = ncr.status as NcrStatus;
  const steps = nextSteps(status);
  const severity = NCR_SEVERITY_META[ncr.severity as NcrSeverity];
  const pending = actions.find((a) => a.decision === null) ?? null;
  const accepted = actions.find((a) => a.decision === "accepted") ?? null;

  const userNames = await loadUserNames([
    ncr.raised_by,
    ...(ncr.responsible_user_id ? [ncr.responsible_user_id] : []),
    ...(ncr.verified_by ? [ncr.verified_by] : []),
    ...actions.flatMap((a) =>
      [a.proposed_by, a.assigned_to, a.decided_by].filter((u): u is string => Boolean(u)),
    ),
  ]);

  const members = steps.canPropose || status === "open" ? await listMembers(ctx.org.id) : [];

  const errorMessage = sp.error ? (ERROR_MAP[sp.error] ?? decodeURIComponent(sp.error)) : null;
  const savedMessage = sp.saved ? (SAVED_MAP[sp.saved] ?? null) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
        <Link href="/quality" className="hover:text-slate-900">
          Works quality
        </Link>
        <span aria-hidden>/</span>
        <Link href="/quality/ncrs" className="hover:text-slate-900">
          Non-conformance
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{ncr.reference}</span>
      </nav>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium text-slate-600">{ncr.reference}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${NCR_STATUS_META[status].tone}`}>
            {NCR_STATUS_META[status].label}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${severity.tone}`}>
            {severity.label}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">{ncr.title}</h1>
        {item && plan ? (
          <p className="text-sm text-slate-600">
            Against item {item.item_number} — {item.title} on{" "}
            <Link href={`/quality/${plan.id}`} className="text-slate-800 underline">
              {plan.reference ?? "the plan"} · {plan.work_package}
            </Link>
          </p>
        ) : null}
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

      {/* ── What does not conform ─────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Non-conformance</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{ncr.description}</p>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Meta label="Raised by">{userNames.get(ncr.raised_by) ?? "Member"}</Meta>
          <Meta label="Raised">{new Date(ncr.created_at).toLocaleString("en-GB")}</Meta>
          <Meta label="Responsible">
            {[
              ncr.responsible_user_id ? (userNames.get(ncr.responsible_user_id) ?? "Member") : null,
              ncr.responsible_subcontractor,
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </Meta>
          <Meta label="Corrective action due">{ncr.due_date ?? "—"}</Meta>
          {sourceSignoff ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Source sign-off
              </dt>
              <dd className="mt-0.5 text-slate-700">
                Failed by {sourceSignoff.signed_name} on {sourceSignoff.inspected_at}
                {sourceSignoff.comments ? ` — ${sourceSignoff.comments}` : ""}
                {sourceSignoff.voided_at ? " (since voided and re-inspected)" : ""}
              </dd>
            </div>
          ) : null}
          {ncr.status === "closed" ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Closure verification
              </dt>
              <dd className="mt-0.5 text-slate-700">
                Verified by {ncr.verified_by ? (userNames.get(ncr.verified_by) ?? "a member") : "a member"}
                {ncr.verified_at ? ` on ${new Date(ncr.verified_at).toLocaleString("en-GB")}` : ""}
                {ncr.closure_comment ? ` — ${ncr.closure_comment}` : ""}
              </dd>
            </div>
          ) : null}
        </dl>

        {/* Evidence: photos of the nonconformity, the rework, the re-test. */}
        <div className="mt-4">
          <AttachmentsPanel targetTable="non_conformance_reports" targetId={ncr.id} />
        </div>
      </section>

      {/* ── Corrective actions ─────────────────────────────────────────────── */}
      <section aria-labelledby="ncr-actions-heading" className="space-y-3">
        <h2 id="ncr-actions-heading" className="text-base font-semibold text-slate-900">
          Corrective actions
        </h2>
        <p className="text-xs text-slate-500">
          Each proposal is its own record: the review decision is written once,
          and a rejected proposal is replaced with a new one, never edited. The
          NCR&rsquo;s status follows this record — the database moves it.
        </p>

        {actions.length === 0 ? (
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            No corrective action proposed yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {actions.map((a) => (
              <li key={a.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      a.decision === "accepted"
                        ? "bg-emerald-100 text-emerald-800"
                        : a.decision === "rejected"
                          ? "bg-red-100 text-red-800"
                          : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {a.decision === "accepted"
                      ? a.completed_at
                        ? "Accepted · completed"
                        : "Accepted"
                      : a.decision === "rejected"
                        ? "Rejected"
                        : "Awaiting review"}
                  </span>
                  <span className="text-xs text-slate-500">
                    Proposed {new Date(a.proposed_at).toLocaleString("en-GB")}
                    {a.proposed_by ? ` by ${userNames.get(a.proposed_by) ?? "a member"}` : ""}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{a.description}</p>
                <dl className="mt-2 space-y-1 text-xs text-slate-600">
                  {a.assigned_to ? (
                    <div>
                      <dt className="sr-only">Assigned</dt>
                      <dd>Assigned to {userNames.get(a.assigned_to) ?? "a member"}</dd>
                    </div>
                  ) : null}
                  {a.due_date ? (
                    <div>
                      <dt className="sr-only">Due</dt>
                      <dd>Due {a.due_date}</dd>
                    </div>
                  ) : null}
                  {a.decision ? (
                    <div>
                      <dt className="sr-only">Decision</dt>
                      <dd>
                        {a.decision === "accepted" ? "Accepted" : "Rejected"}
                        {a.decided_at ? ` ${new Date(a.decided_at).toLocaleString("en-GB")}` : ""}
                        {a.decided_by ? ` by ${userNames.get(a.decided_by) ?? "a member"}` : ""}
                        {a.decision_reason ? ` — ${a.decision_reason}` : ""}
                      </dd>
                    </div>
                  ) : null}
                  {a.completed_at ? (
                    <div>
                      <dt className="sr-only">Completed</dt>
                      <dd>
                        Completed {new Date(a.completed_at).toLocaleString("en-GB")}
                        {a.completion_comment ? ` — ${a.completion_comment}` : ""}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {/* Review a pending proposal (owner/admin — the DB enforces it). */}
                {steps.canDecide && a.decision === null ? (
                  <div className="mt-3 space-y-3">
                    <form action={decideCorrectiveAction} className="space-y-2">
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="ncrId" value={ncr.id} />
                      <input type="hidden" name="decision" value="accepted" />
                      <button
                        type="submit"
                        className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
                      >
                        Accept corrective action
                      </button>
                    </form>
                    <details>
                      <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-red-700 hover:text-red-900">
                        Reject this proposal
                      </summary>
                      <form action={decideCorrectiveAction} className="mt-2 space-y-2">
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="ncrId" value={ncr.id} />
                        <input type="hidden" name="decision" value="rejected" />
                        <label htmlFor={`reject-${a.id}`} className={labelClass}>
                          Why is it rejected?<span className="ml-0.5 text-red-500">*</span>
                        </label>
                        <input
                          id={`reject-${a.id}`}
                          name="decisionReason"
                          type="text"
                          required
                          maxLength={2000}
                          placeholder="Doesn't address the root cause — repair spec needed"
                          className={inputClass}
                        />
                        <button
                          type="submit"
                          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 sm:w-auto"
                        >
                          Reject proposal
                        </button>
                      </form>
                    </details>
                  </div>
                ) : null}

                {/* Record completion of the accepted action. */}
                {steps.canComplete && a.decision === "accepted" && !a.completed_at ? (
                  <form action={completeCorrectiveAction} className="mt-3 space-y-2">
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="ncrId" value={ncr.id} />
                    <label htmlFor={`complete-${a.id}`} className={labelClass}>
                      What was done<span className="ml-0.5 text-red-500">*</span>
                    </label>
                    <textarea
                      id={`complete-${a.id}`}
                      name="completionComment"
                      required
                      rows={2}
                      maxLength={4000}
                      placeholder="Run re-laid to 1:80, re-tested to BS EN 1610."
                      className={inputClass}
                    />
                    <button
                      type="submit"
                      className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
                    >
                      Record completion
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* Propose a corrective action (only meaningful while OPEN). */}
        {steps.canPropose && !pending ? (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <h3 className="text-sm font-semibold text-slate-900">Propose a corrective action</h3>
            <form action={proposeCorrectiveAction} className="mt-3 space-y-4">
              <input type="hidden" name="ncrId" value={ncr.id} />
              <div>
                <label htmlFor="actionDescription" className={labelClass}>
                  The fix<span className="ml-0.5 text-red-500">*</span>
                </label>
                <textarea
                  id="actionDescription"
                  name="description"
                  required
                  rows={3}
                  maxLength={4000}
                  placeholder="What will be done to bring the works back to specification."
                  className={inputClass}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="assignedTo" className={labelClass}>
                    Assigned to
                  </label>
                  <select id="assignedTo" name="assignedTo" defaultValue="" className={inputClass}>
                    <option value="">Not assigned yet</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="actionDueDate" className={labelClass}>
                    Due
                  </label>
                  <input id="actionDueDate" name="dueDate" type="date" className={inputClass} />
                </div>
              </div>
              <button
                type="submit"
                className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
              >
                Propose action
              </button>
            </form>
          </div>
        ) : null}
      </section>

      {/* ── Close (verification) ───────────────────────────────────────────── */}
      {steps.canClose && accepted?.completed_at ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Verify and close</h2>
          <p className="mt-1 text-sm text-slate-600">
            You are attesting, as yourself, that the corrective works were
            checked and now conform. The verification is recorded on the NCR
            and cannot be edited afterwards.
          </p>
          <form action={closeNcr} className="mt-3 space-y-2">
            <input type="hidden" name="id" value={ncr.id} />
            <label htmlFor="closureComment" className={labelClass}>
              What was verified<span className="ml-0.5 text-red-500">*</span>
            </label>
            <textarea
              id="closureComment"
              name="closureComment"
              required
              rows={2}
              maxLength={4000}
              placeholder="Re-inspected against the acceptance criteria; falls now 1:78–1:82."
              className={inputClass}
            />
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
            >
              Close NCR
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Edit while open ────────────────────────────────────────────────── */}
      {status === "open" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Edit NCR</h2>
          <p className="mt-1 text-xs text-slate-500">
            Editable while open. Once a corrective action is proposed the NCR is
            frozen and the corrective-action record carries what changed.
          </p>
          <form action={updateNcr} className="mt-3 space-y-4">
            <input type="hidden" name="id" value={ncr.id} />
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
                defaultValue={ncr.title}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="edit-description" className={labelClass}>
                Description<span className="ml-0.5 text-red-500">*</span>
              </label>
              <textarea
                id="edit-description"
                name="description"
                required
                rows={4}
                maxLength={20000}
                defaultValue={ncr.description}
                className={inputClass}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-severity" className={labelClass}>
                  Severity<span className="ml-0.5 text-red-500">*</span>
                </label>
                <select
                  id="edit-severity"
                  name="severity"
                  required
                  defaultValue={ncr.severity}
                  className={inputClass}
                >
                  {NCR_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {NCR_SEVERITY_META[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="edit-dueDate" className={labelClass}>
                  Corrective action due
                </label>
                <input
                  id="edit-dueDate"
                  name="dueDate"
                  type="date"
                  defaultValue={ncr.due_date ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-responsibleUserId" className={labelClass}>
                  Responsible member
                </label>
                <select
                  id="edit-responsibleUserId"
                  name="responsibleUserId"
                  defaultValue={ncr.responsible_user_id ?? ""}
                  className={inputClass}
                >
                  <option value="">Not one of the team</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="edit-responsibleSubcontractor" className={labelClass}>
                  Responsible subcontractor
                </label>
                <input
                  id="edit-responsibleSubcontractor"
                  name="responsibleSubcontractor"
                  type="text"
                  maxLength={200}
                  defaultValue={ncr.responsible_subcontractor ?? ""}
                  className={inputClass}
                />
              </div>
            </div>
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 sm:w-auto"
            >
              Save NCR
            </button>
          </form>
        </section>
      ) : null}

      {/* ── Cancel ─────────────────────────────────────────────────────────── */}
      {steps.canCancel && status !== "closed" ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">Cancel</h2>
          <p className="mt-1 text-sm text-slate-600">
            Cancelling keeps the record (an NCR is never deleted) and marks it
            as raised in error or overtaken by events. Before an approved fix
            the raiser or an admin may cancel; after, admins only.
          </p>
          <form action={cancelNcr} className="mt-3">
            <input type="hidden" name="id" value={ncr.id} />
            <button
              type="submit"
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-red-300 bg-white px-3 text-sm font-medium text-red-700 hover:bg-red-50 sm:w-auto"
            >
              Cancel NCR
            </button>
          </form>
        </section>
      ) : null}
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

import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { buildRotaPlan } from "@/server/services/schedule-integrity";
import { SCHEDULE_WINDOW_DAYS } from "@/lib/schedule/window";
import {
  SOLVER_CRITERIA,
  SOLVER_NO_SKILLS_NOTE,
  type RotaAssignment,
  type SolverFactor,
  type UnfilledJob,
} from "@/lib/schedule/solver";
import { formatConflictDay } from "@/lib/schedule/conflicts";

/**
 * Generate rota — the DETERMINISTIC optimising scheduler's surface.
 *
 * Takes every job in the window that currently has nobody effectively on it and
 * proposes one person per job, chosen by a constraint solver over the org's own
 * records — rota entries, approved leave, job assignments and job locations. No
 * AI, no guesswork: the score beside each name is exactly the sum of the lines
 * under it, so nothing influences the choice that a manager cannot read.
 *
 * STRICTLY READ-ONLY. There is no form, no server action and no mutation on this
 * page. Each proposal renders as a sentence, the records behind it, and a LINK
 * that opens the existing assign-shift form with the fields filled in — the shift
 * exists only once a human presses Assign there, by `createRotaEntry`, under its
 * own admin gate. Nothing on this page moves anybody.
 */

export const metadata = {
  title: "Generate rota · CrewFlow",
};

/** "+40" / "−10" / "0" — the sign is part of the claim, so it is never dropped. */
function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function whenLabel(daysAway: number): string {
  if (daysAway <= 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  return `In ${daysAway} days`;
}

function Evidence({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <code
          key={id}
          title={id}
          className="rounded bg-slate-100 px-1 py-px font-mono text-[10px] text-slate-500"
        >
          {id.slice(0, 8)}
        </code>
      ))}
    </span>
  );
}

function FactorLine({ factor }: { factor: SolverFactor }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-[11px] text-slate-600">
      <span
        className={`shrink-0 font-mono ${
          factor.delta > 0
            ? "text-emerald-700"
            : factor.delta < 0
              ? "text-rose-700"
              : "text-slate-400"
        }`}
      >
        {signed(factor.delta)}
      </span>
      <span className="min-w-0">
        {factor.text}
        <Evidence ids={factor.evidence} />
      </span>
    </li>
  );
}

function AssignmentCard({ assignment }: { assignment: RotaAssignment }) {
  const { need } = assignment;
  return (
    <li className="overflow-hidden rounded-lg border border-l-4 border-slate-200 border-l-emerald-500 bg-white shadow-sm">
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {whenLabel(need.daysAway)}
            </span>
            {need.district ? (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                {need.district}
              </span>
            ) : null}
            {need.reason === "assignment_off_rota" ? (
              <span className="inline-flex items-center rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-800">
                Named, off rota
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-800">
                Unassigned
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            {need.jobLabel} · {formatConflictDay(need.day)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-900">
              Propose {assignment.userName}
            </span>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              {assignment.role}
            </span>
            <span className="font-mono text-[10px] text-slate-400">score {assignment.score}</span>
            <span className="text-[10px] text-slate-400">
              chosen from {assignment.candidateCount}{" "}
              {assignment.candidateCount === 1 ? "free person" : "free people"}
            </span>
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {assignment.factors.map((f) => (
              <FactorLine key={`${f.code}-${f.text}`} factor={f} />
            ))}
          </ul>
        </div>
        <Link
          href={assignment.applyHref}
          className="inline-flex min-h-[36px] shrink-0 items-center justify-center rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          Fill in on the rota
        </Link>
      </div>
    </li>
  );
}

function UnfilledCard({ job }: { job: UnfilledJob }) {
  const { need } = job;
  return (
    <li className="overflow-hidden rounded-lg border border-l-4 border-slate-200 border-l-amber-500 bg-white shadow-sm">
      <div className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {whenLabel(need.daysAway)}
          </span>
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">
            Nobody free
          </span>
        </div>
        <p className="mt-1 text-sm font-semibold text-slate-900">
          {need.jobLabel} · {formatConflictDay(need.day)}
        </p>
        <p className="mt-1 text-xs text-slate-600">{job.reason}</p>
      </div>
    </li>
  );
}

export default async function GenerateRotaPage() {
  const { ctx } = await requireOrgContext();
  const { plan, window } = await buildRotaPlan(ctx.org.id);
  const { assignments, unfilled, summary, insufficient, notes } = plan;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Generate rota</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            A proposed rota for the jobs in the next {SCHEDULE_WINDOW_DAYS} days (
            {formatConflictDay(window.fromDay)} – {formatConflictDay(window.toDay)}) that have
            nobody on them yet. Every proposal is worked out from your own records — no AI, no
            guesswork — and <strong>nothing here is saved</strong>: each line fills in the rota
            form for you to check and confirm.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/staff/rota/conflicts"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Schedule check
          </Link>
          <Link
            href="/staff/rota"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Back to rota
          </Link>
        </div>
      </header>

      {insufficient ? (
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
          <span aria-hidden className="text-slate-400">
            ℹ
          </span>
          {insufficient}
        </div>
      ) : (
        <>
          <section
            aria-label="Plan summary"
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <h2 className="text-sm font-semibold text-slate-900">
              {summary.assigned} of {summary.needs}{" "}
              {summary.needs === 1 ? "job" : "jobs"} can be staffed
              {summary.assigned > 0 ? (
                <>
                  {" "}
                  across {summary.peopleUsed}{" "}
                  {summary.peopleUsed === 1 ? "person" : "people"}
                </>
              ) : null}
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              Proposals are worked out from your rota entries, approved leave, job assignments and
              job locations. Every proposal shows its full working, and the score beside it is
              exactly the sum of the lines under it, so nothing influences the order that you
              cannot see.
              {summary.unfilled > 0 ? (
                <>
                  {" "}
                  For{" "}
                  <strong>
                    {summary.unfilled} {summary.unfilled === 1 ? "job" : "jobs"}
                  </strong>{" "}
                  there is genuinely nobody free; that is said plainly below rather than filled with
                  a name that would not work.
                </>
              ) : null}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-700 underline">
                What the ranking takes into account
              </summary>
              <ul className="mt-2 space-y-1">
                {SOLVER_CRITERIA.map((criterion) => (
                  <li key={criterion.label} className="text-[11px] text-slate-600">
                    <strong className="text-slate-800">{criterion.label}</strong> —{" "}
                    {criterion.detail}
                  </li>
                ))}
              </ul>
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
                {SOLVER_NO_SKILLS_NOTE}
              </p>
            </details>
          </section>

          {assignments.length > 0 ? (
            <section aria-label="Proposed assignments" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Proposed assignments
              </h2>
              <ul className="space-y-2">
                {assignments.map((a) => (
                  <AssignmentCard key={a.jobId} assignment={a} />
                ))}
              </ul>
            </section>
          ) : null}

          {unfilled.length > 0 ? (
            <section aria-label="Jobs nobody is free for" className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Nobody free ({unfilled.length})
              </h2>
              <ul className="space-y-2">
                {unfilled.map((j) => (
                  <UnfilledCard key={j.need.jobId} job={j} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {notes.length > 0 ? (
        <div className="space-y-1">
          {notes.map((note) => (
            <p key={note} className="text-[11px] italic leading-relaxed text-slate-500">
              {note}
            </p>
          ))}
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-slate-500">
        This scheduler is deterministic: given the same rota, leave and jobs it always proposes
        the same plan. It fills the most constrained jobs first, never places a person on two
        overlapping shifts (including within this plan), and spreads work across the crew rather
        than piling it on the freest person. It answers who is free and who is nearest — never who
        is best — because CrewFlow stores no skills or certifications against a person.
      </p>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Proposals are never actions: <strong>nothing on this page moves anybody</strong>. “Fill in
        on the rota” opens the assign-shift form with the details filled in, and the shift exists
        only once you press Assign there — where the usual checks and permissions still apply.
        Times are shown in UK local time here; the rota form and grid work in UTC clock time, so
        during British Summer Time they read one hour earlier there.
      </p>
    </div>
  );
}

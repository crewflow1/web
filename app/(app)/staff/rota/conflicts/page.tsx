import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { buildScheduleIntegrity } from "@/server/services/schedule-integrity";
import {
  SCHEDULE_CONFLICT_KINDS,
  SCHEDULE_CONFLICT_META,
  formatConflictDay,
  groupConflictsByDay,
  type ScheduleConflict,
} from "@/lib/schedule/conflicts";
import { SCHEDULE_WINDOW_DAYS } from "@/lib/schedule/window";
import {
  NO_SKILLS_MODEL_NOTE,
  RECOMMENDATION_CRITERIA,
  type CandidateFactor,
  type RecommendationCandidate,
  type ScheduleRecommendation,
} from "@/lib/schedule/recommendations";
import type { BriefingSeverity } from "@/lib/briefing/types";

/**
 * Schedule check — the conflict detector, and what to do about each finding.
 *
 * Sits under the rota because `rota_entries` is the canonical record of who is
 * working when; everything here is a disagreement between that record and some
 * other scheduling fact (a second shift, approved leave, a job's assignee, an
 * asset's custody).
 *
 * STRICTLY READ-ONLY, INCLUDING THE RECOMMENDATIONS. There is no form, no
 * server action and no mutation on this page. A recommendation renders as a
 * sentence, the records behind it, and a LINK that opens the existing
 * assign-shift form with the fields filled in — the shift is written only when
 * a human presses Assign there, by `createRotaEntry`, under its own admin gate.
 * Nothing on this page moves anybody.
 *
 * Every option shows its whole reasoning: the score is the sum of the displayed
 * factors, so there is no hidden term. Where nobody is free, the panel says so
 * and stops — it never pads the list to look useful.
 */

export const metadata = {
  title: "Schedule check · CrewFlow",
};

const SEVERITY: Record<BriefingSeverity, { chip: string; accent: string; label: string }> = {
  critical: { chip: "bg-red-100 text-red-800 ring-red-200", accent: "border-l-red-500", label: "Critical" },
  high: { chip: "bg-amber-100 text-amber-900 ring-amber-200", accent: "border-l-amber-500", label: "High" },
  medium: { chip: "bg-sky-100 text-sky-800 ring-sky-200", accent: "border-l-sky-400", label: "Attention" },
  low: { chip: "bg-slate-100 text-slate-700 ring-slate-200", accent: "border-l-slate-300", label: "Note" },
};

function whenLabel(c: ScheduleConflict): string {
  if (c.daysAway <= 0) return "Today";
  if (c.daysAway === 1) return "Tomorrow";
  return `In ${c.daysAway} days`;
}

/** "+40" / "−10" / "0" — the sign is part of the claim, so it is never dropped. */
function signed(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * The row ids behind a claim, shown short with the full value on hover.
 *
 * A positive claim cites records; an ABSENCE claim ("no approved leave") cites
 * none, because there is no row to point at — the clause names the window it
 * searched instead. Rendering nothing there is the honest output, not a gap.
 */
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

function FactorLine({ factor }: { factor: CandidateFactor }) {
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

function CandidateCard({ candidate }: { candidate: RecommendationCandidate }) {
  const isMove = candidate.kind === "move_day";
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-900">
              {candidate.userName}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isMove ? "bg-indigo-100 text-indigo-800" : "bg-emerald-100 text-emerald-800"
              }`}
            >
              {isMove ? "Move the day" : "Cover the slot"}
            </span>
            <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              {candidate.role}
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              score {candidate.score}
            </span>
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {candidate.factors.map((f) => (
              <FactorLine key={`${f.code}-${f.text}`} factor={f} />
            ))}
          </ul>
        </div>
        <Link
          href={candidate.applyHref}
          className="inline-flex min-h-[36px] shrink-0 items-center justify-center rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          Fill in on the rota
        </Link>
      </div>
    </li>
  );
}

/**
 * One conflict's resolutions.
 *
 * Collapsed by default: a manager scans findings first and opens the one they
 * are working on. The summary line always states the honest headline — how many
 * options, or that there are none — so nothing is hidden behind the disclosure.
 */
function RecommendationPanel({ rec }: { rec: ScheduleRecommendation }) {
  const n = rec.candidates.length;
  const headline =
    n === 0
      ? "How to fix this — nobody is free"
      : `How to fix this — ${n} option${n === 1 ? "" : "s"}`;

  return (
    <details className="border-t border-slate-200 bg-slate-50/70 px-3 py-2">
      <summary className="cursor-pointer list-none text-xs font-semibold text-slate-700 marker:content-none">
        <span className="inline-flex min-h-[32px] items-center gap-1">
          <span aria-hidden>▸</span>
          {headline}
        </span>
      </summary>

      <p className="mt-1 text-[11px] text-slate-600">{rec.need.summary}</p>

      {n > 0 ? (
        <ul className="mt-2 space-y-2">
          {rec.candidates.map((c) => (
            <CandidateCard key={`${c.kind}-${c.userId}-${c.startIso}`} candidate={c} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {rec.impossible}
        </p>
      )}

      {rec.notes.map((note) => (
        <p key={note} className="mt-2 text-[11px] italic text-slate-500">
          {note}
        </p>
      ))}

      {rec.ruledOut.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-slate-500 underline">
            Why the other {rec.ruledOutTotal === 1 ? "person" : `${rec.ruledOutTotal} people`}{" "}
            {rec.ruledOutTotal === 1 ? "was" : "were"} not offered
          </summary>
          <ul className="mt-1 space-y-0.5">
            {rec.ruledOut.map((r) => (
              <li key={`${r.userId}-${r.code}`} className="text-[11px] text-slate-500">
                {r.text}
                <Evidence ids={r.evidence} />
              </li>
            ))}
          </ul>
          {rec.ruledOut.length < rec.ruledOutTotal ? (
            <p className="mt-1 text-[11px] text-slate-400">
              …and {rec.ruledOutTotal - rec.ruledOut.length} more.
            </p>
          ) : null}
        </details>
      ) : null}
    </details>
  );
}

export default async function ScheduleConflictsPage() {
  const { ctx } = await requireOrgContext();
  const report = await buildScheduleIntegrity(ctx.org.id);
  const { conflicts, total, summary, window, recommendations, recommendationSummary } = report;
  const days = groupConflictsByDay(conflicts);
  const shown = conflicts.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Schedule check</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Conflicts found in your rota, jobs, approved leave and plant custody for the next{" "}
            {SCHEDULE_WINDOW_DAYS} days ({formatConflictDay(window.fromDay)} –{" "}
            {formatConflictDay(window.toDay)}). Nothing here is changed for you — each line
            explains what disagrees, shows who could take it and why, and fills in the rota
            form for you to check and confirm.
          </p>
        </div>
        <Link
          href="/staff/rota"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back to rota
        </Link>
      </header>

      <section
        aria-label="What is checked"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 className="text-sm font-semibold text-slate-900">
          {total === 0
            ? "No conflicts found"
            : `${total} ${total === 1 ? "conflict" : "conflicts"} found`}
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SCHEDULE_CONFLICT_KINDS.map((kind) => {
            const meta = SCHEDULE_CONFLICT_META[kind];
            const roll = summary.byKind[kind];
            return (
              <li
                key={kind}
                className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <span
                  className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.tone}`}
                >
                  {meta.label}
                </span>
                <span className="min-w-0 text-[11px] text-slate-600">
                  <strong className="text-slate-900">
                    {roll.count === 0 ? "None" : roll.count}
                  </strong>{" "}
                  · {meta.blurb}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {recommendationSummary.withRecommendations > 0 ? (
        <section
          aria-label="How options are worked out"
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-slate-900">
            {recommendationSummary.withCandidates} of{" "}
            {recommendationSummary.withRecommendations} have an option you can act on
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Options are worked out from your own records — rota entries, approved leave and
            job assignments — with no guesswork and no AI. Every option shows its full
            working, and the score beside it is exactly the sum of the lines under it, so
            nothing influences the order that you cannot see.
            {recommendationSummary.withNobodyFree > 0 ? (
              <>
                {" "}
                For{" "}
                <strong>
                  {recommendationSummary.withNobodyFree}{" "}
                  {recommendationSummary.withNobodyFree === 1 ? "conflict" : "conflicts"}
                </strong>{" "}
                there is genuinely nobody free; that is said plainly rather than filled with
                a name that would not work.
              </>
            ) : null}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-slate-700 underline">
              What the ranking takes into account
            </summary>
            <ul className="mt-2 space-y-1">
              {RECOMMENDATION_CRITERIA.map((criterion) => (
                <li key={criterion.label} className="text-[11px] text-slate-600">
                  <strong className="text-slate-800">{criterion.label}</strong> —{" "}
                  {criterion.detail}
                </li>
              ))}
            </ul>
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
              {NO_SKILLS_MODEL_NOTE}
            </p>
          </details>
        </section>
      ) : null}

      {conflicts.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
          <span aria-hidden className="text-emerald-500">
            ✓
          </span>
          Nothing clashes in the next {SCHEDULE_WINDOW_DAYS} days. Conflicts beyond that window
          appear here as the dates come closer.
        </div>
      ) : (
        <div className="space-y-5">
          {shown < total ? (
            <p className="text-xs text-slate-500">
              Showing the {shown} most urgent of {total}.
            </p>
          ) : null}
          {days.map((group) => (
            <section key={group.day} aria-label={formatConflictDay(group.day)}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {formatConflictDay(group.day)}
              </h2>
              <ul className="mt-2 space-y-2">
                {group.conflicts.map((c) => {
                  const sev = SEVERITY[c.severity];
                  const meta = SCHEDULE_CONFLICT_META[c.kind];
                  const rec = recommendations.get(c.key);
                  return (
                    <li
                      key={c.key}
                      className={`overflow-hidden rounded-lg border border-l-4 border-slate-200 bg-white shadow-sm ${sev.accent}`}
                    >
                      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${sev.chip}`}
                            >
                              {sev.label}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.tone}`}
                            >
                              {meta.label}
                            </span>
                            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                              {whenLabel(c)}
                            </span>
                          </div>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{c.title}</p>
                          <p className="mt-0.5 text-sm text-slate-600">{c.detail}</p>
                        </div>
                        <div className="shrink-0">
                          <Link
                            href={c.href}
                            className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Open
                          </Link>
                        </div>
                      </div>
                      {rec ? (
                        <RecommendationPanel rec={rec} />
                      ) : (
                        // An ABSENT key is not "we found nobody" — it is a class
                        // with no staffing question in it. Saying so is more use
                        // than an empty options panel would be.
                        <p className="border-t border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] text-slate-500">
                          No staffing options here — this is a record to correct, not a
                          gap to fill.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        Detection is deterministic: it compares stored times only, treats a shift ending exactly
        when another begins as a handover rather than a clash, and uses UK calendar days
        (so British Summer Time is handled). It reports what it can see and nothing more —
        an empty list means no conflict was detected, not a guarantee that the week is fine.
      </p>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Options are proposals, never actions: <strong>nothing on this page moves anybody</strong>.
        &ldquo;Fill in on the rota&rdquo; opens the assign-shift form with the details filled in,
        and the shift exists only once you press Assign there — where the usual checks and
        permissions still apply. Times are shown in UK local time here; the rota form and grid
        work in UTC clock time, so during British Summer Time they read one hour earlier there.
      </p>
    </div>
  );
}

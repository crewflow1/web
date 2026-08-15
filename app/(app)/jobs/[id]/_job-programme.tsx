import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { StateForm } from "@/components/forms/StateForm";
import { Field } from "@/components/forms/Field";
import { formatDateShortUK } from "@/lib/time/format";
import { readWeight, WEIGHT_SUM_TOLERANCE } from "@/lib/job-programme/planned";
import { setJobProgramme } from "./programme-actions";
import { setMilestoneDependencies } from "./dependency-actions";
import { computeCriticalPath, type CpmNode } from "@/lib/jobs/critical-path";

/**
 * Job Programme panel — the planned window, its milestones, and the way to
 * (re-)baseline. The _job-quality.tsx idioms throughout: the panel owns its
 * ACTIVE-org-pinned reads, reads loudly, and renders an explicit error block
 * rather than a quiet nothing.
 *
 * WHAT THIS PANEL DELIBERATELY DOES NOT DO
 * ----------------------------------------
 *   - NO variance verdict. It shows the plan; the progress panel above shows
 *     what happened. "3 weeks behind programme" is a sentence with commercial
 *     consequences, and nothing here computes it.
 *   - NO automatic re-baseline. When a variation's agreed extension of time
 *     (quotes.eot_agreed_completion_date, 20261073) postdates the baselined
 *     completion, the panel SUGGESTS a re-baseline and pre-fills the note —
 *     the plan moves only when an admin presses the button. An automatic move
 *     would defeat the entire write-once design: the note exists to record a
 *     human's reason, and a machine has none.
 *   - NO milestone editing. A revision's milestones are frozen at the
 *     database; the form always records a WHOLE new revision.
 *
 * The admin gate here is presentational (hide the form from staff); the REAL
 * gate is the database's admin-only RLS on insert plus the SECURITY INVOKER
 * RPC — a hidden form is not a security boundary and is not treated as one.
 */

/** Form rows offered per revision. Mirrors FORM_ROWS in programme-actions.ts. */
const MILESTONE_FORM_ROWS = 6;

type BaselineRow = {
  id: string;
  revision: number;
  planned_start: string;
  planned_end: string;
  note: string | null;
  created_at: string;
};

type MilestoneRow = {
  id: string;
  title: string;
  planned_start: string | null;
  planned_end: string;
  weight: number | string | null;
  customer_visible: boolean;
  sort: number;
};

type DependencyRow = {
  milestone_id: string;
  depends_on_milestone_id: string;
};

export async function JobProgrammeSection({ jobId }: { jobId: string }) {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";
  const supabase = await createClient();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tbl = (c: unknown) => (c as { from: (t: string) => any }).from.bind(c);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const [baselineRes, eotRes] = await Promise.all([
    tbl(supabase)("job_programme_baselines")
      .select("id, revision, planned_start, planned_end, note, created_at")
      .eq("org_id", ctx.org.id)
      .eq("job_id", jobId)
      .is("superseded_at", null)
      .maybeSingle(),
    // Agreed extensions of time on this job's variations (20261073). Only the
    // agreed date is read — never the commercial figures riding on the quote.
    tbl(supabase)("quotes")
      .select("eot_agreed_completion_date")
      .eq("org_id", ctx.org.id)
      .eq("job_id", jobId)
      .not("eot_agreed_completion_date", "is", null)
      .limit(100),
  ]);

  if (baselineRes.error || eotRes.error) {
    reportReadFailure(
      "job hub: programme",
      (baselineRes.error ?? eotRes.error) as SupabaseReadError,
    );
    return (
      <section
        id="programme"
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-red-800">Programme</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load this job&apos;s programme. This panel is NOT saying
          there is none — refresh to try again.
        </p>
      </section>
    );
  }

  const baseline = (baselineRes.data ?? null) as BaselineRow | null;

  let milestones: MilestoneRow[] = [];
  if (baseline) {
    const msRes = await tbl(supabase)("job_milestones")
      .select("id, title, planned_start, planned_end, weight, customer_visible, sort")
      .eq("org_id", ctx.org.id)
      .eq("baseline_id", baseline.id)
      .order("sort", { ascending: true });
    if (msRes.error) {
      reportReadFailure("job hub: programme milestones", msRes.error as SupabaseReadError);
      return (
        <section
          id="programme"
          className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
        >
          <h2 className="text-base font-semibold text-red-800">Programme</h2>
          <p className="mt-1 text-sm text-red-700">
            Couldn&apos;t load the programme milestones. Refresh to try again.
          </p>
        </section>
      );
    }
    milestones = (msRes.data ?? []) as MilestoneRow[];
  }

  // Dependency edges for this baseline + the derived critical path. Best-effort:
  // a read failure degrades to "no dependencies" (the milestones still render),
  // never a broken panel — the edges are an enhancement over the flat list.
  let dependencies: DependencyRow[] = [];
  if (baseline && milestones.length > 0) {
    const depRes = await tbl(supabase)("job_milestone_dependencies")
      .select("milestone_id, depends_on_milestone_id")
      .eq("org_id", ctx.org.id)
      .eq("baseline_id", baseline.id);
    if (!depRes.error) {
      dependencies = (depRes.data ?? []) as DependencyRow[];
    }
  }

  const cpm = computeCriticalPath(
    milestones.map((m) => ({
      id: m.id,
      planned_start: m.planned_start,
      planned_end: m.planned_end,
      sort: m.sort,
    })),
    dependencies,
  );
  const cpmById = new Map<string, CpmNode>(cpm.nodes.map((n) => [n.id, n]));
  const titleById = new Map<string, string>(milestones.map((m) => [m.id, m.title]));
  const hasDeps = dependencies.length > 0;

  // Weight status, computed with the SAME reader the planned line uses so the
  // sentence below and the chart above can never disagree.
  const weights = milestones.map((m) => readWeight(m.weight));
  const fullyWeighted =
    milestones.length > 0 &&
    weights.every((w) => w !== null) &&
    Math.abs(weights.reduce<number>((s, w) => s + (w ?? 0), 0) - 100) <=
      WEIGHT_SUM_TOLERANCE;

  // The EoT affordance: the LATEST agreed completion date across this job's
  // variations, compared with the baselined completion. Suggests; never acts.
  const eotDates = ((eotRes.data ?? []) as Array<{ eot_agreed_completion_date: string | null }>)
    .map((r) => r.eot_agreed_completion_date)
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const latestEot = eotDates.length > 0 ? eotDates[eotDates.length - 1]! : null;
  const rebaselineSuggested = Boolean(
    baseline && latestEot && latestEot > baseline.planned_end,
  );
  const suggestedNote =
    rebaselineSuggested && latestEot
      ? `Extension of time agreed to ${latestEot} on an accepted variation`
      : "";

  return (
    <section
      id="programme"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Programme</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            The baselined plan this job is measured against. Revisions supersede
            — they never overwrite.
          </p>
        </div>
        {baseline ? (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
            Baseline revision {baseline.revision}
          </span>
        ) : null}
      </div>

      {baseline ? (
        <>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-sm font-semibold text-slate-900">
              {formatDateShortUK(baseline.planned_start)} →{" "}
              {formatDateShortUK(baseline.planned_end)}
            </span>
            <span className="text-xs text-slate-500">
              {fullyWeighted
                ? "Fully weighted — the planned line is drawn on the progress chart."
                : "Not fully weighted — no planned line is drawn (weights must all be set and sum to 100)."}
            </span>
          </div>
          {baseline.note ? (
            <p className="mt-1 text-xs text-slate-600">
              Reason for revision {baseline.revision}: {baseline.note}
            </p>
          ) : null}

          {rebaselineSuggested && latestEot ? (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <span className="font-semibold">Re-baseline suggested.</span> An
              extension of time to {formatDateShortUK(latestEot)} has been
              agreed on a variation — after the baselined completion of{" "}
              {formatDateShortUK(baseline.planned_end)}. Nothing moves
              automatically: re-baselining below records a new revision with
              your note.
            </p>
          ) : null}

          {milestones.length > 0 ? (
            <>
              {hasDeps && !cpm.cyclic ? (
                <p className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-900">
                  <span className="font-semibold">Critical path.</span>{" "}
                  {cpm.criticalPath.length > 0
                    ? cpm.criticalPath
                        .map((id) => titleById.get(id) ?? "—")
                        .join(" → ")
                    : "No milestones are on the critical path yet."}{" "}
                  <span className="text-indigo-700">
                    ({cpm.projectDurationDays} day
                    {cpm.projectDurationDays === 1 ? "" : "s"} across{" "}
                    {dependencies.length} link
                    {dependencies.length === 1 ? "" : "s"})
                  </span>
                </p>
              ) : null}
              {hasDeps && cpm.cyclic ? (
                <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                  These dependencies form a loop, so no critical path can be
                  drawn. Edit the links below to break the cycle.
                </p>
              ) : null}
              <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
                {milestones.map((m) => {
                  const node = cpmById.get(m.id);
                  const critical = !cpm.cyclic && node?.isCritical && hasDeps;
                  const float = node && !cpm.cyclic ? node.totalFloat : null;
                  return (
                    <li
                      key={m.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                        {m.title}
                      </span>
                      <span className="text-xs tabular-nums text-slate-600">
                        {m.planned_start
                          ? `${formatDateShortUK(m.planned_start)} → `
                          : "by "}
                        {formatDateShortUK(m.planned_end)}
                      </span>
                      {readWeight(m.weight) !== null ? (
                        <span className="text-xs tabular-nums text-slate-500">
                          {readWeight(m.weight)}%
                        </span>
                      ) : null}
                      {critical ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-800">
                          Critical
                        </span>
                      ) : hasDeps && !cpm.cyclic && float !== null ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {float}d float
                        </span>
                      ) : null}
                      {m.customer_visible ? (
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                          Customer sees this
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}

          {isAdmin && milestones.length >= 2 ? (
            <MilestoneDependencyEditor
              jobId={jobId}
              baselineId={baseline.id}
              milestones={milestones}
              dependencies={dependencies}
            />
          ) : null}
        </>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          No programme baselined yet. {isAdmin
            ? "Set the planned window and milestones below — once every milestone is weighted, the progress chart gains a planned line to compare against."
            : "An admin can baseline the planned window and milestones for this job."}
        </p>
      )}

      {isAdmin ? (
        <StateForm
          action={setJobProgramme.bind(null, jobId)}
          className="mt-5 space-y-3 border-t border-slate-100 pt-4"
        >
          <p className="text-xs font-medium text-slate-700">
            {baseline
              ? `Re-baseline (records revision ${baseline.revision + 1} — the current plan is kept as history)`
              : "Set the programme baseline"}
          </p>
          <div className="grid gap-3 sm:grid-cols-[10rem_10rem_1fr]">
            <Field name="planned_start" label="Planned start" required>
              <input
                id="planned_start"
                name="planned_start"
                type="date"
                required
                defaultValue={baseline?.planned_start ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field name="planned_end" label="Planned end" required>
              <input
                id="planned_end"
                name="planned_end"
                type="date"
                required
                defaultValue={baseline?.planned_end ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>
            <Field
              name="note"
              label={baseline ? "Reason for moving the plan" : "Note"}
              optional={!baseline}
              help={
                baseline
                  ? "Required — the baseline history is the audit trail"
                  : undefined
              }
            >
              <input
                id="note"
                name="note"
                type="text"
                maxLength={2000}
                required={Boolean(baseline)}
                defaultValue={suggestedNote}
                placeholder={
                  baseline ? "e.g. extension of time agreed, ground conditions" : ""
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <p className="text-[11px] text-slate-500">
            Milestones — rows with no title are ignored. Weights are optional,
            but to earn a planned line every milestone must carry one and they
            must sum to 100.
          </p>
          <div className="space-y-2">
            {Array.from({ length: MILESTONE_FORM_ROWS }, (_, idx) => {
              const i = idx + 1;
              const existing = milestones[idx];
              return (
                <div
                  key={i}
                  className="grid gap-2 sm:grid-cols-[1fr_8.5rem_8.5rem_5rem_auto] sm:items-center"
                >
                  <input
                    name={`milestone_title_${i}`}
                    type="text"
                    maxLength={200}
                    defaultValue={existing?.title ?? ""}
                    placeholder={`Milestone ${i} title`}
                    aria-label={`Milestone ${i} title`}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    name={`milestone_start_${i}`}
                    type="date"
                    defaultValue={existing?.planned_start ?? ""}
                    aria-label={`Milestone ${i} planned start (optional)`}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    name={`milestone_end_${i}`}
                    type="date"
                    defaultValue={existing?.planned_end ?? ""}
                    aria-label={`Milestone ${i} planned end`}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <input
                    name={`milestone_weight_${i}`}
                    type="number"
                    min={0.01}
                    max={100}
                    step={0.01}
                    inputMode="decimal"
                    defaultValue={
                      existing ? (readWeight(existing.weight) ?? "") : ""
                    }
                    placeholder="%"
                    aria-label={`Milestone ${i} weight percent (optional)`}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      name={`milestone_visible_${i}`}
                      type="checkbox"
                      defaultChecked={existing?.customer_visible ?? false}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Customer
                  </label>
                </div>
              );
            })}
          </div>

          <button
            type="submit"
            className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
          >
            {baseline ? "Re-baseline programme" : "Baseline programme"}
          </button>
        </StateForm>
      ) : null}
    </section>
  );
}

/**
 * Dependency editor — for each milestone, tick the milestones that must finish
 * before it starts. Submits the whole edge set; the RPC re-validates and refuses
 * a cycle. Admin-only (the presentational gate; the DB is the real one). Kept
 * compact: a full matrix would overwhelm, so each successor lists the OTHER
 * milestones as candidate predecessors.
 */
function MilestoneDependencyEditor({
  jobId,
  baselineId,
  milestones,
  dependencies,
}: {
  jobId: string;
  baselineId: string;
  milestones: MilestoneRow[];
  dependencies: DependencyRow[];
}) {
  const preds = new Map<string, Set<string>>();
  for (const d of dependencies) {
    if (!preds.has(d.milestone_id)) preds.set(d.milestone_id, new Set());
    preds.get(d.milestone_id)!.add(d.depends_on_milestone_id);
  }
  const milestoneIds = milestones.map((m) => m.id).join(",");

  return (
    <details className="mt-5 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">
        Milestone dependencies &amp; critical path
      </summary>
      <p className="mt-2 text-xs text-slate-500">
        Tick what each milestone waits on. The critical path (and each
        milestone&apos;s float) is derived from these links — a loop is refused.
      </p>
      <StateForm
        action={setMilestoneDependencies.bind(null, jobId, baselineId)}
        className="mt-3 space-y-3"
      >
        <input type="hidden" name="milestone_ids" value={milestoneIds} />
        <div className="space-y-3">
          {milestones.map((m) => {
            const chosen = preds.get(m.id) ?? new Set<string>();
            const candidates = milestones.filter((o) => o.id !== m.id);
            return (
              <div key={m.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-sm font-medium text-slate-800">{m.title}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">must wait for:</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                  {candidates.map((o) => (
                    <label
                      key={o.id}
                      className="flex items-center gap-1.5 text-xs text-slate-600"
                    >
                      <input
                        type="checkbox"
                        name={`deps_${m.id}`}
                        value={o.id}
                        defaultChecked={chosen.has(o.id)}
                        className="h-3.5 w-3.5 rounded border-slate-300"
                      />
                      {o.title}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="submit"
          className="h-9 rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Save dependencies
        </button>
      </StateForm>
    </details>
  );
}

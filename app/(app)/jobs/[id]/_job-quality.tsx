import Link from "next/link";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  ITP_STATUS_LABELS,
  completionPercent,
  isFullyAccepted,
  type ItpStatus,
} from "@/lib/quality/itp";
import { toProgress } from "../../quality/_data";
import type { ItpRow, PlanStatusRow } from "@/lib/quality/schema";

/**
 * Job Works-Quality panel — the per-job inspection register on the job hub.
 *
 * Two bounded reads, both ACTIVE-org pinned (RLS is the outer boundary, not the
 * scope: `current_org_ids()` spans every org a dual-org member belongs to).
 *
 * LOUD READ, panel-scoped. This panel's whole job is to say whether anything is
 * holding work up, so an empty render on a FAILED read would assert "no
 * outstanding hold points" — a control failing open on a safety-adjacent
 * surface. It therefore reports to Sentry and renders an EXPLICIT error block,
 * never the quiet nothing that the job hub's older panels fall back to.
 *
 * Renders nothing when the job genuinely has no inspection plans.
 */

export async function JobQualitySection({ jobId }: { jobId: string }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tbl = (c: unknown) => (c as { from: (t: string) => any }).from.bind(c);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const [plansRes, statusRes] = await Promise.all([
    tbl(supabase)("inspection_test_plans")
      .select("id, reference, title, work_package, status, created_at")
      .eq("org_id", ctx.org.id)
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(50),
    tbl(supabase)("works_quality_plan_status")
      .select(
        "plan_id, org_id, job_id, status, total_items, hold_point_items, signed_off_items, outstanding_required_items, open_hold_points, failed_items, hold_point_breaches, open_hold_item_number",
      )
      .eq("org_id", ctx.org.id)
      .eq("job_id", jobId),
  ]);

  if (plansRes.error || statusRes.error) {
    reportReadFailure(
      "job hub: works quality",
      (plansRes.error ?? statusRes.error) as SupabaseReadError,
    );
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-red-800">Works quality</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load the inspection plans for this job. This panel is NOT
          saying there are none — refresh to try again.
        </p>
      </section>
    );
  }

  const plans = (plansRes.data ?? []) as Array<
    Pick<ItpRow, "id" | "reference" | "title" | "work_package" | "status" | "created_at">
  >;
  if (plans.length === 0) return null;

  const byPlan = new Map<string, PlanStatusRow>();
  for (const s of (statusRes.data ?? []) as PlanStatusRow[]) byPlan.set(s.plan_id, s);

  const withProgress = plans.map((p) => ({ ...p, progress: toProgress(byPlan.get(p.id)) }));
  const blocked = withProgress.filter(
    (p) => p.status === "issued" && p.progress.openHoldItemNumber !== null,
  );
  const openHoldPoints = blocked.reduce((n, p) => n + p.progress.openHoldPoints, 0);

  const STATUS_STYLE: Record<ItpStatus, string> = {
    draft: "bg-slate-100 text-slate-700",
    issued: "bg-emerald-100 text-emerald-800",
    superseded: "bg-amber-100 text-amber-800",
    withdrawn: "bg-slate-100 text-slate-600",
  };

  return (
    <section
      aria-labelledby="job-quality-heading"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="job-quality-heading" className="text-base font-semibold text-slate-900">
          Works quality
        </h2>
        <span className="text-xs text-slate-500">
          {plans.length} inspection plan{plans.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* WARN, never block. An open hold point changes nothing about what the
          job hub lets anyone do — it says so, loudly, and that is all. */}
      {openHoldPoints > 0 ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
          {openHoldPoints} hold point{openHoldPoints === 1 ? "" : "s"} outstanding on this job. Work
          should not proceed past{" "}
          {blocked.length === 1
            ? `item ${blocked[0]!.progress.openHoldItemNumber} of ${blocked[0]!.reference ?? "the plan"}`
            : "the open hold points"}{" "}
          until signed off.
        </p>
      ) : null}

      <ul className="mt-4 divide-y divide-slate-100 text-sm">
        {withProgress.map((p) => (
          <li key={p.id} className="py-2.5">
            <Link
              href={`/quality/${p.id}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 hover:underline"
            >
              <span className="font-mono text-xs font-medium text-slate-600">
                {p.reference ?? "Draft"}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-800">{p.work_package}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status as ItpStatus] ?? "bg-slate-100 text-slate-600"}`}
              >
                {ITP_STATUS_LABELS[p.status as ItpStatus] ?? p.status}
              </span>
            </Link>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
              <span>
                {p.progress.signedOffItems}/{p.progress.totalItems} signed off
                {p.progress.totalItems > 0 ? ` · ${completionPercent(p.progress)}%` : ""}
              </span>
              {p.progress.openHoldItemNumber !== null && p.status === "issued" ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-800">
                  Hold at item {p.progress.openHoldItemNumber}
                </span>
              ) : null}
              {p.progress.failedItems > 0 ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                  {p.progress.failedItems} failed
                </span>
              ) : null}
              {isFullyAccepted(p.progress) && p.status === "issued" ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
                  All checks accepted
                </span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

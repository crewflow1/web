import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { buildLaunchReadiness } from "@/server/services/launch-readiness";
import { GlowHeader, Panel, Surface } from "@/components/ui";

/**
 * /admin/launch-checklist — Phase 8.
 *
 * Single page traffic-lighting CrewFlow's readiness across every
 * prior phase (Ops / Retention / Customer Portal / Automation / AI /
 * HQ / Security / Polish). The directive's Step 7 list of readiness
 * items is rendered here with GREEN/AMBER/RED status.
 *
 * HQ-only. Layout gates; this page double-checks.
 */

export const dynamic = "force-dynamic";

const STATUS_PILL = {
  green:
    "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  amber: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  red: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
} as const;

const STATUS_BANNER = {
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-200",
} as const;

const STATUS_LABEL = {
  green: "GREEN",
  amber: "AMBER",
  red: "RED",
} as const;

export default async function LaunchChecklistPage() {
  await requireHqPage();

  const readiness = await buildLaunchReadiness();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Launch checklist"
        subtitle="Single page readiness across every phase. GREEN = ready, AMBER = unblocked but watch, RED = blocking."
      />

      <div className="space-y-6 p-5 sm:p-7">
        <section
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-5 ${STATUS_BANNER[readiness.overall]}`}
          role="status"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
              Overall readiness
            </p>
            <p className="mt-1 text-3xl font-bold">
              {STATUS_LABEL[readiness.overall]}
            </p>
          </div>
          <p className="max-w-md text-sm">
            {readiness.overall === "green"
              ? "Every check passes. Ready for controlled real-customer use."
              : readiness.overall === "amber"
                ? "No blockers — one or more items deserve a look before scaling."
                : "Blocking issue(s) detected. Fix before onboarding real customers."}
          </p>
        </section>

        <Panel title="Checks">
          <ul className="divide-y divide-slate-800">
            {readiness.rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-100">
                    {row.label}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-300">{row.summary}</p>
                  {row.detail ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {row.detail}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[row.status]}`}
                >
                  {STATUS_LABEL[row.status]}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Next checks">
          <p className="text-xs text-slate-300">
            Re-run the end-to-end lifecycle script before the next launch
            window:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-slate-100">
            {`supabase db query --linked --file scripts/e2e-lifecycle.sql`}
          </pre>
          <p className="mt-3 text-xs text-slate-300">
            See{" "}
            <Link
              href="/admin/ops"
              className="text-indigo-300 transition-colors hover:text-indigo-200"
            >
              /admin/ops
            </Link>{" "}
            for live cron + email health, and{" "}
            <Link
              href="/admin/automations"
              className="text-indigo-300 transition-colors hover:text-indigo-200"
            >
              /admin/automations
            </Link>{" "}
            for automation telemetry.
          </p>
        </Panel>
      </div>
    </Surface>
  );
}

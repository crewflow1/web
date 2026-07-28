import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import { buildLaunchReadiness } from "@/server/services/launch-readiness";

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
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  red: "bg-red-100 text-red-800 border-red-200",
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
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Launch checklist</h1>
        <p className="text-sm text-slate-600">
          Single page readiness across every phase. GREEN = ready, AMBER
          = unblocked but watch, RED = blocking.
        </p>
      </header>

      <section
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-5 shadow-sm ${STATUS_PILL[readiness.overall]}`}
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

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Checks</h2>
        <ul className="mt-4 divide-y divide-slate-100">
          {readiness.rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">
                  {row.label}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">{row.summary}</p>
                {row.detail ? (
                  <p className="mt-1 text-[11px] text-slate-500">{row.detail}</p>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[row.status]}`}
              >
                {STATUS_LABEL[row.status]}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Next checks</h2>
        <p className="mt-2 text-xs">
          Re-run the end-to-end lifecycle script before the next launch window,
          against a LOCAL stack — it creates and deletes real business rows, and{" "}
          <code className="font-mono">--linked</code> means production:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] text-slate-100">
          {`supabase start\nsupabase status   # copy DB_URL (127.0.0.1:54322)\npsql "<DB_URL>" -v ON_ERROR_STOP=1 -f scripts/e2e-lifecycle.sql`}
        </pre>
        <p className="mt-3 text-xs">
          See{" "}
          <Link href="/admin/ops" className="text-indigo-700 hover:underline">
            /admin/ops
          </Link>{" "}
          for live cron + email health, and{" "}
          <Link
            href="/admin/automations"
            className="text-indigo-700 hover:underline"
          >
            /admin/automations
          </Link>{" "}
          for automation telemetry.
        </p>
      </section>
    </div>
  );
}

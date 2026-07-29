import Link from "next/link";
import { requireHqPage } from "@/server/auth/hq";
import {
  buildOpsSnapshot,
  type CronRouteHealth,
  type EnvVarStatus,
} from "@/server/services/ops-snapshot";

/**
 * /admin/ops — HQ system status dashboard.
 *
 * Single source of truth for "is CrewFlow's plumbing healthy?".
 * Five sections matching the directive's Phase 1 Step 6 list:
 *
 *   1. Top traffic-light banner (green / amber / red + summary).
 *   2. Env-var presence (required vs optional, never the value).
 *   3. Email queue (counts + recent failures).
 *   4. Cron status (last run, last success, failures last 7d).
 *   5. Recent failures table (across all crons).
 *
 * No client JS. HQ-gated at the layout (notFound for non-superadmin).
 * The page double-checks with `notFound()` for defence-in-depth.
 */

export const dynamic = "force-dynamic";

const STATUS_PILL = {
  green: "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber: "bg-amber-100 text-amber-900 border-amber-200",
  red: "bg-red-100 text-red-800 border-red-200",
} as const;

export default async function OpsPage() {
  await requireHqPage();

  const snapshot = await buildOpsSnapshot();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Ops</h1>
        <p className="text-sm text-slate-600">
          Live system health for CrewFlow. Refresh to recompute.
        </p>
      </header>

      {/* Headline traffic-light */}
      <section
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-5 shadow-sm ${STATUS_PILL[snapshot.status]}`}
        role="status"
      >
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
            System status
          </p>
          <p className="mt-1 text-xl font-bold capitalize">{snapshot.status}</p>
        </div>
        <p className="max-w-2xl text-sm">{snapshot.summary}</p>
      </section>

      {/* Env var presence */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">Environment</h2>
          <p className="text-[11px] text-slate-500">presence only · never values</p>
        </header>
        <ul className="mt-4 divide-y divide-slate-100">
          {snapshot.env.map((e) => (
            <EnvRow key={e.name} env={e} />
          ))}
        </ul>
      </section>

      {/* Email queue */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">Email queue</h2>
          <Link
            href="/admin/notifications"
            className="text-[11px] font-medium text-indigo-700 hover:underline"
          >
            Open notifications →
          </Link>
        </header>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Kpi label="Queued" value={snapshot.email.queued} />
          <Kpi label="Sent (24h)" value={snapshot.email.sent_24h} />
          <Kpi
            label="Failed (24h)"
            value={snapshot.email.failed_24h}
            tone={snapshot.email.failed_24h > 0 ? "amber" : undefined}
          />
          <Kpi label="Skipped" value={snapshot.email.skipped} />
          <Kpi
            label="Permanent failures"
            value={snapshot.email.permanent_failures}
            tone={snapshot.email.permanent_failures > 0 ? "red" : undefined}
          />
        </dl>
        {snapshot.email.recent_failures.length > 0 ? (
          <details className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs">
            <summary className="cursor-pointer font-medium text-red-900">
              Recent email failures ({snapshot.email.recent_failures.length})
            </summary>
            <ul className="mt-2 space-y-1 text-red-900">
              {snapshot.email.recent_failures.map((f) => (
                <li key={f.id} className="font-mono text-[11px]">
                  {f.failed_at?.slice(0, 16).replace("T", " ") ?? "—"} ·{" "}
                  {f.to_email} · {f.last_error ?? "no detail"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {/* Cron status */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">Cron jobs</h2>
          <p className="text-[11px] text-slate-500">last 7 days</p>
        </header>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2">Last success</th>
                <th className="px-3 py-2 text-right">Runs (7d)</th>
                <th className="px-3 py-2 text-right">Fails (7d)</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {snapshot.crons.map((c) => (
                <CronRow key={c.route} cron={c} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent failures */}
      {snapshot.recent_failures.length > 0 ? (
        <section className="rounded-xl border border-red-200 bg-red-50/30 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-red-900">
            Recent cron failures
          </h2>
          <ul className="mt-3 space-y-2">
            {snapshot.recent_failures.map((f) => (
              <li
                key={f.id}
                className="rounded-md border border-red-200 bg-white p-3 text-xs text-red-900"
              >
                <p className="font-semibold">
                  {f.route} ·{" "}
                  <span className="font-mono text-[10px] text-red-700">
                    {f.started_at.slice(0, 16).replace("T", " ")}
                  </span>
                </p>
                <p className="mt-1 font-mono text-[11px] text-red-800">
                  {f.error_message ?? "no detail"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EnvRow({ env }: { env: EnvVarStatus }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium text-slate-800">
          {env.name}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">{env.hint}</p>
      </div>
      <span
        className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
          env.present
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : env.required
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-amber-200 bg-amber-50 text-amber-900"
        }`}
      >
        {env.present
          ? "set"
          : env.required
            ? "missing · required"
            : "missing · optional"}
      </span>
    </li>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "red";
}) {
  const valueCls =
    tone === "red"
      ? "text-red-700"
      : tone === "amber"
        ? "text-amber-700"
        : "text-slate-900";
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={`mt-0.5 text-xl font-semibold ${valueCls}`}>{value}</dd>
    </div>
  );
}

function CronRow({ cron }: { cron: CronRouteHealth }) {
  const okBadge =
    cron.last_ok === true
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : cron.last_ok === false
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-3 py-2 font-mono text-xs font-medium text-slate-800">
        /{cron.route}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700">
        {cron.last_run_at ? cron.last_run_at.slice(0, 16).replace("T", " ") : "—"}
        {cron.last_duration_ms != null ? (
          <span className="ml-1 text-slate-500">
            · {cron.last_duration_ms}ms
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700">
        {cron.last_ok_at ? cron.last_ok_at.slice(0, 16).replace("T", " ") : "—"}
      </td>
      <td className="px-3 py-2 text-right text-xs text-slate-700">
        {cron.runs_7d}
      </td>
      <td className="px-3 py-2 text-right text-xs">
        {cron.failures_7d > 0 ? (
          <span className="font-semibold text-red-700">{cron.failures_7d}</span>
        ) : (
          <span className="text-slate-500">0</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${okBadge}`}
        >
          {cron.last_ok === null
            ? "no runs"
            : cron.last_ok
              ? "ok"
              : "failed"}
        </span>
      </td>
    </tr>
  );
}

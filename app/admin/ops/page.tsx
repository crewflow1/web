import { requireHqPage } from "@/server/auth/hq";
import { pill } from "@/components/ui/tokens";
import {
  buildOpsSnapshot,
  type CronRouteHealth,
  type EnvVarStatus,
} from "@/server/services/ops-snapshot";
import {
  AnimatedNumber,
  ButtonLink,
  GlowHeader,
  Panel,
  StatTile,
  Surface,
} from "@/components/ui";

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
 * No client JS. HQ-gated at the layout (requireHqPage → 404 for
 * non-superadmin). The page re-calls requireHqPage() for defence-in-depth.
 */

export const dynamic = "force-dynamic";

const STATUS_BANNER = {
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-200",
} as const;

export default async function OpsPage() {
  await requireHqPage();

  const snapshot = await buildOpsSnapshot();

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Ops"
        subtitle="Live system health for CrewFlow. Refresh to recompute."
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* Headline traffic-light */}
        <section
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-5 ${STATUS_BANNER[snapshot.status]}`}
          role="status"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
              System status
            </p>
            <p className="mt-1 text-xl font-bold capitalize">
              {snapshot.status}
            </p>
          </div>
          <p className="max-w-2xl text-sm">{snapshot.summary}</p>
        </section>

        {/* Env var presence */}
        <Panel
          title="Environment"
          action={
            <p className="text-[11px] text-slate-500">
              presence only · never values
            </p>
          }
        >
          <ul className="divide-y divide-slate-800">
            {snapshot.env.map((e) => (
              <EnvRow key={e.name} env={e} />
            ))}
          </ul>
        </Panel>

        {/* Email queue */}
        <Panel
          title="Email queue"
          action={
            <ButtonLink href="/admin/notifications" variant="glass" size="sm">
              Open notifications →
            </ButtonLink>
          }
        >
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatTile label="Queued" value={<AnimatedNumber value={snapshot.email.queued} />} />
            <StatTile
              label="Sent (24h)"
              value={<AnimatedNumber value={snapshot.email.sent_24h} />}
            />
            <StatTile
              label="Failed (24h)"
              value={<AnimatedNumber value={snapshot.email.failed_24h} />}
              accent={snapshot.email.failed_24h > 0 ? "amber" : "slate"}
            />
            <StatTile
              label="Skipped"
              value={<AnimatedNumber value={snapshot.email.skipped} />}
            />
            <StatTile
              label="Permanent failures"
              value={<AnimatedNumber value={snapshot.email.permanent_failures} />}
              accent={snapshot.email.permanent_failures > 0 ? "rose" : "slate"}
            />
          </dl>
          {snapshot.email.recent_failures.length > 0 ? (
            <details className="mt-4 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-rose-200">
                Recent email failures ({snapshot.email.recent_failures.length})
              </summary>
              <ul className="mt-2 space-y-1 text-rose-200">
                {snapshot.email.recent_failures.map((f) => (
                  <li key={f.id} className="font-mono text-[11px]">
                    {f.failed_at?.slice(0, 16).replace("T", " ") ?? "—"} ·{" "}
                    {f.to_email} · {f.last_error ?? "no detail"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>

        {/* Cron status */}
        <Panel
          title="Cron jobs"
          action={<p className="text-[11px] text-slate-500">last 7 days</p>}
        >
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Route</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">Last success</th>
                  <th className="px-3 py-2 text-right">Runs (7d)</th>
                  <th className="px-3 py-2 text-right">Fails (7d)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {snapshot.crons.map((c) => (
                  <CronRow key={c.route} cron={c} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Recent failures */}
        {snapshot.recent_failures.length > 0 ? (
          <section className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-5">
            <h2 className="text-sm font-semibold text-rose-200">
              Recent cron failures
            </h2>
            <ul className="mt-3 space-y-2">
              {snapshot.recent_failures.map((f) => (
                <li
                  key={f.id}
                  className="rounded-xl border border-rose-500/30 bg-slate-900/60 p-3 text-xs text-rose-200"
                >
                  <p className="font-semibold">
                    {f.route} ·{" "}
                    <span className="font-mono text-[10px] text-rose-300">
                      {f.started_at.slice(0, 16).replace("T", " ")}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-rose-200">
                    {f.error_message ?? "no detail"}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Surface>
  );
}

function EnvRow({ env }: { env: EnvVarStatus }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="font-mono text-sm font-medium text-slate-200">
          {env.name}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">{env.hint}</p>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
          env.present
            ? pill("emerald")
            : env.required
              ? pill("rose")
              : pill("amber")
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

function CronRow({ cron }: { cron: CronRouteHealth }) {
  const okBadge =
    cron.last_ok === true
      ? pill("emerald")
      : cron.last_ok === false
        ? pill("rose")
        : pill("quiet");
  return (
    <tr className="transition-colors hover:bg-slate-900/50">
      <td className="px-3 py-2 font-mono text-xs font-medium text-slate-200">
        /{cron.route}
      </td>
      <td className="px-3 py-2 text-xs text-slate-300">
        {cron.last_run_at ? cron.last_run_at.slice(0, 16).replace("T", " ") : "—"}
        {cron.last_duration_ms != null ? (
          <span className="ml-1 text-slate-500">
            · {cron.last_duration_ms}ms
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs text-slate-300">
        {cron.last_ok_at ? cron.last_ok_at.slice(0, 16).replace("T", " ") : "—"}
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-300">
        {cron.runs_7d}
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums">
        {cron.failures_7d > 0 ? (
          <span className="font-semibold text-rose-300">{cron.failures_7d}</span>
        ) : (
          <span className="text-slate-500">0</span>
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${okBadge}`}
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

import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { readAutomationHealth } from "@/server/services/automation-dispatcher";

/**
 * /admin/automations — Phase 4.
 *
 * Single page listing every built-in automation rule with its
 * enabled state, last-run timestamp, 7-day run + failure counts,
 * and a description. Deliberately simple — the directive's Step 5
 * said "Do not build complex Zapier clone yet."
 *
 * HQ-only. Layout gates; this page double-checks (defence in depth).
 */

export const dynamic = "force-dynamic";

const STATUS_PILL = {
  ok: "bg-emerald-100 text-emerald-800 border-emerald-200",
  failed: "bg-red-100 text-red-800 border-red-200",
  skipped: "bg-slate-100 text-slate-700 border-slate-200",
} as const;

export default async function AutomationsPage() {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  const health = await readAutomationHealth();
  const totalRuns = health.reduce((acc, h) => acc + h.runs_7d, 0);
  const totalFails = health.reduce((acc, h) => acc + h.failures_7d, 0);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900">Automations</h1>
        <p className="text-sm text-slate-600">
          CrewFlow&apos;s built-in automations — fired by the dispatcher
          whenever a domain event lands. Idempotent by{" "}
          <code className="rounded bg-slate-100 px-1 text-[11px]">
            (rule_id, source)
          </code>{" "}
          so re-emitting the same event never double-fires.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Rules enabled" value={health.filter((h) => h.rule.enabled).length} />
        <Kpi label="Runs (7d)" value={totalRuns} />
        <Kpi
          label="Failures (7d)"
          value={totalFails}
          tone={totalFails > 0 ? "amber" : undefined}
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Built-in rules
          </h2>
          <Link
            href="/admin/ops"
            className="text-[11px] font-medium text-indigo-700 hover:underline"
          >
            Open ops →
          </Link>
        </header>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2 text-right">Runs (7d)</th>
                <th className="px-3 py-2 text-right">Fails (7d)</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {health.map((h) => (
                <tr key={h.rule.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">
                      {h.rule.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {h.rule.description}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {h.rule.actions.map((a) => (
                        <span
                          key={a}
                          className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {h.rule.trigger}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    {h.last_run_at
                      ? h.last_run_at.slice(0, 16).replace("T", " ")
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-slate-700">
                    {h.runs_7d}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {h.failures_7d > 0 ? (
                      <span className="font-semibold text-red-700">
                        {h.failures_7d}
                      </span>
                    ) : (
                      <span className="text-slate-500">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        h.last_status
                          ? STATUS_PILL[h.last_status]
                          : h.rule.enabled
                            ? "bg-slate-100 text-slate-600 border-slate-200"
                            : "bg-amber-100 text-amber-800 border-amber-200"
                      }`}
                    >
                      {h.last_status ??
                        (h.rule.enabled ? "enabled · no runs" : "disabled")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] text-slate-500">
        User-editable rules + per-org overrides land later. For now the
        catalogue is hardcoded — to disable a rule, edit{" "}
        <code className="rounded bg-slate-100 px-1">lib/automation/rules.ts</code>{" "}
        and ship.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber";
}) {
  const valueCls = tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold ${valueCls}`}>{value}</div>
    </div>
  );
}

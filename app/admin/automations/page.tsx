import { requireHqPage } from "@/server/auth/hq";
import { pill } from "@/components/ui/tokens";
import { readAutomationHealth } from "@/server/services/automation-dispatcher";
import {
  AnimatedNumber,
  ButtonLink,
  GlowHeader,
  Panel,
  StatTile,
  Surface,
} from "@/components/ui";

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
  ok: pill("emerald"),
  failed: pill("rose"),
  skipped: pill("quiet"),
} as const;

export default async function AutomationsPage() {
  await requireHqPage();

  const health = await readAutomationHealth();
  const totalRuns = health.reduce((acc, h) => acc + h.runs_7d, 0);
  const totalFails = health.reduce((acc, h) => acc + h.failures_7d, 0);

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Automations"
        subtitle={
          <>
            {
              "CrewFlow's built-in automations — fired by the dispatcher whenever a domain event lands. Idempotent by "
            }
            <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
              (rule_id, source)
            </code>
            {" so re-emitting the same event never double-fires."}
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Rules enabled"
            value={
              <AnimatedNumber
                value={health.filter((h) => h.rule.enabled).length}
              />
            }
          />
          <StatTile label="Runs (7d)" value={<AnimatedNumber value={totalRuns} />} />
          <StatTile
            label="Failures (7d)"
            value={<AnimatedNumber value={totalFails} />}
            accent={totalFails > 0 ? "amber" : "slate"}
          />
        </section>

        <Panel
          title="Built-in rules"
          action={
            <ButtonLink href="/admin/ops" variant="glass" size="sm">
              Open ops →
            </ButtonLink>
          }
        >
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Rule</th>
                  <th className="px-3 py-2">Trigger</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2 text-right">Runs (7d)</th>
                  <th className="px-3 py-2 text-right">Fails (7d)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {health.map((h) => (
                  <tr key={h.rule.id} className="transition-colors hover:bg-slate-900/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-100">
                        {h.rule.label}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500">
                        {h.rule.description}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {h.rule.actions.map((a) => (
                          <span
                            key={a}
                            className="rounded-full bg-slate-800/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-300">
                      {h.rule.trigger}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-300">
                      {h.last_run_at
                        ? h.last_run_at.slice(0, 16).replace("T", " ")
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-300">
                      {h.runs_7d}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {h.failures_7d > 0 ? (
                        <span className="font-semibold text-rose-300">
                          {h.failures_7d}
                        </span>
                      ) : (
                        <span className="text-slate-500">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          h.last_status
                            ? STATUS_PILL[h.last_status]
                            : h.rule.enabled
                              ? pill("quiet")
                              : pill("amber")
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
        </Panel>

        <p className="text-[11px] text-slate-500">
          User-editable rules + per-org overrides land later. For now the
          catalogue is hardcoded — to disable a rule, edit{" "}
          <code className="rounded bg-slate-800/80 px-1 ring-1 ring-inset ring-slate-700">
            lib/automation/rules.ts
          </code>{" "}
          and ship.
        </p>
      </div>
    </Surface>
  );
}

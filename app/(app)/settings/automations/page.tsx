import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listAutomationRulesForOrg } from "@/server/services/automation-rules";
import {
  listSchedulesForOrg,
  scheduleRuleLabel,
  schedulableRules,
} from "@/server/services/automation-schedules";
import {
  listCustomRulesForOrg,
  listPendingApprovals,
  getCustomRule,
} from "@/server/services/automation-custom-rules";
import {
  toggleAutomationRule,
  createAutomationSchedule,
  toggleAutomationSchedule,
  removeAutomationSchedule,
  toggleCustomRuleAction,
  deleteCustomRuleAction,
  decideApprovalAction,
} from "./actions";
import { CustomRuleBuilder } from "./CustomRuleBuilder";

/**
 * Settings → Automations — per-org control of the automation engine (20261096).
 *
 * Two surfaces, both admin-gated:
 *   · RULES   — override each catalogue rule's enabled-state for THIS org. The
 *               static catalogue is the default; a toggle writes an override row.
 *   · SCHEDULES — time-triggered rules (a cron expression bound to a rule),
 *               fired org-scoped by /api/cron/automation-schedules-drain.
 *
 * The role check here drives the UX (members see a read-only view); the
 * automation_rules / automation_schedules admin-write RLS policies are the real
 * boundary. Reads are org-pinned + loud (the services throw on error).
 */

export const dynamic = "force-dynamic";

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AutomationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    error?: string;
    edit?: string;
    rpage?: string;
  }>;
}) {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  const sp = await searchParams;
  const rulePage = Number.isFinite(Number(sp.rpage)) ? Math.max(0, Number(sp.rpage)) : 0;

  const supabase = await createClient();
  const client = supabase as unknown as { from: (t: string) => never };
  const customClient = supabase as unknown as never;
  const [rules, schedules, customRules, approvals] = await Promise.all([
    listAutomationRulesForOrg(client, ctx.org.id),
    listSchedulesForOrg(client, ctx.org.id),
    listCustomRulesForOrg(customClient, ctx.org.id, rulePage),
    listPendingApprovals(customClient, ctx.org.id, 0),
  ]);

  // Edit mode: load the rule into the builder (org-pinned read).
  const editRule =
    isAdmin && sp.edit
      ? await getCustomRule(customClient, ctx.org.id, sp.edit).catch(() => null)
      : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
          <span>/</span>
          <span className="text-slate-700">Automations</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Automations</h1>
        <p className="text-sm text-slate-600">
          Turn CrewFlow&apos;s built-in automations on or off for your team, and
          schedule rules to run on a timetable. Changes apply to your
          organisation only.
        </p>
      </header>

      {sp.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {sp.error === "forbidden"
            ? "Only owners and admins can change automations."
            : sp.error === "schedule_validation"
              ? "That cron expression isn't valid. Use 5 fields, e.g. 0 9 * * 1."
              : sp.error === "custom_validation" || sp.error === "custom_save_failed"
                ? "That custom rule couldn't be saved. Check the trigger, conditions and actions."
                : sp.error === "approval_failed"
                  ? "That approval couldn't be processed. It may already have been decided."
                  : "Something went wrong. Try again."}
        </div>
      ) : null}
      {sp.saved ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          Saved.
        </div>
      ) : null}

      {!isAdmin ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          You can see the current setup, but only owners and admins can change
          it.
        </div>
      ) : null}

      {/* Rules ---------------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Rules</h2>
        <p className="mt-1 text-sm text-slate-600">
          Each rule runs its actions when its trigger event happens.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rules.map((r) => (
                <tr key={r.rule.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">
                      {r.rule.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {r.rule.description}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                    {r.rule.trigger}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        r.enabled
                          ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                          : "border-slate-200 bg-slate-100 text-slate-600"
                      }`}
                    >
                      {r.enabled ? "On" : "Off"}
                    </span>
                    {r.overridden ? (
                      <span className="ml-1 text-[10px] text-slate-400">
                        (overridden)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isAdmin ? (
                      <form action={toggleAutomationRule}>
                        <input type="hidden" name="rule_key" value={r.rule.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={r.enabled ? "false" : "true"}
                        />
                        <button
                          type="submit"
                          className="rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {r.enabled ? "Turn off" : "Turn on"}
                        </button>
                      </form>
                    ) : (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Schedules ------------------------------------------------------ */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Schedules</h2>
        <p className="mt-1 text-sm text-slate-600">
          Run a rule on a timetable. Times are in UTC. Example:{" "}
          <code className="rounded bg-slate-100 px-1 text-[11px]">0 9 * * 1</code>{" "}
          = 09:00 every Monday.
        </p>

        {schedules.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No schedules yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Rule</th>
                  <th className="px-3 py-2">Cron</th>
                  <th className="px-3 py-2">Next run</th>
                  <th className="px-3 py-2">Last run</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {schedules.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">
                      {scheduleRuleLabel(s.rule_key)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                      {s.cron_expr}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {fmt(s.next_run_at)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">
                      {fmt(s.last_run_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                          s.enabled
                            ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                            : "border-slate-200 bg-slate-100 text-slate-600"
                        }`}
                      >
                        {s.enabled ? "On" : "Off"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin ? (
                        <div className="flex justify-end gap-2">
                          <form action={toggleAutomationSchedule}>
                            <input
                              type="hidden"
                              name="schedule_id"
                              value={s.id}
                            />
                            <input
                              type="hidden"
                              name="enabled"
                              value={s.enabled ? "false" : "true"}
                            />
                            <button
                              type="submit"
                              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              {s.enabled ? "Pause" : "Resume"}
                            </button>
                          </form>
                          <form action={removeAutomationSchedule}>
                            <input
                              type="hidden"
                              name="schedule_id"
                              value={s.id}
                            />
                            <button
                              type="submit"
                              className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                            >
                              Delete
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {isAdmin ? (
          <form
            action={createAutomationSchedule}
            className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-5"
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Rule
              <select
                name="rule_key"
                required
                className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
              >
                {schedulableRules().map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Cron (UTC)
              <input
                name="cron_expr"
                required
                placeholder="0 9 * * 1"
                className="w-40 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              Add schedule
            </button>
          </form>
        ) : null}
      </section>

      {/* Pending approvals --------------------------------------------- */}
      {approvals.items.length > 0 ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-5 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">
            Awaiting approval
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            These custom rules ran their first steps and are waiting for a
            decision before the rest run.
          </p>
          <div className="mt-4 space-y-3">
            {approvals.items.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border border-amber-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-900">{a.rule_name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      Trigger{" "}
                      <span className="font-mono">{a.event_type}</span> ·{" "}
                      {Array.isArray(a.pending_actions)
                        ? a.pending_actions.length
                        : 0}{" "}
                      action(s) pending · {fmt(a.created_at)}
                    </div>
                  </div>
                  {isAdmin ? (
                    <div className="flex gap-2">
                      <form action={decideApprovalAction}>
                        <input type="hidden" name="approval_id" value={a.id} />
                        <input type="hidden" name="decision" value="approve" />
                        <button
                          type="submit"
                          className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
                        >
                          Approve
                        </button>
                      </form>
                      <form action={decideApprovalAction}>
                        <input type="hidden" name="approval_id" value={a.id} />
                        <input type="hidden" name="decision" value="reject" />
                        <button
                          type="submit"
                          className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                        >
                          Reject
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-400">
                      Awaiting an admin
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Custom rules -------------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Custom rules</h2>
        <p className="mt-1 text-sm text-slate-600">
          Build your own rules: pick a trigger, add conditions, choose the
          actions, and optionally require approval before some steps run.
        </p>

        {customRules.items.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No custom rules yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Rule</th>
                  <th className="px-3 py-2">Trigger</th>
                  <th className="px-3 py-2">Approval</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customRules.items.map((r) => {
                  const def = (r.definition ?? {}) as {
                    actions?: unknown[];
                    requiresApproval?: boolean;
                  };
                  return (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">{r.name}</div>
                        {r.description ? (
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            {r.description}
                          </div>
                        ) : null}
                        <div className="mt-0.5 text-[11px] text-slate-400">
                          {Array.isArray(def.actions) ? def.actions.length : 0}{" "}
                          action(s)
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                        {r.trigger_event}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-600">
                        {def.requiresApproval ? "Required" : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            r.enabled
                              ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                              : "border-slate-200 bg-slate-100 text-slate-600"
                          }`}
                        >
                          {r.enabled ? "On" : "Off"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isAdmin ? (
                          <div className="flex justify-end gap-2">
                            <Link
                              href={`/settings/automations?edit=${r.id}`}
                              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              Edit
                            </Link>
                            <form action={toggleCustomRuleAction}>
                              <input type="hidden" name="rule_id" value={r.id} />
                              <input
                                type="hidden"
                                name="enabled"
                                value={r.enabled ? "false" : "true"}
                              />
                              <button
                                type="submit"
                                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                {r.enabled ? "Turn off" : "Turn on"}
                              </button>
                            </form>
                            <form action={deleteCustomRuleAction}>
                              <input type="hidden" name="rule_id" value={r.id} />
                              <button
                                type="submit"
                                className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                              >
                                Delete
                              </button>
                            </form>
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* F-1 pager */}
        {customRules.page > 0 || customRules.hasMore ? (
          <div className="mt-3 flex items-center gap-3 text-xs">
            {customRules.page > 0 ? (
              <Link
                href={`/settings/automations?rpage=${customRules.page - 1}`}
                className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                ← Newer
              </Link>
            ) : null}
            {customRules.hasMore ? (
              <Link
                href={`/settings/automations?rpage=${customRules.page + 1}`}
                className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Older →
              </Link>
            ) : null}
          </div>
        ) : null}

        {isAdmin ? (
          <div className="mt-6 border-t border-slate-100 pt-5">
            <h3 className="mb-3 text-sm font-semibold text-slate-900">
              {editRule ? `Edit "${editRule.name}"` : "Create a custom rule"}
            </h3>
            <CustomRuleBuilder
              key={editRule?.id ?? "new"}
              initial={
                editRule
                  ? {
                      id: editRule.id,
                      name: editRule.name,
                      description: editRule.description,
                      definition: editRule.definition,
                    }
                  : undefined
              }
            />
            {editRule ? (
              <Link
                href="/settings/automations"
                className="mt-3 inline-block text-xs text-slate-500 hover:underline"
              >
                Cancel edit / start a new rule
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

import Link from "next/link";
import { Search, ShieldOff } from "lucide-react";
import {
  listAiEmployees,
  resolveApprovalLevelsByEmployeeId,
} from "@/server/services/ai-employees";
import {
  getAiWorkforceStats,
  getEmployeeKpis,
  kpisForEmployee,
  statsForEmployee,
} from "@/server/services/ai-employee-stats";
import {
  AI_EMPLOYEE_STATUSES,
  STATUS_LABELS,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  statusLabel,
  relativeTime,
  countByStatus,
} from "@/lib/ai-employees/model";
import {
  aggregateWorkforce,
  formatRate,
  type WorkforceSummary,
} from "@/lib/ai-employees/stats";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { statusStyle, accentClasses } from "./_styles";
import { EmployeeIcon } from "./_icon";
import { ApprovalLevelBadge } from "./_cards";

/**
 * AI Boardroom — roster grid (CEO Directive 001, Phase 1).
 *
 * Product UX rebuild (HQ phase): re-skinned off the old dark/neon surface onto
 * the light operational system (Stripe/Linear clarity, not "AI magic"). The
 * roster stays grouped by department; each card now communicates only the seven
 * things a leader reads at a glance — name, role, status, current focus, last
 * activity, approval rung, and whether it needs approval — with the deeper
 * Confidence/ETA/Health cards moved into the employee workspace where they
 * belong (and off the roster's hot read path).
 *
 * FRAMEWORK ONLY — every card is configuration + logged history. No employee
 * runs anything; the banner makes that explicit and honest.
 */

type SP = Promise<{ q?: string; dept?: string; status?: string }>;

/** Status → design-system tone. `blocked` (no orange tone) reads as amber "attention". */
const STATUS_TONE: Record<string, "slate" | "emerald" | "amber" | "red"> = {
  idle: "slate",
  working: "emerald",
  waiting_approval: "amber",
  blocked: "amber",
  error: "red",
  disabled: "slate",
};

function buildHref(params: { q: string; dept: string; status: string }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.dept) sp.set("dept", params.dept);
  if (params.status) sp.set("status", params.status);
  const qs = sp.toString();
  return qs ? `/admin/ai-boardroom?${qs}` : "/admin/ai-boardroom";
}

export default async function AiBoardroomPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const [employees, workforce] = await Promise.all([
    listAiEmployees(),
    getAiWorkforceStats(),
  ]);
  // The explicit 1–5 approval level per employee, derived from the served posture the Capability
  // Registry resolves (deterministic classification — no new authority; see approval-levels.ts).
  const approvalLevels = await resolveApprovalLevelsByEmployeeId(employees);
  // Current UK-month KPIs per employee (tasks/cost/failure-rate) — honest
  // derived figures from hq_ai_tasks + hq_approvals + the attributed AI cost
  // ledger; this read path also PERSISTS the period row (compute-on-read
  // upsert into ai_employee_kpis).
  const kpis = await getEmployeeKpis(
    employees.map((e) => ({ id: e.id, slug: e.slug })),
  );
  // slug → display name, for the "Reports to" line on each card.
  const nameBySlug = new Map(employees.map((e) => [e.slug, e.name] as const));

  const q = (sp.q ?? "").trim().toLowerCase();
  const dept = (sp.dept ?? "").trim();
  const status = (sp.status ?? "").trim();

  const counts = countByStatus(employees);
  const summary = aggregateWorkforce(
    employees,
    employees.map((e) => statsForEmployee(workforce, e.id)),
  );

  const filtered = employees.filter(
    (e) =>
      (!q ||
        e.name.toLowerCase().includes(q) ||
        e.role.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.slug.includes(q)) &&
      (!dept || e.department === dept) &&
      (!status || e.status === status),
  );

  const hasFilters = Boolean(q || dept || status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Boardroom"
        description="Your AI employee roster — roles, permissions, and logged activity. Configure each one; a human always approves."
        actions={
          <Badge tone="amber" className="gap-1.5 px-3 py-1">
            <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Framework mode · no autonomous execution
          </Badge>
        }
      />

      {/* Workforce telemetry — roster-level framework figures (configured +
          logged, under the framework banner; not live autonomous activity). */}
      <WorkforceStrip summary={summary} />

      {/* Status summary cards double as quick status filters. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {AI_EMPLOYEE_STATUSES.map((s) => {
          const active = status === s;
          const st = statusStyle(s);
          return (
            <Link
              key={s}
              href={buildHref({ q, dept, status: active ? "" : s })}
              aria-pressed={active}
              className={`rounded-xl border p-3 transition ${
                active
                  ? "border-slate-400 bg-slate-100"
                  : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`inline-block h-2 w-2 rounded-full ${st.dot}`} aria-hidden />
                <span className="text-2xl font-bold tabular-nums text-slate-900">
                  {counts[s]}
                </span>
              </div>
              <p className="mt-1 text-[11px] font-medium text-slate-500">
                {STATUS_LABELS[s]}
              </p>
            </Link>
          );
        })}
      </div>

      {/* Search + department filter */}
      <form
        method="GET"
        action="/admin/ai-boardroom"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
      >
        <input type="hidden" name="status" value={status} />
        <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-500">
          Search
          <div className="relative mt-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Name, role, description…"
              className="block w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
            />
          </div>
        </label>
        <label className="text-[11px] font-medium text-slate-500">
          Department
          <select
            name="dept"
            defaultValue={dept}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300"
          >
            <option value="">All departments</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {DEPARTMENT_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass("primary", "sm")}>
          Apply
        </button>
        {hasFilters ? (
          <Link href="/admin/ai-boardroom" className={buttonClass("secondary", "sm")}>
            Reset
          </Link>
        ) : null}
        <p className="ml-auto text-[11px] text-slate-500">
          {filtered.length} of {employees.length} shown
        </p>
      </form>

      {/* Employee grid, grouped by department */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <p className="text-sm text-slate-500">
            No AI employees match the current filters.
          </p>
          {hasFilters ? (
            <Link
              href="/admin/ai-boardroom"
              className="mt-2 inline-block text-xs font-medium text-slate-700 underline hover:text-slate-900"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="space-y-8">
          {DEPARTMENTS.filter((d) => filtered.some((e) => e.department === d)).map((d) => {
            const deptItems = filtered.filter((e) => e.department === d);
            return (
              <section key={d}>
                {/* Grouped by department so the 32-strong workforce reads as an org. */}
                <div className="mb-3 flex items-baseline gap-2 border-b border-slate-200 pb-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                    {DEPARTMENT_LABELS[d]}
                  </h2>
                  <span className="text-xs text-slate-400">{deptItems.length}</span>
                </div>
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {deptItems.map((e) => {
                    const accent = accentClasses(e.accent);
                    const stats = statsForEmployee(workforce, e.id);
                    const level = approvalLevels.get(e.id);
                    const needsApproval = e.status === "waiting_approval";
                    return (
                      <li key={e.id}>
                        <Link
                          href={`/admin/ai-boardroom/${e.slug}`}
                          className="group flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <span
                                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${accent.icon}`}
                              >
                                <EmployeeIcon icon={e.icon} className="h-5 w-5" />
                              </span>
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-slate-900">
                                  {e.name}
                                </p>
                                <p className="truncate text-xs text-slate-500">{e.role}</p>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1.5">
                              <StatusPill status={e.status} />
                              {level ? <ApprovalLevelBadge result={level} /> : null}
                            </div>
                          </div>

                          {/* Management line (relationships.md §2). Null = the human board. */}
                          <p className="mt-2 text-[11px] text-slate-500">
                            Reports to{" "}
                            <span className="font-medium text-slate-700">
                              {e.manager_slug
                                ? (nameBySlug.get(e.manager_slug) ?? e.manager_slug)
                                : "Human board"}
                            </span>
                          </p>

                          {/* Current focus (configured) */}
                          <div className="mt-3 min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              Current focus
                            </p>
                            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-slate-600">
                              {e.current_task ?? "—"}
                            </p>
                          </div>

                          {/* This month's honest KPIs — engine tasks, attributed
                              AI cost, failure rate. Derived, never invented. */}
                          {(() => {
                            const k = kpisForEmployee(kpis, e.slug);
                            return (
                              <p className="mt-2 text-[11px] tabular-nums text-slate-500">
                                This month: {k.tasksCompleted} done · {k.tasksFailed}{" "}
                                failed
                                {k.failureRatePct !== null
                                  ? ` (${k.failureRatePct}% fail)`
                                  : ""}{" "}
                                · £{(k.costPence / 100).toFixed(2)} AI cost
                              </p>
                            );
                          })()}

                          {/* Needs-approval flag — the honest per-card signal. */}
                          {needsApproval ? (
                            <div className="mt-3">
                              <Badge tone="amber" variant="soft">
                                Needs your approval
                              </Badge>
                            </div>
                          ) : null}

                          <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-500">
                            <span className="inline-flex items-center gap-1.5 font-medium uppercase tracking-wide">
                              {departmentLabel(e.department)}
                            </span>
                            <span className="normal-case">
                              {stats.lastCompletedTitle
                                ? `Last: ${relativeTime(e.last_activity_at)}`
                                : `Active ${relativeTime(e.last_activity_at)}`}
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Status pill — the design-system Badge, with a solid dot that keeps the six
 *  statuses distinguishable (incl. blocked/orange) beyond the tone alone. */
function StatusPill({ status }: { status: string }) {
  const st = statusStyle(status);
  return (
    <Badge tone={STATUS_TONE[status] ?? "slate"} className="gap-1.5 text-[10px]">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${st.dot}`} aria-hidden />
      {statusLabel(status)}
    </Badge>
  );
}

/**
 * Headline workforce KPIs across the whole roster. These are the FRAMEWORK's
 * configured + logged figures (task notes are authored on this surface), shown
 * under the framework-mode banner — not a claim of live autonomous work.
 */
function WorkforceStrip({ summary }: { summary: WorkforceSummary }) {
  return (
    <section>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        AI workforce
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Active now"
          value={String(summary.activeWorkers)}
          hint={`of ${summary.totalEmployees} employees`}
          tone="emerald"
        />
        <StatTile
          label="Tasks today"
          value={String(summary.tasksToday)}
          hint={`${summary.tasksInProgress} in progress`}
          tone="blue"
        />
        <StatTile
          label="Success rate"
          value={formatRate(summary.successRatePct)}
          hint={`${summary.completedTotal} done · ${summary.failedTotal} failed`}
          tone="indigo"
        />
        <StatTile
          label="Avg completion"
          value={summary.avgCompletionLabel}
          hint={`${summary.totalMemoryEntries} memories · ${summary.memoryUsageLabel}`}
          tone="amber"
        />
      </div>
    </section>
  );
}

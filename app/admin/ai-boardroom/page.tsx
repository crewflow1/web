import Link from "next/link";
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Search,
  ShieldOff,
  Timer,
  Users,
} from "lucide-react";
import { listAiEmployees } from "@/server/services/ai-employees";
import {
  getAiWorkforceStats,
  statsForEmployee,
} from "@/server/services/ai-employee-stats";
import {
  AI_EMPLOYEE_STATUSES,
  STATUS_LABELS,
  STATUS_PULSE,
  DEPARTMENTS,
  DEPARTMENT_LABELS,
  departmentLabel,
  statusLabel,
  countByStatus,
} from "@/lib/ai-employees/model";
import {
  aggregateWorkforce,
  formatRate,
  type WorkforceSummary,
} from "@/lib/ai-employees/stats";
import { statusStyle, accentClasses } from "./_styles";
import { EmployeeIcon } from "./_icon";

/**
 * AI Boardroom — roster grid (CEO Directive 001, Phase 1).
 *
 * Premium dark surface inside the (light) HQ shell. Shows the AI
 * employee roster as status-aware cards with per-status summary
 * counts, search, and department/status filters. URL params drive
 * search + filters so refresh and shared links keep state.
 *
 * FRAMEWORK ONLY — every card is configuration + history. No employee
 * runs anything; the banner makes that explicit.
 */

type SP = Promise<{ q?: string; dept?: string; status?: string }>;

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
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header with subtle glow */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <BrainCircuit className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                AI Boardroom
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                Your AI employee roster — roles, prompts, permissions, and
                activity history. Configure each one; a human always approves.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
            <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Framework mode · no autonomous execution
          </span>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Workforce telemetry — headline KPIs across the whole roster */}
        <WorkforceStrip summary={summary} />

        {/* Status summary cards (also act as quick status filters) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {AI_EMPLOYEE_STATUSES.map((s) => {
            const active = status === s;
            const st = statusStyle(s);
            return (
              <Link
                key={s}
                href={buildHref({ q, dept, status: active ? "" : s })}
                aria-pressed={active}
                className={`rounded-xl border p-3 transition duration-200 ${
                  active
                    ? "border-slate-600 bg-slate-800"
                    : "border-slate-800 bg-slate-900/50 hover:-translate-y-0.5 hover:border-slate-700 hover:bg-slate-900"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${st.dot}`}
                    aria-hidden
                  />
                  <span className="text-2xl font-bold tabular-nums text-white">
                    {counts[s]}
                  </span>
                </div>
                <p className="mt-1 text-[11px] font-medium text-slate-400">
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
          className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
        >
          <input type="hidden" name="status" value={status} />
          <label className="min-w-[200px] flex-1 text-[11px] font-medium text-slate-400">
            Search
            <div className="relative mt-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                type="search"
                name="q"
                defaultValue={sp.q ?? ""}
                placeholder="Name, role, description…"
                className="block w-full rounded-md border border-slate-700 bg-slate-950 py-1.5 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </label>
          <label className="text-[11px] font-medium text-slate-400">
            Department
            <select
              name="dept"
              defaultValue={dept}
              className="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="">All departments</option>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {DEPARTMENT_LABELS[d]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            Apply
          </button>
          {hasFilters ? (
            <Link
              href="/admin/ai-boardroom"
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
            >
              Reset
            </Link>
          ) : null}
          <p className="ml-auto text-[11px] text-slate-500">
            {filtered.length} of {employees.length} shown
          </p>
        </form>

        {/* Employee grid */}
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-16 text-center">
            <p className="text-sm text-slate-400">
              No AI employees match the current filters.
            </p>
            {hasFilters ? (
              <Link
                href="/admin/ai-boardroom"
                className="mt-2 inline-block text-xs font-medium text-indigo-400 hover:text-indigo-300"
              >
                Clear filters
              </Link>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((e) => {
              const accent = accentClasses(e.accent);
              const stats = statsForEmployee(workforce, e.id);
              return (
                <li key={e.id}>
                  <Link
                    href={`/admin/ai-boardroom/${e.slug}`}
                    className={`group relative flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl ${accent.ring} ${accent.glow}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${accent.icon}`}
                        >
                          <EmployeeIcon icon={e.icon} className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-white">
                            {e.name}
                          </p>
                          <p className="truncate text-xs text-slate-400">
                            {e.role}
                          </p>
                        </div>
                      </div>
                      <StatusPill status={e.status} />
                    </div>

                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {e.description}
                    </p>

                    {/* Live workforce telemetry */}
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <CardStat
                        label="Today"
                        value={String(stats.tasksToday)}
                        accent={accent.text}
                      />
                      <CardStat
                        label="Success"
                        value={formatRate(stats.successRatePct)}
                        accent={accent.text}
                      />
                      <CardStat
                        label="Avg time"
                        value={stats.avgCompletionLabel}
                        accent={accent.text}
                      />
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                      <div className="min-w-0">
                        <dt className="text-slate-500">Current task</dt>
                        <dd className="truncate text-slate-300">
                          {e.current_task ?? "—"}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-slate-500">Last completed</dt>
                        <dd className="truncate text-slate-300">
                          {stats.lastCompletedTitle ?? "—"}
                        </dd>
                      </div>
                    </dl>

                    <div className="mt-3 flex items-center justify-between border-t border-slate-800 pt-3">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        {departmentLabel(e.department)}
                        <span className="text-slate-700">·</span>
                        <span className="normal-case text-slate-500">
                          v{stats.knowledgeVersion} · {stats.memoryUsageLabel}
                        </span>
                      </span>
                      <span className="text-xs font-medium text-slate-400 transition group-hover:text-white">
                        Open →
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const st = statusStyle(status);
  const pulse = (STATUS_PULSE as Record<string, boolean>)[status] ?? false;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${st.pill}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {pulse ? (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${st.dot} opacity-75`}
            aria-hidden
          />
        ) : null}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${st.dot}`}
          aria-hidden
        />
      </span>
      {statusLabel(status)}
    </span>
  );
}

/** Headline workforce KPIs across the whole roster (CEO Directive 004, P3). */
function WorkforceStrip({ summary }: { summary: WorkforceSummary }) {
  const tiles: Array<{
    label: string;
    value: string;
    sub: string;
    icon: typeof Users;
    chip: string;
    value_cls: string;
  }> = [
    {
      label: "Active now",
      value: String(summary.activeWorkers),
      sub: `of ${summary.totalEmployees} employees`,
      icon: Users,
      chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
      value_cls: "text-emerald-300",
    },
    {
      label: "Tasks today",
      value: String(summary.tasksToday),
      sub: `${summary.tasksInProgress} in progress`,
      icon: Activity,
      chip: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
      value_cls: "text-sky-300",
    },
    {
      label: "Success rate",
      value: formatRate(summary.successRatePct),
      sub: `${summary.completedTotal} done · ${summary.failedTotal} failed`,
      icon: CheckCircle2,
      chip: "bg-indigo-500/15 text-indigo-300 ring-indigo-400/30",
      value_cls: "text-indigo-300",
    },
    {
      label: "Avg completion",
      value: summary.avgCompletionLabel,
      sub: `${summary.totalMemoryEntries} memories · ${summary.memoryUsageLabel}`,
      icon: Timer,
      chip: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
      value_cls: "text-amber-300",
    },
  ];
  return (
    <section>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        AI workforce
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <div
              key={t.label}
              className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {t.label}
                </p>
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset ${t.chip}`}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                </span>
              </div>
              <p
                className={`mt-2 text-2xl font-bold tabular-nums ${t.value_cls}`}
              >
                {t.value}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">
                {t.sub}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Compact per-employee telemetry cell used inside a roster card. */
function CardStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className={`mt-0.5 truncate text-sm font-bold tabular-nums ${accent}`}>
        {value}
      </p>
    </div>
  );
}

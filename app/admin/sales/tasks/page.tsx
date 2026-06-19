import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import { Building2, ListChecks, Plus } from "lucide-react";
import {
  getAiTaskCounts,
  listAiTasks,
  listTaskTypes,
} from "@/server/services/hq-sales";
import { listAiEmployees } from "@/server/services/ai-employees";
import {
  AI_TASK_PRIORITIES,
  AI_TASK_PRIORITY_LABELS,
  AI_TASK_STATUSES,
  aiTaskPriorityLabel,
  aiTaskStatusLabel,
  departmentLabel,
  relativeTime,
  type SalesTaskItem,
  type SalesTaskType,
} from "@/lib/sales/model";
import type { AiEmployee } from "@/lib/ai-employees/model";
import {
  AiTaskStatusPill,
  Chip,
  EmptyState,
  Field,
  Section,
  Tile,
} from "../_components";
import { inputCls, selectCls } from "../_styles";
import { enqueueAiTaskAction } from "../actions";

/**
 * Sales AI — AI Task Queue (CEO Directive 003, scale expansion).
 *
 * The durable foundation for autonomous AI workers. Every scheduled unit of
 * work — research, outreach, calls, follow-ups — lives here with its status
 * (pending / running / completed / failed / cancelled), priority, retry
 * count, assigned AI employee, and timestamps. NO worker executes anything
 * yet: this is the audited, queue-ordered foundation the directive asks for
 * ("Design once. Scale forever."). HQ Super Admin only (gated by the admin
 * layout). The view is URL-driven so a refresh or shared link restores it.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ status?: string; type?: string; show?: string }>;

const WINDOWS = [100, 250, 500] as const;

export default async function SalesTasksPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;

  const statusFilter = (AI_TASK_STATUSES as readonly string[]).includes(
    sp.status ?? "",
  )
    ? sp.status
    : undefined;
  const requested = Number.parseInt(sp.show ?? "100", 10);
  const limit = WINDOWS.includes(requested as (typeof WINDOWS)[number])
    ? requested
    : 100;

  const [counts, taskTypes, employees] = await Promise.all([
    getAiTaskCounts(),
    listTaskTypes(),
    listAiEmployees(),
  ]);

  const typeFilter = taskTypes.some((t) => t.slug === sp.type)
    ? sp.type
    : undefined;

  const tasks = await listAiTasks({
    status: statusFilter,
    taskType: typeFilter,
    limit,
  });

  const total =
    counts.pending +
    counts.running +
    counts.completed +
    counts.failed +
    counts.cancelled;
  const open = counts.pending + counts.running;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          / <span className="text-slate-300">Task queue</span>
        </p>

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <ListChecks className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white">
                AI task queue
              </h1>
              <p className="text-xs text-slate-400">
                The foundation for autonomous AI workers. No task runs yet —
                every row is durable, prioritised, and fully audited.
              </p>
            </div>
          </div>
        </div>

        {/* Status counts */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total" value={<AnimatedNumber value={total} />} accent />
          <Tile label="Open" value={<AnimatedNumber value={open} />} sub="pending + running" />
          <Tile label="Pending" value={<AnimatedNumber value={counts.pending} />} />
          <Tile label="Running" value={<AnimatedNumber value={counts.running} />} />
          <Tile label="Completed" value={<AnimatedNumber value={counts.completed} />} />
          <Tile label="Failed" value={<AnimatedNumber value={counts.failed} />} />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusTab label="All" href={tasksHref(undefined, typeFilter, limit)} active={!statusFilter} />
          {AI_TASK_STATUSES.map((s) => (
            <StatusTab
              key={s}
              label={`${aiTaskStatusLabel(s)} · ${counts[s].toLocaleString()}`}
              href={tasksHref(s, typeFilter, limit)}
              active={statusFilter === s}
            />
          ))}
          <form method="get" className="ml-auto flex items-center gap-2">
            {statusFilter ? (
              <input type="hidden" name="status" value={statusFilter} />
            ) : null}
            {limit !== 100 ? (
              <input type="hidden" name="show" value={limit} />
            ) : null}
            <select name="type" defaultValue={typeFilter ?? ""} className={selectCls}>
              <option value="">All task types</option>
              {taskTypes.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
            >
              Filter
            </button>
          </form>
        </div>

        {/* Queue */}
        {tasks.length === 0 ? (
          <EmptyState
            message={
              statusFilter || typeFilter
                ? "No tasks match this filter."
                : "No tasks scheduled yet. Schedule one below, or from any company record."
            }
          />
        ) : (
          <Section
            title="Queue"
            subtitle="Highest priority first, then oldest. Company-scoped tasks link to their record."
          >
            <ul className="space-y-2">
              {tasks.map((t) => (
                <TaskQueueRow key={t.id} task={t} />
              ))}
            </ul>
          </Section>
        )}

        {/* Schedule a global task */}
        <Section
          title="Schedule a task"
          subtitle="Queue work for a future autonomous worker. Leave company blank for a database-wide job."
        >
          <EnqueueGlobalTaskForm taskTypes={taskTypes} employees={employees} />
        </Section>

        {/* Window controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <span className="text-[11px] text-slate-500">Show up to</span>
          {WINDOWS.map((w) => {
            const active = w === limit;
            return (
              <Link
                key={w}
                href={tasksHref(statusFilter, typeFilter, w)}
                aria-current={active ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-slate-700 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {w}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helpers + sub-views.
// ---------------------------------------------------------------------

function tasksHref(
  status: string | undefined,
  type: string | undefined,
  show: number,
): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  if (show !== 100) params.set("show", String(show));
  const qs = params.toString();
  return qs ? `/admin/sales/tasks?${qs}` : "/admin/sales/tasks";
}

function StatusTab({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "border-indigo-500 bg-indigo-600 text-white"
          : "border-slate-700 text-slate-300 hover:bg-slate-800"
      }`}
    >
      {label}
    </Link>
  );
}

function TaskQueueRow({ task: t }: { task: SalesTaskItem }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-200">
            {t.task_type.replace(/_/g, " ")}
          </span>
          <AiTaskStatusPill status={t.status} />
          <Chip>{aiTaskPriorityLabel(t.priority)}</Chip>
          {t.retry_count > 0 ? (
            <Chip>
              retry {t.retry_count}/{t.max_retries}
            </Chip>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          {t.company_id && t.company_name ? (
            <Link
              href={`/admin/sales/companies/${t.company_id}`}
              className="inline-flex items-center gap-1 font-medium text-indigo-400 transition-colors hover:text-indigo-300"
            >
              <Building2 className="h-3 w-3" aria-hidden />
              {t.company_name}
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-3 w-3" aria-hidden />
              Database-wide
            </span>
          )}
          {t.scheduled_at ? (
            <span>Scheduled {relativeTime(t.scheduled_at)}</span>
          ) : (
            <span>Queued {relativeTime(t.created_at)}</span>
          )}
          {t.error_message ? (
            <span className="text-red-300">{t.error_message}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function EnqueueGlobalTaskForm({
  taskTypes,
  employees,
}: {
  taskTypes: SalesTaskType[];
  employees: AiEmployee[];
}) {
  return (
    <form action={enqueueAiTaskAction} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Task type">
          <select name="task_type" defaultValue={taskTypes[0]?.slug ?? ""} className={selectCls}>
            {taskTypes.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue="normal" className={selectCls}>
            {AI_TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {AI_TASK_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scheduled for" hint="optional">
          <input name="scheduled_at" type="datetime-local" className={inputCls} />
        </Field>
        <Field label="Max retries" hint="0–10">
          <input name="max_retries" type="number" min={0} max={10} defaultValue={3} className={inputCls} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Assign AI employee" hint="optional">
          <select name="assigned_ai_employee_id" defaultValue="" className={selectCls}>
            <option value="">— Unassigned —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({departmentLabel(e.department)})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dedupe key" hint="optional — prevents duplicates">
          <input name="dedupe_key" type="text" maxLength={200} className={inputCls} />
        </Field>
      </div>
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Schedule task
      </button>
    </form>
  );
}

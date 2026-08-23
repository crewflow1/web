import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock3,
  ShieldCheck,
  Hourglass,
} from "lucide-react";
import {
  getTaskQueueOverview,
  type EmployeeQueueSummary,
  type QueueBucket,
  type TaskQueueRow,
} from "@/server/services/hq-task-queue";
import { RELATIVE_TIME_PRESETS, relativeTime } from "@/lib/time/relative";
import { PageHeader } from "@/components/ui/page-header";
import { StatTile } from "@/components/ui/stat-tile";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/tokens";
import { presentTaskState } from "@/lib/hq/presentation-state";
import { DecisionStateBadge } from "@/app/admin/_components/decision-state";

/**
 * AI Task Queue — the unified operator read model for the Generic Task Engine
 * (CEO Directive #012 / D-02, PR-G).
 *
 * One screen for the whole autonomous workforce on the shared queue: engine-wide
 * totals up top, a per-employee breakdown of recent load, and a live feed of the
 * newest tasks across every type. It renders whatever the engine holds — no task
 * type is named here, so a newly migrated employee shows up automatically.
 *
 * Product UX rebuild (HQ phase): re-skinned off the old dark island onto the
 * light operational system, and the live feed now speaks the ONE HQ decision
 * language (lib/hq/presentation-state) so a task's state reads the same word as
 * an approval or a saga. Read-only + HQ-gated by app/admin/layout.tsx; the data
 * comes from hq-task-queue.ts, which only ever SELECTs hq_ai_tasks.
 */

export const dynamic = "force-dynamic";

const BUCKET_LABEL: Record<QueueBucket, string> = {
  queued: "Queued",
  active: "Active",
  waiting_approval: "Approval",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/** Count-chip tone per bucket (light, AA-verified tones). */
const BUCKET_TONE: Record<QueueBucket, Tone> = {
  queued: "slate",
  active: "indigo",
  waiting_approval: "amber",
  completed: "emerald",
  failed: "red",
  blocked: "amber",
  cancelled: "slate",
};

// The buckets surfaced in the per-employee breakdown, in operator-priority order.
const SUMMARY_BUCKETS: ReadonlyArray<QueueBucket> = [
  "active",
  "queued",
  "waiting_approval",
  "completed",
  "failed",
];

export default async function TaskQueuePage() {
  const overview = await getTaskQueueOverview();
  const { totals, byType, recent, windowSize, windowCap } = overview;

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Task Queue"
        description="The Generic Task Engine — one durable queue every AI employee runs on. Each task is leased, heart-beated and traced on the event spine. Employees come and go; this surface stays the same."
        actions={
          <Badge tone="emerald" className="gap-1.5 px-3 py-1">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Read-only · service-role · every action audited
          </Badge>
        }
      />

      {/* Engine-wide totals (exact) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total tasks" value={totals.total.toLocaleString()} tone="indigo" />
        <StatTile label="Queued" value={totals.queued.toLocaleString()} hint="waiting to run" />
        <StatTile label="Active" value={totals.active.toLocaleString()} hint="leased right now" />
        <StatTile label="Awaiting approval" value={totals.waitingApproval.toLocaleString()} tone="amber" />
        <StatTile label="Completed" value={totals.completed.toLocaleString()} tone="emerald" />
        <StatTile label="Failed" value={totals.failed.toLocaleString()} tone="red" />
      </div>

      {/* Per-employee breakdown (recent-activity window) */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-slate-400" aria-hidden />
            <h2 className="text-sm font-semibold text-slate-900">Workforce on the engine</h2>
          </div>
          <span className="text-[11px] text-slate-500">
            {windowSize >= windowCap
              ? `latest ${windowCap.toLocaleString()} tasks`
              : `all ${windowSize.toLocaleString()} task${windowSize === 1 ? "" : "s"}`}
          </span>
        </div>
        {byType.length === 0 ? (
          <EmptyState>
            No tasks on the engine yet. As soon as an AI employee enqueues work, its
            task type appears here.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {byType.map((t) => (
              <EmployeeRow key={t.taskType} summary={t} />
            ))}
          </ul>
        )}
      </section>

      {/* Live feed */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-slate-400" aria-hidden />
          <h2 className="text-sm font-semibold text-slate-900">Most recent tasks</h2>
        </div>
        {recent.length === 0 ? (
          <EmptyState>The queue is quiet — nothing has run yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recent.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmployeeRow({ summary }: { summary: EmployeeQueueSummary }) {
  const title = summary.employee?.name ?? humaniseType(summary.taskType);
  const dept = summary.employee?.department;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          {title}
          {dept ? (
            <Badge tone="slate" className="text-[10px] uppercase tracking-wide">
              {dept}
            </Badge>
          ) : null}
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">{summary.taskType}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SUMMARY_BUCKETS.map((b) =>
          summary.buckets[b] > 0 ? (
            <Badge key={b} tone={BUCKET_TONE[b]}>
              <span className="tabular-nums">{summary.buckets[b]}</span> {BUCKET_LABEL[b]}
            </Badge>
          ) : null,
        )}
        {summary.lastActivityAt ? (
          <span className="ml-1 text-[11px] text-slate-500">
            {relativeTime(summary.lastActivityAt, RELATIVE_TIME_PRESETS.hqConsole)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function TaskRow({ task }: { task: TaskQueueRow }) {
  const when = task.finishedAt ?? task.startedAt ?? task.createdAt;
  const who = task.employee?.name ?? humaniseType(task.taskType);
  const retrying = task.retryCount > 0;
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
          <DecisionStateBadge badge={presentTaskState(task.status)} />
          <span className="truncate">{who}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span className="font-mono">{task.taskType}</span>
          {task.subjectKind !== "none" ? <span>· {task.subjectKind}</span> : null}
          {retrying ? (
            <span className="text-amber-700">
              · retry {task.retryCount}/{task.maxRetries}
            </span>
          ) : null}
          {task.origin && task.origin !== "manual" ? <span>· {task.origin}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <BucketGlyph bucket={task.bucket} />
        {when ? (
          <span className="text-[11px] text-slate-500">
            {relativeTime(when, RELATIVE_TIME_PRESETS.hqConsole)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function BucketGlyph({ bucket }: { bucket: QueueBucket }) {
  const cls = "h-4 w-4";
  switch (bucket) {
    case "completed":
      return <CheckCircle2 className={`${cls} text-emerald-600`} aria-hidden />;
    case "failed":
      return <XCircle className={`${cls} text-red-600`} aria-hidden />;
    case "active":
      return <Activity className={`${cls} text-indigo-600`} aria-hidden />;
    case "waiting_approval":
      return <Hourglass className={`${cls} text-amber-600`} aria-hidden />;
    default:
      return <Clock3 className={`${cls} text-slate-400`} aria-hidden />;
  }
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

/** `research_company` → "Research company" — a humane fallback when no employee
 *  identity is joined (the migrated employees always stamp one, so this is the
 *  rare edge). */
function humaniseType(taskType: string): string {
  const spaced = taskType.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : taskType;
}

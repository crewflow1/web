import {
  Radar,
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

/**
 * AI Task Queue — the unified operator read model for the Generic Task Engine
 * (CEO Directive #012 / D-02, PR-G).
 *
 * One screen for the whole autonomous workforce on the shared queue: engine-wide
 * totals up top, a per-employee breakdown of recent load, and a live feed of the
 * newest tasks across every type. It renders whatever the engine holds — no task
 * type is named here, so a newly migrated employee shows up automatically. This
 * is the architectural health metric made visible: the operating system is the
 * thing that grows, not the employee.
 *
 * Read-only + HQ-gated by app/admin/layout.tsx (requireHqPage). The data comes
 * from hq-task-queue.ts, which only ever SELECTs hq_ai_tasks.
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

const BUCKET_PILL: Record<QueueBucket, string> = {
  queued: "bg-slate-700/40 text-slate-300 ring-slate-500/30",
  active: "bg-indigo-500/15 text-indigo-300 ring-indigo-400/30",
  waiting_approval: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
  blocked: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  cancelled: "bg-slate-700/30 text-slate-400 ring-slate-600/30",
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
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
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
              <Radar className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">AI Task Queue</h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                The Generic Task Engine — one durable queue every AI employee runs
                on. Each task is leased, heart-beated and traced on the event spine.
                Employees come and go; this surface stays the same.
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Read-only · service-role · every action audited
          </span>
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-7">
        {/* Engine-wide totals (exact) */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total tasks" value={totals.total} accent />
          <Tile label="Queued" value={totals.queued} sub="waiting to run" />
          <Tile label="Active" value={totals.active} sub="leased right now" />
          <Tile label="Awaiting approval" value={totals.waitingApproval} />
          <Tile label="Completed" value={totals.completed} />
          <Tile label="Failed" value={totals.failed} />
        </div>

        {/* Per-employee breakdown (recent-activity window) */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-slate-400" aria-hidden />
              <h2 className="text-sm font-semibold text-white">Workforce on the engine</h2>
            </div>
            <span className="text-[11px] text-slate-500">
              {windowSize >= windowCap
                ? `latest ${windowCap.toLocaleString()} tasks`
                : `all ${windowSize.toLocaleString()} task${windowSize === 1 ? "" : "s"}`}
            </span>
          </div>
          {byType.length === 0 ? (
            <EmptyState>
              No tasks on the engine yet. As soon as an AI employee enqueues work,
              its task type appears here.
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
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-slate-400" aria-hidden />
            <h2 className="text-sm font-semibold text-white">Most recent tasks</h2>
          </div>
          {recent.length === 0 ? (
            <EmptyState>The queue is quiet — nothing has run yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {recent.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? "border-indigo-400/30 bg-indigo-500/[0.07] ring-1 ring-inset ring-indigo-400/20"
          : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <p className="text-2xl font-bold tabular-nums text-white">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-xs font-medium text-slate-300">{label}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

function EmployeeRow({ summary }: { summary: EmployeeQueueSummary }) {
  const title = summary.employee?.name ?? humaniseType(summary.taskType);
  const dept = summary.employee?.department;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-white">
          {title}
          {dept ? (
            <span className="rounded-full bg-slate-700/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
              {dept}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">{summary.taskType}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {SUMMARY_BUCKETS.map((b) =>
          summary.buckets[b] > 0 ? (
            <span
              key={b}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${BUCKET_PILL[b]}`}
            >
              <span className="tabular-nums">{summary.buckets[b]}</span>
              {BUCKET_LABEL[b]}
            </span>
          ) : null,
        )}
        {summary.lastActivityAt ? (
          <span className="ml-1 text-[11px] text-slate-500">
            {relativeTime(summary.lastActivityAt)}
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
        <p className="flex items-center gap-2 text-sm font-medium text-white">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${BUCKET_PILL[task.bucket]}`}
          >
            {task.status}
          </span>
          <span className="truncate">{who}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span className="font-mono">{task.taskType}</span>
          {task.subjectKind !== "none" ? <span>· {task.subjectKind}</span> : null}
          {retrying ? (
            <span className="text-amber-400/80">
              · retry {task.retryCount}/{task.maxRetries}
            </span>
          ) : null}
          {task.origin && task.origin !== "manual" ? <span>· {task.origin}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <BucketGlyph bucket={task.bucket} />
        {when ? <span className="text-[11px] text-slate-500">{relativeTime(when)}</span> : null}
      </div>
    </li>
  );
}

function BucketGlyph({ bucket }: { bucket: QueueBucket }) {
  const cls = "h-4 w-4";
  switch (bucket) {
    case "completed":
      return <CheckCircle2 className={`${cls} text-emerald-400`} aria-hidden />;
    case "failed":
      return <XCircle className={`${cls} text-red-400`} aria-hidden />;
    case "active":
      return <Activity className={`${cls} text-indigo-400`} aria-hidden />;
    case "waiting_approval":
      return <Hourglass className={`${cls} text-amber-400`} aria-hidden />;
    default:
      return <Clock3 className={`${cls} text-slate-500`} aria-hidden />;
  }
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-500">
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

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

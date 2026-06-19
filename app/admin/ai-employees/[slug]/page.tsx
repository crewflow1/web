import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  Gauge,
  Lock,
  ScrollText,
  Settings2,
  Sparkles,
  UserCircle2,
} from "lucide-react";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { getEmployeeProfile } from "@/server/services/ai-employee-profiles";
import {
  departmentLabel,
  memoryScopeLabel,
  relativeTime,
  statusLabel,
  taskStatusLabel,
} from "@/lib/ai-employees/model";
import { formatRate } from "@/lib/ai-employees/stats";
import {
  Alert,
  Badge,
  EmptyState,
  Fact,
  Meter,
  Panel,
  StatTile,
  Surface,
  type Accent,
} from "@/components/ui";
import { taskStatusPill, toDesignAccent } from "@/components/ai-employees/styles";
import type {
  AuditEntry,
  AuditKind,
  MemoryRef,
  TaskRef,
} from "@/lib/ai-employees/framework";
import {
  AvatarTile,
  DimensionTag,
  FrameworkBadge,
  HealthPill,
  MonoChip,
  healthAccent,
} from "../_components";

/**
 * AI Employee — the full six-dimension profile (CEO Directive 007, Phase 1).
 *
 * One page that renders the entire framework contract for a single employee:
 * Identity · Configuration · Runtime · Memory · Performance · Audit. Live
 * `ai_employees` history binds onto runtime / memory / audit where it exists;
 * everything else renders an honest "foundation" baseline — figures are never
 * invented, and every health signal carries its reason.
 *
 * FRAMEWORK ONLY — execution is locked and there is no control anywhere that
 * enables it. HQ-gated at the layout; re-checked here for defence-in-depth.
 */

type Params = Promise<{ slug: string }>;

export const dynamic = "force-dynamic";

const AUDIT_ACCENT: Record<AuditKind, Accent> = {
  action: "slate",
  decision: "indigo",
  approval: "emerald",
  rejection: "rose",
};

export default async function AiEmployeeDetailPage({
  params,
}: {
  params: Params;
}) {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) notFound();

  const { slug } = await params;
  const detail = await getEmployeeProfile(slug);
  if (!detail) notFound();

  const { employee, profile, seeded } = detail;
  const id = profile.identity;
  const cfg = profile.configuration;
  const rt = profile.runtime;
  const mem = profile.memory;
  const perf = profile.performance;
  const audit = profile.audit;
  const ds = toDesignAccent(id.avatar.accent);
  const responsibilities = employee.responsibilities();

  const auditBuckets: Array<{ label: string; entries: AuditEntry[] }> = [
    { label: "Actions", entries: audit.actions },
    { label: "Decisions", entries: audit.decisions },
    { label: "Approvals", entries: audit.approvals },
    { label: "Rejections", entries: audit.rejections },
  ];
  const auditTotal = auditBuckets.reduce((n, b) => n + b.entries.length, 0);

  const memoryFacets: Array<{ label: string; count: number }> = [
    { label: "Conversation", count: mem.conversationHistory.length },
    { label: "Decisions", count: mem.decisions.length },
    { label: "Outputs", count: mem.previousOutputs.length },
    { label: "Shared company", count: mem.sharedCompany.length },
  ];

  return (
    <Surface>
      <div className="space-y-6 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link
            href="/admin/ai-employees"
            className="hover:text-slate-700 dark:hover:text-slate-300"
          >
            AI Employees
          </Link>
          {" / "}
          <span className="text-slate-700 dark:text-slate-300">{id.name}</span>
        </p>

        {/* Identity banner */}
        <header className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900/40">
          <div
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{
              background:
                "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
            }}
            aria-hidden
          />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <AvatarTile avatar={id.avatar} size="lg" />
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                  {id.name}
                </h1>
                <p className="mt-0.5 text-sm text-slate-500">{id.role}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <HealthPill health={rt.health} />
                  <Badge accent={ds} soft>
                    {departmentLabel(id.department)}
                  </Badge>
                  <Badge accent="slate" soft>
                    {seeded ? "Seeded" : "Foundation"}
                  </Badge>
                </div>
              </div>
            </div>
            <FrameworkBadge />
          </div>
        </header>

        {/* Foundation honesty banner */}
        {profile.foundation ? (
          <Alert
            tone="info"
            icon={<Sparkles aria-hidden />}
            title="Foundation profile"
          >
            This employee is wired through the framework but no execution backend
            is connected. Runtime, memory and audit bind to real history where it
            exists; otherwise every figure is an honest baseline — never invented.
          </Alert>
        ) : null}

        {/* Overview KPIs (runtime + performance at a glance) */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="State"
            value={statusLabel(rt.state)}
            accent={healthAccent(rt.health.tone)}
          />
          <StatTile
            label="Health"
            value={rt.health.label}
            accent={healthAccent(rt.health.tone)}
          />
          <StatTile
            label="Completed"
            value={String(perf.tasksCompleted)}
            accent="emerald"
          />
          <StatTile
            label="Success"
            value={formatRate(perf.successRate)}
            accent="indigo"
          />
          <StatTile
            label="Avg time"
            value={perf.avgCompletionLabel}
            accent="sky"
          />
          <StatTile
            label="Errors"
            value={String(perf.errors)}
            accent={perf.errors > 0 ? "rose" : "slate"}
          />
        </div>

        {/* ===== Dimension 1 — Identity ===== */}
        <Panel
          icon={<UserCircle2 className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Identity"
          subtitle="Who this employee is"
          action={<DimensionTag index={1} />}
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <dl>
              <Fact label="Name" value={id.name} />
              <Fact label="Role" value={id.role} />
              <Fact label="Department" value={departmentLabel(id.department)} />
              <Fact
                label="Slug"
                value={<span className="font-mono text-xs">{id.slug}</span>}
              />
              <Fact label="Avatar" value={`${id.avatar.emoji} ${id.avatar.accent}`} />
            </dl>
            <div>
              <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {id.description}
              </p>
              <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Responsibilities
              </p>
              <ul className="space-y-1.5">
                {responsibilities.map((r) => (
                  <li
                    key={r}
                    className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300"
                  >
                    <CheckCircle2
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400"
                      aria-hidden
                    />
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>

        {/* ===== Dimension 2 — Configuration ===== */}
        <Panel
          icon={<Settings2 className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Configuration"
          subtitle="How the employee is wired — model, prompt, tools, permissions"
          action={<DimensionTag index={2} />}
        >
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <dl>
                <Fact label="Provider" value={cfg.model.provider} />
                <Fact label="Model" value={cfg.model.name} />
                <Fact label="Temperature" value={cfg.model.temperature.toFixed(1)} />
                <Fact
                  label="Memory scope"
                  value={memoryScopeLabel(mem.longTerm.scope)}
                />
              </dl>

              <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Tools
              </p>
              {cfg.tools.length === 0 ? (
                <p className="text-xs text-slate-500">No tools configured.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {cfg.tools.map((t) => (
                    <li key={t}>
                      <MonoChip>{t}</MonoChip>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Permissions
              </p>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                    <Lock
                      className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400"
                      aria-hidden
                    />
                    Execution
                  </span>
                  <Badge accent="rose" soft>
                    Disabled (framework mode)
                  </Badge>
                </li>
                <li className="flex items-center justify-between gap-3">
                  <span className="text-slate-600 dark:text-slate-300">
                    Requires approval
                  </span>
                  <Badge
                    accent={cfg.permissions.requires_approval ? "emerald" : "slate"}
                    soft
                  >
                    {cfg.permissions.requires_approval ? "Yes" : "No"}
                  </Badge>
                </li>
              </ul>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {cfg.permissions.scopes.length === 0 ? (
                  <span className="text-xs text-slate-500">No scopes</span>
                ) : (
                  cfg.permissions.scopes.map((s) => (
                    <MonoChip key={s}>{s}</MonoChip>
                  ))
                )}
              </div>
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Knowledge sources
              </p>
              {cfg.knowledgeSources.length === 0 ? (
                <p className="text-xs text-slate-500">None configured.</p>
              ) : (
                <ul className="space-y-2">
                  {cfg.knowledgeSources.map((k) => (
                    <li
                      key={k.key}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                          {k.label}
                        </span>
                        <Badge accent="slate" soft>
                          {k.kind}
                        </Badge>
                      </div>
                      {k.detail ? (
                        <p className="mt-0.5 text-xs text-slate-500">{k.detail}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Memory sources
              </p>
              <ul className="space-y-2">
                {cfg.memorySources.map((m) => (
                  <li
                    key={m.scope + m.label}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                        {m.label}
                      </span>
                      <Badge accent="slate" soft>
                        {memoryScopeLabel(m.scope)}
                      </Badge>
                    </div>
                    {m.detail ? (
                      <p className="mt-0.5 text-xs text-slate-500">{m.detail}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <details className="mt-6 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900/40">
            <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600 dark:text-slate-300">
              System prompt
              <span className="ml-2 font-normal text-slate-400">
                {cfg.systemPrompt.length.toLocaleString("en-GB")} chars · not sent
                to any model in Phase 1
              </span>
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
              {cfg.systemPrompt}
            </pre>
          </details>
        </Panel>

        {/* ===== Dimension 3 — Runtime ===== */}
        <Panel
          icon={<Activity className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Runtime"
          subtitle="What the employee is doing right now"
          action={<DimensionTag index={3} />}
        >
          <Alert tone="info" className="mb-4">
            <span className="font-medium">Health · {rt.health.label}.</span>{" "}
            {rt.health.reason}
          </Alert>

          <dl className="mb-4">
            <Fact label="State" value={statusLabel(rt.state)} />
            <Fact
              label="Current task"
              value={rt.currentTask ? rt.currentTask.title : "Idle — no active task"}
            />
            <Fact
              label="Confidence"
              value={rt.confidence === null ? "Not measured" : `${rt.confidence}%`}
            />
            <Fact
              label="Estimated completion"
              value={
                rt.estimatedCompletion
                  ? relativeTime(rt.estimatedCompletion)
                  : "Not scheduled"
              }
            />
            <Fact label="Last activity" value={relativeTime(rt.lastActivityAt)} />
          </dl>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Queue ({rt.queue.length})
              </p>
              {rt.queue.length === 0 ? (
                <p className="text-xs text-slate-500">Nothing queued.</p>
              ) : (
                <ul className="space-y-2">
                  {rt.queue.map((t, i) => (
                    <TaskRow key={t.id ?? `q-${i}`} t={t} />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Previous tasks ({rt.previousTasks.length})
              </p>
              {rt.previousTasks.length === 0 ? (
                <p className="text-xs text-slate-500">No completed tasks yet.</p>
              ) : (
                <ul className="space-y-2">
                  {rt.previousTasks.slice(0, 8).map((t, i) => (
                    <TaskRow key={t.id ?? `p-${i}`} t={t} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Panel>

        {/* ===== Dimension 4 — Memory ===== */}
        <Panel
          icon={<BrainCircuit className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Memory"
          subtitle="What the employee remembers"
          action={<DimensionTag index={4} />}
        >
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {memoryFacets.map((f) => (
              <div
                key={f.label}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-center dark:border-slate-800 dark:bg-slate-900/40"
              >
                <p className="text-lg font-bold tabular-nums text-slate-700 dark:text-slate-200">
                  {f.count}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  {f.label}
                </p>
              </div>
            ))}
          </div>

          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Long-term memory · {memoryScopeLabel(mem.longTerm.scope)} (
            {mem.longTerm.entries.length})
          </p>
          {mem.longTerm.entries.length === 0 ? (
            <EmptyState
              icon={<BrainCircuit aria-hidden />}
              title="No long-term memory yet"
              description="Memory entries logged against this employee will surface here."
            />
          ) : (
            <ul className="space-y-2">
              {mem.longTerm.entries.slice(0, 12).map((m, i) => (
                <MemoryRow key={m.id ?? `m-${i}`} m={m} />
              ))}
            </ul>
          )}
        </Panel>

        {/* ===== Dimension 5 — Performance ===== */}
        <Panel
          icon={<Gauge className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Performance"
          subtitle="How well the employee performs"
          action={<DimensionTag index={5} />}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Tasks completed"
              value={String(perf.tasksCompleted)}
              accent="emerald"
            />
            <StatTile
              label="Avg completion"
              value={perf.avgCompletionLabel}
              accent="sky"
            />
            <StatTile
              label="Errors"
              value={String(perf.errors)}
              accent={perf.errors > 0 ? "rose" : "slate"}
            />
            <StatTile
              label="Quality score"
              value={perf.qualityScore === null ? "—" : String(perf.qualityScore)}
              sub={perf.qualityScore === null ? "not measured yet" : undefined}
              accent="violet"
            />
          </div>
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Success rate
              </span>
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {formatRate(perf.successRate)}
              </span>
            </div>
            <Meter value={perf.successRate} accent={ds} />
          </div>
        </Panel>

        {/* ===== Dimension 6 — Audit ===== */}
        <Panel
          icon={<ScrollText className="h-4 w-4" aria-hidden />}
          accent={ds}
          title="Audit"
          subtitle="An immutable trail — every action, decision, approval and rejection"
          action={<DimensionTag index={6} />}
        >
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {auditBuckets.map((b) => (
              <div
                key={b.label}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-center dark:border-slate-800 dark:bg-slate-900/40"
              >
                <p className="text-lg font-bold tabular-nums text-slate-700 dark:text-slate-200">
                  {b.entries.length}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                  {b.label}
                </p>
              </div>
            ))}
          </div>

          {auditTotal === 0 ? (
            <EmptyState
              icon={<ScrollText aria-hidden />}
              title="No audit trail yet"
              description="Configuration changes and logged actions are recorded here. Nothing ever disappears."
            />
          ) : (
            <div className="space-y-5">
              {auditBuckets.map((b) =>
                b.entries.length === 0 ? null : (
                  <div key={b.label}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {b.label} ({b.entries.length})
                    </p>
                    <ul className="space-y-2">
                      {b.entries.slice(0, 8).map((a, i) => (
                        <AuditRow key={a.id ?? `a-${i}`} entry={a} />
                      ))}
                    </ul>
                  </div>
                ),
              )}
            </div>
          )}
        </Panel>
      </div>
    </Surface>
  );
}

// ---------------------------------------------------------------------
// Local row renderers — pure presentation over the framework ref shapes.
// ---------------------------------------------------------------------

function TaskRow({ t }: { t: TaskRef }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-200">
        {t.title}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {t.at ? (
          <span className="text-[11px] text-slate-500">{relativeTime(t.at)}</span>
        ) : null}
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${taskStatusPill(t.status)}`}
        >
          {taskStatusLabel(t.status)}
        </span>
      </div>
    </li>
  );
}

function MemoryRow({ m }: { m: MemoryRef }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-200">
        {m.label}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <Badge accent="slate" soft>
          {memoryScopeLabel(m.kind)}
        </Badge>
        {m.at ? (
          <span className="text-[11px] text-slate-500">{relativeTime(m.at)}</span>
        ) : null}
      </div>
    </li>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-700 dark:text-slate-200">
          {entry.detail ?? entry.action}
        </p>
        {entry.actor ? (
          <p className="mt-0.5 text-[11px] text-slate-500">by {entry.actor}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge accent={AUDIT_ACCENT[entry.kind]} soft>
          {entry.kind}
        </Badge>
        <span className="text-[11px] text-slate-500">
          {relativeTime(entry.at)}
        </span>
      </div>
    </li>
  );
}

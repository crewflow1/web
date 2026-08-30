import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Lock,
  ShieldOff,
  Plus,
  ChevronDown,
  Target,
  Activity,
  CheckCircle2,
  Inbox,
  AlertTriangle,
  KeyRound,
  BarChart3,
  Wrench,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import {
  getEmployeeInteractionFeed,
  getEmployeeRecommendations,
  listAiEmployees,
  loadAiEmployeeBySlug,
  resolveEmployeeApprovalLevel,
  type InteractionItem,
  type RecommendationItem,
} from "@/server/services/ai-employees";
import {
  getEmployeeKpis,
  kpisForEmployee,
} from "@/server/services/ai-employee-stats";
import {
  AI_EMPLOYEE_STATUSES,
  STATUS_LABELS,
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABELS,
  MEMORY_SCOPE_HELP,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  departmentLabel,
  isRetired,
  statusLabel,
  memoryScopeLabel,
  taskStatusLabel,
  relativeTime,
} from "@/lib/ai-employees/model";
import { computeEmployeeStats, formatRate } from "@/lib/ai-employees/stats";
import { getBoardroomCardsForEmployee } from "@/server/services/hq-task-pipeline";
import { accentClasses } from "../_styles";
import { EmployeeIcon } from "../_icon";
import {
  BoardroomCardPanel,
  PipelineStageStrip,
  ApprovalLevelBadge,
  ApprovalLevelPanel,
} from "../_cards";
import {
  updateAiEmployeeConfig,
  addAiEmployeeTask,
  addAiEmployeeMemory,
  authorAiEmployeeCapabilities,
  authorAiEmployeeMemoryScope,
  retireAiEmployee,
} from "../actions";
import {
  getEmployeeMemoryFeed,
  listMemoryTypes,
} from "@/server/services/hq-memory";
import { resolveServedCapabilityView } from "@/server/sdk/registry-parity";
import { MemoryCard, buildTypeMap } from "../../memory/_components";
import { PageHeader, Badge, StatTile, buttonClass, type Tone } from "@/components/ui";
import type { AiEmployeeTask } from "@/lib/ai-employees/model";

/**
 * AI Boardroom — employee detail (CEO Directive 001, Phase 1).
 *
 * Product UX rebuild (HQ phase): re-skinned onto the LIGHT operational design
 * system and reorganised so an executive reads the answers first — what this
 * employee is responsible for, what it's doing now, what it recently produced,
 * what is waiting on a human, what failed, and what authority it holds — before
 * any operator-grade editor. Implementation noise (system prompt, capability
 * tokens, memory-scope editor, raw scopes, audit log) is collapsed behind an
 * intentional "Technical detail" toggle.
 *
 * FRAMEWORK ONLY. Execution is locked. `current_task`, `last_activity_at` and
 * the task/memory rows are HUMAN-AUTHORED configured state on this surface —
 * they are labelled as configured/logged state, never as autonomous AI output.
 * The served approval stance is shown read-only; nothing here enables execution.
 */

type Params = Promise<{ slug: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

export default async function AiEmployeeDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const detail = await loadAiEmployeeBySlug(slug);
  if (!detail) notFound();

  const { employee: e, tasks, memory, activity } = detail;
  const accent = accentClasses(e.accent);

  // Workforce telemetry — derived from the task + memory history already loaded
  // above (no extra query). Architecture only: read + derive.
  const stats = computeEmployeeStats(tasks, memory);

  // The SERVED capability authority (Directive #015 / D-05, LR5.2 — the Read
  // Migration Rule). The authority summary + technical editor read what the
  // runtime SERVES from the now-SOLE-authoritative Capability Registry, with the
  // default-deny floor as the automatic fail-safe. Resolved alongside the
  // read-only shared-memory feed (CEO Directive 002).
  const now = new Date();
  const [
    served,
    approvalLevel,
    memoryFeed,
    memoryTypes,
    boardroomCards,
    interactionFeed,
    recommendations,
    kpiMap,
    roster,
  ] = await Promise.all([
    resolveServedCapabilityView(e),
    resolveEmployeeApprovalLevel(e),
    getEmployeeMemoryFeed({ id: e.id, department: e.department }),
    listMemoryTypes(),
    getBoardroomCardsForEmployee(e.id, now),
    // The employee's real conversation with the company — engine tasks,
    // human config decisions, approvals (see interaction-feed.ts for why
    // this merged feed IS the honest conversation history).
    getEmployeeInteractionFeed(e.slug),
    // The proposals its completed work carries — folded from stored task
    // results, never generated (see recommendations.ts).
    getEmployeeRecommendations(e.slug),
    getEmployeeKpis([{ id: e.id, slug: e.slug }]),
    listAiEmployees(), // manager-name lookup for the management line
  ]);
  const kpi = kpisForEmployee(kpiMap, e.slug);
  const managerName = e.manager_slug
    ? (roster.find((r) => r.slug === e.manager_slug)?.name ?? e.manager_slug)
    : null;
  const retired = isRetired(e.status);
  // The complete served token set seeds the registry-native authoring editor.
  const capabilityTokens = [...served.tokens];
  const memoryTypeMap = buildTypeMap(memoryTypes);
  const feedGroups = [
    { label: "Pinned", items: memoryFeed.pinned },
    { label: "Relevant", items: memoryFeed.relevant },
    { label: `${departmentLabel(e.department)} department`, items: memoryFeed.department },
    { label: "Recently added", items: memoryFeed.recent },
  ];
  const hasFeed = feedGroups.some((g) => g.items.length > 0);

  // Exec-facing task slices — the full history lives in Configure below.
  const completedTasks = tasks.filter((t) => t.status === "completed");
  const waitingTasks = tasks.filter((t) => t.status === "waiting_approval");
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const health = boardroomCards.health;
  const showHealthReasons =
    (health.level === "amber" || health.level === "red") &&
    health.reasons.length > 0;
  const failuresClean = failedTasks.length === 0 && !showHealthReasons;

  const saved = sp.saved ? prettySaved(sp.saved) : null;
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="space-y-6">
      {/* 1 · Header ---------------------------------------------------------- */}
      <PageHeader
        breadcrumb={[
          { label: "AI Boardroom", href: "/admin/ai-boardroom" },
          { label: e.name },
        ]}
        title={
          <span className="flex items-center gap-3">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${accent.icon}`}
            >
              <EmployeeIcon icon={e.icon} className="h-6 w-6" />
            </span>
            <span className="min-w-0 truncate">{e.name}</span>
          </span>
        }
        description={`${e.role} · ${departmentLabel(e.department)} · Reports to ${managerName ?? "the human board"}`}
        actions={
          <>
            <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>
            <ApprovalLevelBadge result={approvalLevel} />
            <Badge tone="amber" className="gap-1.5 px-3 py-1">
              <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Framework mode
            </Badge>
          </>
        }
      />

      {/* Banners */}
      {errorMsg ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMsg}
        </div>
      ) : null}
      {saved ? (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {saved}
        </div>
      ) : null}
      {retired ? (
        <div
          role="status"
          className="rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-700"
        >
          Retired {e.retired_at ? fmtStamp(e.retired_at) : ""} — retirement is
          terminal. This record is read-only; the database refuses any further
          change to it.
        </div>
      ) : null}

      {/* 2 · Responsibility -------------------------------------------------- */}
      <Section
        icon={Target}
        title="Responsibility"
        hint="What this employee is responsible for."
      >
        <p className="text-base font-medium text-slate-900">{e.role}</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {e.description || (
            <span className="text-slate-500">No mandate configured yet.</span>
          )}
        </p>
        <p className="mt-3 text-sm text-slate-600">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Reports to
          </span>{" "}
          {e.manager_slug ? (
            <Link
              href={`/admin/ai-boardroom/${e.manager_slug}`}
              className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
            >
              {managerName}
            </Link>
          ) : (
            <span className="font-medium text-slate-900">Human board</span>
          )}
        </p>
      </Section>

      {/* 3 · Now ------------------------------------------------------------- */}
      <Section
        icon={Activity}
        title="Now"
        hint="What this employee is set to work on — configured state on this framework surface, not autonomous output."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Band>Current focus</Band>
            <p className="mt-1 text-sm text-slate-900">
              {e.current_task ?? (
                <span className="text-slate-500">No focus configured</span>
              )}
            </p>
          </div>
          <div>
            <Band>Status</Band>
            <p className="mt-1">
              <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>
            </p>
          </div>
          <div>
            <Band>Logged activity</Band>
            <p className="mt-1 text-sm text-slate-900">
              {relativeTime(e.last_activity_at)}
            </p>
          </div>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs leading-relaxed text-slate-500">
            Confidence, ETA and Health are derived deterministically from the
            configured task queue; insufficient data never reads as green.
          </p>
          <BoardroomCardPanel cards={boardroomCards} now={now} />
          <div className="mt-4">
            <Band>Product pipeline</Band>
            <div className="mt-2">
              <PipelineStageStrip pipeline={boardroomCards.pipeline} />
            </div>
          </div>
        </div>
      </Section>

      {/* 4 · Recent output --------------------------------------------------- */}
      <Section
        icon={CheckCircle2}
        title="Recent output"
        hint="Most recently produced work, from the configured task log."
      >
        {completedTasks.length === 0 ? (
          <Empty>No completed work logged yet.</Empty>
        ) : (
          <div className="space-y-3">
            {stats.lastCompletedTitle ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <Band>Last completed</Band>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {stats.lastCompletedTitle}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {relativeTime(stats.lastCompletedAt)}
                </p>
              </div>
            ) : null}
            <ol className="space-y-2">
              {completedTasks.slice(0, 5).map((t) => (
                <TaskRow key={t.id} t={t} />
              ))}
            </ol>
          </div>
        )}
      </Section>

      {/* 5 · Waiting on you -------------------------------------------------- */}
      <Section
        icon={Inbox}
        title="Waiting on you"
        hint="Items that need a human decision before anything proceeds."
      >
        {served.requiresApproval ? (
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            This employee&apos;s served posture requires human approval before
            any action.
          </p>
        ) : null}
        {waitingTasks.length === 0 ? (
          <Empty>
            Nothing is waiting on you right now. Approval routing isn&apos;t wired
            yet — items appear here only when logged manually below.
          </Empty>
        ) : (
          <ol className="space-y-2">
            {waitingTasks.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ol>
        )}
      </Section>

      {/* 6 · What failed ----------------------------------------------------- */}
      <Section
        icon={AlertTriangle}
        title="What failed"
        hint="Failures and health warnings for this employee."
      >
        {failuresClean ? (
          <Empty>No failures on record.</Empty>
        ) : (
          <div className="space-y-3">
            {showHealthReasons ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <Band>Health warnings</Band>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-700">
                  {health.reasons.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span
                        className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-amber-500"
                        aria-hidden
                      />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {failedTasks.length > 0 ? (
              <ol className="space-y-2">
                {failedTasks.map((t) => (
                  <TaskRow key={t.id} t={t} />
                ))}
              </ol>
            ) : null}
          </div>
        )}
      </Section>

      {/* 7 · Authority ------------------------------------------------------- */}
      <Section
        icon={KeyRound}
        title="Authority"
        hint="What this employee can and cannot do."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <Band>Granted capabilities</Band>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                {served.tokens.length}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {served.toolsAllowed.length} tool · {served.scopes.length} scope
                {served.scopes.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <Band>Execution</Band>
              <p className="mt-1.5">
                <Badge tone="red">
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  Disabled (framework mode)
                </Badge>
              </p>
              <p className="mt-1.5 text-[11px] text-slate-500">
                No executor is wired to these labels.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <Band>Requires approval</Band>
              <p className="mt-1.5">
                <Badge tone={served.requiresApproval ? "amber" : "slate"}>
                  {served.requiresApproval ? "Yes" : "No"}
                </Badge>
              </p>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Before any future action.
              </p>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            A readable summary of the capability tokens the Registry serves —
            capability labels only, no executor is wired to them. This classifies
            current authority: it grants nothing, and execution stays locked, with
            the default-deny floor applied whenever the Registry is silent. The
            raw token set and scopes are editable under Technical detail.
          </p>
          <div className="border-t border-slate-200 pt-4">
            <ApprovalLevelPanel result={approvalLevel} />
          </div>
        </div>
      </Section>

      {/* 8 · Telemetry tiles ------------------------------------------------- */}
      <Section
        icon={BarChart3}
        title="Telemetry"
        hint="Derived from this employee's configured task & memory history."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Tasks today"
            value={String(stats.tasksToday)}
            hint={`${stats.tasksTotal} recent`}
          />
          <StatTile
            label="Success rate"
            value={formatRate(stats.successRatePct)}
            hint={`${stats.completed} done · ${stats.failed} failed`}
            tone={rateTone(stats.successRatePct)}
          />
          <StatTile
            label="Avg completion"
            value={stats.avgCompletionLabel}
            hint="per completed task"
          />
          <StatTile
            label="Knowledge"
            value={`v${stats.knowledgeVersion}`}
            hint={`${stats.memoryEntries} entries`}
          />
          <StatTile
            label="Memory usage"
            value={stats.memoryUsageLabel}
            hint={`${stats.memoryChars.toLocaleString("en-GB")} chars`}
          />
        </div>

        {/* This month's persisted KPIs (ai_employee_kpis) — engine-task
            outcomes, approvals raised, and ATTRIBUTED AI cost from the
            invocation ledger. Honest derived figures; nothing invented. */}
        <div className="mt-4 border-t border-slate-200 pt-4">
          <Band>This month (period {kpi.periodStart})</Band>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="Engine tasks done"
              value={String(kpi.tasksCompleted)}
              hint={`${kpi.tasksFailed} failed`}
            />
            <StatTile
              label="Failure rate"
              value={kpi.failureRatePct === null ? "—" : `${kpi.failureRatePct}%`}
              hint="finished engine tasks"
              tone={
                kpi.failureRatePct === null
                  ? undefined
                  : kpi.failureRatePct >= 50
                    ? "red"
                    : kpi.failureRatePct >= 20
                      ? "amber"
                      : "emerald"
              }
            />
            <StatTile
              label="Approvals raised"
              value={String(kpi.approvalsRequested)}
              hint="sent to a human"
            />
            <StatTile
              label="AI cost"
              value={`£${(kpi.costPence / 100).toFixed(2)}`}
              hint="attributed invocations"
            />
          </div>
        </div>
      </Section>

      {/* 8b · Interaction history --------------------------------------------- */}
      <Section
        icon={Activity}
        title="Interaction history"
        hint="This employee's real conversation with the company — engine tasks and their results, human configuration decisions, and approvals. Merged from stored records; nothing is generated (no chat UI exists, so no transcript is invented)."
      >
        {interactionFeed.length === 0 ? (
          <Empty>No interactions recorded yet.</Empty>
        ) : (
          <ol className="divide-y divide-slate-100">
            {interactionFeed.map((item) => (
              <InteractionRow key={item.key} item={item} />
            ))}
          </ol>
        )}
      </Section>

      {/* 8c · Recommendations -------------------------------------------------- */}
      <Section
        icon={Lightbulb}
        title="Recommendations"
        hint="Proposals this employee's completed work carries — proposed actions, considered alternatives, review findings, verdicts and prep briefs. Read straight out of stored task results; read-only, nothing here executes."
      >
        {recommendations.length === 0 ? (
          <Empty>
            No recommendations yet — items appear when this employee&apos;s tasks
            complete with proposals.
          </Empty>
        ) : (
          <ol className="divide-y divide-slate-100">
            {recommendations.map((item) => (
              <RecommendationRow key={item.key} item={item} />
            ))}
          </ol>
        )}
      </Section>

      {/* 9 · Configure (lower-emphasis operator zone) ------------------------ */}
      <div className="border-t border-slate-200 pt-6">
        <div className="mb-4 flex items-center gap-2.5">
          <Wrench className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
              Configure
            </h2>
            <p className="text-xs text-slate-500">
              Operator tools — log work, capture memory, review shared knowledge.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Task history + add-task form */}
          <Section
            title="Task history"
            hint="Manually logged for now. The structure is ready for automated entries later."
          >
            {tasks.length === 0 ? (
              <Empty>No tasks logged yet.</Empty>
            ) : (
              <ol className="space-y-2">
                {tasks.map((t) => (
                  <TaskRow key={t.id} t={t} />
                ))}
              </ol>
            )}

            <form
              action={addAiEmployeeTask}
              className="mt-4 space-y-3 border-t border-slate-200 pt-4"
            >
              <input type="hidden" name="ai_employee_id" value={e.id} />
              <input type="hidden" name="slug" value={e.slug} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <Field label="New task title">
                    <input
                      name="title"
                      type="text"
                      required
                      maxLength={300}
                      placeholder="e.g. Draft Q3 outbound sequence"
                      className={inputCls}
                    />
                  </Field>
                </div>
                <Field label="Status">
                  <select name="status" defaultValue="pending" className={selectCls}>
                    {TASK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {TASK_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Summary" hint="optional">
                <textarea
                  name="summary"
                  rows={2}
                  maxLength={8000}
                  className={inputCls}
                />
              </Field>
              <button type="submit" className={buttonClass("secondary")}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Log task
              </button>
            </form>
          </Section>

          {/* Memory list + add-memory form */}
          <Section
            title="Memory"
            hint={`Scope: ${memoryScopeLabel(e.memory_scope)} — ${MEMORY_SCOPE_HELP[e.memory_scope as keyof typeof MEMORY_SCOPE_HELP] ?? ""}`}
          >
            {memory.length === 0 ? (
              <Empty>No memory entries yet.</Empty>
            ) : (
              <ul className="space-y-2">
                {memory.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-lg border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 font-mono text-xs font-medium text-slate-700">
                        {m.mem_key ?? "untitled"}
                      </p>
                      <Badge tone="slate" variant="soft">
                        {memoryScopeLabel(m.scope)}
                      </Badge>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                      {m.content}
                    </p>
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      {fmtStamp(m.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <form
              action={addAiEmployeeMemory}
              className="mt-4 space-y-3 border-t border-slate-200 pt-4"
            >
              <input type="hidden" name="ai_employee_id" value={e.id} />
              <input type="hidden" name="slug" value={e.slug} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Key" hint="optional">
                  <input
                    name="mem_key"
                    type="text"
                    maxLength={200}
                    placeholder="e.g. tone_of_voice"
                    className={inputCls}
                  />
                </Field>
                <Field label="Scope">
                  <select
                    name="scope"
                    defaultValue={e.memory_scope}
                    className={selectCls}
                  >
                    {MEMORY_SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {MEMORY_SCOPE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Content">
                <textarea
                  name="content"
                  rows={3}
                  required
                  maxLength={20_000}
                  placeholder="A fact or instruction this employee should remember."
                  className={inputCls}
                />
              </Field>
              <button type="submit" className={buttonClass("secondary")}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add memory
              </button>
            </form>
          </Section>

          {/* Shared memory feed (read-only) — CEO Directive 002 */}
          <Section
            title="Shared memory"
            hint="Permission-aware slice from the company knowledge engine. Read-only — this employee reads memory; it never writes."
          >
            {!hasFeed ? (
              <p className="text-sm text-slate-500">
                No shared memory is visible to this employee yet.{" "}
                <Link
                  href="/admin/memory"
                  className="font-medium text-slate-900 underline underline-offset-2 hover:text-slate-700"
                >
                  Open Shared Memory →
                </Link>
              </p>
            ) : (
              <div className="space-y-5">
                {feedGroups.map((group) =>
                  group.items.length === 0 ? null : (
                    <div key={group.label}>
                      <Band>{group.label}</Band>
                      <ul className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {group.items.map((mItem) => (
                          <li key={mItem.id}>
                            <MemoryCard memory={mItem} typeMap={memoryTypeMap} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* 10 · Technical detail (collapsed by default; native <details>) ------ */}
      <details className="group rounded-xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-5 py-4 text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-slate-400" strokeWidth={2} aria-hidden />
            Technical detail
          </span>
          <ChevronDown
            className="h-4 w-4 text-slate-400 transition group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="space-y-6 border-t border-slate-200 p-5">
          <p className="text-xs leading-relaxed text-slate-500">
            Operator-grade configuration and audit — system prompt, capability
            tokens, memory scope, raw scopes and the audit log. Editing here is
            audit-logged; execution stays locked.
          </p>

          {/* Configuration (safe fields, incl. system prompt) */}
          <div>
            <Band>Configuration</Band>
            <p className="mt-0.5 text-xs text-slate-500">
              Safe fields only — no execution toggle. Edits are audit-logged.
            </p>
            <form action={updateAiEmployeeConfig} className="mt-3 space-y-4">
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="slug" value={e.slug} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Status">
                  <select name="status" defaultValue={e.status} className={selectCls}>
                    {AI_EMPLOYEE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Planned provider">
                  <input
                    name="model_provider"
                    type="text"
                    maxLength={60}
                    defaultValue={e.model_provider ?? ""}
                    placeholder="e.g. anthropic"
                    className={inputCls}
                  />
                </Field>
                <Field label="Planned model">
                  <input
                    name="model_name"
                    type="text"
                    maxLength={120}
                    defaultValue={e.model_name ?? ""}
                    placeholder="e.g. claude-opus-4-7"
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Role">
                <input
                  name="role"
                  type="text"
                  maxLength={200}
                  defaultValue={e.role}
                  className={inputCls}
                />
              </Field>
              <Field label="Current task" hint="optional">
                <input
                  name="current_task"
                  type="text"
                  maxLength={500}
                  defaultValue={e.current_task ?? ""}
                  placeholder="What is this employee focused on right now?"
                  className={inputCls}
                />
              </Field>
              <Field label="Description" hint="optional">
                <textarea
                  name="description"
                  rows={2}
                  maxLength={4000}
                  defaultValue={e.description}
                  className={inputCls}
                />
              </Field>
              <Field
                label="System prompt"
                hint="defines the role; not yet sent to any model"
              >
                <textarea
                  name="system_prompt"
                  rows={6}
                  maxLength={20_000}
                  defaultValue={e.system_prompt}
                  className={`${inputCls} font-mono text-xs leading-relaxed`}
                />
              </Field>
              <button type="submit" className={buttonClass("primary")}>
                Save configuration
              </button>
            </form>
          </div>

          {/* Capabilities — registry-native authoring editor */}
          <div className="border-t border-slate-200 pt-6">
            <Band>Capabilities</Band>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              The complete capability token set this employee holds — one token
              per line, as SERVED by the Capability Registry (the single source of
              authority). Saving authors the set at the registry; tool permissions
              and scopes are split automatically by the catalogue. Capability
              labels only — no executor is wired to them; execution stays locked.
            </p>
            <form action={authorAiEmployeeCapabilities} className="mt-3 space-y-3">
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="slug" value={e.slug} />
              <textarea
                name="tokens"
                rows={6}
                defaultValue={capabilityTokens.join("\n")}
                placeholder={"e.g.\nread\nmemory.write\ncomm.send"}
                spellCheck={false}
                className={`${inputCls} font-mono text-xs leading-relaxed`}
              />
              <button type="submit" className={buttonClass("primary")}>
                Save capabilities
              </button>
            </form>
          </div>

          {/* Memory scope — registry-native authoring */}
          <div className="border-t border-slate-200 pt-6">
            <Band>Memory scope</Band>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              How widely this employee may read shared memory. Saving authors the
              scope at the registry and deterministically mirrors it to the legacy
              model in one atomic write — the legacy column is never edited
              directly (the Mirror Integrity Rule).{" "}
              {MEMORY_SCOPE_HELP[e.memory_scope as keyof typeof MEMORY_SCOPE_HELP] ?? ""}
            </p>
            <form
              action={authorAiEmployeeMemoryScope}
              className="mt-3 flex flex-wrap items-end gap-3"
            >
              <input type="hidden" name="id" value={e.id} />
              <input type="hidden" name="slug" value={e.slug} />
              <div className="min-w-[12rem] flex-1 sm:max-w-xs">
                <Field label="Memory scope">
                  <select
                    name="memory_scope"
                    defaultValue={e.memory_scope}
                    className={selectCls}
                  >
                    {MEMORY_SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {MEMORY_SCOPE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <button type="submit" className={buttonClass("primary")}>
                Save memory scope
              </button>
            </form>
          </div>

          {/* Raw scopes list */}
          <div className="border-t border-slate-200 pt-6">
            <Band>Served scopes (raw)</Band>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {served.scopes.length === 0 ? (
                <span className="text-xs text-slate-500">None</span>
              ) : (
                served.scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 ring-1 ring-inset ring-slate-200"
                  >
                    {s}
                  </span>
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Execution cannot be enabled from this panel. Connecting a model
              provider and granting run permissions is a later, separately gated
              phase.
            </p>
          </div>

          {/* Activity / audit log */}
          <div className="border-t border-slate-200 pt-6">
            <Band>Activity &amp; audit log</Band>
            <p className="mt-0.5 text-xs text-slate-500">
              Every configuration change and logged action lands here.
            </p>
            {activity.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                No activity recorded yet.
              </p>
            ) : (
              <ol className="mt-3 divide-y divide-slate-200">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 py-2.5 text-sm">
                    <span
                      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-slate-400"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">
                        {prettyAction(a.action)}
                      </p>
                      {a.actor_email ? (
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          by {a.actor_email}
                        </p>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-500">
                      {fmtStamp(a.created_at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Retire — terminal, trigger-enforced (disabled → retired only). */}
          {!retired ? (
            <div className="border-t border-slate-200 pt-6">
              <Band>Retire</Band>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                Retirement is terminal: the database admits only disabled →
                retired, and a retired record refuses every later change. The
                identity and its history stay on the roster as a permanent
                record.
              </p>
              {e.status === "disabled" ? (
                <form action={retireAiEmployee} className="mt-3">
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="slug" value={e.slug} />
                  <button type="submit" className={buttonClass("secondary")}>
                    Retire this employee
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  Set status to Disabled first — only a disabled employee can be
                  retired.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------
// Local presentation helpers (light operational system)
// ---------------------------------------------------------------------

const inputCls =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300";
const selectCls =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-300";

/** Status → design-system tone (no orange tone; blocked maps to amber). */
function statusTone(status: string): Tone {
  switch (status) {
    case "working":
      return "emerald";
    case "waiting_approval":
    case "blocked":
      return "amber";
    case "error":
      return "red";
    default:
      return "slate"; // idle, disabled
  }
}

/** Task status → design-system tone. */
function taskTone(status: string): Tone {
  switch (status) {
    case "in_progress":
      return "blue";
    case "waiting_approval":
      return "amber";
    case "completed":
      return "emerald";
    case "failed":
      return "red";
    default:
      return "slate"; // pending, cancelled
  }
}

/** Success-rate → tone (honest: null reads neutral, low reads red). */
function rateTone(pct: number | null): Tone {
  if (pct === null) return "slate";
  if (pct >= 80) return "emerald";
  if (pct >= 50) return "amber";
  return "red";
}

/** Compact "YYYY-MM-DD HH:MM" from an ISO stamp — the shipped idiom. */
function fmtStamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function Section({
  title,
  hint,
  icon: Icon,
  children,
}: {
  title: string;
  hint?: string;
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-2.5">
        {Icon ? (
          <Icon
            className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
            strokeWidth={2}
            aria-hidden
          />
        ) : null}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {hint ? <p className="mt-0.5 text-sm text-slate-600">{hint}</p> : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Band({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

function TaskRow({ t }: { t: AiEmployeeTask }) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium text-slate-900">{t.title}</p>
        <Badge tone={taskTone(t.status)}>{taskStatusLabel(t.status)}</Badge>
      </div>
      {t.summary ? (
        <p className="mt-1 text-xs leading-relaxed text-slate-600">{t.summary}</p>
      ) : null}
      <p className="mt-1.5 text-[11px] text-slate-500">
        {t.created_by_email ? `${t.created_by_email} · ` : ""}
        {fmtStamp(t.created_at)}
      </p>
    </li>
  );
}

/** One interaction-feed row — kind pill, title, honest detail, actor + stamp. */
function InteractionRow({ item }: { item: InteractionItem }) {
  const kindTone: Tone =
    item.kind === "task" ? "blue" : item.kind === "approval" ? "amber" : "slate";
  const kindLabel =
    item.kind === "task" ? "Task" : item.kind === "approval" ? "Approval" : "Config";
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Badge tone={kindTone} variant="soft" className="mt-0.5 shrink-0 text-[10px]">
        {kindLabel}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">{item.title}</p>
        {item.detail ? (
          <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{item.detail}</p>
        ) : null}
        {item.actor ? (
          <p className="mt-0.5 text-[11px] text-slate-500">by {item.actor}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {item.status ? (
          <Badge tone={taskTone(item.status)} className="text-[10px]">
            {item.status.replace(/_/g, " ")}
          </Badge>
        ) : null}
        <span className="text-[11px] text-slate-500">{fmtStamp(item.at)}</span>
      </div>
    </li>
  );
}

/** Kind pill vocabulary for a recommendation row — labels the stored shape honestly. */
const RECOMMENDATION_KIND_META: Record<
  RecommendationItem["kind"],
  { label: string; tone: Tone }
> = {
  action: { label: "Proposed action", tone: "blue" },
  alternative: { label: "Alternative", tone: "slate" },
  finding: { label: "Finding", tone: "amber" },
  verdict: { label: "Verdict", tone: "emerald" },
  sales_prep: { label: "Sales prep", tone: "blue" },
};

/** One recommendation row — kind pill, title, honest detail, source task + stamp. */
function RecommendationRow({ item }: { item: RecommendationItem }) {
  const meta = RECOMMENDATION_KIND_META[item.kind];
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Badge tone={meta.tone} variant="soft" className="mt-0.5 shrink-0 text-[10px]">
        {meta.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">{item.title}</p>
        {item.detail ? (
          <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{item.detail}</p>
        ) : null}
        <p className="mt-0.5 text-[11px] text-slate-500">
          from {item.taskType.replace(/[._-]+/g, " ")}
        </p>
      </div>
      <span className="shrink-0 text-[11px] text-slate-500">{fmtStamp(item.at)}</span>
    </li>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      {label}
      {hint ? <span className="ml-1 text-slate-400">{hint}</span> : null}
      {children}
    </label>
  );
}

function prettySaved(saved: string): string {
  switch (saved) {
    case "config":
      return "Configuration saved.";
    case "task":
      return "Task logged.";
    case "memory":
      return "Memory entry added.";
    case "capabilities":
      return "Capabilities authored at the registry.";
    case "memory_scope":
      return "Memory scope authored at the registry.";
    case "retired":
      return "Employee retired — this record is now permanent and read-only.";
    default:
      return "Saved.";
  }
}

function prettyAction(action: string): string {
  switch (action) {
    case "ai_employee.config_updated":
      return "Configuration updated";
    case "ai_employee.task_logged":
      return "Task logged";
    case "ai_employee.memory_added":
      return "Memory added";
    default:
      return action.replace(/^ai_employee\./, "").replace(/_/g, " ");
  }
}

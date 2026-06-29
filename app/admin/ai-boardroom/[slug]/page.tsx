import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, ShieldOff, Plus } from "lucide-react";
import { loadAiEmployeeBySlug } from "@/server/services/ai-employees";
import {
  AI_EMPLOYEE_STATUSES,
  STATUS_LABELS,
  STATUS_PULSE,
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABELS,
  MEMORY_SCOPE_HELP,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  departmentLabel,
  statusLabel,
  memoryScopeLabel,
  taskStatusLabel,
  relativeTime,
} from "@/lib/ai-employees/model";
import { computeEmployeeStats, formatRate } from "@/lib/ai-employees/stats";
import { statusStyle, taskStatusPill, accentClasses } from "../_styles";
import { EmployeeIcon } from "../_icon";
import {
  updateAiEmployeeConfig,
  addAiEmployeeTask,
  addAiEmployeeMemory,
  authorAiEmployeeCapabilities,
  authorAiEmployeeMemoryScope,
} from "../actions";
import {
  getEmployeeMemoryFeed,
  listMemoryTypes,
} from "@/server/services/hq-memory";
import { resolveServedCapabilityView } from "@/server/sdk/registry-parity";
import { MemoryCard, buildTypeMap } from "../../memory/_components";

/**
 * AI Boardroom — employee detail (CEO Directive 001, Phase 1).
 *
 * Profile · role · prompt · allowed tools · permissions · current task ·
 * memory scope · task history · memory entries · activity/audit log ·
 * configuration panel.
 *
 * FRAMEWORK ONLY. The configuration panel edits SAFE descriptive fields
 * (status, role, description, planned model, memory scope, current task,
 * system prompt). Execution is locked: `permissions.can_execute` is shown
 * read-only and there is no action anywhere that enables it.
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
  const pulse = (STATUS_PULSE as Record<string, boolean>)[e.status] ?? false;
  const st = statusStyle(e.status);

  // Workforce telemetry — derived from the task + memory history already
  // loaded above (no extra query). Architecture only: read + derive.
  const stats = computeEmployeeStats(tasks, memory);

  // The SERVED capability authority (Directive #015 / D-05, LR5.2 — the Read Migration Rule).
  // The capability editor + permissions panel below read what the runtime SERVES from the
  // now-authoritative Capability Registry — with the legacy model retained only as the automatic
  // fail-safe — NOT the now-inert ai_employees.tools_allowed / permissions columns LR5.1
  // froze. Resolved alongside the read-only shared-memory feed (CEO Directive 002), a
  // permission-aware slice this employee may READ; both are best-effort and degrade to a safe
  // default rather than breaking the profile.
  const [served, memoryFeed, memoryTypes] = await Promise.all([
    resolveServedCapabilityView(e),
    getEmployeeMemoryFeed({ id: e.id, department: e.department }),
    listMemoryTypes(),
  ]);
  // The complete served token set seeds the registry-native authoring editor (one token/line).
  const capabilityTokens = [...served.tokens];
  const memoryTypeMap = buildTypeMap(memoryTypes);
  const feedGroups = [
    { label: "Pinned", items: memoryFeed.pinned },
    { label: "Relevant", items: memoryFeed.relevant },
    { label: `${departmentLabel(e.department)} department`, items: memoryFeed.department },
    { label: "Recently added", items: memoryFeed.recent },
  ];
  const hasFeed = feedGroups.some((g) => g.items.length > 0);

  const saved = sp.saved ? prettySaved(sp.saved) : null;
  const errorMsg = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/ai-boardroom" className="hover:text-slate-300">
            AI Boardroom
          </Link>{" "}
          / <span className="text-slate-300">{e.name}</span>
        </p>

        {/* Identity header */}
        <header className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <span
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl ${accent.icon}`}
              >
                <EmployeeIcon icon={e.icon} className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight text-white">
                  {e.name}
                </h1>
                <p className="mt-0.5 text-sm text-slate-400">{e.role}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${st.pill}`}
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
                    {statusLabel(e.status)}
                  </span>
                  <Chip>{departmentLabel(e.department)}</Chip>
                  <Chip>{memoryScopeLabel(e.memory_scope)} memory</Chip>
                </div>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
              <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Framework mode
            </span>
          </div>
        </header>

        {/* Banners */}
        {errorMsg ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            {errorMsg}
          </div>
        ) : null}
        {saved ? (
          <div
            role="status"
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
          >
            {saved}
          </div>
        ) : null}

        {/* Overview tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Status" value={statusLabel(e.status)} />
          <Tile label="Department" value={departmentLabel(e.department)} />
          <Tile label="Memory scope" value={memoryScopeLabel(e.memory_scope)} />
          <Tile label="Last activity" value={relativeTime(e.last_activity_at)} />
          <Tile
            label="Planned model"
            value={e.model_name ?? "—"}
            sub={e.model_provider ?? "not connected"}
          />
          <Tile label="Execution" value="Locked" locked />
        </div>

        {/* Workforce telemetry (CEO Directive 004, Phase 3) */}
        <Section
          title="Workforce telemetry"
          subtitle="Derived live from this employee's task & memory history. Architecture only — no autonomous execution."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Tasks today"
              value={String(stats.tasksToday)}
              sub={`${stats.tasksTotal} recent`}
            />
            <Tile
              label="Success rate"
              value={formatRate(stats.successRatePct)}
              sub={`${stats.completed} done · ${stats.failed} failed`}
            />
            <Tile
              label="Avg completion"
              value={stats.avgCompletionLabel}
              sub="per completed task"
            />
            <Tile
              label="Last completed"
              value={stats.lastCompletedTitle ?? "—"}
              sub={relativeTime(stats.lastCompletedAt)}
            />
            <Tile
              label="Knowledge"
              value={`v${stats.knowledgeVersion}`}
              sub={`${stats.memoryEntries} entries`}
            />
            <Tile
              label="Memory usage"
              value={stats.memoryUsageLabel}
              sub={`${stats.memoryChars.toLocaleString("en-GB")} chars`}
            />
          </div>
        </Section>

        {/* Current task + description */}
        <Section title="Profile">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Current task
              </dt>
              <dd className="mt-0.5 text-slate-200">
                {e.current_task ?? (
                  <span className="text-slate-500">No active task</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Description
              </dt>
              <dd className="mt-0.5 leading-relaxed text-slate-300">
                {e.description || (
                  <span className="text-slate-500">No description</span>
                )}
              </dd>
            </div>
          </dl>
        </Section>

        {/* Tools + permissions */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Capabilities"
            subtitle="Authored at the Capability Registry. Edits are audit-logged; execution stays locked."
          >
            <p className="mb-3 text-xs text-slate-500">
              The complete capability token set this employee holds — one token per
              line, as SERVED by the Capability Registry (the single source of
              authority). Saving authors the set at the registry; tool permissions and
              scopes are split automatically by the catalogue. Capability labels only —
              no executor is wired to them.
            </p>
            <form action={authorAiEmployeeCapabilities} className="space-y-3">
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
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
                >
                  Save capabilities
                </button>
              </div>
            </form>
          </Section>

          <Section title="Permissions">
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <Lock className="h-3.5 w-3.5 text-red-400" aria-hidden />
                  Execution
                </span>
                <span className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-300 ring-1 ring-inset ring-red-400/30">
                  Disabled (framework mode)
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-slate-300">Requires approval</span>
                <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
                  {served.requiresApproval ? "Yes" : "No"}
                </span>
              </li>
              <li>
                <span className="text-slate-300">Scopes</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {served.scopes.length === 0 ? (
                    <span className="text-xs text-slate-500">None</span>
                  ) : (
                    served.scopes.map((s) => (
                      <span
                        key={s}
                        className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300 ring-1 ring-inset ring-slate-700"
                      >
                        {s}
                      </span>
                    ))
                  )}
                </div>
              </li>
            </ul>
            <p className="mt-3 border-t border-slate-800 pt-3 text-[11px] leading-relaxed text-slate-500">
              Execution cannot be enabled from this panel. Connecting a model
              provider and granting run permissions is a later, separately
              gated phase.
            </p>
          </Section>
        </div>

        {/* Memory scope — registry-native authoring (Directive #015 / D-05, LR2) */}
        <Section
          title="Memory scope"
          subtitle="Authored at the Capability Registry. The grant is authoritative; the legacy model is a derived mirror (Mirror Integrity Rule)."
        >
          <p className="mb-3 text-xs text-slate-500">
            How widely this employee may read shared memory. Saving authors the
            scope at the registry and deterministically mirrors it to the legacy
            model in one atomic write — the legacy column is never edited directly.{" "}
            {MEMORY_SCOPE_HELP[e.memory_scope as keyof typeof MEMORY_SCOPE_HELP] ?? ""}
          </p>
          <form
            action={authorAiEmployeeMemoryScope}
            className="flex flex-wrap items-end gap-3"
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
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Save memory scope
            </button>
          </form>
        </Section>

        {/* Configuration panel (safe fields) */}
        <Section title="Configuration" subtitle="Edits are audit-logged. Safe fields only — no execution toggle.">
          <form action={updateAiEmployeeConfig} className="space-y-4">
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="slug" value={e.slug} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Status">
                <select
                  name="status"
                  defaultValue={e.status}
                  className={selectCls}
                >
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
            <Field label="System prompt" hint="defines the role; not yet sent to any model">
              <textarea
                name="system_prompt"
                rows={6}
                maxLength={20_000}
                defaultValue={e.system_prompt}
                className={`${inputCls} font-mono text-xs leading-relaxed`}
              />
            </Field>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
            >
              Save configuration
            </button>
          </form>
        </Section>

        {/* Task history */}
        <Section
          title="Task history"
          subtitle="Manually logged for now. The structure is ready for automated entries later."
        >
          {tasks.length === 0 ? (
            <p className="text-sm text-slate-500">No tasks logged yet.</p>
          ) : (
            <ol className="space-y-2">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 font-medium text-slate-200">
                      {t.title}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${taskStatusPill(t.status)}`}
                    >
                      {taskStatusLabel(t.status)}
                    </span>
                  </div>
                  {t.summary ? (
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      {t.summary}
                    </p>
                  ) : null}
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    {t.created_by_email ? `${t.created_by_email} · ` : ""}
                    {t.created_at.slice(0, 16).replace("T", " ")}
                  </p>
                </li>
              ))}
            </ol>
          )}

          <form
            action={addAiEmployeeTask}
            className="mt-4 space-y-3 border-t border-slate-800 pt-4"
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
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Log task
            </button>
          </form>
        </Section>

        {/* Memory */}
        <Section
          title="Memory"
          subtitle={`Scope: ${memoryScopeLabel(e.memory_scope)} — ${MEMORY_SCOPE_HELP[e.memory_scope as keyof typeof MEMORY_SCOPE_HELP] ?? ""}`}
        >
          {memory.length === 0 ? (
            <p className="text-sm text-slate-500">No memory entries yet.</p>
          ) : (
            <ul className="space-y-2">
              {memory.map((m) => (
                <li
                  key={m.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 font-mono text-xs font-medium text-slate-300">
                      {m.mem_key ?? "untitled"}
                    </p>
                    <Chip>{memoryScopeLabel(m.scope)}</Chip>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                    {m.content}
                  </p>
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    {m.created_at.slice(0, 16).replace("T", " ")}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <form
            action={addAiEmployeeMemory}
            className="mt-4 space-y-3 border-t border-slate-800 pt-4"
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
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add memory
            </button>
          </form>
        </Section>

        {/* Shared memory feed (read-only) — CEO Directive 002 */}
        <Section
          title="Shared memory"
          subtitle="Permission-aware slice from the company knowledge engine. Read-only — this employee reads memory; it never writes."
        >
          {!hasFeed ? (
            <p className="text-sm text-slate-500">
              No shared memory is visible to this employee yet.{" "}
              <Link
                href="/admin/memory"
                className="font-medium text-indigo-400 hover:text-indigo-300"
              >
                Open Shared Memory →
              </Link>
            </p>
          ) : (
            <div className="space-y-5">
              {feedGroups.map((group) =>
                group.items.length === 0 ? null : (
                  <div key={group.label}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {group.label}
                    </p>
                    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

        {/* Activity / audit log */}
        <Section
          title="Activity & audit log"
          subtitle="Every configuration change and logged action lands here."
        >
          {activity.length === 0 ? (
            <p className="text-sm text-slate-500">No activity recorded yet.</p>
          ) : (
            <ol className="divide-y divide-slate-800">
              {activity.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 py-2.5 text-sm"
                >
                  <span
                    className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-indigo-400"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-200">
                      {prettyAction(a.action)}
                    </p>
                    {a.actor_email ? (
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        by {a.actor_email}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[11px] text-slate-500">
                    {a.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Local presentation helpers
// ---------------------------------------------------------------------

const inputCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500";
const selectCls =
  "mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      {subtitle ? (
        <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  locked,
}: {
  label: string;
  value: string;
  sub?: string;
  locked?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p
        className={`mt-1 flex items-center gap-1.5 text-sm font-bold ${
          locked ? "text-red-300" : "text-white"
        }`}
      >
        {locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : null}
        <span className="truncate">{value}</span>
      </p>
      {sub ? <p className="mt-0.5 truncate text-[10px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300 ring-1 ring-inset ring-slate-700">
      {children}
    </span>
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
    <label className="block text-[11px] font-medium text-slate-400">
      {label}
      {hint ? <span className="ml-1 text-slate-600">{hint}</span> : null}
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

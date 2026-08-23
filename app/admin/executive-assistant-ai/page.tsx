import { Suspense } from "react";
import Link from "next/link";
import { Sparkles, CheckSquare, Scale, Satellite, Bell, ArrowRight } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { loadExecutiveAssistantBoard } from "@/server/services/hq-executive-assistant";
import {
  EXECUTIVE_ASSISTANT_KIND_LABEL,
  type ExecutiveAssistantBoard,
  type ExecutiveAssistantFormat,
  type ExecutiveAssistantMetric,
  type ExecutiveAssistantMetricKind,
  type ExecutiveAssistantStatus,
  type HumanActionItem,
  type HumanUrgency,
} from "@/lib/hq/executive-assistant";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/tokens";
import { DecisionStateLegend } from "@/app/admin/_components/decision-state";

/**
 * CrewFlow HQ — "What needs you" (super-admin surface).
 *
 * The single "what needs the human right now" digest — a pure cross-board
 * projection that composes the open Approval queue, the pending/delayed Decision
 * queue, overdue/stalled AI tasks, and the current alert load into one prioritised
 * list. Honest by construction: every card carries a label badge (Fact / Derived /
 * Insufficient data) and a one-line basis. An empty-but-readable queue reads as a
 * true "all clear"; a queue that could NOT be read reads as "Insufficient data",
 * and the headline verdict never shows all-clear over a failed read.
 *
 * Each digest row deep-links to the source's own HQ surface — this is the one
 * place that tells you what needs you, so it must also route you to the thing.
 *
 * The executive-assistant narrative is DARK: it populates only once a model tier is
 * bound behind the governor. Until then the empty state says so.
 *
 * Auth: the parent /admin layout gates on requireHqPage; this page re-gates for
 * defence-in-depth (and so the gate is provable on this surface directly).
 */

export const dynamic = "force-dynamic";

/** Where each digest row routes — the source queue's own HQ surface. */
const SOURCE_HREF: Record<HumanActionItem["source"], string> = {
  approvals: "/admin/approvals",
  decisions: "/admin/decisions",
  tasks: "/admin/tasks",
  alerts: "/admin/alerts",
};

/** Provenance badge tone: a fact is good/solid, a derived figure is informational. */
const KIND_TONE: Record<ExecutiveAssistantMetricKind, Tone> = {
  fact: "emerald",
  derived: "blue",
  insufficient: "slate",
};

const STATUS_TONE: Record<ExecutiveAssistantStatus, { tone: Tone; label: string }> = {
  all_clear: { tone: "emerald", label: "All clear" },
  attention: { tone: "amber", label: "Attention needed" },
  insufficient: { tone: "slate", label: "Partial read" },
};

const URGENCY_TONE: Record<HumanUrgency, { tone: Tone; label: string }> = {
  critical: { tone: "red", label: "Critical" },
  high: { tone: "amber", label: "High" },
  normal: { tone: "slate", label: "Normal" },
};

function formatEa(value: number | null, format: ExecutiveAssistantFormat): string {
  if (value == null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "days":
      return `${Math.round(value).toLocaleString("en-GB")}d`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-GB");
  }
}

export default async function ExecutiveAssistantAiPage() {
  await requireHqPage();
  return (
    <div>
      <PageHeader
        title="What needs you"
        description={
          <>
            The one &quot;what needs the human right now&quot; digest — the open
            approval queue, pending and delayed decisions, overdue and stalled AI
            tasks, and the current alert load, composed into one prioritised list.
            Every figure is labelled Fact, Derived, or Insufficient data. An empty
            readable queue is a true &quot;all clear&quot;; a queue that could not be
            read says so, and the verdict never shows all-clear over a failed read.
          </>
        }
      />
      <div className="space-y-8">
        <Suspense fallback={<BoardSkeleton />}>
          <Body />
        </Suspense>
        <DecisionStateLegend />
      </div>
    </div>
  );
}

async function Body() {
  const { board, narrative, generatedAt } = await loadExecutiveAssistantBoard();
  return (
    <>
      <DigestPanel board={board} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ApprovalLoadPanel approvalLoad={board.approvalLoad} />
        <DecisionLoadPanel decisionLoad={board.decisionLoad} />
        <TaskLoadPanel taskLoad={board.taskLoad} />
        <AlertLoadPanel alertLoad={board.alertLoad} />
      </div>
      <MetricGrid board={board} />
      <NarrativePanel narrative={narrative} />
      <p className="text-center text-[11px] text-slate-500">
        {board.periodLabel} · generated {new Date(generatedAt).toLocaleString("en-GB")} ·
        every figure sourced from HQ queues or marked insufficient
      </p>
    </>
  );
}

function DigestPanel({ board }: { board: ExecutiveAssistantBoard }) {
  const { summary, needsHuman } = board;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">What needs the human now</h2>
        <Badge tone={STATUS_TONE[summary.status].tone} className="font-semibold">
          {STATUS_TONE[summary.status].label}
        </Badge>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {needsHuman.length === 0 ? (
          <div className="text-[13px] leading-relaxed text-slate-600">
            {summary.status === "all_clear" ? (
              <>
                Nothing is waiting on a human right now — every queue was read and is
                clear.
              </>
            ) : (
              <>
                Nothing needs a human among the queues that could be read. But{" "}
                {summary.unreadableSources.join(", ")} could not be read this cycle,
                so this is not a clean &quot;all clear&quot;.
              </>
            )}
          </div>
        ) : (
          <>
            <p className="mb-3 text-[12px] text-slate-500">
              {summary.itemsNeedingHuman} item
              {summary.itemsNeedingHuman === 1 ? "" : "s"} across{" "}
              {needsHuman.length} categor{needsHuman.length === 1 ? "y" : "ies"} —
              highest priority first.
              {summary.unreadableSources.length > 0 &&
                ` (${summary.unreadableSources.join(", ")} could not be read, so this is a floor.)`}
            </p>
            <ul className="space-y-2">
              {needsHuman.map((item) => (
                <ActionRow key={item.key} item={item} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function ActionRow({ item }: { item: HumanActionItem }) {
  return (
    <li>
      <Link
        href={SOURCE_HREF[item.source]}
        className="group flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{item.label}</span>
            <Badge tone={URGENCY_TONE[item.urgency].tone} className="font-semibold">
              {URGENCY_TONE[item.urgency].label}
            </Badge>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{item.detail}</p>
          {item.oldestAgeDays != null && (
            <p className="mt-1 text-[11px] text-slate-500">
              Oldest open {item.oldestAgeDays} day{item.oldestAgeDays === 1 ? "" : "s"}.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-sm font-bold tabular-nums text-indigo-700">
            {item.count}
          </span>
          <ArrowRight
            className="h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-slate-600"
            aria-hidden
          />
        </div>
      </Link>
    </li>
  );
}

function LoadPanel({
  icon,
  title,
  unavailable,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  unavailable: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </div>
      {unavailable ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-xs text-slate-500">
          This source could not be read this cycle — not shown as &quot;all clear&quot;.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">{children}</div>
      )}
    </section>
  );
}

function CountPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: Tone;
}) {
  return (
    <Badge tone={tone} className="font-semibold">
      <span className="tabular-nums">{count}</span>
      {label}
    </Badge>
  );
}

function ApprovalLoadPanel({
  approvalLoad,
}: {
  approvalLoad: ExecutiveAssistantBoard["approvalLoad"];
}) {
  return (
    <LoadPanel
      icon={<CheckSquare className="h-4 w-4 text-slate-500" aria-hidden />}
      title="Approval queue"
      unavailable={approvalLoad == null}
    >
      {approvalLoad != null && (
        <>
          <div className="flex flex-wrap gap-2">
            <CountPill label="Escalated" count={approvalLoad.escalated} tone="red" />
            <CountPill label="Pending" count={approvalLoad.pending} tone="amber" />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600">
            {approvalLoad.total === 0
              ? "No approvals are waiting on a human right now."
              : `${approvalLoad.total} open approval${approvalLoad.total === 1 ? "" : "s"} awaiting a decision.`}
            {approvalLoad.oldestAgeDays != null &&
              ` Oldest has waited ${approvalLoad.oldestAgeDays} day${approvalLoad.oldestAgeDays === 1 ? "" : "s"}.`}
          </p>
        </>
      )}
    </LoadPanel>
  );
}

function DecisionLoadPanel({
  decisionLoad,
}: {
  decisionLoad: ExecutiveAssistantBoard["decisionLoad"];
}) {
  return (
    <LoadPanel
      icon={<Scale className="h-4 w-4 text-slate-500" aria-hidden />}
      title="Decision queue"
      unavailable={decisionLoad == null}
    >
      {decisionLoad != null && (
        <>
          <div className="flex flex-wrap gap-2">
            <CountPill label="Awaiting" count={decisionLoad.awaiting} tone="amber" />
            <CountPill label="Delayed" count={decisionLoad.delayed} tone="slate" />
            <CountPill label="Now due" count={decisionLoad.delayedDue} tone="red" />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600">
            {decisionLoad.total === 0
              ? "No decisions are pending a human call."
              : `${decisionLoad.awaiting} awaiting a call, ${decisionLoad.delayed} parked (${decisionLoad.delayedDue} now due to revisit).`}
            {decisionLoad.oldestAgeDays != null &&
              ` Oldest raised ${decisionLoad.oldestAgeDays} day${decisionLoad.oldestAgeDays === 1 ? "" : "s"} ago.`}
          </p>
        </>
      )}
    </LoadPanel>
  );
}

function TaskLoadPanel({ taskLoad }: { taskLoad: ExecutiveAssistantBoard["taskLoad"] }) {
  return (
    <LoadPanel
      icon={<Satellite className="h-4 w-4 text-slate-500" aria-hidden />}
      title="AI task attention"
      unavailable={taskLoad == null}
    >
      {taskLoad != null && (
        <>
          <div className="flex flex-wrap gap-2">
            <CountPill label="Stalled" count={taskLoad.stalled} tone="red" />
            <CountPill label="Overdue" count={taskLoad.overdue} tone="amber" />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600">
            {taskLoad.total === 0
              ? "No AI tasks are overdue or stalled right now."
              : `${taskLoad.overdue} overdue against deadline, ${taskLoad.stalled} with a stalled worker.`}
            {taskLoad.oldestOverdueAgeDays != null &&
              ` Most overdue by ${taskLoad.oldestOverdueAgeDays} day${taskLoad.oldestOverdueAgeDays === 1 ? "" : "s"}.`}
          </p>
          {taskLoad.byStage.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {taskLoad.byStage.map((s) => (
                <Badge key={s.stage} tone="slate" variant="soft">
                  <span className="tabular-nums font-semibold">{s.count}</span>
                  {s.label}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </LoadPanel>
  );
}

function AlertLoadPanel({ alertLoad }: { alertLoad: ExecutiveAssistantBoard["alertLoad"] }) {
  return (
    <LoadPanel
      icon={<Bell className="h-4 w-4 text-slate-500" aria-hidden />}
      title="Alert load"
      unavailable={alertLoad == null}
    >
      {alertLoad != null && (
        <>
          <div className="flex flex-wrap gap-2">
            <CountPill label="Critical" count={alertLoad.critical} tone="red" />
            <CountPill label="Warning" count={alertLoad.warning} tone="amber" />
            <CountPill label="Info" count={alertLoad.info} tone="blue" />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-600">
            {alertLoad.total === 0
              ? "No open alerts across the estate right now."
              : `${alertLoad.critical + alertLoad.warning} of ${alertLoad.total} open alert${alertLoad.total === 1 ? "" : "s"} need attention.`}
            {alertLoad.oldestAgeDays != null &&
              ` Oldest has been open ${alertLoad.oldestAgeDays} day${alertLoad.oldestAgeDays === 1 ? "" : "s"}.`}
          </p>
          <p className="mt-3 text-[11px] text-slate-500">
            From the deterministic HQ alerts rules engine; resolved and snoozed
            alerts are excluded.
          </p>
        </>
      )}
    </LoadPanel>
  );
}

function MetricGrid({ board }: { board: ExecutiveAssistantBoard }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-900">Digest metrics</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Deterministic figures for {board.periodLabel} — each card states exactly
          how it is (or cannot be) computed
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {board.metrics.map((m) => (
          <MetricCard key={m.key} metric={m} />
        ))}
      </div>
    </section>
  );
}

function MetricCard({ metric }: { metric: ExecutiveAssistantMetric }) {
  const insufficient = metric.kind === "insufficient";
  return (
    <div
      className={`flex h-full flex-col rounded-xl border p-4 shadow-sm ${
        insufficient ? "border-dashed border-slate-300 bg-slate-50" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {metric.label}
        </p>
        <KindBadge kind={metric.kind} />
      </div>
      <p
        className={`mt-2 text-2xl font-bold tabular-nums ${
          insufficient ? "text-slate-400" : "text-slate-900"
        }`}
      >
        {formatEa(metric.value, metric.format)}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{metric.basis}</p>
    </div>
  );
}

function KindBadge({ kind }: { kind: ExecutiveAssistantMetricKind }) {
  return <Badge tone={KIND_TONE[kind]}>{EXECUTIVE_ASSISTANT_KIND_LABEL[kind]}</Badge>;
}

function NarrativePanel({ narrative }: { narrative: string | null }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-slate-900">Executive-assistant narrative</h2>
      </div>
      {narrative ? (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-700 shadow-sm">
          {narrative}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-slate-500 ring-1 ring-inset ring-slate-200">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-slate-900">
              Executive-assistant narrative populates once a model tier is bound
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A governed prose summary of what needs the human runs behind the AI
              governor. It stays dark — and this digest stays fully honest on the
              deterministic figures above — until a model tier is armed for it. No
              governor registry key is added for it yet, because an unwired key is a
              permission granted to nothing.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
        <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-200" />
        <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-slate-200" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="h-5 w-24 animate-pulse rounded-full bg-slate-200" />
            <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-200" />
            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-200" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="h-3 w-16 animate-pulse rounded bg-slate-200" />
                <div className="h-4 w-14 animate-pulse rounded-full bg-slate-200" />
              </div>
              <div className="mt-3 h-7 w-24 animate-pulse rounded bg-slate-200" />
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

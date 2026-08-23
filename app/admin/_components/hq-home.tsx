import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Inbox,
} from "lucide-react";
import { loadExecutiveAssistantBoard } from "@/server/services/hq-executive-assistant";
import { getTaskQueueOverview } from "@/server/services/hq-task-queue";
import { getTimelinePage } from "@/server/services/spine-timeline";
import { getCeoBriefingArchive } from "@/server/services/hq-ceo-briefing-reader";
import { buildOpsSnapshot } from "@/server/services/ops-snapshot";
import { RELATIVE_TIME_PRESETS, relativeTime } from "@/lib/time/relative";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/tokens";
import { presentTaskState } from "@/lib/hq/presentation-state";
import { DecisionStateBadge } from "./decision-state";

/**
 * HQ Home — the five executive sections (product UX rebuild, HQ phase).
 *
 * The canonical front door. Within ~10 seconds a leader should read: WHAT NEEDS
 * ME · WHAT IS HAPPENING · WHAT JUST FINISHED · the CEO BRIEF · IS ANYTHING
 * WRONG. Attention first, not metrics.
 *
 * HONEST BY CONSTRUCTION:
 *   • "Needs you" is the deterministic executive-assistant digest (real
 *     approvals/decisions/tasks/alerts); a queue that can't be read says so and
 *     never reads as "all clear".
 *   • "Active now" is the REAL task engine (hq_ai_tasks) — never the
 *     human-authored boardroom notes — and zero running tasks is stated plainly.
 *   • The CEO brief is the deterministic morning briefing; its generative
 *     narrative is dark in prod, so the empty state is handled, never faked.
 *   • System health shows exceptions only; when green it says so in one line.
 *
 * Each section is its own async server component so the page can stream them
 * independently (the digest carries the heaviest read); each degrades to an
 * honest empty/error state rather than throwing the whole page.
 */

const CARD = "rounded-xl border border-slate-200 bg-white shadow-sm";
const SECTION_TITLE = "text-sm font-semibold text-slate-900";
const SECTION_SUB = "text-xs text-slate-500";

function SectionShell({
  title,
  sub,
  href,
  hrefLabel,
  id,
  children,
}: {
  title: string;
  sub?: string;
  href?: string;
  hrefLabel?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`${CARD} p-5`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className={SECTION_TITLE}>{title}</h2>
          {sub ? <p className={`mt-0.5 ${SECTION_SUB}`}>{sub}</p> : null}
        </div>
        {href ? (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900"
          >
            {hrefLabel ?? "Open"}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
      {children}
    </p>
  );
}

const URGENCY_TONE: Record<string, Tone> = {
  critical: "red",
  high: "amber",
  normal: "blue",
};

const SOURCE_HREF: Record<string, string> = {
  approvals: "/admin/approvals",
  decisions: "/admin/decisions",
  tasks: "/admin/tasks",
  alerts: "/admin/alerts",
};

// =====================================================================
// A. WHAT NEEDS ME  — the deterministic executive-assistant digest.
// =====================================================================

export async function NeedsYou() {
  const { board } = await loadExecutiveAssistantBoard().catch(() => ({
    board: null as null | Awaited<ReturnType<typeof loadExecutiveAssistantBoard>>["board"],
  }));

  if (!board) {
    return (
      <SectionShell id="needs" title="Needs your attention" href="/admin/executive-assistant-ai" hrefLabel="Full digest">
        <EmptyLine>
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          The digest couldn&apos;t be assembled just now — open the full digest to retry.
        </EmptyLine>
      </SectionShell>
    );
  }

  const { needsHuman, summary } = board;

  return (
    <SectionShell
      id="needs"
      title="Needs your attention"
      sub={
        summary.status === "insufficient"
          ? `Some queues couldn't be read (${summary.unreadableSources.join(", ")}) — not shown as clear.`
          : `${summary.itemsNeedingHuman} item${summary.itemsNeedingHuman === 1 ? "" : "s"} need a human decision.`
      }
      href="/admin/executive-assistant-ai"
      hrefLabel="Full digest"
    >
      {needsHuman.length === 0 ? (
        <EmptyLine>
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          {summary.status === "insufficient"
            ? "Nothing needs you among the queues that could be read."
            : "You're all caught up — nothing is waiting on you."}
        </EmptyLine>
      ) : (
        <ul className="space-y-2">
          {needsHuman.map((item) => {
            const href = SOURCE_HREF[item.source] ?? "/admin/executive-assistant-ai";
            return (
              <li key={item.key}>
                <Link
                  href={href}
                  className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-4 py-3 transition hover:border-slate-300 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      <Badge tone={URGENCY_TONE[item.urgency] ?? "slate"}>
                        {item.count} {item.urgency === "normal" ? "waiting" : item.urgency}
                      </Badge>
                      <span className="truncate">{item.label}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">{item.detail}</p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                    {item.oldestAgeDays !== null ? (
                      <span>{item.oldestAgeDays}d oldest</span>
                    ) : null}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionShell>
  );
}

// =====================================================================
// B. ACTIVE NOW — the REAL task engine (never the boardroom notes).
// =====================================================================

export async function ActiveNow() {
  const overview = await getTaskQueueOverview({ feed: 6 }).catch(() => null);
  const running = overview
    ? overview.recent.filter((t) => t.bucket === "active" || t.bucket === "queued").slice(0, 6)
    : [];

  return (
    <SectionShell
      id="active"
      title="Active now"
      sub={
        overview
          ? `${overview.totals.active} running · ${overview.totals.queued} queued`
          : undefined
      }
      href="/admin/tasks"
      hrefLabel="Task queue"
    >
      {!overview ? (
        <EmptyLine>The task engine couldn&apos;t be read just now.</EmptyLine>
      ) : running.length === 0 ? (
        <EmptyLine>
          <CircleDot className="h-4 w-4 text-slate-400" aria-hidden />
          Nothing is running right now.
        </EmptyLine>
      ) : (
        <ul className="divide-y divide-slate-100">
          {running.map((t) => {
            const who = t.employee?.name ?? t.taskType.replace(/[_-]+/g, " ");
            const when = t.startedAt ?? t.createdAt;
            return (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <DecisionStateBadge badge={presentTaskState(t.status)} />
                  <span className="truncate text-sm text-slate-800">{who}</span>
                </div>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {when ? relativeTime(when, RELATIVE_TIME_PRESETS.hqConsole) : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionShell>
  );
}

// =====================================================================
// C. RECENT OUTCOMES — the event spine.
// =====================================================================

export async function RecentOutcomes() {
  const page = await getTimelinePage({ limit: 8 }).catch(() => null);
  const items = page?.items ?? [];

  return (
    <SectionShell id="recent" title="Recent outcomes" href="/admin/pulse" hrefLabel="Activity feed">
      {items.length === 0 ? (
        <EmptyLine>No recorded activity yet.</EmptyLine>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((e) => (
            <li key={e.event_id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-800">
                  {e.verb.replace(/[._]+/g, " ")}
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {e.object_type}
                  {e.actor_type ? ` · ${e.actor_type}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-[11px] text-slate-500">
                {relativeTime(e.ts, RELATIVE_TIME_PRESETS.hqConsole)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

// =====================================================================
// D. CEO BRIEF — the deterministic morning briefing (narrative dark-safe).
// =====================================================================

export async function CeoBrief() {
  const archive = await getCeoBriefingArchive().catch(() => null);
  const latest = archive?.latest ?? null;

  return (
    <SectionShell
      id="brief"
      title="CEO brief"
      sub={latest ? `Briefing for ${latest.briefingDate}` : undefined}
      href="/admin/ceo/briefings"
      hrefLabel="All briefings"
    >
      {!latest ? (
        <EmptyLine>No briefing recorded yet — the morning cron writes the first one.</EmptyLine>
      ) : (
        <div>
          <p className="text-sm font-medium text-slate-900">{latest.headline}</p>
          {latest.narrative ? (
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600 line-clamp-6">
              {latest.narrative}
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">
              Deterministic briefing recorded. The narrative summary is not generated in this
              environment.
            </p>
          )}
        </div>
      )}
    </SectionShell>
  );
}

// =====================================================================
// E. SYSTEM HEALTH — exceptions only.
// =====================================================================

export async function SystemHealth() {
  const snap = await buildOpsSnapshot().catch(() => null);

  if (!snap) {
    return (
      <SectionShell title="System health" href="/admin/ops" hrefLabel="System status">
        <EmptyLine>Health couldn&apos;t be read just now.</EmptyLine>
      </SectionShell>
    );
  }

  if (snap.status === "green") {
    return (
      <SectionShell title="System health" href="/admin/ops" hrefLabel="System status">
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          All systems nominal — no exceptions.
        </p>
      </SectionShell>
    );
  }

  const failingCrons = snap.crons.filter((c) => c.failures_7d > 0);
  const missingEnv = snap.env.filter((e) => e.required && !e.present);

  return (
    <SectionShell
      title="System health"
      sub={snap.summary}
      href="/admin/ops"
      hrefLabel="System status"
    >
      <div className="space-y-2">
        <Badge tone={snap.status === "red" ? "red" : "amber"}>
          {snap.status === "red" ? "Action needed" : "Watch"}
        </Badge>
        <ul className="space-y-1 text-sm text-slate-700">
          {missingEnv.map((e) => (
            <li key={e.name} className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-hidden />
              Missing required config: <span className="font-mono text-xs">{e.name}</span>
            </li>
          ))}
          {failingCrons.map((c) => (
            <li key={c.route} className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
              Cron <span className="font-mono text-xs">{c.route}</span> — {c.failures_7d} failure
              {c.failures_7d === 1 ? "" : "s"} in 7d
            </li>
          ))}
          {snap.recent_failures.slice(0, 3).map((f, i) => (
            <li key={`${f.route}-${i}`} className="flex items-center gap-2 text-slate-600">
              <CircleDot className="h-3.5 w-3.5 text-slate-400" aria-hidden />
              <span className="font-mono text-xs">{f.route}</span>
              <span className="truncate">{f.error_message ?? "failed"}</span>
            </li>
          ))}
        </ul>
      </div>
    </SectionShell>
  );
}

/** Skeleton fallback for a streaming Home section. */
export function HomeSectionSkeleton({ title }: { title: string }) {
  return (
    <section className={`${CARD} p-5`}>
      <h2 className={SECTION_TITLE}>{title}</h2>
      <div className="mt-3 space-y-2" aria-hidden>
        <div className="h-12 rounded-lg bg-slate-100" />
        <div className="h-12 rounded-lg bg-slate-50" />
      </div>
    </section>
  );
}

export { Inbox };

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  CircleDashed,
  Loader2,
  Minus,
  Sparkles,
  X,
} from "lucide-react";
import {
  completedStepCount,
  phaseProgress,
  RESEARCH_PHASE_LABELS,
  type ResearchRunState,
  type ResearchStepState,
  type ResearchStepStatus,
} from "@/lib/research/model";
import { PHASE_PILL, STEP_BADGE, STEP_DOT, STEP_LABEL_TONE } from "../_styles";

/**
 * Research AI — the live run view (CEO Directive 005, Phase 1 + UX mandate).
 *
 * The "watch the AI work" experience. On mount it kicks the worker
 * (POST /api/admin/research/run) and then polls the checkpointed task state
 * (~1.2s) so the checklist animates in real time off the same row the runner
 * writes. The kick is idempotent server-side, so a refresh or the cron drain
 * can never double-run it. When the run reaches a terminal phase we stop
 * polling and refresh the route once, so the server re-renders the full
 * intelligence report in place.
 */

const POLL_MS = 1200;

function isTerminal(status: ResearchRunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function LiveRun({
  taskId,
  seed,
}: {
  taskId: string;
  seed: ResearchRunState;
}) {
  const router = useRouter();
  const [run, setRun] = useState<ResearchRunState>(seed);
  const kicked = useRef(false);
  const refreshed = useRef(false);
  const stopped = useRef(false);

  const terminal = isTerminal(run.status);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/research/state/${taskId}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { ok?: boolean; state?: ResearchRunState };
      if (json.ok && json.state) setRun(json.state);
    } catch {
      // transient — the next tick retries
    }
  }, [taskId]);

  // Kick the worker once, the moment the live view mounts.
  useEffect(() => {
    if (kicked.current || isTerminal(seed.status)) return;
    kicked.current = true;
    void fetch("/api/admin/research/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).catch(() => {
      // The cron drain is the safety net if this kick never lands.
    });
  }, [taskId, seed.status]);

  // Poll while the run is in flight; refresh once when it finishes.
  useEffect(() => {
    if (isTerminal(run.status)) {
      if (!refreshed.current) {
        refreshed.current = true;
        // Let the final state paint, then pull the rich server report in.
        const t = setTimeout(() => router.refresh(), 650);
        return () => clearTimeout(t);
      }
      return;
    }
    if (stopped.current) return;
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [run.status, poll, router]);

  const pct = Math.round(phaseProgress(run.phase) * 100);
  const done = completedStepCount(run.steps);
  const total = run.steps.length;

  return (
    <div className="space-y-6">
      {/* Live progress header */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              {terminal ? (
                <Sparkles className="h-5 w-5" aria-hidden />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              )}
            </span>
            <div>
              <p className="text-sm font-semibold text-white">
                {terminal ? "Research finished" : "Research AI is working…"}
              </p>
              <p className="text-xs text-slate-500">
                {done} of {total} steps · {RESEARCH_PHASE_LABELS[run.phase]}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold ${PHASE_PILL[run.phase]}`}
          >
            {RESEARCH_PHASE_LABELS[run.phase]}
          </span>
        </div>

        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-500 transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Animated checklist */}
      <ol className="space-y-1">
        {run.steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>

      {run.status === "failed" && run.error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {run.error}
        </p>
      ) : null}

      <p className="text-center text-[11px] text-slate-600">
        Reading public sources · scoring transparently · drafting for your
        review. Research AI never contacts anyone.
      </p>
    </div>
  );
}

function StepRow({ step }: { step: ResearchStepState }) {
  const active = step.status === "active";
  return (
    <li
      className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 transition ${
        active
          ? "border-indigo-500/30 bg-indigo-500/[0.06]"
          : "border-transparent"
      }`}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
        <StepIcon status={step.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className={`text-sm font-medium ${STEP_LABEL_TONE[step.status]}`}>
            {step.label}
          </span>
          <StepBadge status={step.status} />
        </span>
        {step.detail ? (
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {step.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function StepIcon({ status }: { status: ResearchStepStatus }) {
  const cls = `h-4 w-4 ${STEP_BADGE[status]}`;
  switch (status) {
    case "active":
      return <Loader2 className={`${cls} animate-spin`} aria-hidden />;
    case "done":
      return <Check className={cls} aria-hidden />;
    case "skipped":
      return <Minus className={cls} aria-hidden />;
    case "failed":
      return <X className={cls} aria-hidden />;
    default:
      return <CircleDashed className={cls} aria-hidden />;
  }
}

function StepBadge({ status }: { status: ResearchStepStatus }) {
  if (status === "pending") return null;
  const label =
    status === "active"
      ? "Working"
      : status === "done"
        ? "Done"
        : status === "skipped"
          ? "Skipped"
          : "Failed";
  return (
    <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${STEP_BADGE[status]}`}>
      {label}
    </span>
  );
}

/** Tiny presence dot used in compact contexts (kept for the step legend). */
export function StepDot({ status }: { status: ResearchStepStatus }) {
  return <span className={`block h-2.5 w-2.5 rounded-full ${STEP_DOT[status]}`} />;
}

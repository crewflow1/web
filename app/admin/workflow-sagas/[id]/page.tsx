import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { getSaga, type StepRow } from "@/server/services/hq-workflow";
import { relativeTime } from "@/lib/time/relative";
import { advanceStepAction, abandonSagaAction } from "../actions";

/**
 * HQ Workflow-Saga detail — one saga's step graph and its dispatch controls.
 *
 * Read-only projection of the saga plus its ordered steps, each rendered with its
 * department/role, dependency edge, live status and linked task. The "Advance"
 * control dispatches a step through the Task-Engine authority (server action →
 * service → hq_ai_task_create); a step whose dependency is not yet done cannot be
 * advanced (the button is disabled and the service refuses).
 *
 * Gated by the /admin layout (requireHqPage) plus this page's own call.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ saved?: string; error?: string }>;

const STEP_STYLE: Record<StepRow["status"], string> = {
  pending: "bg-slate-100 text-slate-600",
  running: "bg-blue-100 text-blue-700",
  blocked: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-700",
  skipped: "bg-slate-200 text-slate-500",
  failed: "bg-red-100 text-red-700",
};

export default async function SagaDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SP;
}) {
  await requireHqPage();
  const { id } = await params;
  const sp = await searchParams;

  const data = await getSaga(id);
  if (!data) notFound();
  const { saga, steps, progress } = data;

  const errorMsg = (sp.error ?? "").trim() || null;
  const terminal = saga.status === "done" || saga.status === "abandoned";
  const byOrdinal = new Map(steps.map((s) => [s.ordinal, s]));

  return (
    <div className="space-y-5">
      <Link
        href="/admin/workflow-sagas"
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All sagas
      </Link>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
            {saga.status}
          </span>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">{saga.title}</h1>
        </div>
        <p className="text-xs text-slate-500">
          {progress.done}/{progress.total} steps done ({progress.donePct}%) · raised{" "}
          {relativeTime(saga.created_at)}
          {saga.template_key ? ` · template ${saga.template_key}` : ""}
        </p>
      </header>

      {errorMsg ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {errorMsg}
        </p>
      ) : null}

      <ol className="space-y-3">
        {steps.map((step) => {
          const dep = step.depends_on_ordinal ? byOrdinal.get(step.depends_on_ordinal) : null;
          const depDone = dep === null || dep === undefined || dep.status === "done";
          const canAdvance = !terminal && depDone && step.status !== "done" && step.status !== "skipped";
          return (
            <li
              key={step.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-800 text-[11px] font-bold text-white">
                  {step.ordinal}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STEP_STYLE[step.status]}`}>
                  {step.status}
                </span>
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                  {step.title}
                </h3>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                {step.department ? <span>dept: {step.department}</span> : null}
                {step.role ? <span>role: {step.role}</span> : null}
                {step.depends_on_ordinal ? (
                  <span>depends on step {step.depends_on_ordinal}</span>
                ) : (
                  <span>root step</span>
                )}
                {step.hq_ai_task_id ? (
                  <span className="font-mono">task {step.hq_ai_task_id.slice(0, 8)}</span>
                ) : (
                  <span>not dispatched</span>
                )}
              </div>
              {canAdvance ? (
                <form action={advanceStepAction} className="mt-3">
                  <input type="hidden" name="saga_id" value={saga.id} />
                  <input type="hidden" name="step_id" value={step.id} />
                  <button
                    type="submit"
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
                  >
                    {step.hq_ai_task_id ? "Re-sync from task" : "Dispatch step"}
                  </button>
                </form>
              ) : !depDone ? (
                <p className="mt-3 text-[11px] text-slate-400">
                  Waiting on step {step.depends_on_ordinal} to complete.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {!terminal ? (
        <form action={abandonSagaAction} className="pt-2">
          <input type="hidden" name="saga_id" value={saga.id} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-red-300 hover:text-red-600"
          >
            Abandon saga
          </button>
        </form>
      ) : null}
    </div>
  );
}

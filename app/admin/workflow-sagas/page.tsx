import Link from "next/link";
import { Workflow } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { listSagas, SAGA_TEMPLATES, type SagaRow } from "@/server/services/hq-workflow";
import { relativeTime } from "@/lib/time/relative";
import { presentSagaState } from "@/lib/hq/presentation-state";
import { DecisionStateBadge } from "@/app/admin/_components/decision-state";
import { createSagaAction } from "./actions";

/**
 * HQ Workflow-Saga board — the cross-department task GRAPH surface.
 *
 * A saga decomposes a directive into an ordered, dependency-linked graph of steps,
 * each mapping to a single hq_ai_tasks row. This is the READ-ONLY board plus the
 * create action; the deterministic decomposition builds the graph, and each step is
 * dispatched through the Task-Engine authority on its detail page.
 *
 * Gated twice: app/admin/layout.tsx (requireHqPage) plus this page's own
 * requireHqPage() call (defence-in-depth, same as the Decision Centre).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ saved?: string; error?: string }>;

const SAVED_LABEL: Record<string, string> = {
  created: "Saga planned — its step graph is ready to dispatch.",
  advanced: "Step advanced — its task state is now reflected.",
  abandoned: "Saga abandoned — recorded in the permanent history.",
};

export default async function WorkflowSagasPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;

  const all = await listSagas({ limit: 200 });
  const active = all.filter((s) => s.status === "planned" || s.status === "running" || s.status === "blocked");
  const closed = all.filter((s) => s.status === "done" || s.status === "abandoned");

  const savedMsg = sp.saved ? (SAVED_LABEL[sp.saved] ?? null) : null;
  const errorMsg = (sp.error ?? "").trim() || null;

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
          <Workflow className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Workflow Sagas</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
            A directive decomposed into a cross-department task graph — ordered,
            dependency-linked steps, each mapping to one AI task. The saga sits above the
            task engine; progress reflects the real state of each step&apos;s task, never a
            fabricated one.
          </p>
        </div>
      </header>

      {savedMsg ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {savedMsg}
        </p>
      ) : null}
      {errorMsg ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {errorMsg}
        </p>
      ) : null}

      <NewSagaForm />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <EmptyState label="No active sagas. Decompose a directive above." />
        ) : (
          <ul className="space-y-3">
            {active.map((row) => (
              <li key={row.id}>
                <SagaCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Finished ({closed.length})
        </h2>
        {closed.length === 0 ? (
          <EmptyState label="No sagas have finished yet." />
        ) : (
          <ul className="space-y-3">
            {closed.map((row) => (
              <li key={row.id}>
                <SagaCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function NewSagaForm() {
  // Only render the create form to a permitted operator (the action re-gates, and
  // the service gates a third time — defence in depth).
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-600">
        + Decompose a new directive
      </summary>
      <form action={createSagaAction} className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Directive title <span className="text-red-500">*</span>
          </span>
          <input
            type="text"
            name="title"
            required
            maxLength={300}
            placeholder="e.g. Launch the invoicing revamp"
            className="block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Decomposition template <span className="text-red-500">*</span>
          </span>
          <select
            name="template_key"
            required
            defaultValue=""
            className="block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="" disabled>
              Choose a template…
            </option>
            {SAGA_TEMPLATES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} — {t.steps.length} steps
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          Plan the saga
        </button>
      </form>
    </details>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

function SagaCard({ row }: { row: SagaRow }) {
  return (
    <Link
      href={`/admin/workflow-sagas/${row.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow"
    >
      <div className="flex flex-wrap items-center gap-2">
        <DecisionStateBadge badge={presentSagaState(row.status)} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{row.title}</h3>
        <span className="text-[11px] text-slate-400">{relativeTime(row.updated_at)}</span>
      </div>
      {row.template_key ? (
        <p className="mt-1.5 text-xs text-slate-500">template: {row.template_key}</p>
      ) : null}
    </Link>
  );
}

import Link from "next/link";
import { GitBranch, ScrollText } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  listDecisions,
  type DecisionRow,
  type DecisionStatus,
} from "@/server/services/hq-decisions";
import { relativeTime } from "@/lib/time/relative";
import { createDecisionAction } from "./actions";
import { DecisionStatusPill } from "./_status";

/**
 * HQ Decision Centre — the strategic-decision surface (Master-Plan Phase 16 +
 * the HQ Layer-5 gap). Where the Approval Console decides whether one AI action may
 * send, this decides which strategic MOVES the business makes, and how: a rich,
 * human-authored proposal resolved with FOUR outcomes — approve, reject, DELAY,
 * DELEGATE (the two the audit found missing from the approval engine).
 *
 * Gated twice: app/admin/layout.tsx (requireHqPage) plus this page's own
 * requireHqPage() call (defence-in-depth, same as approvals). The engine never
 * executes anything — approving only records that the decision was made.
 *
 * ai_debate is untrusted model output once the AI tier is bound; it renders as
 * React-escaped text on the detail page, never as HTML.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ saved?: string; error?: string }>;

const SAVED_LABEL: Record<string, string> = {
  created: "Proposal raised — it now awaits a decision.",
  approved: "Approved — recorded in the permanent decision history.",
  rejected: "Rejected — recorded with your reason.",
  delayed: "Delayed — recorded with a revisit date.",
  delegated: "Delegated — assigned to an owner.",
};

const STATUS_ORDER: DecisionStatus[] = [
  "proposed",
  "approved",
  "delegated",
  "delayed",
  "rejected",
];

export default async function DecisionsPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;

  const all = await listDecisions({ limit: 200 });
  const proposed = all.filter((d) => d.status === "proposed");
  const decided = all.filter((d) => d.status !== "proposed");

  const savedMsg = sp.saved ? (SAVED_LABEL[sp.saved] ?? null) : null;
  const errorMsg = (sp.error ?? "").trim() || null;

  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    count: all.filter((d) => d.status === s).length,
  })).filter((c) => c.count > 0);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
            <GitBranch className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Decision Centre</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
              Strategic decisions, each a full proposal — problem, impact, cost, risk —
              resolved with one of four outcomes: approve, reject, delay, or delegate.
              The engine records the decision; it never executes it.
            </p>
          </div>
        </div>
        {counts.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {counts.map((c) => (
              <DecisionStatusPill key={c.status} status={c.status} suffix={` ${c.count}`} />
            ))}
          </div>
        ) : null}
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

      <NewDecisionForm />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Awaiting a decision ({proposed.length})
        </h2>
        {proposed.length === 0 ? (
          <EmptyState label="No decisions are awaiting judgement. Raise one above." />
        ) : (
          <ul className="space-y-3">
            {proposed.map((row) => (
              <li key={row.id}>
                <DecisionCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Decided ({decided.length})
        </h2>
        {decided.length === 0 ? (
          <EmptyState label="No decisions have been made yet." />
        ) : (
          <ul className="space-y-3">
            {decided.map((row) => (
              <li key={row.id}>
                <DecisionCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function NewDecisionForm() {
  // Only render the raise-a-proposal form to a permitted reviewer (the action
  // re-gates, and the service gates a third time — defence in depth).
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-semibold text-violet-700 hover:text-violet-600">
        + Raise a new decision
      </summary>
      <form action={createDecisionAction} className="mt-4 space-y-3">
        <Field name="title" label="Title" required placeholder="e.g. Adopt a second Supabase region" />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextArea name="problem" label="Problem" />
          <TextArea name="recommendation" label="Recommendation" />
          <TextArea name="business_impact" label="Business impact" />
          <TextArea name="revenue_impact" label="Revenue impact" />
          <TextArea name="demand" label="Demand / evidence" />
          <TextArea name="engineering_cost" label="Engineering cost" />
          <TextArea name="risk" label="Risk" />
          <TextArea name="timeline" label="Timeline" />
        </div>
        <button
          type="submit"
          className="rounded-md bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-violet-500"
        >
          Raise proposal
        </button>
      </form>
    </details>
  );
}

function Field({
  name,
  label,
  required,
  placeholder,
}: {
  name: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </span>
      <input
        type="text"
        name={name}
        required={required}
        maxLength={300}
        placeholder={placeholder}
        className="block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 placeholder-slate-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </label>
  );
}

function TextArea({ name, label }: { name: string; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <textarea
        name={name}
        rows={2}
        maxLength={5000}
        className="block w-full rounded-md border border-slate-300 p-2.5 text-sm text-slate-800 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </label>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

function DecisionCard({ row }: { row: DecisionRow }) {
  const stamp = row.decided_at ?? row.created_at;
  return (
    <Link
      href={`/admin/decisions/${row.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-violet-300 hover:shadow"
    >
      <div className="flex flex-wrap items-center gap-2">
        <DecisionStatusPill status={row.status} />
        {row.source === "deterministic" ? (
          <span
            className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700"
            title="Opened automatically from a system signal — awaiting a human decision."
          >
            Auto-proposed
          </span>
        ) : null}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {row.title}
        </h3>
        <span className="text-[11px] text-slate-400">{relativeTime(stamp)}</span>
      </div>
      {row.problem ? (
        <p className="mt-2 line-clamp-2 text-xs text-slate-600">{row.problem}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {row.revenue_impact ? (
          <span className="inline-flex items-center gap-1">
            <ScrollText className="h-3 w-3" aria-hidden /> {row.revenue_impact}
          </span>
        ) : null}
        {row.status === "delayed" && row.delay_until ? (
          <span>revisit {row.delay_until}</span>
        ) : null}
        {(row.ai_debate?.length ?? 0) > 0 ? (
          <span>{row.ai_debate.length} debate entries</span>
        ) : null}
      </div>
    </Link>
  );
}

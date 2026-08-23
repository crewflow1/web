import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Flag,
  Inbox,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import {
  listDecidedApprovals,
  listPendingApprovals,
  type ApprovalRow,
} from "@/server/services/hq-approvals";
import { listAiEmployees } from "@/server/services/ai-employees";
import { legalActions, type ApprovalState } from "@/lib/approvals/state";
import { effectivePayload, formatPayloadForDisplay } from "@/lib/approvals/payload";
import { relativeTime } from "@/lib/time/relative";
import { presentApprovalState } from "@/lib/hq/presentation-state";
import { DecisionStateBadge } from "@/app/admin/_components/decision-state";
import {
  approveApprovalAction,
  editApprovalAction,
  escalateApprovalAction,
  rejectApprovalAction,
} from "./actions";

/**
 * HQ Approval Console — the human decision surface of the Approval Engine
 * (Train 11; closes the write-only approvals hole from Directive 010 Phase 2).
 *
 * Producers (employee runners) already land proposals in hq_approvals; the
 * service already implements every transition; the DB trigger already enforces
 * the state machine. What was missing was a place where a HUMAN sees the queue
 * and decides. This page is that place: pending + escalated items as cards,
 * decided/expired history as the permanent record.
 *
 * Gated twice: app/admin/layout.tsx (requireHqPage) plus this page's own
 * requireHqPage() call (defence-in-depth, same as pulse/settings/ai-costs), and
 * every action re-checks the allowlist before the service checks it a third time.
 *
 * UNTRUSTED PAYLOADS: what an AI employee proposed is model output and may carry
 * adversarial text. Payloads render as React-escaped plain text inside <pre> —
 * never dangerouslySetInnerHTML, never interpreted, never followed.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ tab?: string; saved?: string; error?: string }>;

const SAVED_LABEL: Record<string, string> = {
  approved: "Approved — the engine marked it granted.",
  rejected: "Rejected — recorded with your reason.",
  escalated: "Escalated for higher attention.",
  edited: "Edit saved — tracked as your revision of the proposal.",
};

function expiryLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  if (t <= Date.now()) return "expiry due — awaiting the sweep";
  return `expires ${expiresAt.slice(0, 16).replace("T", " ")} UTC`;
}

export default async function ApprovalsPage({ searchParams }: { searchParams: SP }) {
  await requireHqPage();
  const sp = await searchParams;
  const tab = sp.tab === "history" ? "history" : "queue";

  const [queue, history, employees] = await Promise.all([
    listPendingApprovals(100),
    tab === "history" ? listDecidedApprovals(100) : Promise.resolve([]),
    listAiEmployees(),
  ]);
  const employeeName = new Map(employees.map((e) => [e.id, e.name]));
  const nameFor = (id: string) => employeeName.get(id) ?? "Unknown employee";

  const savedMsg = sp.saved ? (SAVED_LABEL[sp.saved] ?? null) : null;
  const errorMsg = (sp.error ?? "").trim() || null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700">
            <ClipboardCheck className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Approval Console
            </h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-600">
              Every AI-employee proposal waits here until a human decides. The
              engine never sends or executes — approving only marks an item
              approved.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-300">
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Payloads are untrusted data — rendered verbatim, never interpreted
        </span>
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

      {/* Tabs */}
      <nav className="flex gap-2 border-b border-slate-200 pb-px text-sm font-medium">
        <TabLink href="/admin/approvals" active={tab === "queue"}>
          <Inbox className="h-4 w-4" aria-hidden /> Review queue
          <span className="rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold text-slate-700">
            {queue.length}
          </span>
        </TabLink>
        <TabLink href="/admin/approvals?tab=history" active={tab === "history"}>
          <Clock3 className="h-4 w-4" aria-hidden /> Decided & expired
        </TabLink>
      </nav>

      {tab === "queue" ? (
        queue.length === 0 ? (
          <EmptyState label="Nothing awaits a decision. Proposals land here the moment an employee needs approval." />
        ) : (
          <ul className="space-y-4">
            {queue.map((row) => (
              <li key={row.id}>
                <QueueCard row={row} employeeName={nameFor(row.ai_employee_id)} />
              </li>
            ))}
          </ul>
        )
      ) : history.length === 0 ? (
        <EmptyState label="No decided or expired approvals yet." />
      ) : (
        <ul className="space-y-3">
          {history.map((row) => (
            <li key={row.id}>
              <HistoryCard row={row} employeeName={nameFor(row.ai_employee_id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 transition ${
        active
          ? "border-indigo-600 text-indigo-700"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
    >
      {children}
    </Link>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}

function StatePill({ state }: { state: ApprovalState }) {
  // The ONE HQ decision language: pending/escalated → "Needs approval",
  // approved → "Ready" (granted; the executor is dark, nothing has run),
  // rejected → "Rejected", expired keeps its own honest name.
  return <DecisionStateBadge badge={presentApprovalState(state)} />;
}

/**
 * The payload, shown SAFELY: React-escaped text inside <pre>. This is the one
 * place approval content meets the screen — it is data on display, not
 * instructions to anyone, human or machine.
 */
function PayloadBlock({ row }: { row: ApprovalRow }) {
  const edited = row.edited_payload !== null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {edited ? "Payload (reviewer-edited)" : "Proposed payload"}
      </p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
        {formatPayloadForDisplay(effectivePayload(row))}
      </pre>
      {edited ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700">
            Original proposal (unedited)
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-600">
            {formatPayloadForDisplay(row.proposed_payload)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function MetaGrid({ row, employeeName }: { row: ApprovalRow; employeeName: string }) {
  const expiry = expiryLabel(row.expires_at);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
      <Meta label="Requested by" value={employeeName} />
      <Meta label="Action" value={`${row.action} · ${row.subject_type}`} />
      <Meta label="Subject" value={row.subject_id} mono />
      <Meta
        label="Age"
        value={`${relativeTime(row.requested_at)}${expiry ? ` · ${expiry}` : ""}`}
      />
    </dl>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className={`truncate text-slate-700 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/** An active item: what's proposed, who proposed it, and the decision controls. */
function QueueCard({ row, employeeName }: { row: ApprovalRow; employeeName: string }) {
  const actions = legalActions(row.state);
  const canEscalate = actions.includes("escalate");
  const overdue =
    !!row.expires_at &&
    Number.isFinite(new Date(row.expires_at).getTime()) &&
    new Date(row.expires_at).getTime() <= Date.now();
  return (
    <article
      className={`rounded-xl border bg-white p-4 shadow-sm sm:p-5 ${
        row.state === "escalated" ? "border-orange-300" : "border-slate-200"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={row.state} />
        {row.supersedes_id ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
            recovery of a prior decision
          </span>
        ) : null}
        {overdue ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden /> past its deadline
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-slate-400">{row.id}</span>
      </div>

      <div className="mt-3 space-y-3">
        <MetaGrid row={row} employeeName={employeeName} />
        <PayloadBlock row={row} />
      </div>

      {/* Decisions — thin forms over the service's transitions. */}
      <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-slate-100 pt-4">
        <form action={approveApprovalAction}>
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Approve
          </button>
        </form>

        <form action={rejectApprovalAction} className="flex items-center gap-2">
          <input type="hidden" name="id" value={row.id} />
          <input
            type="text"
            name="reason"
            required
            maxLength={2000}
            placeholder="Rejection reason (required)"
            className="w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-500"
          >
            <XCircle className="h-3.5 w-3.5" aria-hidden /> Reject
          </button>
        </form>

        {canEscalate ? (
          <form action={escalateApprovalAction}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-700 transition hover:bg-orange-100"
            >
              <Flag className="h-3.5 w-3.5" aria-hidden /> Escalate
            </button>
          </form>
        ) : null}
      </div>

      {/* Edit-before-approve: the tracked revision the service already supports. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-indigo-600 hover:text-indigo-500">
          Edit payload before deciding
        </summary>
        <form action={editApprovalAction} className="mt-2 space-y-2">
          <input type="hidden" name="id" value={row.id} />
          <textarea
            name="payload_json"
            rows={8}
            defaultValue={formatPayloadForDisplay(effectivePayload(row))}
            className="block w-full rounded-lg border border-slate-300 p-3 font-mono text-xs text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              Save edit
            </button>
            <p className="text-[11px] text-slate-500">
              Strict JSON object only. Saved as your tracked revision — the
              original proposal stays on record.
            </p>
          </div>
        </form>
      </details>
    </article>
  );
}

/** A terminal item: the immutable record of what was decided, by whom, and why. */
function HistoryCard({ row, employeeName }: { row: ApprovalRow; employeeName: string }) {
  const decidedAt = row.decided_at ?? row.updated_at;
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={row.state} />
        <span className="text-xs text-slate-600">
          {row.action} · {row.subject_type}
        </span>
        <span className="text-[11px] text-slate-400">{relativeTime(decidedAt)}</span>
        <span className="ml-auto font-mono text-[10px] text-slate-400">{row.id}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Meta label="Requested by" value={employeeName} />
        <Meta label="Subject" value={row.subject_id} mono />
        <Meta
          label="Reviewer"
          value={row.state === "expired" ? "system (expiry sweep)" : (row.reviewer_email ?? "—")}
        />
        <Meta label="Requested" value={relativeTime(row.requested_at)} />
      </dl>
      {row.decision_reason ? (
        <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold text-slate-500">Reason: </span>
          {row.decision_reason}
        </p>
      ) : null}
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-slate-500 hover:text-slate-700">
          Payload as decided
        </summary>
        <div className="mt-1">
          <PayloadBlock row={row} />
        </div>
      </details>
    </article>
  );
}

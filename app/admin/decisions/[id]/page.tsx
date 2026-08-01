import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock3, UserPlus, XCircle } from "lucide-react";
import { requireHqPage } from "@/server/auth/hq";
import {
  getDecision,
  listDecisionEvents,
  type DecisionEventRow,
  type DecisionRow,
} from "@/server/services/hq-decisions";
import { relativeTime } from "@/lib/time/relative";
import { decideAction } from "../actions";
import { DecisionStatusPill } from "../_status";

/**
 * HQ Decision Centre — decision detail (Master-Plan Phase 16).
 *
 * The full proposal, the four decision actions, and the immutable decision history.
 * Gated on requireHqPage (the layout gates too; defence-in-depth). ai_debate is
 * untrusted model output once the AI tier is bound — it renders as React-escaped
 * text inside <pre>, never as HTML, never interpreted.
 */

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SP = Promise<{ saved?: string; error?: string }>;

const SAVED_LABEL: Record<string, string> = {
  approved: "Approved — recorded in the permanent decision history.",
  rejected: "Rejected — recorded with your reason.",
  delayed: "Delayed — recorded with a revisit date.",
  delegated: "Delegated — assigned to an owner.",
};

export default async function DecisionDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SP;
}) {
  await requireHqPage();
  const { id } = await params;
  const sp = await searchParams;

  const decision = await getDecision(id);
  if (!decision) notFound();
  const events = await listDecisionEvents(id);

  const savedMsg = sp.saved ? (SAVED_LABEL[sp.saved] ?? null) : null;
  const errorMsg = (sp.error ?? "").trim() || null;
  const isOpen = decision.status === "proposed";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link
        href="/admin/decisions"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All decisions
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <DecisionStatusPill status={decision.status} />
          <span className="ml-auto font-mono text-[10px] text-slate-400">{decision.id}</span>
        </div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{decision.title}</h1>
        <p className="text-[11px] text-slate-400">Raised {relativeTime(decision.created_at)}</p>
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

      {/* The proposal. */}
      <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2">
        <ProposalField label="Problem" value={decision.problem} full />
        <ProposalField label="Recommendation" value={decision.recommendation} full />
        <ProposalField label="Business impact" value={decision.business_impact} />
        <ProposalField label="Revenue impact" value={decision.revenue_impact} />
        <ProposalField label="Demand" value={decision.demand} />
        <ProposalField label="Engineering cost" value={decision.engineering_cost} />
        <ProposalField label="Risk" value={decision.risk} />
        <ProposalField label="Timeline" value={decision.timeline} />
      </section>

      {/* The AI-employee debate — empty until a model tier is bound. */}
      <AiDebate debate={decision.ai_debate} />

      {/* The decision, or the record of it. */}
      {isOpen ? (
        <DecisionActions decision={decision} />
      ) : (
        <DecisionOutcomeSummary decision={decision} />
      )}

      {/* The immutable history. */}
      <DecisionHistory events={events} />
    </div>
  );
}

function ProposalField({
  label,
  value,
  full,
}: {
  label: string;
  value: string | null;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">
        {value ?? <span className="text-slate-400">—</span>}
      </p>
    </div>
  );
}

function AiDebate({ debate }: { debate: DecisionRow["ai_debate"] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">AI debate</h2>
      {!debate || debate.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
          AI debate populates once a model tier is bound.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {debate.map((entry, i) => (
            <li key={i}>
              {/* Untrusted model output — rendered as escaped text, never HTML. */}
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700">
                {JSON.stringify(entry, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DecisionActions({ decision }: { decision: DecisionRow }) {
  return (
    <section className="space-y-4 rounded-xl border border-violet-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Make the decision</h2>
      <p className="text-xs text-slate-500">
        Recording a decision never executes it — acting on it stays a human&apos;s job.
      </p>

      {/* Approve */}
      <form action={decideAction} className="flex items-center gap-2">
        <input type="hidden" name="id" value={decision.id} />
        <input type="hidden" name="outcome" value="approve" />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden /> Approve
        </button>
        <input
          type="text"
          name="reason"
          maxLength={2000}
          placeholder="Optional note"
          className="w-64 rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
        />
      </form>

      {/* Reject */}
      <form action={decideAction} className="flex items-center gap-2">
        <input type="hidden" name="id" value={decision.id} />
        <input type="hidden" name="outcome" value="reject" />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-red-500"
        >
          <XCircle className="h-4 w-4" aria-hidden /> Reject
        </button>
        <input
          type="text"
          name="reason"
          required
          maxLength={2000}
          placeholder="Reason (required)"
          className="w-64 rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
        />
      </form>

      {/* Delay */}
      <form action={decideAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={decision.id} />
        <input type="hidden" name="outcome" value="delay" />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-sky-500"
        >
          <Clock3 className="h-4 w-4" aria-hidden /> Delay
        </button>
        <input
          type="date"
          name="delay_until"
          required
          className="rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-800 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
        <input
          type="text"
          name="reason"
          required
          maxLength={2000}
          placeholder="Why delay? (required)"
          className="w-56 rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />
      </form>

      {/* Delegate */}
      <form action={decideAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={decision.id} />
        <input type="hidden" name="outcome" value="delegate" />
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-violet-500"
        >
          <UserPlus className="h-4 w-4" aria-hidden /> Delegate
        </button>
        <input
          type="text"
          name="delegate_to"
          required
          maxLength={200}
          placeholder="Delegate user id (uuid)"
          className="w-64 rounded-md border border-slate-300 px-2.5 py-2 font-mono text-xs text-slate-800 placeholder-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
        />
        <input
          type="text"
          name="reason"
          required
          maxLength={2000}
          placeholder="Why delegate? (required)"
          className="w-56 rounded-md border border-slate-300 px-2.5 py-2 text-xs text-slate-800 placeholder-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400"
        />
      </form>
    </section>
  );
}

function DecisionOutcomeSummary({ decision }: { decision: DecisionRow }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionStatusPill status={decision.status} />
        <span className="text-xs text-slate-600">
          decided {decision.decided_at ? relativeTime(decision.decided_at) : "—"}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        {decision.delay_until ? (
          <SummaryItem label="Revisit on" value={decision.delay_until} />
        ) : null}
        {decision.delegate_to ? (
          <SummaryItem label="Delegated to" value={decision.delegate_to} mono />
        ) : null}
      </dl>
      {decision.decision_reason ? (
        <p className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
          <span className="font-semibold text-slate-500">Reason: </span>
          {decision.decision_reason}
        </p>
      ) : null}
      <p className="mt-3 text-[11px] text-slate-400">
        This decision is terminal — its record is frozen. To revisit it, raise a new
        proposal.
      </p>
    </section>
  );
}

function SummaryItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`truncate text-slate-700 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function DecisionHistory({ events }: { events: DecisionEventRow[] }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">History</h2>
      <p className="mb-3 text-[11px] text-slate-400">
        Append-only and immutable — every transition, stored forever.
      </p>
      <ol className="space-y-2">
        {events.map((ev) => (
          <li key={ev.id} className="flex flex-wrap items-center gap-2 text-xs">
            <DecisionStatusPill status={ev.event_type} />
            <span className="text-slate-600">
              {ev.from_status ? `${ev.from_status} → ${ev.to_status}` : `raised as ${ev.to_status}`}
            </span>
            {ev.actor_email ? <span className="text-slate-500">by {ev.actor_email}</span> : null}
            <span className="ml-auto text-slate-400">{relativeTime(ev.created_at)}</span>
            {ev.reason ? (
              <p className="w-full rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-slate-600">
                {ev.reason}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

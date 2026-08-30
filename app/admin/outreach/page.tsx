import Link from "next/link";
import {
  AlertCircle,
  Inbox,
  Mail,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getOutreachMetrics,
  type OutreachRunRow,
  type OutreachTaskStatus,
} from "@/server/services/hq-outreach";
import { searchCompanies } from "@/server/services/hq-sales";
import { RELATIVE_TIME_PRESETS, relativeTime } from "@/lib/time/relative";
import { OutreachLauncher, QuickDraftButton, type OutreachCandidate } from "./_launcher";

/**
 * Outreach AI — section home (CEO Directive 010, Phase 4).
 *
 * The activation surface for the previously CALLER-LESS `startOutreach`
 * pipeline (server/services/hq-outreach.ts): the one chooser ("Draft
 * outreach") over the qualified pipeline, live run metrics, and the drafts the
 * employee has produced. HQ-gated by the /admin layout (requireHqPage → 404
 * for non-allowlisted), exactly like its Research/Qualification siblings; the
 * server actions re-check the allowlist besides.
 *
 * HONEST ABOUT THE DARK STATE: this employee is DRAFT-ONLY (no send scope —
 * a human reviews, edits, approves and sends), and while no LLM cost tier is
 * bound the Draft Engine degrades to its deterministic template. Every run
 * row carries its real provenance, and deterministic drafts are labelled as
 * deterministic — never dressed up as model output.
 */

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<OutreachTaskStatus, string> = {
  pending: "bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-400/30",
  running: "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30",
  completed: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  failed: "bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-400/30",
  cancelled: "bg-slate-700/40 text-slate-400 ring-1 ring-inset ring-slate-600/40",
};

const STATUS_LABEL: Record<OutreachTaskStatus, string> = {
  pending: "Queued",
  running: "Drafting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const PROVENANCE_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deterministic: "Deterministic (governed dark)",
};

export default async function OutreachHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, metrics, candidatePage] = await Promise.all([
    searchParams,
    getOutreachMetrics(),
    searchCompanies({ status: "qualified", sort: "researched", pageSize: 12 }),
  ]);

  const candidates: OutreachCandidate[] = candidatePage.companies.map((c) => ({
    id: c.id,
    name: c.name,
    score: c.ai_qualification_score,
    researched: !!c.last_researched_at,
  }));

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(244,114,182,0.10), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Mail className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Outreach AI</h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                Drafts the cold outreach email for a qualified company, grounded
                on the research report and the qualification verdict. Every
                draft is an immutable artifact awaiting human review — this
                employee has no send scope.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Draft only · nothing is ever sent
            </span>
            <Link
              href="/admin/qualification"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              Qualification AI
            </Link>
          </div>
        </div>
      </div>

      <div className="space-y-6 p-5 sm:p-7">
        {error ? (
          <p className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {error}
          </p>
        ) : null}

        {/* The one chooser */}
        <section className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-900/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-300" aria-hidden />
            <h2 className="text-sm font-semibold text-white">Draft outreach</h2>
          </div>
          <OutreachLauncher candidates={candidates} />
          <p className="mt-4 rounded-lg border border-slate-700/40 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
            Governed and currently dark: while no model cost tier is bound, the
            Draft Engine&rsquo;s deterministic template produces the draft — the
            run completes honestly with provenance &lsquo;deterministic&rsquo;,
            never a fabricated model draft. A human reviews, edits, approves and
            sends every email.
          </p>
        </section>

        {/* Live outcomes */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-slate-400" aria-hidden />
              <h2 className="text-sm font-semibold text-white">Outcomes</h2>
            </div>
            <span className="text-[11px] text-slate-500">
              {metrics.total.toLocaleString()} total
              {metrics.failed ? ` · ${metrics.failed} failed` : ""}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Drafts produced" value={metrics.drafted.toLocaleString()} accent />
            <Tile label="Completed runs" value={metrics.completed.toLocaleString()} />
            <Tile label="In flight" value={metrics.inFlight.toLocaleString()} sub="queued + running" />
            <Tile
              label="Deterministic"
              value={metrics.provenance.deterministic.toLocaleString()}
              sub="governed-dark fallback"
            />
            <Tile
              label="Model-drafted"
              value={(metrics.provenance.anthropic + metrics.provenance.openai).toLocaleString()}
              sub="governed LLM leg"
            />
          </div>
        </section>

        {/* Qualified companies — one-click draft */}
        {candidates.length ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Qualified companies</h2>
              <span className="text-[11px] text-slate-500">
                {candidatePage.total.toLocaleString()} qualified
              </span>
            </div>
            <ul className="divide-y divide-slate-800/70">
              {candidates.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/sales/companies/${c.id}`}
                      className="truncate text-sm font-medium text-white transition hover:text-indigo-300"
                    >
                      {c.name}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                      <span className="font-semibold tabular-nums text-slate-300">
                        {c.score == null ? "Unscored" : `Fit ${c.score}`}
                      </span>
                      {!c.researched ? (
                        <span className="text-amber-400/80">not researched</span>
                      ) : null}
                    </p>
                  </div>
                  <QuickDraftButton companyId={c.id} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Drafts / recent runs */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent drafts</h2>
            {metrics.lastCompletedAt ? (
              <span className="text-[11px] text-slate-500">
                Last completed{" "}
                {relativeTime(metrics.lastCompletedAt, RELATIVE_TIME_PRESETS.hqConsole)}
              </span>
            ) : null}
          </div>
          {metrics.recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-500">
              No outreach drafts yet. Choose a qualified company above — the
              draft lands here, awaiting human review.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {metrics.recent.map((run) => (
                <RunRow key={run.taskId} run={run} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        accent
          ? "border-indigo-400/30 bg-indigo-500/10"
          : "border-slate-800 bg-slate-900/40"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-white">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

function RunRow({ run }: { run: OutreachRunRow }) {
  const when = run.finishedAt ?? run.createdAt;
  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        {run.companyId ? (
          <Link
            href={`/admin/sales/companies/${run.companyId}`}
            className="truncate text-sm font-medium text-white transition hover:text-indigo-300"
          >
            {run.companyName ?? "Untitled company"}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium text-white">
            {run.companyName ?? "Untitled company"}
          </p>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
          <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_PILL[run.status]}`}>
            {STATUS_LABEL[run.status]}
          </span>
          {run.provenance ? (
            <span
              className={
                run.provenance === "deterministic"
                  ? "rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30"
                  : "rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-300 ring-1 ring-inset ring-sky-400/30"
              }
            >
              {PROVENANCE_LABEL[run.provenance] ?? run.provenance}
            </span>
          ) : null}
          {when ? <span>{relativeTime(when, RELATIVE_TIME_PRESETS.hqConsole)}</span> : null}
        </p>
      </div>
      <span className="text-[11px] text-slate-500">
        {run.draftId ? "Draft ready · awaiting review" : run.status === "failed" ? "No draft" : "—"}
      </span>
    </li>
  );
}

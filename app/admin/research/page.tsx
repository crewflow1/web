import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import {
  Activity,
  AlertCircle,
  Brain,
  Microscope,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getResearchMetrics,
  type ResearchRunRow,
} from "@/server/services/hq-research";
import { researchAiEnabled } from "@/server/services/research-llm";
import { ResearchLauncher } from "./_launcher";
import { Tile, ProvenanceBadge } from "./_components";
import { STATUS_LABEL, STATUS_PILL, scoreTone } from "./_styles";

/**
 * Research AI — section home (CEO Directive 005, Phase 1 + 10).
 *
 * The one button ("Research company") plus the live metrics of the employee:
 * how many companies it has researched, the in-flight queue, the average
 * score, decision makers found, and how its figures were produced (model vs
 * deterministic). Honest "Foundation" zeros until the first run. Recent runs
 * link straight to their live / finished view.
 */

export const dynamic = "force-dynamic";

export default async function ResearchHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, metrics, aiEnabled] = await Promise.all([
    searchParams,
    getResearchMetrics(),
    Promise.resolve(researchAiEnabled()),
  ]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="relative border-b border-slate-800 px-5 py-6 sm:px-7">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(60% 120% at 15% 0%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50% 120% at 90% 0%, rgba(16,185,129,0.12), transparent 55%)",
          }}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Microscope className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Research AI</h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                Give it a company and it learns more in a minute than a salesperson
                could in an hour — real sources, a transparent score, and drafted
                outreach ready for Sales AI.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Read + draft only · fully audited
            </span>
            <Link
              href="/admin/sales"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Activity className="h-3.5 w-3.5" aria-hidden />
              Sales AI
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

        {/* The one button */}
        <section className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/80 to-slate-900/40 p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-indigo-300" aria-hidden />
            <h2 className="text-sm font-semibold text-white">Research a company</h2>
          </div>
          <ResearchLauncher />
          {!aiEnabled ? (
            <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-300/90">
              No AI provider key is configured, so runs use the deterministic
              engine only — real extracted facts and a transparent score, with
              interpretive fields left honestly unknown. Add a provider key to
              enable the full analysis.
            </p>
          ) : null}
        </section>

        {/* Live metrics */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Companies researched" value={<AnimatedNumber value={metrics.completed} />} accent />
          <Tile label="In flight" value={<AnimatedNumber value={metrics.inFlight} />} sub="queued + running" />
          <Tile
            label="Average score"
            value={metrics.avgScore == null ? "—" : `${metrics.avgScore}`}
            sub={metrics.scored ? `${metrics.scored} scored` : "no scores yet"}
          />
          <Tile label="Decision makers" value={<AnimatedNumber value={metrics.decisionMakersIdentified} />} sub="identified" />
          <Tile label="Total runs" value={<AnimatedNumber value={metrics.total} />} />
          <Tile label="Failed" value={<AnimatedNumber value={metrics.failed} />} />
        </div>

        {/* Provenance breakdown — honest about how figures were produced */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center gap-2">
            <Brain className="h-4 w-4 text-slate-400" aria-hidden />
            <h2 className="text-sm font-semibold text-white">How findings were produced</h2>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ProvenanceTile
              label="Claude (Anthropic)"
              value={metrics.provenance.anthropic}
              tone="indigo"
            />
            <ProvenanceTile
              label="GPT (OpenAI)"
              value={metrics.provenance.openai}
              tone="emerald"
            />
            <ProvenanceTile
              label="Deterministic"
              value={metrics.provenance.deterministic}
              tone="slate"
            />
          </div>
        </section>

        {/* Recent runs */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Recent research</h2>
            {metrics.lastCompletedAt ? (
              <span className="text-[11px] text-slate-500">
                Last completed {relativeTime(metrics.lastCompletedAt)}
              </span>
            ) : null}
          </div>
          {metrics.recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 px-4 py-8 text-center text-sm text-slate-500">
              No research yet. Enter a company above and watch Research AI work.
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

function ProvenanceTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "indigo" | "emerald" | "slate";
}) {
  const ring =
    tone === "indigo"
      ? "ring-indigo-400/20"
      : tone === "emerald"
        ? "ring-emerald-400/20"
        : "ring-slate-700";
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/60 p-4 ring-1 ring-inset ${ring}`}>
      <p className="text-2xl font-bold text-white">{value.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-slate-500">{label}</p>
    </div>
  );
}

function RunRow({ run }: { run: ResearchRunRow }) {
  const when = run.finishedAt ?? run.createdAt;
  return (
    <li>
      <Link
        href={`/admin/research/${run.taskId}`}
        className="flex items-center justify-between gap-3 py-3 transition hover:opacity-90"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {run.companyName ?? "Untitled company"}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span
              className={`rounded-full px-2 py-0.5 font-medium ${STATUS_PILL[run.status]}`}
            >
              {STATUS_LABEL[run.status]}
            </span>
            {run.decisionMakers != null ? <span>{run.decisionMakers} DMs</span> : null}
            {when ? <span>{relativeTime(when)}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ProvenanceBadge provenance={run.provenance} />
          <span className={`text-lg font-bold tabular-nums ${scoreTone(run.score)}`}>
            {run.score == null ? "—" : run.score}
          </span>
        </div>
      </Link>
    </li>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

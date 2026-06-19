import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import {
  ArrowRight,
  BookMarked,
  Brain,
  Building2,
  Layers,
  Quote,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import { getLearningEngine } from "@/server/services/hq-sales";
import { relativeTime } from "@/lib/sales/model";
import {
  confidenceLabel,
  confidenceTone,
  learningChannelLabel,
  learningStatusLabel,
  patternTypeLabel,
} from "@/lib/sales/learning";
import type { SalesLearningItem } from "@/lib/sales/model";
import { Chip, EmptyState, Pill, Section, Tile } from "../_components";
import { inputCls, tonerPill } from "../_styles";

/**
 * Sales AI — Learning Engine (CEO Directive 004, Phase 7).
 *
 * The compounding edge: every winning cold-call, email, LinkedIn touch,
 * objection rebuttal, demo and close is distilled into a REUSABLE pattern —
 * the prompt that worked, the context it worked in, the result it produced,
 * the metrics behind it, tags, and a confidence. Over time this is the sales
 * brain the autonomous engine reaches for first.
 *
 * FOUNDATION ONLY — nothing here captures, scores, or applies a learning; it
 * presents the permanent, audited hq_sales_learnings data plus the seeded,
 * immediately-useful CrewFlow construction-sales winning patterns. A proven
 * learning can be PROMOTED into the company-wide Shared Memory engine via the
 * memory_id bridge (a later phase wires that write) — shown honestly here as
 * a badge, never faked. HQ operator only (the layout gates the module to
 * Super Admin).
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ q?: string }>;

/** Flatten a learning's free-form metrics bag to printable key/value pairs. */
function metricEntries(
  metrics: Record<string, unknown> | null,
): { key: string; value: string }[] {
  if (!metrics) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (value == null) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out.push({ key, value: String(value) });
    }
  }
  return out;
}

export default async function LearningPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const query = sp.q?.trim() ?? "";

  const engine = await getLearningEngine({ search: query || undefined });
  const { stats, learnings } = engine;

  const topTypes = stats.byType
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count);

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
        <div className="relative">
          <p className="text-sm text-slate-500">
            <Link href="/admin/sales" className="hover:text-slate-300">
              Sales AI
            </Link>{" "}
            / <span className="text-slate-300">Learning</span>
          </p>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                <Brain className="h-6 w-6" strokeWidth={1.75} aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">
                  Learning Engine
                </h1>
                <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                  Every winning call, email, LinkedIn touch, objection, demo
                  and close — distilled into a reusable pattern the engine
                  reaches for first. The compounding sales brain.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Foundation only · patterns are captured, never auto-applied
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Totals */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile
            label="Patterns"
            value={<AnimatedNumber value={stats.total} />}
            accent
            sub="distilled plays"
          />
          <Tile label="Active" value={<AnimatedNumber value={stats.active} />} sub="in rotation" />
          <Tile
            label="Blended win rate"
            value={`${stats.blendedWinRate}%`}
            sub="wins ÷ uses"
          />
          <Tile
            label="Avg confidence"
            value={stats.avgConfidence != null ? `${stats.avgConfidence}%` : "—"}
            sub="authored belief"
          />
          <Tile
            label="Logged uses"
            value={<AnimatedNumber value={stats.totalUses} />}
            sub="real applications"
          />
          <Tile
            label="Promoted"
            value={<AnimatedNumber value={stats.promoted} />}
            sub="in Shared Memory"
          />
        </div>

        {/* By pattern type */}
        <Section
          title="By pattern type"
          subtitle="Where the playbook is deepest across the sales motion"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Layers className="h-3.5 w-3.5" aria-hidden />
              {topTypes.length}
            </span>
          }
        >
          {topTypes.length === 0 ? (
            <p className="text-sm text-slate-500">
              No patterns captured yet — distilled plays appear here grouped by
              the part of the sale they win.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topTypes.map((t) => (
                <span
                  key={t.slug}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5"
                >
                  <span className="text-sm font-medium text-slate-200">
                    {patternTypeLabel(t.slug)}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-white">
                    {t.count.toLocaleString()}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Section>

        {/* Pattern library + search */}
        <Section
          title="Winning patterns"
          subtitle="The reusable prompt, the context it wins in, and the result it produced — searchable"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <BookMarked className="h-3.5 w-3.5" aria-hidden />
              {learnings.length}
            </span>
          }
        >
          <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                aria-hidden
              />
              <input
                type="search"
                name="q"
                defaultValue={query}
                placeholder="Search every pattern — title, prompt, context, result…"
                aria-label="Search patterns"
                className={`${inputCls} mt-0 pl-9`}
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              Search
            </button>
            {query ? (
              <Link
                href="/admin/sales/learning"
                className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear
              </Link>
            ) : null}
          </form>

          {learnings.length === 0 ? (
            <EmptyState
              message={
                query
                  ? "No patterns match that search yet."
                  : "No patterns captured yet. Winning calls, emails and closes are distilled here into reusable plays — each with the prompt, the context and the result that proved it."
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {learnings.map((l) => (
                <LearningCard key={l.id} learning={l} />
              ))}
            </div>
          )}
        </Section>

        {/* Shared Memory bridge */}
        <Section
          title="Shared Memory bridge"
          subtitle="Proven plays graduate from the sales playbook into the company-wide brain every AI employee reads."
        >
          <Link
            href="/admin/memory"
            className="group flex items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-indigo-500/40 hover:bg-slate-900"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/15 text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/30">
                <Brain className="h-5 w-5" strokeWidth={1.75} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100">
                  Shared Memory Engine
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {stats.promoted.toLocaleString()} sales{" "}
                  {stats.promoted === 1 ? "pattern" : "patterns"} promoted into
                  company-wide memory. A learning earns promotion by proving
                  itself in real, logged use — the bridge is wired, never faked.
                </p>
              </div>
            </div>
            <ArrowRight
              className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:translate-x-0.5 group-hover:text-indigo-300"
              aria-hidden
            />
          </Link>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Card component (server, no client JS).
// ---------------------------------------------------------------------

function LearningCard({ learning: l }: { learning: SalesLearningItem }) {
  const metrics = metricEntries(l.metrics);
  const measured = l.times_used > 0;

  return (
    <article className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 text-sm font-semibold text-white">{l.title}</h3>
        {l.confidence != null ? (
          <Pill className={tonerPill(confidenceTone(l.confidence))}>
            {l.confidence}% · {confidenceLabel(l.confidence)}
          </Pill>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Chip>{patternTypeLabel(l.pattern_type)}</Chip>
        {l.channel ? <Chip>{learningChannelLabel(l.channel)}</Chip> : null}
        {l.status !== "active" ? (
          <Chip>{learningStatusLabel(l.status)}</Chip>
        ) : null}
        {l.memory_id ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[10px] font-medium text-fuchsia-300 ring-1 ring-inset ring-fuchsia-400/30">
            <Sparkles className="h-3 w-3" aria-hidden />
            In Shared Memory
          </span>
        ) : null}
      </div>

      {l.summary ? (
        <p className="mt-2 text-xs text-slate-400">{l.summary}</p>
      ) : null}

      {l.prompt ? (
        <div className="mt-3">
          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Quote className="h-3 w-3" aria-hidden />
            The play
          </p>
          <p className="mt-1 whitespace-pre-line border-l-2 border-indigo-500/40 pl-3 text-xs italic text-slate-300">
            {l.prompt}
          </p>
        </div>
      ) : null}

      {l.context ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            When to use it
          </p>
          <p className="mt-1 text-xs text-slate-300">{l.context}</p>
        </div>
      ) : null}

      {l.result ? (
        <div className="mt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Why it works
          </p>
          <p className="mt-1 text-xs text-slate-300">{l.result}</p>
        </div>
      ) : null}

      {l.supporting_points.length > 0 ? (
        <div className="mt-3">
          <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <Target className="h-3 w-3" aria-hidden />
            Keys
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {l.supporting_points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {metrics.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {metrics.map((m) => (
            <span
              key={m.key}
              className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-300"
            >
              <span className="text-slate-500">{m.key}</span>
              <span className="font-semibold tabular-nums text-slate-100">
                {m.value}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {l.tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Tag className="h-3 w-3 text-slate-600" aria-hidden />
          {l.tags.map((t) => (
            <span key={t} className="text-[11px] text-slate-500">
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
        {measured ? (
          <>
            {l.win_rate != null ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <TrendingUp className="h-3 w-3" aria-hidden />
                {l.win_rate}% win
              </span>
            ) : null}
            <span>
              {l.times_used.toLocaleString()}{" "}
              {l.times_used === 1 ? "use" : "uses"}
            </span>
            {l.times_won > 0 ? (
              <span>{l.times_won.toLocaleString()} won</span>
            ) : null}
          </>
        ) : (
          <span className="text-slate-600">
            Authored prior · earns its win-rate from logged use
          </span>
        )}
        {l.company_id && l.company_name ? (
          <Link
            href={`/admin/sales/companies/${l.company_id}`}
            className="inline-flex items-center gap-1 text-slate-400 hover:text-indigo-300"
          >
            <Building2 className="h-3 w-3" aria-hidden />
            {l.company_name}
          </Link>
        ) : null}
        <span className="ml-auto">{relativeTime(l.updated_at)}</span>
      </div>
    </article>
  );
}

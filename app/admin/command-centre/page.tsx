import { Suspense } from "react";
import { IconTile, pill } from "@/components/ui";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BrainCircuit,
  Crown,
  Gauge,
} from "lucide-react";
import { getExecutiveDashboard } from "@/server/services/hq-executive";
import {
  type ExecAccent,
  type ExecCard,
  type ExecSection,
  type ExecTrend,
} from "@/lib/hq/executive";
import { ExecCounter, LiveDot } from "./_counter";

/**
 * CrewFlow HQ — Command Centre (CEO Directive 004, Phase 2).
 *
 * The live control centre of the entire company: revenue, pipeline,
 * conversion rates, outreach, the AI workforce, and the research engine in
 * one glance. ~27 animated cards grouped into six sections, every figure
 * sourced from real HQ data (the one channel with no source yet — WhatsApp
 * — is flagged "Foundation").
 *
 * Premium, Stripe/Linear-grade feel: a glass-on-near-black canvas with an
 * indigo→emerald header glow, count-up numbers, period-over-period trend
 * badges, staggered card entrances (pure CSS via tailwindcss-animate), and
 * a streaming skeleton while the data resolves.
 *
 * Auth: the parent /admin layout gates on isSuperAdminEmail — non-allowlisted
 * users 404 before reaching here. This is the /admin landing page.
 */

export const dynamic = "force-dynamic";

const ACCENT: Record<ExecAccent, { text: string; glow: string }> = {
  indigo: { text: "text-indigo-300", glow: "bg-indigo-500/20" },
  emerald: { text: "text-emerald-300", glow: "bg-emerald-500/20" },
  amber: { text: "text-amber-300", glow: "bg-amber-500/20" },
  sky: { text: "text-sky-300", glow: "bg-sky-500/20" },
  fuchsia: { text: "text-fuchsia-300", glow: "bg-fuchsia-500/20" },
  rose: { text: "text-rose-300", glow: "bg-rose-500/20" },
  violet: { text: "text-violet-300", glow: "bg-violet-500/20" },
  slate: { text: "text-slate-200", glow: "bg-slate-500/20" },
};

export default function CommandCentrePage() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header />
      <div className="space-y-8 p-5 sm:p-7">
        <Suspense fallback={<CommandSkeleton />}>
          <Body />
        </Suspense>
      </div>
    </div>
  );
}

function Header() {
  return (
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
          <IconTile size="lg">
            <Gauge className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </IconTile>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              Command Centre
            </h1>
            <p className="mt-0.5 max-w-xl text-sm text-slate-400">
              The live control centre of the entire company — revenue,
              pipeline, outreach, the AI workforce, and the research engine in
              one glance.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
            <LiveDot />
            Live · HQ only · Super Admin
          </span>
          <Link
            href="/admin/ceo"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <Crown className="h-3.5 w-3.5" aria-hidden />
            CEO Board
          </Link>
          <Link
            href="/admin/sales"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <Activity className="h-3.5 w-3.5" aria-hidden />
            Sales AI
          </Link>
          <Link
            href="/admin/ai-employees"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <BrainCircuit className="h-3.5 w-3.5" aria-hidden />
            AI Employees
          </Link>
        </div>
      </div>
    </div>
  );
}

async function Body() {
  const data = await getExecutiveDashboard();
  let runningIndex = 0;
  return (
    <>
      {data.sections.map((section) => {
        const startIndex = runningIndex;
        runningIndex += section.cards.length;
        return (
          <SectionView
            key={section.key}
            section={section}
            startIndex={startIndex}
          />
        );
      })}
      <p className="text-center text-[11px] text-slate-600">
        Live snapshot · generated{" "}
        {new Date(data.generatedAt).toLocaleString("en-GB")} · every figure
        sourced from HQ data
      </p>
    </>
  );
}

function SectionView({
  section,
  startIndex,
}: {
  section: ExecSection;
  startIndex: number;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-white">{section.title}</h2>
        {section.subtitle ? (
          <p className="mt-0.5 text-xs text-slate-500">{section.subtitle}</p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {section.cards.map((card, idx) => (
          <MetricCard key={card.key} card={card} index={startIndex + idx} />
        ))}
      </div>
    </section>
  );
}

function MetricCard({ card, index }: { card: ExecCard; index: number }) {
  const a = ACCENT[card.accent];
  // Stagger card entrances; cap the delay so later cards don't lag.
  const delayMs = Math.min(index * 35, 650);

  const inner = (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl">
      <div
        className={`pointer-events-none absolute -right-6 -top-8 h-20 w-20 rounded-full blur-2xl ${a.glow}`}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {card.label}
        </p>
        {card.foundation ? (
          <FoundationTag />
        ) : card.trend ? (
          <TrendBadge trend={card.trend} />
        ) : null}
      </div>
      <p className={`relative mt-2 text-2xl font-bold ${a.text}`}>
        <ExecCounter value={card.value} format={card.format} delayMs={delayMs} />
      </p>
      {card.sub ? (
        <p className="relative mt-1 truncate text-[11px] text-slate-500">
          {card.sub}
        </p>
      ) : null}
    </div>
  );

  const entrance =
    "animate-in fade-in-0 slide-in-from-bottom-3 fill-mode-both duration-500";
  const style = { animationDelay: `${delayMs}ms` };

  return card.href ? (
    <Link href={card.href} className={`block ${entrance}`} style={style}>
      {inner}
    </Link>
  ) : (
    <div className={entrance} style={style}>
      {inner}
    </div>
  );
}

function TrendBadge({ trend }: { trend: ExecTrend }) {
  if (trend.direction === "flat") return null;
  const up = trend.direction === "up";
  const cls = pill(up ? "emerald" : "rose");
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {Math.abs(trend.pct)}%
    </span>
  );
}

function FoundationTag() {
  return (
    <span className="rounded-full bg-slate-700/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400 ring-1 ring-inset ring-slate-600/40">
      Foundation
    </span>
  );
}

function CommandSkeleton() {
  return (
    <div className="space-y-8">
      {[6, 5, 4].map((n, s) => (
        <div key={s}>
          <div className="mb-3 h-4 w-44 animate-pulse rounded bg-slate-800" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: n }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
              >
                <div className="h-3 w-16 animate-pulse rounded bg-slate-800" />
                <div className="mt-3 h-7 w-24 animate-pulse rounded bg-slate-800" />
                <div className="mt-2 h-3 w-20 animate-pulse rounded bg-slate-800" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

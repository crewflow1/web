import { Suspense } from "react";
import { IconTile } from "@/components/ui";
import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Banknote,
  Bot,
  Brain,
  Crown,
  Gauge,
  LifeBuoy,
  Megaphone,
  Microscope,
  Phone,
  Target,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { getCeoDashboard } from "@/server/services/hq-ceo";
import { formatExec, type ExecAccent, type ExecCard, type ExecTrend } from "@/lib/hq/executive";
import type { DeptCard, DeptHealth, DeptHealthTone, DeptStat } from "@/lib/hq/ceo";
import { ExecCounter, LiveDot } from "../command-centre/_counter";

/**
 * CrewFlow HQ — CEO Dashboard (CEO Directive 004, Phase 8).
 *
 * The whole company on one board. Not the Phase 2 metric grid — a
 * *departmental* read: a hero band of five company vitals, then one scorecard
 * per department (Finance, Customers, Pipeline, Sales, Marketing, Research,
 * AI, Learning, Support, Growth), each with a headline figure, a few
 * supporting stats, an optional trend, a drill-in link, and a single honest
 * health signal.
 *
 * Honest by construction: live departments (money, customers, support) report
 * real direction; the nascent AI functions report "Foundation" until they log
 * real volume — never a faked green light. All derivation is pure
 * (lib/hq/ceo.ts); this file is presentation only.
 *
 * Premium, Stripe/Linear-grade feel: glass-on-near-black, indigo→emerald
 * header glow, count-up headline numbers, staggered card entrances (pure CSS),
 * and a streaming skeleton while the data resolves.
 *
 * Auth: the parent /admin layout gates on isSuperAdminEmail — non-allowlisted
 * users 404 before reaching here.
 */

export const dynamic = "force-dynamic";

const ACCENT: Record<ExecAccent, { text: string; glow: string; chip: string }> = {
  indigo: { text: "text-indigo-300", glow: "bg-indigo-500/20", chip: "bg-indigo-500/15 ring-indigo-400/30" },
  emerald: { text: "text-emerald-300", glow: "bg-emerald-500/20", chip: "bg-emerald-500/15 ring-emerald-400/30" },
  amber: { text: "text-amber-300", glow: "bg-amber-500/20", chip: "bg-amber-500/15 ring-amber-400/30" },
  sky: { text: "text-sky-300", glow: "bg-sky-500/20", chip: "bg-sky-500/15 ring-sky-400/30" },
  fuchsia: { text: "text-fuchsia-300", glow: "bg-fuchsia-500/20", chip: "bg-fuchsia-500/15 ring-fuchsia-400/30" },
  rose: { text: "text-rose-300", glow: "bg-rose-500/20", chip: "bg-rose-500/15 ring-rose-400/30" },
  violet: { text: "text-violet-300", glow: "bg-violet-500/20", chip: "bg-violet-500/15 ring-violet-400/30" },
  slate: { text: "text-slate-200", glow: "bg-slate-500/20", chip: "bg-slate-500/15 ring-slate-400/30" },
};

const DEPT_ICON: Record<string, LucideIcon> = {
  banknote: Banknote,
  users: Users,
  target: Target,
  phone: Phone,
  megaphone: Megaphone,
  microscope: Microscope,
  bot: Bot,
  brain: Brain,
  "life-buoy": LifeBuoy,
  "trending-up": TrendingUp,
};

const HEALTH: Record<DeptHealthTone, { dot: string; pill: string }> = {
  healthy: {
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30",
  },
  steady: {
    dot: "bg-sky-400",
    pill: "bg-sky-500/10 text-sky-300 ring-sky-400/30",
  },
  attention: {
    dot: "bg-amber-400",
    pill: "bg-amber-500/10 text-amber-300 ring-amber-400/30",
  },
  foundation: {
    dot: "bg-slate-500",
    pill: "bg-slate-700/40 text-slate-400 ring-slate-600/40",
  },
};

export default function CeoDashboardPage() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <Header />
      <div className="space-y-8 p-5 sm:p-7">
        <Suspense fallback={<BoardSkeleton />}>
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
          <IconTile accent="amber" size="lg">
            <Crown className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </IconTile>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              CEO Dashboard
            </h1>
            <p className="mt-0.5 max-w-xl text-sm text-slate-400">
              Every department of the AI company on one board — money,
              customers, the sales engine, the AI workforce, and support, each
              with an honest health signal.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
            <LiveDot />
            Live · HQ only · Super Admin
          </span>
          <Link
            href="/admin/command-centre"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <Gauge className="h-3.5 w-3.5" aria-hidden />
            Command Centre
          </Link>
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
  );
}

async function Body() {
  const { board, generatedAt } = await getCeoDashboard();
  return (
    <>
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-white">Company vitals</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            The five numbers that define where the company stands right now
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {board.vitals.map((card, idx) => (
            <VitalCard key={card.key} card={card} index={idx} />
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Departments</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Each function of the business at a glance — open one to drill in
            </p>
          </div>
          <HealthLegend />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {board.departments.map((dept, idx) => (
            <DepartmentCard key={dept.key} dept={dept} index={idx} />
          ))}
        </div>
      </section>

      <p className="text-center text-[11px] text-slate-600">
        Live snapshot · generated{" "}
        {new Date(generatedAt).toLocaleString("en-GB")} · every figure sourced
        from HQ data
      </p>
    </>
  );
}

function VitalCard({ card, index }: { card: ExecCard; index: number }) {
  const a = ACCENT[card.accent];
  const delayMs = Math.min(index * 45, 300);
  return (
    <div
      className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 animate-in fade-in-0 slide-in-from-bottom-3 fill-mode-both hover:-translate-y-0.5 hover:bg-slate-900"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div
        className={`pointer-events-none absolute -right-6 -top-8 h-20 w-20 rounded-full blur-2xl ${a.glow}`}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {card.label}
        </p>
        {card.trend ? <TrendBadge trend={card.trend} /> : null}
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
}

function DepartmentCard({ dept, index }: { dept: DeptCard; index: number }) {
  const a = ACCENT[dept.accent];
  const Icon = DEPT_ICON[dept.icon] ?? Target;
  const delayMs = Math.min(index * 40, 360);
  return (
    <Link
      href={dept.href}
      className="group block animate-in fade-in-0 slide-in-from-bottom-3 fill-mode-both duration-500"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg ring-1 ring-inset ring-white/5 transition duration-200 hover:-translate-y-0.5 hover:bg-slate-900 hover:shadow-xl">
        <div
          className={`pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full blur-2xl ${a.glow}`}
          aria-hidden
        />
        <div className="relative flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-inset ${a.chip} ${a.text}`}
            >
              <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </span>
            <h3 className="text-sm font-semibold text-white">{dept.title}</h3>
          </div>
          <HealthPill health={dept.health} />
        </div>

        <div className="relative mt-3 flex items-end justify-between gap-2">
          <p className={`text-3xl font-bold ${a.text}`}>
            <ExecCounter
              value={dept.headline.value}
              format={dept.headline.format}
              delayMs={delayMs}
            />
          </p>
          {dept.trend ? <TrendBadge trend={dept.trend} /> : null}
        </div>
        <p className="relative mt-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          {dept.headline.label}
        </p>

        <p className="relative mt-2 text-xs leading-relaxed text-slate-400">
          {dept.blurb}
        </p>

        {dept.stats.length > 0 ? (
          <div className="relative mt-3 flex gap-2">
            {dept.stats.map((s) => (
              <StatBlock key={s.label} stat={s} />
            ))}
          </div>
        ) : null}

        <div className="relative mt-3 flex items-center gap-1 border-t border-slate-800/70 pt-2.5 text-[11px] font-semibold text-slate-400 transition group-hover:text-slate-200">
          Open {dept.title}
          <ArrowRight
            className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </div>
      </div>
    </Link>
  );
}

function StatBlock({ stat }: { stat: DeptStat }) {
  return (
    <div className="flex-1 rounded-lg border border-slate-800/60 bg-slate-950/40 px-2.5 py-1.5">
      <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-slate-500">
        {stat.label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">
        {formatExec(stat.value, stat.format)}
      </p>
    </div>
  );
}

function HealthPill({ health }: { health: DeptHealth }) {
  const h = HEALTH[health.tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${h.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${h.dot}`} aria-hidden />
      {health.label}
    </span>
  );
}

function HealthLegend() {
  const items: { tone: DeptHealthTone; label: string }[] = [
    { tone: "healthy", label: "Healthy" },
    { tone: "steady", label: "Steady" },
    { tone: "attention", label: "Attention" },
    { tone: "foundation", label: "Foundation" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <span
          key={it.tone}
          className="inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-500"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${HEALTH[it.tone].dot}`}
            aria-hidden
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function TrendBadge({ trend }: { trend: ExecTrend }) {
  if (trend.direction === "flat") return null;
  const up = trend.direction === "up";
  const cls = up
    ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30"
    : "bg-rose-500/15 text-rose-300 ring-rose-400/30";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${cls}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      {Math.abs(trend.pct)}%
    </span>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-8">
      <div>
        <div className="mb-3 h-4 w-36 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
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
      <div>
        <div className="mb-3 h-4 w-32 animate-pulse rounded bg-slate-800" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <div className="flex items-center justify-between">
                <div className="h-9 w-9 animate-pulse rounded-lg bg-slate-800" />
                <div className="h-4 w-16 animate-pulse rounded-full bg-slate-800" />
              </div>
              <div className="mt-3 h-8 w-24 animate-pulse rounded bg-slate-800" />
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-slate-800" />
              <div className="mt-3 flex gap-2">
                <div className="h-10 flex-1 animate-pulse rounded-lg bg-slate-800" />
                <div className="h-10 flex-1 animate-pulse rounded-lg bg-slate-800" />
                <div className="h-10 flex-1 animate-pulse rounded-lg bg-slate-800" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

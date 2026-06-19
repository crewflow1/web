import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import {
  Activity,
  BarChart3,
  Brain,
  Briefcase,
  ListChecks,
  MessagesSquare,
  PhoneCall,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { getSalesDashboard } from "@/server/services/hq-sales";
import { formatGbp, statusLabel } from "@/lib/sales/model";
import {
  ActivityChart,
  CompanyCard,
  EmptyState,
  FacetBars,
  FunnelChart,
  Section,
  Tile,
  TimelineItem,
} from "./_components";

/**
 * Sales AI Platform — command dashboard (CEO Directive 003, Phase 1).
 *
 * The whole pipeline at a glance: the directive's status counts, funnel
 * conversion, weekly / monthly activity, AI productivity (last 30 days),
 * pipeline + won value, the headline facets, and the most recent
 * companies + activity. Status counts come from an indexed read; facets +
 * activity from bounded windows in the service layer.
 */

export const dynamic = "force-dynamic";

const HEADLINE: { key: string; accent?: boolean }[] = [
  { key: "new" },
  { key: "qualified" },
  { key: "outreach_ready" },
  { key: "contacted" },
  { key: "replied" },
  { key: "demo_booked" },
  { key: "won", accent: true },
  { key: "lost" },
  { key: "disqualified" },
];

export default async function SalesDashboardPage() {
  const d = await getSalesDashboard();

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
              <Briefcase className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                Sales AI
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                The company-intelligence database, AI research, pipeline, and
                activity feed for the CrewFlow sales engine — fully audited.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              HQ only · Super Admin · every change audited
            </span>
            <Link
              href="/admin/sales/analytics"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <BarChart3 className="h-3.5 w-3.5" aria-hidden />
              Analytics
            </Link>
            <Link
              href="/admin/sales/activity"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Activity className="h-3.5 w-3.5" aria-hidden />
              Activity
            </Link>
            <Link
              href="/admin/sales/communications"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
              Comms
            </Link>
            <Link
              href="/admin/sales/calling"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <PhoneCall className="h-3.5 w-3.5" aria-hidden />
              Calling
            </Link>
            <Link
              href="/admin/sales/learning"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Brain className="h-3.5 w-3.5" aria-hidden />
              Learning
            </Link>
            <Link
              href="/admin/sales/tasks"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              Tasks
            </Link>
            <Link
              href="/admin/sales/companies"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Search className="h-3.5 w-3.5" aria-hidden />
              Companies
            </Link>
            <Link
              href="/admin/sales/companies/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New company
            </Link>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Headline status counts */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Tile label="Total companies" value={<AnimatedNumber value={d.total} />} accent />
          {HEADLINE.map((h) => (
            <Tile
              key={h.key}
              label={statusLabel(h.key)}
              value={<AnimatedNumber value={(d.counts[h.key as keyof typeof d.counts] ?? 0)} />}
              accent={h.accent}
            />
          ))}
        </div>

        {/* Performance + money */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile
            label="Pipeline value"
            value={formatGbp(d.pipelineValueGbp)}
            sub="open deals"
            accent
          />
          <Tile label="Won value" value={formatGbp(d.wonValueGbp)} sub="closed-won" />
          <Tile label="Win rate" value={`${d.winRate}%`} sub="won ÷ all" />
          <Tile label="Close rate" value={`${d.closeRate}%`} sub="won ÷ decided" />
          <Tile label="Weekly activity" value={<AnimatedNumber value={d.activity.weekly} />} sub="last 7 days" />
          <Tile label="Monthly activity" value={<AnimatedNumber value={d.activity.monthly} />} sub="last 30 days" />
        </div>

        {/* Funnel + activity */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Pipeline funnel"
            subtitle="Companies reaching each stage + conversion from the previous"
          >
            <FunnelChart funnel={d.funnel} />
          </Section>
          <Section title="Activity" subtitle="Logged events per day (last 14 days)">
            <ActivityChart points={d.activity.series} />
          </Section>
        </div>

        {/* AI productivity */}
        <Section
          title="AI productivity"
          subtitle="AI-attributed output in the last 30 days — every item traceable"
          action={
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {d.aiProductivity.total.toLocaleString()} total
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Research reports" value={<AnimatedNumber value={d.aiProductivity.researchReports} />} />
            <Tile label="Recommendations" value={<AnimatedNumber value={d.aiProductivity.recommendations} />} />
            <Tile label="Logged actions" value={<AnimatedNumber value={d.aiProductivity.loggedActions} />} />
            <Tile label="Total AI actions" value={<AnimatedNumber value={d.aiProductivity.total} />} accent />
          </div>
        </Section>

        {/* Headline facets */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Section title="Top industries">
            <FacetBars facets={d.facets.byIndustry.slice(0, 8)} />
          </Section>
          <Section title="Top counties">
            <FacetBars facets={d.facets.byCounty.slice(0, 8)} />
          </Section>
          <Section title="Lead sources">
            <FacetBars facets={d.facets.bySource.slice(0, 8)} />
          </Section>
        </div>

        {/* Recent companies */}
        <Section
          title="Recently added companies"
          action={
            <Link
              href="/admin/sales/companies"
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              Browse all →
            </Link>
          }
        >
          {d.recentCompanies.length === 0 ? (
            <EmptyState
              message="No companies yet. Add the first company to the intelligence database."
              cta={
                <Link
                  href="/admin/sales/companies/new"
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                >
                  Add a company →
                </Link>
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {d.recentCompanies.map((c) => (
                <li key={c.id}>
                  <CompanyCard company={c} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent activity */}
        <Section
          title="Recent activity"
          action={
            <Link
              href="/admin/sales/activity"
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              Full feed →
            </Link>
          }
        >
          {d.recentActivity.length === 0 ? (
            <p className="text-sm text-slate-500">No activity logged yet.</p>
          ) : (
            <ul className="relative">
              {d.recentActivity.map((e) => (
                <TimelineItem key={e.id} event={e} showCompany />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

import Link from "next/link";
import { AnimatedNumber, IconTile } from "@/components/ui";
import { BarChart3, TrendingUp } from "lucide-react";
import { getSalesAnalytics } from "@/server/services/hq-sales";
import { formatGbp } from "@/lib/sales/model";
import { FacetBars, FunnelChart, Section, Tile } from "../_components";

/**
 * Sales AI — Analytics (CEO Directive 003, Phase 1).
 *
 * The directive's Analytics deliverable: pipeline funnel + conversion,
 * win / close rates, open-pipeline value, and the full facet set — lead
 * source, industry, county, region, salesperson, status, and size — all
 * computed in the pure model layer from a bounded company window. HQ
 * operator only (the layout gates the whole module to Super Admin).
 */

export const dynamic = "force-dynamic";

export default async function SalesAnalyticsPage() {
  const a = await getSalesAnalytics();

  const decided = a.counts.won + a.counts.lost + a.counts.disqualified;
  const open = a.total - decided;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb + header */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          / <span className="text-slate-300">Analytics</span>
        </p>

        <div className="flex items-center gap-3">
          <IconTile size="md">
            <BarChart3 className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </IconTile>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Sales analytics
            </h1>
            <p className="text-xs text-slate-400">
              Funnel, conversion, and every facet across the master database.
            </p>
          </div>
        </div>

        {/* Headline rates + money */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total companies" value={<AnimatedNumber value={a.total} />} accent />
          <Tile label="Open pipeline" value={<AnimatedNumber value={open} />} sub="not yet decided" />
          <Tile label="Pipeline value" value={formatGbp(a.pipelineValueGbp)} sub="open deals" accent />
          <Tile label="Win rate" value={`${a.winRate}%`} sub="won ÷ all" />
          <Tile label="Close rate" value={`${a.closeRate}%`} sub="won ÷ decided" />
          <Tile label="Decided deals" value={<AnimatedNumber value={decided} />} sub="won + lost + DQ" />
        </div>

        {/* Funnel + conversion */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Pipeline funnel"
            subtitle="Companies reaching each stage + conversion from the previous"
          >
            <FunnelChart funnel={a.funnel} />
          </Section>
          <Section
            title="Status distribution"
            subtitle="Every company by current pipeline status"
            action={
              <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                <TrendingUp className="h-3.5 w-3.5" aria-hidden />
                {a.total.toLocaleString()} total
              </span>
            }
          >
            <FacetBars facets={a.facets.byStatus} />
          </Section>
        </div>

        {/* Lead source + salesperson */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Lead sources"
            subtitle="Where companies entered the database"
          >
            <FacetBars facets={a.facets.bySource} emptyLabel="No sources recorded yet." />
          </Section>
          <Section
            title="Salesperson"
            subtitle="Companies by assigned owner"
          >
            <FacetBars
              facets={a.facets.bySalesperson}
              emptyLabel="No companies assigned yet."
            />
          </Section>
        </div>

        {/* Geography */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Top counties" subtitle="Geographic concentration by county">
            <FacetBars facets={a.facets.byCounty.slice(0, 12)} emptyLabel="No county data yet." />
          </Section>
          <Section title="Regions" subtitle="Geographic concentration by region">
            <FacetBars facets={a.facets.byRegion.slice(0, 12)} emptyLabel="No region data yet." />
          </Section>
        </div>

        {/* Industry + size */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Top industries" subtitle="Sector mix across the database">
            <FacetBars facets={a.facets.byIndustry.slice(0, 12)} emptyLabel="No industry data yet." />
          </Section>
          <Section title="Company size" subtitle="By employee-count band">
            <FacetBars facets={a.facets.bySize} emptyLabel="No size data yet." />
          </Section>
        </div>

        <p className="text-[11px] text-slate-600">
          Facets are computed from the most recent 5,000 companies. Funnel
          conversion reflects current pipeline position; lost and disqualified
          companies sit off the linear funnel.
        </p>
      </div>
    </div>
  );
}

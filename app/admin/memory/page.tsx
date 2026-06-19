import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import { Brain, Plus, Search, ShieldCheck } from "lucide-react";
import {
  getDashboardStats,
  listMemoryTypes,
} from "@/server/services/hq-memory";
import type { FacetCount } from "@/lib/memory/model";
import {
  EmptyState,
  MemoryCard,
  MemoryTypeBadge,
  Section,
  Tile,
  buildTypeMap,
} from "./_components";

/**
 * Shared Memory Engine — CEO dashboard (CEO Directive 002, Phase 2).
 *
 * The company knowledge engine at a glance: totals, today's additions,
 * important + pinned + unread counts, knowledge growth, department
 * activity, top contributors, and the most recent / pinned memories.
 *
 * Headline counts come from indexed COUNT queries; the facets + growth
 * are aggregated from a bounded recent window in the service layer.
 */

export const dynamic = "force-dynamic";

export default async function MemoryDashboardPage() {
  const [stats, types] = await Promise.all([
    getDashboardStats(),
    listMemoryTypes(),
  ]);
  const typeMap = buildTypeMap(types);

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
              <Brain className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">
                Shared Memory
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-slate-400">
                The single company brain every AI employee reads from —
                indexed, searchable, permission-aware, and audited.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Read-first · AI reads, humans write
            </span>
            <Link
              href="/admin/memory/search"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Search className="h-3.5 w-3.5" aria-hidden />
              Search
            </Link>
            <Link
              href="/admin/memory/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New memory
            </Link>
          </div>
        </div>
      </div>

      <div className="space-y-5 p-5 sm:p-7">
        {/* Headline stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Total memories" value={<AnimatedNumber value={stats.total} />} />
          <Tile label="Added today" value={<AnimatedNumber value={stats.today} />} />
          <Tile label="Important" value={<AnimatedNumber value={stats.important} />} />
          <Tile label="Pinned" value={<AnimatedNumber value={stats.pinned} />} />
          <Tile label="Unread" value={<AnimatedNumber value={stats.unread} />} />
          <Tile
            label="Recently accessed"
            value={<AnimatedNumber value={stats.recentlyAccessed} />}
            sub="last 7 days"
          />
        </div>

        {/* Growth + department activity */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section
            title="Knowledge growth"
            subtitle="New memories per day (last 14 days)"
          >
            <GrowthChart points={stats.facets.growth} />
          </Section>
          <Section title="Department activity" subtitle="Memories by department">
            {stats.facets.byDepartment.length === 0 ? (
              <p className="text-sm text-slate-500">No data yet.</p>
            ) : (
              <FacetBars facets={stats.facets.byDepartment} />
            )}
          </Section>
        </div>

        {/* By type / status / importance */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Section title="By memory type">
            {stats.facets.byType.length === 0 ? (
              <p className="text-sm text-slate-500">No data yet.</p>
            ) : (
              <ul className="space-y-2">
                {stats.facets.byType.map((f) => (
                  <li
                    key={f.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <MemoryTypeBadge type={typeMap[f.key]} slug={f.key} />
                    <span className="text-sm font-semibold tabular-nums text-slate-200">
                      {f.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="By status">
            <FacetBars facets={stats.facets.byStatus} />
          </Section>
          <Section title="By importance">
            <FacetBars facets={stats.facets.byImportance} />
          </Section>
        </div>

        {/* Top contributors */}
        <Section title="Top contributors" subtitle="Who is feeding the brain">
          {stats.facets.topContributors.length === 0 ? (
            <p className="text-sm text-slate-500">No contributors yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {stats.facets.topContributors.map((c, i) => (
                <li
                  key={c.email}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 py-1 pl-1 pr-3"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/15 text-[11px] font-bold text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
                    {i + 1}
                  </span>
                  <span className="text-xs text-slate-300">{c.email}</span>
                  <span className="text-xs font-semibold tabular-nums text-slate-400">
                    {c.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Pinned */}
        <Section
          title="Pinned memory"
          action={
            <Link
              href="/admin/memory/search?pinned=1"
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              View all →
            </Link>
          }
        >
          {stats.pinnedMemories.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing pinned yet.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {stats.pinnedMemories.map((m) => (
                <li key={m.id}>
                  <MemoryCard memory={m} typeMap={typeMap} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent */}
        <Section
          title="Recently added"
          action={
            <Link
              href="/admin/memory/search"
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              Browse all →
            </Link>
          }
        >
          {stats.recent.length === 0 ? (
            <EmptyState
              message="No memories yet. Capture the first piece of company knowledge."
              cta={
                <Link
                  href="/admin/memory/new"
                  className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                >
                  Create a memory →
                </Link>
              }
            />
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {stats.recent.map((m) => (
                <li key={m.id}>
                  <MemoryCard memory={m} typeMap={typeMap} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Local chart helpers (dependency-free, server-rendered).
// ---------------------------------------------------------------------

function GrowthChart({ points }: { points: { date: string; count: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <div>
      <div className="flex h-28 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.date}
            className="group relative flex-1"
            title={`${p.date}: ${p.count}`}
          >
            <div
              className="w-full rounded-t bg-gradient-to-t from-indigo-600/40 to-indigo-400/80 transition group-hover:from-indigo-500/60 group-hover:to-indigo-300"
              style={{
                height: `${Math.max(4, (p.count / max) * 100)}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-600">
        <span>{points[0]?.date.slice(5)}</span>
        <span>{points[points.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function FacetBars({ facets }: { facets: FacetCount[] }) {
  if (facets.length === 0) {
    return <p className="text-sm text-slate-500">No data yet.</p>;
  }
  const max = Math.max(1, ...facets.map((f) => f.count));
  return (
    <ul className="space-y-2.5">
      {facets.map((f) => (
        <li key={f.key}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-300">{f.label}</span>
            <span className="font-semibold tabular-nums text-slate-400">
              {f.count}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-indigo-500/70"
              style={{ width: `${(f.count / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

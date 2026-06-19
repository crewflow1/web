import Link from "next/link";
import { AnimatedNumber } from "@/components/ui";
import { Activity as ActivityIcon, Search, X } from "lucide-react";
import { listActivityFeed } from "@/server/services/hq-sales";
import { eventCategory } from "@/lib/sales/model";
import { EmptyState, Section, TimelineItem, Tile } from "../_components";
import { inputCls } from "../_styles";

/**
 * Sales AI — global Activity Feed (CEO Directive 003, Phase 1).
 *
 * The directive's Activity deliverable: one chronological stream of every
 * logged touch and lifecycle milestone across ALL companies — new
 * companies, AI research, outreach, replies, demos, and closed deals —
 * each linking back to its company. HQ operator only (the layout gates the
 * whole module to Super Admin). The window size is URL-driven so a
 * refresh or shared link restores the same view.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ show?: string; q?: string }>;

const WINDOWS = [60, 120, 240] as const;
const MAX_WINDOW = WINDOWS[WINDOWS.length - 1] ?? 240;

/** Group "YYYY-MM-DD" into a friendly heading relative to today. */
function dayHeading(dayKey: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (dayKey === today) return "Today";
  if (dayKey === yesterday) return "Yesterday";
  const d = new Date(`${dayKey}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function SalesActivityPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const requested = Number.parseInt(sp.show ?? "60", 10);
  const limit = WINDOWS.includes(requested as (typeof WINDOWS)[number])
    ? requested
    : 60;
  const query = sp.q?.trim() ?? "";

  const feed = await listActivityFeed(limit, query || undefined);
  const now = new Date();

  const interactions = feed.filter(
    (e) => eventCategory(e.event_type) === "interaction",
  ).length;
  const lifecycle = feed.length - interactions;
  const aiActions = feed.filter((e) => e.ai_employee_id != null).length;

  // Group consecutive events by calendar day (feed is newest-first).
  const groups: { day: string; events: typeof feed }[] = [];
  for (const e of feed) {
    const day = e.occurred_at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(e);
    else groups.push({ day, events: [e] });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      <div className="space-y-5 p-5 sm:p-7">
        {/* Breadcrumb + header */}
        <p className="text-sm text-slate-500">
          <Link href="/admin/sales" className="transition-colors hover:text-slate-300">
            Sales AI
          </Link>{" "}
          / <span className="text-slate-300">Activity</span>
        </p>

        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <ActivityIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">
              Activity feed
            </h1>
            <p className="text-xs text-slate-400">
              Every logged touch and milestone across the master database.
            </p>
          </div>
        </div>

        {/* Full-text search — "everything must be searchable" */}
        <form method="get" className="flex flex-wrap items-center gap-2">
          {limit !== 60 ? (
            <input type="hidden" name="show" value={limit} />
          ) : null}
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search every event — subject, notes, outcome, type…"
              aria-label="Search activity"
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
              href={limit === 60 ? "/admin/sales/activity" : `/admin/sales/activity?show=${limit}`}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Clear
            </Link>
          ) : null}
        </form>

        {query ? (
          <p className="text-xs text-slate-500">
            {feed.length === 0
              ? `No events match “${query}”.`
              : `Showing ${feed.length} event${feed.length === 1 ? "" : "s"} matching “${query}”.`}
          </p>
        ) : null}

        {/* Window summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Events shown" value={<AnimatedNumber value={feed.length} />} accent />
          <Tile label="Interactions" value={<AnimatedNumber value={interactions} />} sub="logged touches" />
          <Tile label="Milestones" value={<AnimatedNumber value={lifecycle} />} sub="lifecycle events" />
          <Tile label="AI actions" value={<AnimatedNumber value={aiActions} />} sub="AI-attributed" />
        </div>

        {/* Feed */}
        {feed.length === 0 ? (
          <EmptyState
            message="No activity logged yet. Activity appears here as companies are added, researched, and contacted."
            cta={
              <Link
                href="/admin/sales/companies/new"
                className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
              >
                Add the first company →
              </Link>
            }
          />
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <Section key={g.day} title={dayHeading(g.day, now)}>
                <ul className="relative">
                  {g.events.map((e) => (
                    <TimelineItem key={e.id} event={e} showCompany />
                  ))}
                </ul>
              </Section>
            ))}
          </div>
        )}

        {/* Load-more / window controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <span className="text-[11px] text-slate-500">Show latest</span>
          {WINDOWS.map((w) => {
            const active = w === limit;
            const params = new URLSearchParams();
            if (w !== 60) params.set("show", String(w));
            if (query) params.set("q", query);
            const qs = params.toString();
            return (
              <Link
                key={w}
                href={qs ? `/admin/sales/activity?${qs}` : "/admin/sales/activity"}
                aria-current={active ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  active
                    ? "border-indigo-500 bg-indigo-600 text-white"
                    : "border-slate-700 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {w}
              </Link>
            );
          })}
          {feed.length >= limit && limit < MAX_WINDOW ? (
            <span className="ml-auto text-[11px] text-slate-600">
              Showing the most recent {limit} events.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

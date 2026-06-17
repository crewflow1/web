import Link from "next/link";
import { Activity as ActivityIcon } from "lucide-react";
import { listActivityFeed } from "@/server/services/hq-sales";
import { eventCategory } from "@/lib/sales/model";
import { EmptyState, Section, TimelineItem, Tile } from "../_components";

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

type SP = Promise<{ show?: string }>;

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

  const feed = await listActivityFeed(limit);
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
          <Link href="/admin/sales" className="hover:text-slate-300">
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

        {/* Window summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Events shown" value={feed.length.toLocaleString()} accent />
          <Tile label="Interactions" value={interactions.toLocaleString()} sub="logged touches" />
          <Tile label="Milestones" value={lifecycle.toLocaleString()} sub="lifecycle events" />
          <Tile label="AI actions" value={aiActions.toLocaleString()} sub="AI-attributed" />
        </div>

        {/* Feed */}
        {feed.length === 0 ? (
          <EmptyState
            message="No activity logged yet. Activity appears here as companies are added, researched, and contacted."
            cta={
              <Link
                href="/admin/sales/companies/new"
                className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
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
            return (
              <Link
                key={w}
                href={
                  w === 60
                    ? "/admin/sales/activity"
                    : `/admin/sales/activity?show=${w}`
                }
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

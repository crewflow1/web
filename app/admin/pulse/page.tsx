import { Suspense } from "react";
import { requireHqPage } from "@/server/auth/hq";
import {
  getTimelinePage,
  getTimelineFacets,
  getTimelineEvent,
  type TimelinePage,
  type TimelineFacets,
} from "@/server/services/spine-timeline";
import { categoryConstraint, decodeFilters } from "./_url";
import { PulseFeed } from "./_feed";

/**
 * The Pulse — HQ Timeline (Module 1, PR5 / CEO Directive #005, STEP 5).
 *
 * "Open the Pulse and feel like opening Linear, Stripe or Vercel." A server
 * component that gates on requireHqPage() (the single source of truth — 404 for
 * non-allowlisted), decodes the filter state from the URL so a shared
 * `?cat=&sev=&act=&q=&event=` link reconstructs exactly, and SSR-fetches the first
 * page + facets (+ any deep-linked event) so first paint is instant. The client
 * <PulseFeed> then owns the live, virtualised, polling surface.
 *
 * Reads ONLY the hq_timeline projection (via the service's SECURITY DEFINER RPCs)
 * — never hq_events. Never-throw services mean a read hiccup degrades to an empty
 * page, not a 500.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "The Pulse · CrewFlow HQ" };

const EMPTY_PAGE: TimelinePage = { items: [], next_cursor: null };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function PulsePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireHqPage();

  const sp = await searchParams;
  const filters = decodeFilters((k) => firstParam(sp[k]));
  const constraint = categoryConstraint(filters.categories);

  const eventIdRaw = firstParam(sp.event);
  const eventId = eventIdRaw != null ? Number(eventIdRaw) : NaN;

  const [page, facets, detail]: [
    TimelinePage,
    TimelineFacets | null,
    Awaited<ReturnType<typeof getTimelineEvent>>,
  ] = await Promise.all([
    constraint === "none"
      ? Promise.resolve(EMPTY_PAGE)
      : getTimelinePage({
          limit: 50,
          filters: {
            categories: Array.isArray(constraint) ? constraint : undefined,
            severities: filters.severities.size ? [...filters.severities] : undefined,
            actorTypes: filters.actors.size ? [...filters.actors] : undefined,
            search: filters.search || undefined,
          },
        }),
    getTimelineFacets(),
    Number.isFinite(eventId) ? getTimelineEvent(eventId) : Promise.resolve(null),
  ]);

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-xl">
      {/* Header with radial glow */}
      <header className="relative shrink-0 border-b border-slate-800/80 px-5 py-4">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 140% at 12% 0%, rgba(99,102,241,0.18) 0%, rgba(99,102,241,0) 60%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-400/30">
            <PulseGlyph />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-slate-50">The Pulse</h1>
            <p className="truncate text-[12.5px] text-slate-400">
              Every event across CrewFlow — the company&apos;s entire history, live.
              <span className="ml-2 text-slate-600">HQ only · Super Admin</span>
            </p>
          </div>
        </div>
      </header>

      {/* Live, virtualised feed */}
      <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
        <Suspense fallback={null}>
          <PulseFeed
            initialItems={page.items}
            initialCursor={page.next_cursor}
            initialFacets={facets}
            initialFilters={{
              categories: [...filters.categories],
              severities: [...filters.severities],
              actors: [...filters.actors],
              search: filters.search,
            }}
            initialEvent={detail?.event ?? null}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** A minimal pulse/heartbeat glyph for the header. */
function PulseGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12h4l2.5-7 5 14 2.5-7H22" />
    </svg>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ArrowUp, RefreshCw, Radio, Inbox, AlertTriangle, Loader2 } from "lucide-react";
import type {
  TimelineEvent,
  TimelineCursor,
  TimelineFacets,
} from "@/server/services/spine-timeline";
import { ALL_CATEGORIES, type Category } from "@/lib/events/categories";
import type { Severity, ActorType } from "@/lib/events/registry";
import { dayBucket, BUCKET_LABEL, type DayBucket } from "@/lib/events/render";
import {
  encodeCategories,
  categoryConstraint,
  filtersAreDirty,
  DEFAULT_CATEGORY_SET,
  type PulseFilters,
} from "./_url";
import { PulseFilters as FilterBar } from "./_filters";
import { EventCard } from "./_event-card";
import { DetailDrawer } from "./_detail-drawer";
import { LiveDot, CountUp } from "./_primitives";

/**
 * The Pulse — live feed (Module 1, PR5 / CEO Directive #005, STEP 5).
 *
 * The interactive heart: a virtualised (@tanstack/react-virtual), infinite-
 * scrolling, ~15s-polling timeline with category/severity/actor/search filters,
 * Today / Yesterday / This Week / Earlier grouping, and the animated detail
 * drawer. The server page hands us the first page + facets (+ a deep-linked
 * event) so first paint is instant; thereafter the client owns the live surface
 * and talks to /api/hq/pulse directly. New events arriving while you read pool
 * into a "N new" pill (Linear-style) instead of yanking your scroll. All filter
 * + drawer state round-trips through the URL via history.replaceState — shareable,
 * no server re-render. PR5 "live" is polling; PR6 makes it push.
 */

const POLL_MS = 15_000;
const PAGE_LIMIT = 50;
const NEAR_TOP_PX = 140;

type FeedFilters = PulseFilters;
type ApiResponse = {
  items: TimelineEvent[];
  next_cursor: TimelineCursor | null;
  facets: TimelineFacets | null;
};
type Row =
  | { kind: "header"; id: string; label: string }
  | { kind: "event"; id: string; event: TimelineEvent };

function buildQuery(f: FeedFilters, cursor: TimelineCursor | null): string {
  const qs = new URLSearchParams();
  qs.set("limit", String(PAGE_LIMIT));
  if (cursor) {
    qs.set("cursor_ts", cursor.ts);
    qs.set("cursor_id", String(cursor.event_id));
  }
  const cat = categoryConstraint(f.categories);
  if (Array.isArray(cat)) qs.set("categories", cat.join(","));
  if (f.severities.size > 0) qs.set("severities", [...f.severities].join(","));
  if (f.actors.size > 0) qs.set("actors", [...f.actors].join(","));
  const q = f.search.trim();
  if (q) qs.set("q", q);
  return qs.toString();
}

async function fetchPage(
  f: FeedFilters,
  cursor: TimelineCursor | null,
  signal?: AbortSignal,
): Promise<ApiResponse> {
  const res = await fetch(`/api/hq/pulse?${buildQuery(f, cursor)}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`pulse ${res.status}`);
  return (await res.json()) as ApiResponse;
}

/** Prepend `front` (newest) ahead of `rest`, dropping ids already present. */
function prepend(front: TimelineEvent[], rest: TimelineEvent[]): TimelineEvent[] {
  if (front.length === 0) return rest;
  const seen = new Set(rest.map((e) => e.event_id));
  const add = front.filter((e) => !seen.has(e.event_id));
  return add.length ? [...add, ...rest] : rest;
}

/** Append `next` after `prev`, dropping ids already present. */
function append(prev: TimelineEvent[], next: TimelineEvent[]): TimelineEvent[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((e) => e.event_id));
  const add = next.filter((e) => !seen.has(e.event_id));
  return add.length ? [...prev, ...add] : prev;
}

function buildRows(items: TimelineEvent[]): Row[] {
  const out: Row[] = [];
  const now = new Date();
  let last: DayBucket | null = null;
  for (const e of items) {
    const b = dayBucket(e.ts, now);
    if (b !== last) {
      out.push({ kind: "header", id: `h-${b}`, label: BUCKET_LABEL[b] });
      last = b;
    }
    out.push({ kind: "event", id: `e-${e.event_id}`, event: e });
  }
  return out;
}

export function PulseFeed({
  initialItems,
  initialCursor,
  initialFacets,
  initialFilters,
  initialEvent,
}: {
  initialItems: TimelineEvent[];
  initialCursor: TimelineCursor | null;
  initialFacets: TimelineFacets | null;
  initialFilters: {
    categories: Category[];
    severities: Severity[];
    actors: ActorType[];
    search: string;
  };
  initialEvent: TimelineEvent | null;
}) {
  const [items, setItems] = useState<TimelineEvent[]>(initialItems);
  const [cursor, setCursor] = useState<TimelineCursor | null>(initialCursor);
  const [facets, setFacets] = useState<TimelineFacets | null>(initialFacets);
  const [reachedEnd, setReachedEnd] = useState(initialCursor === null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [pendingNew, setPendingNew] = useState<TimelineEvent[]>([]);
  const [openEvent, setOpenEvent] = useState<TimelineEvent | null>(initialEvent);

  const [categories, setCategories] = useState<Set<Category>>(new Set(initialFilters.categories));
  const [severities, setSeverities] = useState<Set<Severity>>(new Set(initialFilters.severities));
  const [actors, setActors] = useState<Set<ActorType>>(new Set(initialFilters.actors));
  const [search, setSearch] = useState(initialFilters.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initialFilters.search);

  const parentRef = useRef<HTMLDivElement>(null);
  const didMount = useRef(false);
  const refetchAbort = useRef<AbortController | null>(null);
  const headIdRef = useRef<number>(initialItems[0]?.event_id ?? 0);
  const filterRef = useRef<FeedFilters>({ categories, severities, actors, search: debouncedSearch });
  const filtersKeyRef = useRef("");

  const filters: FeedFilters = useMemo(
    () => ({ categories, severities, actors, search: debouncedSearch }),
    [categories, severities, actors, debouncedSearch],
  );
  const filtersKey = useMemo(
    () =>
      JSON.stringify({
        c: [...categories].sort(),
        s: [...severities].sort(),
        a: [...actors].sort(),
        q: debouncedSearch.trim(),
      }),
    [categories, severities, actors, debouncedSearch],
  );

  // Keep refs current for the (stable) poll loop + race guards.
  useEffect(() => {
    filterRef.current = filters;
    filtersKeyRef.current = filtersKey;
  }, [filters, filtersKey]);
  useEffect(() => {
    headIdRef.current = items[0]?.event_id ?? headIdRef.current;
  }, [items]);

  // Debounce the search box before it drives a refetch.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const rows = useMemo(() => buildRows(items), [items]);

  // --- URL sync (history.replaceState — no server round-trip) ---------------
  const syncUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const p = url.searchParams;
    const cat = encodeCategories(categories);
    if (cat) p.set("cat", cat);
    else p.delete("cat");
    if (severities.size) p.set("sev", [...severities].join(","));
    else p.delete("sev");
    if (actors.size) p.set("act", [...actors].join(","));
    else p.delete("act");
    const q = debouncedSearch.trim();
    if (q) p.set("q", q);
    else p.delete("q");
    window.history.replaceState(null, "", url);
  }, [categories, severities, actors, debouncedSearch]);

  // --- refetch from head for the current filters ----------------------------
  const runRefetch = useCallback(async () => {
    const f = filterRef.current;
    if (f.categories.size === 0) {
      setItems([]);
      setCursor(null);
      setReachedEnd(true);
      setPendingNew([]);
      setError(false);
      setRefreshing(false);
      return;
    }
    refetchAbort.current?.abort();
    const ctrl = new AbortController();
    refetchAbort.current = ctrl;
    setRefreshing(true);
    setError(false);
    try {
      const res = await fetchPage(f, null, ctrl.signal);
      setItems(res.items);
      setCursor(res.next_cursor);
      setReachedEnd(res.next_cursor === null);
      setPendingNew([]);
      if (res.facets) setFacets(res.facets);
      headIdRef.current = res.items[0]?.event_id ?? 0;
      parentRef.current?.scrollTo({ top: 0 });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(true);
    } finally {
      if (refetchAbort.current === ctrl) setRefreshing(false);
    }
  }, []);

  // Re-fetch whenever the filter signature changes (skip the mount: SSR seeded us).
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    syncUrl();
    void runRefetch();
    // filtersKey captures every filter input; runRefetch/syncUrl read the latest
    // via refs/closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // --- load older (infinite scroll) -----------------------------------------
  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd || cursor === null) return;
    const startKey = filtersKeyRef.current;
    setLoadingMore(true);
    try {
      const res = await fetchPage(filterRef.current, cursor);
      if (filtersKeyRef.current !== startKey) return; // filters changed mid-flight
      setItems((prev) => append(prev, res.items));
      setCursor(res.next_cursor);
      if (res.next_cursor === null) setReachedEnd(true);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, reachedEnd, cursor]);

  // --- poll the head every 15s ----------------------------------------------
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const f = filterRef.current;
      if (f.categories.size === 0) return;
      const startKey = filtersKeyRef.current;
      try {
        const res = await fetchPage(f, null);
        if (filtersKeyRef.current !== startKey) return;
        if (res.facets) setFacets(res.facets);
        const fresh = res.items.filter((e) => e.event_id > headIdRef.current);
        if (fresh.length === 0) return;
        const nearTop = (parentRef.current?.scrollTop ?? 0) < NEAR_TOP_PX;
        if (nearTop) {
          headIdRef.current = fresh[0]?.event_id ?? headIdRef.current;
          setItems((prev) => prepend(fresh, prev));
        } else {
          setPendingNew((prev) => prepend(fresh, prev));
        }
      } catch {
        /* polling failures are silent — the next tick retries */
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const revealPending = useCallback(() => {
    setPendingNew((pending) => {
      if (pending.length) {
        headIdRef.current = pending[0]?.event_id ?? headIdRef.current;
        setItems((prev) => prepend(pending, prev));
      }
      return [];
    });
    parentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // --- virtualiser ----------------------------------------------------------
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? 40 : 88),
    overscan: 10,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Trigger infinite-scroll when the last row scrolls into view.
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 1 && !reachedEnd && !loadingMore && cursor) {
      void loadMore();
    }
  }, [virtualItems, rows.length, reachedEnd, loadingMore, cursor, loadMore]);

  // --- drawer open/close (URL deep-link via replaceState) -------------------
  const openDetail = useCallback((ev: TimelineEvent) => {
    setOpenEvent(ev);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("event", String(ev.event_id));
      window.history.replaceState(null, "", url);
    }
  }, []);
  const closeDetail = useCallback(() => {
    setOpenEvent(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("event");
      window.history.replaceState(null, "", url);
    }
  }, []);

  // --- filter callbacks ------------------------------------------------------
  const toggleCategory = useCallback((c: Category) => {
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }, []);
  const selectAllCategories = useCallback(() => {
    setCategories(new Set(ALL_CATEGORIES));
  }, []);
  const toggleSeverity = useCallback((s: Severity) => {
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);
  const toggleActor = useCallback((a: ActorType) => {
    setActors((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }, []);
  const resetFilters = useCallback(() => {
    setCategories(new Set(DEFAULT_CATEGORY_SET));
    setSeverities(new Set());
    setActors(new Set());
    setSearch("");
    setDebouncedSearch("");
  }, []);

  const dirty = filtersAreDirty(filters);
  const noCategories = categories.size === 0;
  const total = facets?.total ?? items.length;
  const showEmpty = !refreshing && !error && items.length === 0;

  return (
    <MotionConfig reducedMotion="user">
      {/* Live row */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-slate-400">
          {refreshing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-300" />
              <span>Updating…</span>
            </>
          ) : (
            <>
              <Radio className="h-3.5 w-3.5 text-slate-500" />
              <CountUp value={total} className="font-semibold text-slate-200" />
              <span>events</span>
            </>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
          <LiveDot />
          Live · polling
        </span>
      </div>

      {/* Filters */}
      <div className="mb-3">
        <FilterBar
          facets={facets}
          search={search}
          selectedCategories={categories}
          selectedSeverities={severities}
          selectedActors={actors}
          allCategoriesActive={categories.size >= ALL_CATEGORIES.length}
          filtersDirty={dirty}
          onSearch={setSearch}
          onToggleCategory={toggleCategory}
          onSelectAllCategories={selectAllCategories}
          onToggleSeverity={toggleSeverity}
          onToggleActor={toggleActor}
          onReset={resetFilters}
        />
      </div>

      {/* The list */}
      <div className="relative min-h-0 flex-1">
        {/* New-events pill */}
        <AnimatePresence>
          {pendingNew.length > 0 ? (
            <motion.button
              type="button"
              onClick={revealPending}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute left-1/2 top-2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-indigo-400/40 bg-indigo-500/90 px-3 py-1 text-[12px] font-semibold text-white shadow-lg shadow-indigo-900/40 backdrop-blur transition hover:bg-indigo-500"
            >
              <ArrowUp className="h-3.5 w-3.5" />
              {pendingNew.length} new event{pendingNew.length === 1 ? "" : "s"}
            </motion.button>
          ) : null}
        </AnimatePresence>

        <div
          ref={parentRef}
          className="h-full overflow-y-auto overscroll-contain rounded-xl border border-slate-800/70 bg-slate-950/40 [scrollbar-color:theme(colors.slate.700)_transparent]"
        >
          {noCategories ? (
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title="No categories selected"
              hint="Pick a chip above, or press All to see everything."
              action={{ label: "Reset filters", onClick: resetFilters }}
            />
          ) : error && items.length === 0 ? (
            <EmptyState
              icon={<AlertTriangle className="h-6 w-6 text-amber-400" />}
              title="Couldn’t load the timeline"
              hint="A read hiccup — the projection is a window onto the spine, so this is safe to retry."
              action={{ label: "Try again", onClick: () => void runRefetch() }}
            />
          ) : refreshing && items.length === 0 ? (
            <FeedSkeleton />
          ) : showEmpty ? (
            <EmptyState
              icon={<Inbox className="h-6 w-6" />}
              title={dirty ? "No events match these filters" : "Nothing here yet"}
              hint={
                dirty
                  ? "Try widening the categories, severity, or search."
                  : "As events land on the spine they’ll stream in here."
              }
              action={dirty ? { label: "Reset filters", onClick: resetFilters } : undefined}
            />
          ) : (
            <motion.div
              key={filtersKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
            >
              {virtualItems.map((vi) => {
                const row = rows[vi.index];
                if (!row) return null;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {row.kind === "header" ? (
                      <GroupHeader label={row.label} />
                    ) : (
                      <div className="px-3 pb-2">
                        <EventCard
                          event={row.event}
                          active={openEvent?.event_id === row.event.event_id}
                          onOpen={openDetail}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </motion.div>
          )}

          {/* Footer (normal flow → it adds to scroll height + is reachable) */}
          {items.length > 0 && (loadingMore || reachedEnd) ? (
            <div className="px-3">
              {loadingMore ? (
                <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…
                </div>
              ) : (
                <div className="py-4 text-center text-[11px] text-slate-600">
                  The beginning · {items.length.toLocaleString("en-GB")} events loaded
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <DetailDrawer event={openEvent} onClose={closeDetail} onOpen={openDetail} />
    </MotionConfig>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pb-1.5 pt-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </h2>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-slate-400 ring-1 ring-inset ring-slate-800">
        {icon}
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-200">{title}</p>
      <p className="mt-1 max-w-sm text-[12.5px] text-slate-500">{hint}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-3.5 py-3"
        >
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-800/70" />
          <div className="flex-1 space-y-2 py-0.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-slate-800/70" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-800/50" />
          </div>
        </div>
      ))}
    </div>
  );
}

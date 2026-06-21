import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActorType, Severity } from "@/lib/events/registry";
import { type Category, namespacesForCategories } from "@/lib/events/categories";

/**
 * The Pulse — HQ Timeline reader service (Module 1, PR5 / CEO Directive #005,
 * STEP 3).
 *
 * The Pulse is a CQRS read-model: nothing here (or anywhere) reads hq_events
 * directly. We read the `hq_timeline` PROJECTION exclusively, and only through the
 * three SECURITY DEFINER functions the migration exposes (page / event / facets),
 * each granted to service_role alone. So this module is a thin, typed, never-throw
 * wrapper — the same posture as spine-consumer.ts and spine-backfill.ts — and the
 * keyset/filter/search logic lives in SQL where it belongs.
 *
 * Never-throw contract: a read failure degrades the surface (an empty page, a null
 * detail/facets) rather than 500-ing the HQ page or the polling endpoint. The Pulse
 * is a window onto the spine; a hiccup reading it must never look like an outage.
 */

// The spine RPCs aren't in the generated Supabase types; cast past the typed
// client exactly as the other spine services do.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

// --- Types -------------------------------------------------------------------

/** Keyset cursor — the (ts, event_id) of a page's last (oldest) row. */
export type TimelineCursor = { ts: string; event_id: number };

/** One projected event, mirroring the hq_timeline columns (sans the tsvector). */
export type TimelineEvent = {
  event_id: number;
  ts: string;
  verb: string;
  namespace: string;
  severity: Severity;
  actor_type: ActorType;
  actor_id: string | null;
  object_type: string;
  object_id: string;
  target_type: string | null;
  target_id: string | null;
  correlation_id: string;
  causation_id: number | null;
  payload: Record<string, unknown>;
  visibility: string;
  projected_at: string;
};

export type TimelinePage = {
  items: TimelineEvent[];
  next_cursor: TimelineCursor | null;
};

export type TimelineEventDetail = {
  event: TimelineEvent;
  /** Every event sharing this one's correlation_id, in causal id-order. */
  correlation: TimelineEvent[];
};

export type TimelineFacets = {
  generated_at: string;
  total: number;
  namespaces: Record<string, number>;
  severities: Record<string, number>;
  actor_types: Record<string, number>;
};

/** Filters the feed accepts. Categories are mapped to namespaces here. */
export type TimelineFilters = {
  categories?: readonly Category[];
  severities?: readonly Severity[];
  actorTypes?: readonly ActorType[];
  search?: string;
};

const EMPTY_PAGE: TimelinePage = { items: [], next_cursor: null };

/** Non-empty array → itself; undefined/empty → null ("no constraint"). */
function orNull<T>(xs: readonly T[] | undefined): T[] | null {
  return xs && xs.length > 0 ? [...xs] : null;
}

// --- Reads -------------------------------------------------------------------

/**
 * One page of the feed, newest-first. `cursor` is the previous page's
 * `next_cursor` (omit for the first page). Filters are AND-combined; an
 * unset/empty filter is "no constraint". Category chips are flattened to the
 * projection's namespace vocabulary. Never throws — returns an empty page on error.
 */
export async function getTimelinePage(opts: {
  cursor?: TimelineCursor | null;
  filters?: TimelineFilters;
  limit?: number;
} = {}): Promise<TimelinePage> {
  const { cursor, filters = {}, limit } = opts;
  const namespaces = filters.categories
    ? orNull(namespacesForCategories(filters.categories))
    : null;
  const search = filters.search?.trim() ? filters.search.trim() : null;
  try {
    const { data, error } = await rpc()("hq_timeline_page", {
      p_limit: limit ?? 50,
      p_before_ts: cursor?.ts ?? null,
      p_before_id: cursor?.event_id ?? null,
      p_namespaces: namespaces,
      p_severities: orNull(filters.severities),
      p_actor_types: orNull(filters.actorTypes),
      p_search: search,
    });
    if (error || data == null) {
      if (error) console.error("[spine-timeline] page failed", { error: error.message });
      return EMPTY_PAGE;
    }
    const page = data as Partial<TimelinePage>;
    return {
      items: Array.isArray(page.items) ? page.items : [],
      next_cursor: page.next_cursor ?? null,
    };
  } catch (e) {
    console.error("[spine-timeline] page threw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return EMPTY_PAGE;
  }
}

/**
 * One event plus its full correlation chain, for the detail drawer. Returns null
 * when the id is unknown or on error (the drawer renders a "not found" state).
 */
export async function getTimelineEvent(
  eventId: number,
): Promise<TimelineEventDetail | null> {
  if (!Number.isFinite(eventId)) return null;
  try {
    const { data, error } = await rpc()("hq_timeline_event", { p_event_id: eventId });
    if (error || data == null) {
      if (error) console.error("[spine-timeline] event failed", { error: error.message });
      return null;
    }
    const detail = data as Partial<TimelineEventDetail>;
    if (!detail.event) return null;
    return {
      event: detail.event,
      correlation: Array.isArray(detail.correlation) ? detail.correlation : [],
    };
  } catch (e) {
    console.error("[spine-timeline] event threw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Chip-badge counts by namespace / severity / actor_type. Null on error. */
export async function getTimelineFacets(): Promise<TimelineFacets | null> {
  try {
    const { data, error } = await rpc()("hq_timeline_facets");
    if (error || data == null) {
      if (error) console.error("[spine-timeline] facets failed", { error: error.message });
      return null;
    }
    return data as TimelineFacets;
  } catch (e) {
    console.error("[spine-timeline] facets threw", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

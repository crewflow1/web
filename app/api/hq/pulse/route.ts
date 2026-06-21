import { NextResponse } from "next/server";
import { requireHqApi } from "@/server/auth/hq";
import {
  getTimelinePage,
  getTimelineFacets,
  type TimelineCursor,
} from "@/server/services/spine-timeline";
import { ALL_CATEGORIES, type Category } from "@/lib/events/categories";
import {
  ACTOR_TYPES,
  SEVERITIES,
  type ActorType,
  type Severity,
} from "@/lib/events/registry";

/**
 * The Pulse — HQ Timeline feed endpoint (Module 1, PR5 / CEO Directive #005).
 *
 *   GET /api/hq/pulse?limit&cursor_ts&cursor_id&categories&severities&actors&q
 *
 * The client feed polls this (~15s) for the live head and calls it again, with
 * the previous page's cursor, for infinite-scroll pagination. PR5's "live" is
 * interval polling, not push: the projection is RLS:hq / service-role-only, so a
 * JWT client cannot subscribe to it over Realtime — true push is the server-
 * authorised broadcaster in PR6. As a small optimisation the live HEAD poll (no
 * cursor) also returns the global facet counts in the same round-trip; paging
 * calls (with a cursor) skip that cost.
 *
 * HQ-gated via requireHqApi (the single source of truth, STEP 4): 404 — never
 * 403 — for anonymous or non-allowlisted callers, so the endpoint does not
 * announce itself. Always returns JSON so the poller never special-cases a body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseLimit(raw: string | null): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.trunc(n), 1), 200);
}

/** Split a CSV param and keep only values in the allowed set (defensive). */
function parseEnumCsv<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T[] | undefined {
  if (!raw) return undefined;
  const set = new Set<string>(allowed);
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => set.has(s)) as T[];
  return out.length > 0 ? out : undefined;
}

export async function GET(request: Request): Promise<Response> {
  const gate = await requireHqApi();
  if (!gate.ok) return gate.response;

  const sp = new URL(request.url).searchParams;

  const cursorTs = sp.get("cursor_ts");
  const cursorIdRaw = sp.get("cursor_id");
  const cursorId = cursorIdRaw != null ? Number(cursorIdRaw) : NaN;
  const cursor: TimelineCursor | null =
    cursorTs && Number.isFinite(cursorId)
      ? { ts: cursorTs, event_id: cursorId }
      : null;

  const categories = parseEnumCsv<Category>(sp.get("categories"), ALL_CATEGORIES);
  const severities = parseEnumCsv<Severity>(sp.get("severities"), SEVERITIES);
  const actorTypes = parseEnumCsv<ActorType>(sp.get("actors"), ACTOR_TYPES);
  const search = sp.get("q")?.trim() || undefined;

  // The live HEAD poll (no cursor) refreshes the chip counts too; paging skips it.
  const [page, facets] = await Promise.all([
    getTimelinePage({
      cursor,
      limit: parseLimit(sp.get("limit")),
      filters: { categories, severities, actorTypes, search },
    }),
    cursor ? Promise.resolve(null) : getTimelineFacets(),
  ]);

  return NextResponse.json({ ...page, facets });
}

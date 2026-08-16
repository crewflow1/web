import { type NextRequest } from "next/server";
import * as respond from "@/lib/api/respond";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";

/**
 * GET /api/activity
 *
 *   ?from=YYYY-MM-DD              inclusive (defaults: no lower bound)
 *   ?to=YYYY-MM-DD                inclusive (defaults: no upper bound)
 *   ?type=quote.                  prefix match (full key like "quote.accepted" also OK)
 *   ?actor=<user_id>              filter to one actor
 *   ?page=<n>                     1-based; 25 per page
 *
 * Returns:
 *   { data, page, pageSize, hasMore, total }
 *
 * RLS does the org scoping (activity_log SELECT policy = members of org).
 */

const PAGE_SIZE = 25;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    const { ctx } = await requireOrgContext();
    const url = request.nextUrl;
    const page = Math.max(parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;

    const supabase = await createClient();
    let q = supabase
      .from("activity_log")
      .select(
        "id, actor_id, actor_name, action, target_table, target_id, metadata, created_at",
        { count: "exact" },
      )
      // ACTIVE-org pin — this endpoint backs the /activity "load more" list, so
      // it must agree with the page's own (now pinned) first page.
      .eq("org_id", ctx.org.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    const from = url.searchParams.get("from");
    if (from && DATE_RE.test(from)) q = q.gte("created_at", `${from}T00:00:00Z`);
    const to = url.searchParams.get("to");
    if (to && DATE_RE.test(to)) q = q.lte("created_at", `${to}T23:59:59Z`);

    const type = url.searchParams.get("type");
    if (type) {
      // Support exact match ("quote.accepted") and prefix ("quote.")
      if (type.endsWith(".")) q = q.like("action", `${type}%`);
      else q = q.eq("action", type);
    }

    const actor = url.searchParams.get("actor");
    if (actor && UUID_RE.test(actor)) q = q.eq("actor_id", actor);

    const { data, error, count } = await q;
    if (error) {
      console.error("[activity] list failed", error);
      return respond.error(500, "Failed to load activity");
    }
    const total = count ?? 0;
    return respond.json({
      ok: true,
      data: data ?? [],
      page,
      pageSize: PAGE_SIZE,
      hasMore: offset + (data?.length ?? 0) < total,
      total,
    });
  } catch (e) {
    console.error("[activity] unhandled", e);
    return respond.error(500, "Activity feed temporarily unavailable");
  }
}

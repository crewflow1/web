import { NextResponse } from "next/server";
import { requireHqApi } from "@/server/auth/hq";
import { getTimelineEvent } from "@/server/services/spine-timeline";

/**
 * The Pulse — single-event detail endpoint (Module 1, PR5 / CEO Directive #005).
 *
 *   GET /api/hq/pulse/:id  →  { event, correlation } | { event: null }
 *
 * Powers the detail drawer's correlation chain. The card click opens the drawer
 * instantly with the row it already holds; this fetch then fills the chain (every
 * event sharing the correlation_id, in causal order) lazily so the open feels
 * instant. HQ-gated via requireHqApi (404 — never 403 — for non-allowlisted),
 * and never-throws: an unknown/failed id returns { event: null } so the drawer
 * renders its own "not found" state rather than the poller seeing a 500.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireHqApi();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const eventId = Number(id);
  if (!Number.isFinite(eventId)) {
    return NextResponse.json({ event: null });
  }

  const detail = await getTimelineEvent(eventId);
  if (!detail) return NextResponse.json({ event: null });

  return NextResponse.json(detail);
}

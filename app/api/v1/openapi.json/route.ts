import { NextResponse } from "next/server";
import { DEFAULT_LIMITS, enforcePersistent } from "@/lib/security/rate-limit";
import { isPublicApiJobsEnabled } from "@/lib/public-api/flag";
import { buildOpenApiDocument } from "@/lib/public-api/openapi";

/**
 * GET /api/v1/openapi.json — the OpenAPI 3.1 description of the v1 read API.
 *
 * DARK BY DEFAULT behind the SAME FEATURE_PUBLIC_API_JOBS flag as the data
 * routes: while off it 404s, so the ENTIRE v1 surface (docs included) stays
 * dark until the CEO flips one switch — publishing a spec for endpoints that
 * 404 would be pointless and would out the surface.
 *
 * Unlike the data routes this endpoint carries NO tenant data — it is pure,
 * public API metadata — so once the flag is on it needs no key. It is still
 * IP-rate-limited (the generic `api` budget) so it cannot be hammered.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  // Flag — dark ⇒ 404, exactly like the data routes.
  if (!isPublicApiJobsEnabled()) return notFound();

  // IP-keyed limit — this is unauthenticated public metadata, not a per-key
  // surface, so the generic `api` budget (not api_v1) applies.
  const limited = await enforcePersistent(request, "api", DEFAULT_LIMITS.api);
  if (limited) return limited;

  return NextResponse.json(buildOpenApiDocument());
}

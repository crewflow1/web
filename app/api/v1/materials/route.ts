import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  MATERIAL_DTO_SELECT,
  toPublicMaterialRequestDto,
  type MaterialRequestRowForDto,
} from "@/lib/public-api/materials";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";

/**
 * GET /api/v1/materials — the public, key-authenticated MATERIAL-REQUESTS READ.
 *
 * Part of the Open-API breadth wave off the Train K jobs substrate. DARK BY
 * DEFAULT behind the one shared FEATURE_PUBLIC_API_JOBS flag: while off this
 * route 404s (see lib/public-api/guard.ts + lib/public-api/flag.ts). Mirrors
 * /api/v1/jobs exactly — same guard, same api-key auth, same org-pinning, same
 * read-only projection, same paginated envelope.
 *
 * READ-ONLY: the material-request lifecycle is trigger-governed in the database
 * (see lib/material-requests/schema.ts); the public API observes it, it does not
 * drive it — there is no write scope or write verb on this surface.
 *
 * Contract (all enforced by guardPublicApiRequest):
 *   - 404 when the flag is off (the surface does not exist yet).
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key.
 *   - 403 without the read:materials scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicMaterialRequestDto[], pagination: { page, per_page, has_more } }.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), and
 * the projection is an EXPLICIT allowlist — identity + state only. The linked
 * job, the requester/decider staff ids, notes and rejection reason are excluded
 * (see lib/public-api/materials.ts). Page size is bounded, order stable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type MaterialsListRead = {
  select: (cols: string) => {
    eq: (
      col: string,
      value: string,
    ) => {
      order: (
        col: string,
        opts: { ascending: boolean },
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => {
          range: (
            from: number,
            to: number,
          ) => Promise<{ data: MaterialRequestRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:materials");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const pagination = parsePagination(
    url.searchParams.get("page"),
    url.searchParams.get("per_page"),
  );
  const { from, to } = rangeFor(pagination);

  const admin = createAdminClient();
  // Service-role read (the key IS the credential; there is no user JWT). The
  // org boundary is enforced HERE, in the query, by pinning to the key's own
  // org — RLS is not the scoper on this path. Stable order: created_at then id
  // as a tiebreak so pages never overlap or skip a row.
  //
  // `material_requests` post-dates the generated Database types (the same house
  // cast idiom the leads route uses for its newer columns) — cast the client so
  // the typed `.from` union does not reject a table it has not been regenerated
  // to know about.
  const materials = (
    admin as unknown as { from: (t: string) => MaterialsListRead }
  ).from("material_requests");
  const { data, error } = await materials
    .select(MATERIAL_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: materials list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicMaterialRequestDto,
  );

  return NextResponse.json({
    data: page,
    pagination: {
      page: pagination.page,
      per_page: pagination.per_page,
      has_more,
    },
  });
}

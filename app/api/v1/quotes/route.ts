import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  QUOTE_DTO_SELECT,
  toPublicQuoteDto,
  type QuoteRowForDto,
} from "@/lib/public-api/quotes";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";

/**
 * GET /api/v1/quotes — the public, key-authenticated QUOTES READ.
 *
 * Part of the Open-API expansion off the Train K jobs substrate. DARK BY
 * DEFAULT behind the one shared FEATURE_PUBLIC_API_JOBS flag: while off this
 * route 404s (see lib/public-api/guard.ts + lib/public-api/flag.ts). Mirrors
 * /api/v1/jobs exactly — same guard, same api-key auth, same org-pinning, same
 * read-only projection, same paginated envelope.
 *
 * Contract (all enforced by guardPublicApiRequest):
 *   - 404 when the flag is off (the surface does not exist yet).
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key.
 *   - 403 without the read:quotes scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicQuoteDto[], pagination: { page, per_page, has_more } }.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), the
 * projection is an EXPLICIT allowlist — the CUSTOMER-FACING price figures only
 * (subtotal/vat_total/total). Every internal cost_* / margin column, the
 * public_token secret, the captured signature, and all internal FKs are
 * excluded (see lib/public-api/quotes.ts). Page size is bounded, order stable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type QuotesListRead = {
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
          ) => Promise<{ data: QuoteRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:quotes");
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
  const { data, error } = await (
    admin.from("quotes") as unknown as QuotesListRead
  )
    .select(QUOTE_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: quotes list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicQuoteDto,
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

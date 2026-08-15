import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  guardPublicJobsRequest,
  guardPublicApiRequest,
} from "@/lib/public-api/guard";
import { verifyCustomerInOrg } from "@/lib/crm/reference-integrity";
import {
  JOB_DTO_SELECT,
  toPublicJobDto,
  parsePagination,
  rangeFor,
  type JobRowForDto,
} from "@/lib/public-api/jobs";
import { createJobSchema } from "@/lib/public-api/write-schemas";
import { parseJsonBody, created, writeError } from "@/lib/public-api/write";

/**
 * GET /api/v1/jobs — the public, key-authenticated JOBS READ (Train K).
 *
 * Activates the shipped-but-inert `read:jobs` scope on the api_keys substrate.
 * DARK BY DEFAULT behind FEATURE_PUBLIC_API_JOBS: while off this route 404s —
 * exposing tenant data through a public API is a CEO decision (see
 * app/api/v1/me/route.ts and lib/public-api/flag.ts). Everything below is
 * built and tested; flipping the flag is the whole decision.
 *
 * Contract (all enforced by guardPublicJobsRequest):
 *   - 404 when the flag is off (the surface does not exist yet).
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key.
 *   - 403 without the read:jobs scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicJobDto[], pagination: { page, per_page, has_more } }.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), the
 * projection is an EXPLICIT allowlist (no cost/PII/internal fields — see
 * lib/public-api/jobs.ts), page size is bounded, and the order is stable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type JobsListRead = {
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
          ) => Promise<{ data: JobRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicJobsRequest(request);
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
    admin.from("jobs") as unknown as JobsListRead
  )
    .select(JOB_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: jobs list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicJobDto,
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

/** Minimal typed surface for the org-pinned insert + allowlisted readback. */
type JobInsertWrite = {
  insert: (row: {
    org_id: string;
    status?: string;
    scheduled_date: string | null;
    customer_id: string | null;
    notes: string | null;
    site_address_line1: string | null;
    site_address_line2: string | null;
    site_city: string | null;
    site_county: string | null;
    site_postcode: string | null;
    site_country: string | null;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: JobRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/**
 * POST /api/v1/jobs — create a job in the KEY'S org.
 *
 * Requires the DISTINCT `write:jobs` scope (routed through the generic guard, a
 * `read:jobs`-only key is forbidden). Strict body (unknown keys rejected),
 * org_id pinned to the key's org, and an optional customer_id verified in-org
 * BEFORE the insert. The created row is returned through the read DTO allowlist.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:jobs");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createJobSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  if (input.customer_id) {
    const ref = await verifyCustomerInOrg(
      admin as never,
      input.customer_id,
      guard.key.orgId,
    );
    if (!ref.ok) return writeError(422, "invalid_reference", ref.message);
  }

  const { data, error } = await (
    admin.from("jobs") as unknown as JobInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      // Only override the DB default status when the caller set one.
      ...(input.status ? { status: input.status } : {}),
      scheduled_date: input.scheduled_date ?? null,
      customer_id: input.customer_id ?? null,
      notes: input.notes ?? null,
      site_address_line1: input.site_address_line1 ?? null,
      site_address_line2: input.site_address_line2 ?? null,
      site_city: input.site_city ?? null,
      site_county: input.site_county ?? null,
      site_postcode: input.site_postcode ?? null,
      site_country: input.site_country ?? null,
    })
    .select(JOB_DTO_SELECT)
    .single();

  if (error || !data) {
    console.error("[public-api] job create failed", error?.message);
    return writeError(500, "write_failed", "Couldn't create the job.");
  }

  return created(toPublicJobDto(data));
}

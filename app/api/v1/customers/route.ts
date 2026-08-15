import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import {
  CUSTOMER_DTO_SELECT,
  toPublicCustomerDto,
  type CustomerRowForDto,
} from "@/lib/public-api/customers";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";
import { createCustomerSchema } from "@/lib/public-api/write-schemas";
import { parseJsonBody, created, writeError } from "@/lib/public-api/write";

/**
 * GET /api/v1/customers — the public, key-authenticated CUSTOMERS READ.
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
 *   - 403 without the read:customers scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicCustomerDto[], pagination: { page, per_page, has_more } }.
 *
 * SECURITY: the read is pinned to key.orgId (never a client-supplied org), the
 * projection is an EXPLICIT allowlist (no contact PII / full address / portal
 * secret / internal fields — see lib/public-api/customers.ts), page size is
 * bounded, and the order is stable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type CustomersListRead = {
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
          ) => Promise<{ data: CustomerRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:customers");
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
    admin.from("customers") as unknown as CustomersListRead
  )
    .select(CUSTOMER_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: customers list", error);

  const rows = data ?? [];
  // We asked for per_page + 1 rows; the extra one only tells us there is a next
  // page — it is never returned.
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicCustomerDto,
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
type CustomerInsertWrite = {
  insert: (row: {
    org_id: string;
    name: string;
    email: string | null;
    phone: string | null;
    address_line1: string | null;
    address_line2: string | null;
    city: string | null;
    county: string | null;
    postcode: string | null;
    country?: string;
    notes: string | null;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: CustomerRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/**
 * POST /api/v1/customers — create a customer in the KEY'S org.
 *
 * Same dark flag + guard as the read; requires the DISTINCT `write:customers`
 * scope (a read-only key cannot create). The body is strictly validated
 * (unknown keys rejected — no mass assignment), org_id is pinned to the key's
 * org (never taken from the body), and the created row is returned through the
 * SAME read DTO allowlist so a write can never expose a field a read would not.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:customers");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createCustomerSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();
  const { data, error } = await (
    admin.from("customers") as unknown as CustomerInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address_line1: input.address_line1 ?? null,
      address_line2: input.address_line2 ?? null,
      city: input.city ?? null,
      county: input.county ?? null,
      postcode: input.postcode ?? null,
      // Only override the DB default country when the caller set one.
      ...(input.country ? { country: input.country } : {}),
      notes: input.notes ?? null,
    })
    .select(CUSTOMER_DTO_SELECT)
    .single();

  if (error || !data) {
    // Loud server-side; generic to the caller (raw Postgres text never leaks).
    console.error("[public-api] customer create failed", error?.message);
    return writeError(500, "write_failed", "Couldn't create the customer.");
  }

  return created(toPublicCustomerDto(data));
}

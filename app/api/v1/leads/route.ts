import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import { verifyCustomerInOrg } from "@/lib/crm/reference-integrity";
import {
  LEAD_DTO_SELECT,
  toPublicLeadDto,
  type LeadRowForDto,
} from "@/lib/public-api/leads";
import { createLeadSchema } from "@/lib/public-api/write-schemas";
import {
  parseJsonBody,
  created,
  writeError,
} from "@/lib/public-api/write";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";

/**
 * POST /api/v1/leads — the public, key-authenticated LEAD CAPTURE surface.
 *
 * The flagship write: a website / marketing integration posts a new enquiry
 * straight into the pipeline. Same dark flag + guard as every v1 route;
 * requires the DISTINCT `write:leads` scope. Read and write are distinct: a key
 * needs `read:leads` to GET (see below) and `write:leads` to POST.
 *
 * SECURITY:
 *   - Strict body validation (unknown keys rejected — no mass assignment);
 *     `status` is NOT accepted, so a captured lead is always created as "new".
 *   - org_id is pinned to the KEY'S org, never the body.
 *   - An optional customer_id is verified to belong to the key's org BEFORE the
 *     insert (defence in depth over the composite FK) so a foreign customer can
 *     never be attached — a clean 422, not a raw 23503 → 500.
 *   - The created row is returned through the leads DTO allowlist (no contact
 *     PII, no internal fields).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal typed surface for the insert + allowlisted readback.
 * `contact_*` columns post-date the generated Database types (landed in
 * 20260601000100_leads_contact_fields) — the house cast idiom keeps the typed
 * client happy for those new columns.
 */
type LeadInsertWrite = {
  insert: (row: {
    org_id: string;
    contact_name: string;
    contact_email: string | null;
    contact_phone: string | null;
    source: string;
    service: string | null;
    urgency: string;
    postcode: string | null;
    estimated_value: number | null;
    notes: string | null;
    customer_id: string | null;
    status: string;
    first_contact_at: string;
    last_activity_at: string;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: LeadRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/** Minimal typed surface for the org-pinned, ranged, ordered read. */
type LeadsListRead = {
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
          ) => Promise<{ data: LeadRowForDto[] | null; error: { message?: string | null } | null }>;
        };
      };
    };
  };
};

/**
 * GET /api/v1/leads — the public, key-authenticated LEADS READ.
 *
 * Mirrors every other v1 read exactly — same dark flag, same api-key auth, same
 * org-pinning to the KEY'S org, same paginated envelope, same LOUD read.
 * Requires the DISTINCT `read:leads` scope (a `write:leads`-only capture key
 * cannot list leads back). The projection is the SAME PII-free allowlist the
 * write returns (lib/public-api/leads.ts): no contact name/email/phone, no
 * notes, no internal FKs.
 *
 * Contract (all enforced by guardPublicApiRequest):
 *   - 404 when the flag is off (the surface does not exist yet).
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key.
 *   - 403 without the read:leads scope.
 *   - 429 over the api_v1 budget (120/min, keyed by KEY ID).
 *   - 200 → { data: PublicLeadDto[], pagination: { page, per_page, has_more } }.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "read:leads");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const pagination = parsePagination(
    url.searchParams.get("page"),
    url.searchParams.get("per_page"),
  );
  const { from, to } = rangeFor(pagination);

  const admin = createAdminClient();
  // Service-role read (the key IS the credential). The org boundary is enforced
  // HERE by pinning to the key's own org — RLS is not the scoper on this path.
  // Stable order: created_at then id as a tiebreak so pages never overlap.
  const { data, error } = await (
    admin.from("leads") as unknown as LeadsListRead
  )
    .select(LEAD_DTO_SELECT)
    .eq("org_id", guard.key.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  // Loud read: a failed query must throw, never masquerade as an empty page.
  if (error) throw readFailure("public-api: leads list", error);

  const rows = data ?? [];
  const has_more = rows.length > pagination.per_page;
  const page = (has_more ? rows.slice(0, pagination.per_page) : rows).map(
    toPublicLeadDto,
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

export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:leads");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createLeadSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  // Cross-tenant reference integrity: a linked customer must be in the key's
  // org. Verified before the write so a forged id is a clean validation error.
  if (input.customer_id) {
    const ref = await verifyCustomerInOrg(
      admin as never,
      input.customer_id,
      guard.key.orgId,
    );
    if (!ref.ok) {
      return writeError(422, "invalid_reference", ref.message);
    }
  }

  const now = new Date().toISOString();
  const { data, error } = await (
    admin.from("leads") as unknown as LeadInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      contact_name: input.contact_name,
      contact_email: input.contact_email ?? null,
      contact_phone: input.contact_phone ?? null,
      source: input.source,
      service: input.service ?? null,
      urgency: input.urgency ?? "normal",
      postcode: input.postcode ?? null,
      estimated_value: input.estimated_value ?? null,
      notes: input.notes ?? null,
      customer_id: input.customer_id ?? null,
      // A captured lead is ALWAYS new — the client cannot inject a stage.
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    })
    .select(LEAD_DTO_SELECT)
    .single();

  if (error || !data) {
    console.error("[public-api] lead create failed", error?.message);
    return writeError(500, "write_failed", "Couldn't create the lead.");
  }

  return created(toPublicLeadDto(data));
}

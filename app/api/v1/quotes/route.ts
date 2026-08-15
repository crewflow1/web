import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { guardPublicApiRequest } from "@/lib/public-api/guard";
import { verifyQuoteReferences } from "@/lib/crm/reference-integrity";
import { computeTotals } from "@/lib/quotes/totals";
import {
  QUOTE_DTO_SELECT,
  toPublicQuoteDto,
  type QuoteRowForDto,
} from "@/lib/public-api/quotes";
import { parsePagination, rangeFor } from "@/lib/public-api/jobs";
import { createQuoteSchema } from "@/lib/public-api/write-schemas";
import { parseJsonBody, created, writeError } from "@/lib/public-api/write";

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

/** Minimal typed surface for the org-pinned quote insert + allowlisted readback. */
type QuoteInsertWrite = {
  insert: (row: {
    org_id: string;
    customer_id: string;
    property_id: string | null;
    lead_id: string | null;
    number: string;
    status: string;
    currency: string;
    subtotal: number;
    vat_total: number;
    total: number;
    notes: string | null;
    terms: string | null;
    valid_until: string | null;
    public_token: string;
    created_by: null;
  }) => {
    select: (cols: string) => {
      single: () => Promise<{
        data: QuoteRowForDto | null;
        error: { message?: string | null } | null;
      }>;
    };
  };
};

/** Minimal typed surface for the line-item insert (best-effort, org-pinned). */
type LineItemsInsert = {
  insert: (
    rows: Array<{
      quote_id: string;
      org_id: string;
      description: string;
      qty: number;
      unit: string;
      unit_price: number;
      vat_rate: number;
      line_total: number;
      sort_order: number;
    }>,
  ) => Promise<{ error: { message?: string | null } | null }>;
};

/**
 * POST /api/v1/quotes — create a draft quote in the KEY'S org.
 *
 * Requires the DISTINCT `write:quotes` scope. The MONEY IS COMPUTED SERVER-SIDE
 * from the submitted line items via the same computeTotals the app uses — a
 * client never sets subtotal/vat/total, and `.strict()` refuses every cost_*
 * field, so no margin data can be injected or read back. All references
 * (customer/property/lead) are verified in the key's org first. The per-org
 * quote number is allocated by the SECURITY DEFINER next_quote_number RPC, and
 * a fresh public_token is minted. Created as `draft`.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await guardPublicApiRequest(request, "write:quotes");
  if (!guard.ok) return guard.response;

  const body = await parseJsonBody(request, createQuoteSchema);
  if (!body.ok) return body.response;
  const input = body.value;

  const admin = createAdminClient();

  // Cross-tenant reference integrity — every FK must live in the key's org.
  const refs = await verifyQuoteReferences(admin as never, guard.key.orgId, {
    customerId: input.customer_id,
    propertyId: input.property_id ?? null,
    leadId: input.lead_id ?? null,
  });
  if (!refs.ok) return writeError(422, "invalid_reference", refs.message);

  // Per-org quote number via the SECURITY DEFINER RPC (same as the app).
  const { data: numberRpc, error: numErr } = await admin.rpc(
    "next_quote_number",
    { target_org: guard.key.orgId },
  );
  if (numErr || !numberRpc) {
    console.error("[public-api] quote number allocation failed", numErr?.message);
    return writeError(500, "write_failed", "Couldn't allocate a quote number.");
  }

  // Normalise line items into a concrete typed shape (a missing/blank unit
  // becomes "ea"), then compute the money here — never trusted from the client.
  const lineItems = input.line_items.map((li) => ({
    description: li.description,
    qty: li.qty,
    unit: li.unit && li.unit !== "" ? li.unit : "ea",
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
  }));
  const totals = computeTotals(lineItems);
  const publicToken = crypto.randomUUID();

  const { data: quote, error: qErr } = await (
    admin.from("quotes") as unknown as QuoteInsertWrite
  )
    .insert({
      // ORG PINNING — the key's own org, never a client-supplied value.
      org_id: guard.key.orgId,
      customer_id: input.customer_id,
      property_id: input.property_id ?? null,
      lead_id: input.lead_id ?? null,
      number: numberRpc as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: totals.subtotal,
      vat_total: totals.vat_total,
      total: totals.total,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      valid_until: input.valid_until ?? null,
      public_token: publicToken,
      // No acting user on the API path.
      created_by: null,
    })
    .select(QUOTE_DTO_SELECT)
    .single();

  if (qErr || !quote) {
    console.error("[public-api] quote create failed", qErr?.message);
    return writeError(500, "write_failed", "Couldn't create the quote.");
  }

  // Line items — org-pinned to the same org, tied to the new quote.
  const rows = lineItems.map((li, idx) => ({
    quote_id: quote.id,
    org_id: guard.key.orgId,
    description: li.description,
    qty: li.qty,
    unit: li.unit,
    unit_price: li.unit_price,
    vat_rate: li.vat_rate,
    line_total: totals.lines[idx]?.line_total ?? 0,
    sort_order: idx,
  }));
  const { error: liErr } = await (
    admin.from("quote_line_items") as unknown as LineItemsInsert
  ).insert(rows);
  if (liErr) {
    // The parent quote is saved with correct totals; surface loudly that the
    // line items didn't land rather than fake a clean create.
    console.error("[public-api] quote line items insert failed", liErr.message);
    return writeError(
      500,
      "line_items_failed",
      "The quote was created but its line items could not be saved.",
    );
  }

  return created(toPublicQuoteDto(quote));
}

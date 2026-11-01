import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure } from "@/lib/supabase/read-failure";
import { sanitizeSearchTerm } from "@/lib/search/sanitize";

/**
 * The ONE shared customer-search capability.
 *
 * Every customer-selection surface — the customers list page, the Cmd/K
 * palette's customer pre-pass, and the typeahead pickers in the sales/project
 * forms (jobs, quotes, leads, reviews, customer-parent) — matches customers
 * through here, so matching is identical everywhere: case-insensitive,
 * partial-anywhere, multi-token (every word must match SOMEWHERE), with
 * formatting-tolerant phone and normalised-postcode matching.
 *
 * All of that logic lives in the `public.search_customers` SECURITY DEFINER RPC
 * (migration 20261261000000). This module is the thin, typed, LOUD TS seam over
 * it. STRICT org isolation and permission enforcement:
 *   - the call goes through the TENANT client (createClient(), user JWT) — never
 *     createAdminClient() — so the RPC runs with the caller's identity;
 *   - the RPC's first act is the canonical `current_org_ids() + 42501` guard, so
 *     a non-member can never read another org's customers (it mirrors the
 *     customers RLS SELECT policy exactly — it never widens the boundary);
 *   - a read failure THROWS (readFailure), never degrades to an empty list — the
 *     silent-empty-state lie the search surfaces exist to avoid.
 */

/** A customer row as the search RPC returns it (display columns only — no money
 * or secret column is ever selected). */
export type CustomerSearchRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  customer_type: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  parent_customer_id: string | null;
  created_at: string;
};

export type CustomerSearchResult = {
  /** The page of matched customers, already ranked + ordered by the RPC. */
  rows: CustomerSearchRow[];
  /** EXACT total number of matches across the whole org (not just this page),
   * for true-total pagination. 0 when this page is empty. */
  total: number;
};

export type CustomerTypeFilter = "individual" | "business";

export type CustomerSearchParams = {
  /** The ACTIVE org to search within. The RPC refuses any other org (42501). */
  orgId: string;
  /** Free-text query; null/empty → the org's customers unfiltered (browse). */
  query?: string | null;
  /** Optional type narrow. Anything else is treated as "no filter". */
  type?: CustomerTypeFilter | null;
  /** Page size. Clamped to [1, 100] by both this seam and the RPC. */
  limit?: number;
  /** Zero-based offset for pagination. Clamped to >= 0. */
  offset?: number;
};

export const CUSTOMER_SEARCH_DEFAULT_LIMIT = 20;
/** Matches the RPC's hard cap. The customers list page pages at 200/page; the
 * typeahead uses 20. */
export const CUSTOMER_SEARCH_MAX_LIMIT = 200;

function clampLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.trunc(raw as number) : CUSTOMER_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), CUSTOMER_SEARCH_MAX_LIMIT);
}

/**
 * Search (or browse) the active org's customers through the shared RPC.
 *
 * `query` is run through the shared sanitizer first — exactly as the customers
 * list and /api/search already do — so the term neutralises PostgREST
 * structural/wildcard chars before it is ever interpolated anywhere. (The RPC
 * also escapes LIKE metacharacters internally, so a direct Data-API caller is
 * protected too; this is belt-and-braces.)
 */
export async function searchCustomers(
  supabase: SupabaseClient<Database>,
  params: CustomerSearchParams,
): Promise<CustomerSearchResult> {
  const limit = clampLimit(params.limit);
  const rawOffset = params.offset ?? 0;
  const offset = Math.max(Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : 0, 0);
  const type =
    params.type === "individual" || params.type === "business" ? params.type : null;
  const cleaned = sanitizeSearchTerm(params.query);

  const { data, error } = await supabase.rpc("search_customers", {
    p_org_id: params.orgId,
    p_query: cleaned.length > 0 ? cleaned : undefined,
    p_type: type ?? undefined,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) throw readFailure("customer search", error);

  const rows = (data ?? []) as Array<CustomerSearchRow & { relevance: number; total_count: number }>;
  // total_count is a window aggregate carried on every returned row, so it is
  // the whole-org match total regardless of this page's size. An empty page
  // (e.g. an out-of-range offset) carries no rows and therefore reports 0 — the
  // list page clamps the page number so it never requests past the end.
  const first = rows[0];
  const total = first ? Number(first.total_count) : 0;

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      customer_type: r.customer_type,
      address_line1: r.address_line1,
      address_line2: r.address_line2,
      city: r.city,
      county: r.county,
      postcode: r.postcode,
      country: r.country,
      parent_customer_id: r.parent_customer_id,
      created_at: r.created_at,
    })),
    total,
  };
}

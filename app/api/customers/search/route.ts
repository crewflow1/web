import { type NextRequest } from "next/server";
import * as respond from "@/lib/api/respond";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  searchCustomers,
  type CustomerTypeFilter,
  CUSTOMER_SEARCH_MAX_LIMIT,
} from "@/lib/customers/search";
import { customerToAddress, formatAddressOneLine } from "@/lib/address";

export const runtime = "nodejs";

/**
 * Customer typeahead backend — powers the shared CustomerCombobox used by the
 * sales/project form pickers (jobs, quotes, leads, reviews, customer-parent).
 *
 *   GET /api/customers/search?q=<term>&type=<individual|business>&limit=<n>
 *
 * It resolves the caller's ACTIVE org and delegates to the shared
 * `searchCustomers` capability (the search_customers RPC), so matching here is
 * byte-identical to the customers list page and the Cmd/K palette: multi-token,
 * partial-anywhere, case-insensitive, postcode-normalised, phone
 * formatting-tolerant.
 *
 * AUTH. requireOrgContext() = any authenticated org member — the same audience
 * the form pickers already expose all org customers to, and exactly what the
 * customers RLS SELECT policy admits. The RPC additionally refuses any org other
 * than the caller's own (42501), so this endpoint can never cross the tenant
 * boundary. It is never more permissive than the picker/list surfaces it serves;
 * the management-only product framing for customer existence stays enforced
 * where it already lives (the customers list capability gate + the /api/search
 * role filter).
 */

type CustomerHit = {
  id: string;
  name: string;
  /** One-line address (name + address is the required result label). */
  address: string;
  customer_type: string | null;
};

function parseType(raw: string | null): CustomerTypeFilter | null {
  return raw === "individual" || raw === "business" ? raw : null;
}

export async function GET(req: NextRequest) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const type = parseType(req.nextUrl.searchParams.get("type"));

  // A 1-char term is too broad to be a useful typeahead and needlessly loads the
  // DB on every keystroke; the palette uses the same 2-char floor. A typed
  // picker with no term still browses (type filter only), so an empty q is
  // allowed through — it returns the first page of the org's customers.
  if (q.length === 1) {
    return respond.json({ hits: [] satisfies CustomerHit[] });
  }

  const limitRaw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.trunc(limitRaw), CUSTOMER_SEARCH_MAX_LIMIT)
    : 20;

  const { rows } = await searchCustomers(supabase, {
    orgId: ctx.org.id,
    query: q.length >= 2 ? q : null,
    type,
    limit,
  });

  const hits: CustomerHit[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: formatAddressOneLine(customerToAddress(r)),
    customer_type: r.customer_type,
  }));

  return respond.json({ hits });
}

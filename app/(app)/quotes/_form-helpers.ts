import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Shared server-only fetchers for the quote builder dropdowns.
 *
 * Each list is pinned to the ACTIVE org, not merely left to RLS: RLS's
 * `current_org_ids()` returns EVERY org the viewer belongs to, so a dual-org
 * member's quote builder offered the other company's customers, sites and leads
 * — and a quote is a money document stamped with THIS org. Callers pass
 * `ctx.org.id` (the #456 convention) so the scope is visible at the call site.
 *
 * Properties + leads both carry `customer_id` so the builder can client-side
 * filter by selected customer without an extra fetch.
 */

export type CustomerOption = { id: string; name: string };
export type PropertyOption = { id: string; label: string; customer_id: string | null };
export type LeadOption = { id: string; label: string; customer_id: string | null };

export async function listCustomersForQuote(orgId: string): Promise<CustomerOption[]> {
  const supabase = await createClient();
  // COMPLETE read (F-1). The old `.limit(1000)` sat on the PostgREST clamp, so an
  // org past the cap lost late-alphabet customers from the quote builder and the
  // edit path could drop an out-of-cap link. Page the WHOLE list so every
  // customer is selectable and the currently-set one is always present. (Scale
  // follow-up: a name-prefix typeahead.)
  const { data, error } = await fetchAllRows<CustomerOption>((from, to) =>
    supabase
      .from("customers")
      .select("id, name")
      .eq("org_id", orgId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("quote form: customers", error);
  return data ?? [];
}

type PropertyRow = {
  id: string;
  customer_id: string | null;
  // Supabase types this jsonb column as `Json`; narrow when we build the label.
  address: unknown;
};
type LeadRow = {
  id: string;
  customer_id: string | null;
  service: string | null;
  postcode: string | null;
  urgency: string | null;
  created_at: string;
};

export async function listPropertiesForQuote(orgId: string): Promise<PropertyOption[]> {
  const supabase = await createClient();
  // Properties = sites/addresses. Best-effort human label from the jsonb
  // address ({ line1, postcode } shape).
  //
  // COMPLETE read (F-1). The old `.limit(1000)` sat EXACTLY on the PostgREST
  // clamp, so an org past the cap lost properties from the picker AND — worse —
  // the quote EDIT path silently NULLED an out-of-cap `property_id`: the builder
  // <select> renders options only from this list, so a saved-but-missing site
  // has no matching option, the browser falls back to value='' and any unrelated
  // save writes property_id = null. Paging the WHOLE list under the cap makes
  // every site selectable and guarantees the currently-set one is present.
  // (Mirrors listCustomersForQuote; scale follow-up: a name-prefix typeahead.)
  const { data, error } = await fetchAllRows<PropertyRow>((from, to) =>
    supabase
      .from("properties")
      .select("id, customer_id, address")
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("quote form: properties", error);
  return (data ?? []).map((p) => {
    const addr =
      (p.address as { line1?: string; postcode?: string } | null) ?? {};
    const label = addr.line1 || addr.postcode || p.id.slice(0, 8);
    return { id: p.id, label, customer_id: p.customer_id ?? null };
  });
}

export async function listLeadsForQuote(orgId: string): Promise<LeadOption[]> {
  const supabase = await createClient();
  // COMPLETE read (F-1). The old `.limit(500)` capped the lead picker: an org
  // past the cap lost older leads AND the quote EDIT path silently NULLED an
  // out-of-cap `lead_id` (same mechanism as properties above — the builder
  // <select> has no option for a saved-but-missing lead, so an untouched save
  // blanks the link). Page the WHOLE org-scoped set with a deterministic order
  // so every lead is selectable and the currently-set one is always present.
  const { data, error } = await fetchAllRows<LeadRow>((from, to) =>
    supabase
      .from("leads")
      .select("id, customer_id, service, postcode, urgency, created_at")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("quote form: leads", error);
  return (data ?? []).map((l) => ({
    id: l.id,
    customer_id: l.customer_id ?? null,
    label:
      `${l.service ?? "Lead"} — ${l.urgency ?? "normal"}` +
      (l.postcode ? ` (${l.postcode})` : ""),
  }));
}

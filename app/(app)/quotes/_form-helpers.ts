import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

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
  const { data, error } = await supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(1000);
  if (error) throw readFailure("quote form: customers", error);
  return data ?? [];
}

export async function listPropertiesForQuote(orgId: string): Promise<PropertyOption[]> {
  const supabase = await createClient();
  // Properties = sites/addresses. Best-effort human label from the
  // jsonb address ({ line1, postcode } shape).
  const { data, error } = await supabase
    .from("properties")
    .select("id, customer_id, address")
    .eq("org_id", orgId)
    .limit(1000);
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
  const { data, error } = await supabase
    .from("leads")
    .select("id, customer_id, service, postcode, urgency, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw readFailure("quote form: leads", error);
  return (data ?? []).map((l) => ({
    id: l.id,
    customer_id: l.customer_id ?? null,
    label:
      `${l.service ?? "Lead"} — ${l.urgency ?? "normal"}` +
      (l.postcode ? ` (${l.postcode})` : ""),
  }));
}

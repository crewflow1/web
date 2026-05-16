import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Shared server-only fetchers for the quote builder dropdowns.
 *
 * RLS scopes each list to the caller's org. Properties + leads both
 * carry `customer_id` so the builder can client-side filter by selected
 * customer without an extra fetch.
 */

export type CustomerOption = { id: string; name: string };
export type PropertyOption = { id: string; label: string; customer_id: string | null };
export type LeadOption = { id: string; label: string; customer_id: string | null };

export async function listCustomersForQuote(): Promise<CustomerOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(1000);
  return data ?? [];
}

export async function listPropertiesForQuote(): Promise<PropertyOption[]> {
  const supabase = await createClient();
  // Properties = sites/addresses. Best-effort human label from the
  // jsonb address ({ line1, postcode } shape).
  const { data } = await supabase
    .from("properties")
    .select("id, customer_id, address")
    .limit(1000);
  return (data ?? []).map((p) => {
    const addr =
      (p.address as { line1?: string; postcode?: string } | null) ?? {};
    const label = addr.line1 || addr.postcode || p.id.slice(0, 8);
    return { id: p.id, label, customer_id: p.customer_id ?? null };
  });
}

export async function listLeadsForQuote(): Promise<LeadOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("id, customer_id, service, postcode, urgency, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  return (data ?? []).map((l) => ({
    id: l.id,
    customer_id: l.customer_id ?? null,
    label:
      `${l.service ?? "Lead"} — ${l.urgency ?? "normal"}` +
      (l.postcode ? ` (${l.postcode})` : ""),
  }));
}

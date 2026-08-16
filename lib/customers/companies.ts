import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Reads for the "companies as a first-class entity" (B2B) feature — the
 * business-customer picker and the parent→children roll-up.
 *
 * All reads are ACTIVE-ORG PINNED (`.eq("org_id", orgId)`): RLS's
 * current_org_ids() admits EVERY org the viewer belongs to, so a dual-org
 * member would otherwise see the other company's businesses in the parent
 * picker and blended children in a roll-up. And they are LOUD — a transient
 * read failure THROWS (readFailure) rather than rendering as "no businesses" /
 * "no sites", which would be the silent-empty-state lie.
 *
 * Takes the client as an argument (the lib/jobs/load.ts + financials.ts idiom)
 * so it stays a pure, testable seam.
 */

type Client = SupabaseClient<Database>;

export type CustomerRef = { id: string; name: string };

/**
 * Business customers in the org, for the "parent business" picker. `excludeId`
 * drops the record being edited so a customer can't be offered itself as its
 * own parent (belt-and-braces beside the DB no-self-parent CHECK). Alphabetical
 * so the dropdown is scannable. Capped at 500 — the picker is a convenience for
 * a human, not an export; beyond that the operator should type-search elsewhere.
 */
export async function loadBusinessOptions(
  supabase: Client,
  orgId: string,
  excludeId?: string,
): Promise<CustomerRef[]> {
  let query = supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("customer_type", "business")
    .order("name", { ascending: true })
    .limit(500);
  if (excludeId) query = query.neq("id", excludeId);

  const { data, error } = await query;
  if (error) throw readFailure("customer parent options", error);
  return (data ?? []) as CustomerRef[];
}

/**
 * Direct children rolled up under a parent business (its sites/contacts held as
 * their own customer rows). One level — the UI models a business and its sites,
 * not an arbitrarily deep tree. Newest first, stable id tiebreaker.
 */
export async function loadChildCustomers(
  supabase: Client,
  orgId: string,
  parentId: string,
): Promise<CustomerRef[]> {
  const { data, error } = await supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("parent_customer_id", parentId)
    .order("name", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw readFailure("customer children", error);
  return (data ?? []) as CustomerRef[];
}

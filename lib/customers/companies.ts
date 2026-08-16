import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

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
 * so the dropdown is scannable. Fully paged (fetchAllRows) — a picker must see
 * the COMPLETE set or it silently drops a valid parent past the cap (the F-1
 * picker-completion class). Stable ordering (name, id) so no row is dropped or
 * repeated at a page boundary.
 */
export async function loadBusinessOptions(
  supabase: Client,
  orgId: string,
  excludeId?: string,
): Promise<CustomerRef[]> {
  const { data, error } = await fetchAllRows<CustomerRef>((from, to) => {
    let query = supabase
      .from("customers")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("customer_type", "business")
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (excludeId) query = query.neq("id", excludeId);
    return query as unknown as PromiseLike<{ data: CustomerRef[] | null; error: unknown }>;
  });
  if (error) throw readFailure("customer parent options", error);
  return data;
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
  const { data, error } = await fetchAllRows<CustomerRef>((from, to) =>
    supabase
      .from("customers")
      .select("id, name")
      .eq("org_id", orgId)
      .eq("parent_customer_id", parentId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: CustomerRef[] | null;
      error: unknown;
    }>,
  );
  if (error) throw readFailure("customer children", error);
  return data;
}

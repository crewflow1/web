import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Server-only helpers shared by the new/edit job pages (and, by now, by the
 * snags / diary / toolbox / assets / site-report surfaces too).
 *
 * These MUST be scoped to the ACTIVE org, not merely left to RLS.
 *
 * They used to run bare `.from("customers")` / `.from("memberships")` selects
 * on the strength of "they fetch under the user JWT so RLS does the org
 * scoping for us". That is wrong for a user who belongs to more than one
 * organisation: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to, so the dropdowns blended both orgs together. Because `jobs.customer_id`
 * and `jobs.assigned_to` have no cross-org guard at the database level (no
 * CHECK, no trigger — verified against the live schema), picking one of those
 * blended rows wrote another org's customer or staff member onto a job in the
 * active org. So this was a read defect that fed a write defect.
 *
 * Callers pass the active org explicitly (`ctx.org.id`) so the scope is
 * visible at the call site and cannot be silently dropped.
 */

export type CustomerOption = { id: string; name: string };
export type StaffOption = { id: string; full_name: string | null; email: string };

export async function listCustomersForOrg(
  orgId: string,
): Promise<CustomerOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(500);
  if (error) throw readFailure("job form: customers", error);
  return data ?? [];
}

export async function listStaffForOrg(orgId: string): Promise<StaffOption[]> {
  const supabase = await createClient();
  // Read memberships in the ACTIVE org; PostgREST joins to users via the FK.
  const { data, error } = await supabase
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .eq("org_id", orgId)
    .limit(500);
  if (error) throw readFailure("job form: staff", error);
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is StaffOption => !!u && !!u.id);
}

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

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
 * to, so the dropdowns blended both orgs together.
 *
 * The WRITE path is now guarded independently at BOTH layers (migration
 * 20261112000000): `jobs.customer_id` / `leads.customer_id` carry a composite
 * FK to customers(id, org_id), and `assigned_to` is gated by an org-membership
 * trigger — so even a forged form submission cannot write another org's
 * customer or a non-member as assignee. The server actions and the calendar
 * reschedule endpoint additionally re-check both references before the write
 * (lib/crm/reference-integrity) to return clean validation errors. Scoping
 * these dropdowns to the active org remains the right thing so the UI never
 * OFFERS a foreign-org option in the first place.
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
  // COMPLETE read (F-1). The old `.limit(500)` capped the picker: for an org
  // past the cap, late-alphabet customers became unattachable AND — worse — the
  // EDIT path silently NULLED an out-of-cap existing link, because updateJob
  // writes `customer_id ?? null` from the submitted <select>, and a current
  // customer missing from the options submits empty on an untouched save.
  // Paging the WHOLE list under the PostgREST cap makes every customer selectable
  // and guarantees the currently-set customer is always present, so no edit can
  // blank a valid link. (Scale follow-up: a server-side name-prefix typeahead.)
  const { data, error } = await fetchAllRows<CustomerOption>((from, to) =>
    supabase
      .from("customers")
      .select("id, name")
      .eq("org_id", orgId)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
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

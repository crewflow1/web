import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Customer + staff dropdown sources for the lead forms.
 *
 * These MUST be scoped to the ACTIVE org, not merely left to RLS. They used to
 * run bare selects on the strength of "RLS does the org scoping" — wrong for a
 * user in more than one organisation: `current_org_ids()` returns EVERY org the
 * viewer belongs to, so the dropdowns blended both companies. `leads.customer_id`
 * and `leads.assigned_to` carry no cross-org guard in the database, so picking a
 * blended row wrote another org's customer or staff member onto a lead in the
 * active org — a read defect feeding a write defect. Exactly the shape fixed for
 * the job forms in #456; callers pass `ctx.org.id` so the scope is visible at the
 * call site and cannot be silently dropped.
 */

export async function listCustomersForLead(
  orgId: string,
): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  // COMPLETE read (F-1). The old `.limit(1000)` sat on the PostgREST clamp: an
  // org past the cap lost late-alphabet customers from the picker AND — worse —
  // the EDIT path silently NULLED an out-of-cap existing link (updateLead writes
  // the submitted <select>, and a current customer missing from the options
  // submits empty on an untouched save). Paging the WHOLE list makes every
  // customer selectable and guarantees the currently-set customer is present, so
  // no edit can blank a valid link. (Scale follow-up: a name-prefix typeahead.)
  const { data, error } = await fetchAllRows<{ id: string; name: string }>(
    (from, to) =>
      supabase
        .from("customers")
        .select("id, name")
        .eq("org_id", orgId)
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
  );
  if (error) throw readFailure("lead form: customers", error);
  return data ?? [];
}

export async function listStaffForLead(
  orgId: string,
): Promise<{ id: string; full_name: string | null; email: string }[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .eq("org_id", orgId)
    .limit(500);
  if (error) throw readFailure("lead form: staff", error);
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is { id: string; full_name: string | null; email: string } => !!u?.id);
}

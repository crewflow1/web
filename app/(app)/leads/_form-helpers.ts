import "server-only";
import { createClient } from "@/lib/supabase/server";

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
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .eq("org_id", orgId)
    .order("name", { ascending: true })
    .limit(1000);
  return data ?? [];
}

export async function listStaffForLead(
  orgId: string,
): Promise<{ id: string; full_name: string | null; email: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .eq("org_id", orgId)
    .limit(500);
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is { id: string; full_name: string | null; email: string } => !!u?.id);
}

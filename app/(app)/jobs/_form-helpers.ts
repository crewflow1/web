import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-only helpers shared by the new/edit job pages.
 *
 * Both pages need the same two dropdown sources (customers + org members),
 * but they fetch under the user JWT so RLS does the org scoping for us.
 */

export type CustomerOption = { id: string; name: string };
export type StaffOption = { id: string; full_name: string | null; email: string };

export async function listCustomersForOrg(): Promise<CustomerOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(500);
  return data ?? [];
}

export async function listStaffForOrg(): Promise<StaffOption[]> {
  const supabase = await createClient();
  // Read memberships in your orgs; PostgREST joins to users via the FK.
  const { data } = await supabase
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .limit(500);
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is StaffOption => !!u && !!u.id);
}

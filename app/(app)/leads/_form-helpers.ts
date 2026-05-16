import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Customer + staff dropdown sources for the lead forms. RLS-scoped. */

export async function listCustomersForLead(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("customers")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(1000);
  return data ?? [];
}

export async function listStaffForLead(): Promise<
  { id: string; full_name: string | null; email: string }[]
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("memberships")
    .select("user:users ( id, full_name, email )")
    .limit(500);
  return (data ?? [])
    .map((row) => row.user)
    .filter((u): u is { id: string; full_name: string | null; email: string } => !!u?.id);
}

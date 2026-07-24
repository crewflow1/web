import { createClient } from "@/lib/supabase/server";
import type { AcknowledgementRow } from "@/lib/health-safety/acknowledgements-schema";
import type { AckSubjectType } from "@/lib/health-safety/acknowledgements";

/**
 * Operative sign-off read layer (shared by the RAMS + permit detail pages).
 * Tenant (user-JWT) client only → RLS-scoped; never the service-role client.
 * safety_acknowledgements post-dates the generated types → precise-shape cast.
 */

type AckWithName = AcknowledgementRow & { signer_name: string };

export async function listAcknowledgements(
  subjectType: AckSubjectType,
  subjectId: string,
): Promise<AckWithName[]> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<AcknowledgementRow & { users: { full_name: string | null; email: string | null } | null }> | null }> } } } };
  })
    .from("safety_acknowledgements")
    .select("id, org_id, subject_type, subject_id, subject_version, user_id, acknowledged_at, statement, statement_version, signed_name, users(full_name, email)")
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("acknowledged_at", { ascending: false });
  return (data ?? []).map((a) => ({ ...a, signer_name: a.users?.full_name || a.users?.email || a.signed_name }));
}

/** Count of org members (the acknowledgement "expected" denominator). */
export async function countOrgMembers(): Promise<number> {
  const supabase = await createClient();
  const { count } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string, o: { count: string; head: boolean }) => Promise<{ count: number | null }> };
  })
    .from("memberships")
    .select("user_id", { count: "exact", head: true });
  return count ?? 0;
}

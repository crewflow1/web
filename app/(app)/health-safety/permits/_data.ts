import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import type { PermitRow, PermitConditionRow } from "@/lib/health-safety/permits-schema";

/**
 * Permit-to-Work read layer. Tenant (user-JWT) client only → the service-role
 * client is never used here. These tables post-date the generated Supabase
 * types, so queries cast through the precise row shapes in
 * lib/health-safety/permits-schema.ts.
 *
 * RLS is the OUTER boundary, not the scope: `current_org_ids()` returns EVERY
 * org the viewer belongs to, so an RLS-only read put both companies' live
 * permits on one board — a safety-critical blend. Every read carries an ACTIVE
 * org predicate supplied by the caller (`ctx.org.id`).
 */

const P_COLS =
  "id, org_id, job_id, risk_assessment_id, reference, permit_type, title, scope, location, responsible_person, isolation_details, emergency_arrangements, valid_from, valid_until, status, closeout_notes, issued_by, issued_at, activated_at, suspended_at, closed_at, cancelled_at, created_at, updated_at";

type PermitListItem = PermitRow & { required_count: number; confirmed_required_count: number };

export async function listPermits(orgId: string): Promise<PermitListItem[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: SupabaseReadError | null }> } } };
  })
    .from("permits_to_work")
    .select(`${P_COLS}, permit_conditions(required, confirmed)`)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  // Throw on a REJECTED query — `[]` is reserved for a genuinely empty register.
  if (error) throw readFailure("permits: register", error);
  if (!data) return [];
  return (data as Array<PermitRow & { permit_conditions: Array<{ required: boolean; confirmed: boolean }> }>).map((p) => {
    const conds = p.permit_conditions ?? [];
    const req = conds.filter((c) => c.required);
    return { ...p, required_count: req.length, confirmed_required_count: req.filter((c) => c.confirmed).length };
  });
}

export async function getPermit(
  orgId: string,
  id: string,
): Promise<{ permit: PermitRow; conditions: PermitConditionRow[] } | null> {
  const supabase = await createClient();
  const { data: permit, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: PermitRow | null; error: SupabaseReadError | null }> } } } };
  })
    .from("permits_to_work").select(P_COLS).eq("id", id).eq("org_id", orgId).maybeSingle();
  // Throw on a REJECTED query — null is reserved for a genuinely missing row.
  if (error) throw readFailure("permits: permit", error);
  if (!permit) return null;
  const { data: conditions, error: conditionsError } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: PermitConditionRow[] | null; error: SupabaseReadError | null }> } } } } };
  })
    .from("permit_conditions")
    .select("id, org_id, permit_id, label, required, confirmed, confirmed_by, confirmed_at, notes, sort_order")
    .eq("permit_id", id)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (conditionsError) throw readFailure("permits: conditions", conditionsError);
  return { permit, conditions: conditions ?? [] };
}

/** Issued/superseded RAMS in the ACTIVE org, to link a permit to its assessment. */
export async function listRamsOptions(
  orgId: string,
): Promise<Array<{ id: string; label: string; job_id: string | null }>> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { in: (k: string, v: string[]) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<{ id: string; reference: string | null; title: string; job_id: string | null }> | null; error: SupabaseReadError | null }> } } } };
  })
    .from("risk_assessments")
    .select("id, reference, title, job_id")
    .eq("org_id", orgId)
    .in("status", ["issued", "superseded"])
    .order("created_at", { ascending: false });
  if (error) throw readFailure("permits: rams options", error);
  return (data ?? []).map((r) => ({ id: r.id, label: `${r.reference ?? "RAMS"} — ${r.title}`, job_id: r.job_id }));
}

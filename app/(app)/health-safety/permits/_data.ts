import { createClient } from "@/lib/supabase/server";
import type { PermitRow, PermitConditionRow } from "@/lib/health-safety/permits-schema";

/**
 * Permit-to-Work read layer. Tenant (user-JWT) client only → RLS scopes every
 * read to the caller's org; the service-role client is never used here. These
 * tables post-date the generated Supabase types, so queries cast through the
 * precise row shapes in lib/health-safety/permits-schema.ts.
 */

const P_COLS =
  "id, org_id, job_id, risk_assessment_id, reference, permit_type, title, scope, location, responsible_person, isolation_details, emergency_arrangements, valid_from, valid_until, status, closeout_notes, issued_by, issued_at, activated_at, suspended_at, closed_at, cancelled_at, created_at, updated_at";

type PermitListItem = PermitRow & { required_count: number; confirmed_required_count: number };

export async function listPermits(): Promise<PermitListItem[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> } };
  })
    .from("permits_to_work")
    .select(`${P_COLS}, permit_conditions(required, confirmed)`)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<PermitRow & { permit_conditions: Array<{ required: boolean; confirmed: boolean }> }>).map((p) => {
    const conds = p.permit_conditions ?? [];
    const req = conds.filter((c) => c.required);
    return { ...p, required_count: req.length, confirmed_required_count: req.filter((c) => c.confirmed).length };
  });
}

export async function getPermit(id: string): Promise<{ permit: PermitRow; conditions: PermitConditionRow[] } | null> {
  const supabase = await createClient();
  const { data: permit, error } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: PermitRow | null; error: unknown }> } } };
  })
    .from("permits_to_work").select(P_COLS).eq("id", id).maybeSingle();
  if (error || !permit) return null;
  const { data: conditions } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: PermitConditionRow[] | null }> } } } };
  })
    .from("permit_conditions")
    .select("id, org_id, permit_id, label, required, confirmed, confirmed_by, confirmed_at, notes, sort_order")
    .eq("permit_id", id)
    .order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  return { permit, conditions: conditions ?? [] };
}

/** Issued/superseded RAMS in the org, to link a permit to its risk assessment. */
export async function listRamsOptions(): Promise<Array<{ id: string; label: string; job_id: string | null }>> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { in: (k: string, v: string[]) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<{ id: string; reference: string | null; title: string; job_id: string | null }> | null }> } } };
  })
    .from("risk_assessments")
    .select("id, reference, title, job_id")
    .in("status", ["issued", "superseded"])
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => ({ id: r.id, label: `${r.reference ?? "RAMS"} — ${r.title}`, job_id: r.job_id }));
}

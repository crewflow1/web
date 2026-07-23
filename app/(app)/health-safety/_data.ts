import { createClient } from "@/lib/supabase/server";
import type { RiskAssessmentRow, HazardRow } from "@/lib/health-safety/schema";

/**
 * Health & Safety — RAMS read layer. Every query runs on the tenant (user-JWT)
 * client so RLS scopes it to the caller's org; we never touch the service-role
 * client here. These tables post-date the generated Supabase types, so each
 * query is cast through the precise row shapes in lib/health-safety/schema.ts.
 */

type RaListItem = RiskAssessmentRow & { hazard_count: number };

const RA_COLUMNS =
  "id, org_id, job_id, reference, title, activity, location, assessor_id, assessment_date, review_date, ppe, method_statement, status, issued_at, issued_by, supersedes_id, created_at, updated_at";

export async function listRiskAssessments(): Promise<RaListItem[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> };
    };
  })
    .from("risk_assessments")
    .select(`${RA_COLUMNS}, risk_assessment_hazards(count)`)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<RiskAssessmentRow & { risk_assessment_hazards: Array<{ count: number }> }>).map((r) => ({
    ...r,
    hazard_count: r.risk_assessment_hazards?.[0]?.count ?? 0,
  }));
}

export async function getRiskAssessment(
  id: string,
): Promise<{ ra: RiskAssessmentRow; hazards: HazardRow[] } | null> {
  const supabase = await createClient();
  const { data: ra, error } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: RiskAssessmentRow | null; error: unknown }> } };
    };
  })
    .from("risk_assessments")
    .select(RA_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error || !ra) return null;

  const { data: hazards } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: HazardRow[] | null }> } } };
    };
  })
    .from("risk_assessment_hazards")
    .select("id, org_id, risk_assessment_id, hazard, who_at_risk, likelihood, severity, risk_rating, control_measures, residual_likelihood, residual_severity, residual_rating, sort_order, created_at")
    .eq("risk_assessment_id", id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  return { ra, hazards: hazards ?? [] };
}

/** Org members who can be named as the assessor (for the create/edit form). */
export async function listAssessors(): Promise<Array<{ id: string; name: string }>> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<{ user_id: string; users: { full_name: string | null; email: string | null } | null }> | null }> } };
  })
    .from("memberships")
    .select("user_id, users(full_name, email)")
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => ({
    id: m.user_id,
    name: m.users?.full_name || m.users?.email || "Member",
  }));
}

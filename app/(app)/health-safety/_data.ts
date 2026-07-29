import { createClient } from "@/lib/supabase/server";
import type { RiskAssessmentRow, HazardRow, RevisionSibling } from "@/lib/health-safety/schema";

/**
 * Health & Safety — RAMS read layer. Every query runs on the tenant (user-JWT)
 * client so RLS scopes it to the caller's ORGS; we never touch the service-role
 * client here. These tables post-date the generated Supabase types, so each
 * query is cast through the precise row shapes in lib/health-safety/schema.ts.
 *
 * RLS is the OUTER boundary, not the scope: `current_org_ids()` returns EVERY
 * org the viewer belongs to, so a dual-org member's RAMS register listed both
 * companies' assessments and `/health-safety/<id>` opened another company's
 * assessment inside this org's shell. Every read below therefore carries its own
 * ACTIVE-org predicate, supplied by the caller (`ctx.org.id`) so the scope is
 * visible at the call site — the convention from #456/#463.
 */

type RaListItem = RiskAssessmentRow & { hazard_count: number };

const RA_COLUMNS =
  "id, org_id, job_id, reference, title, activity, location, assessor_id, assessment_date, review_date, ppe, method_statement, status, issued_at, issued_by, supersedes_id, root_risk_assessment_id, revision_number, created_at, updated_at";

export async function listRiskAssessments(orgId: string): Promise<RaListItem[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> } };
    };
  })
    .from("risk_assessments")
    .select(`${RA_COLUMNS}, risk_assessment_hazards(count)`)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<RiskAssessmentRow & { risk_assessment_hazards: Array<{ count: number }> }>).map((r) => ({
    ...r,
    hazard_count: r.risk_assessment_hazards?.[0]?.count ?? 0,
  }));
}

/**
 * One assessment + its hazards, constrained to the ACTIVE org.
 *
 * A RAMS in a non-active org is deliberately INDISTINGUISHABLE from a missing
 * one: callers already `notFound()` on null.
 */
export async function getRiskAssessment(
  orgId: string,
  id: string,
): Promise<{ ra: RiskAssessmentRow; hazards: HazardRow[] } | null> {
  const supabase = await createClient();
  const { data: ra, error } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: RiskAssessmentRow | null; error: unknown }> } } };
    };
  })
    .from("risk_assessments")
    .select(RA_COLUMNS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !ra) return null;

  const { data: hazards } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: HazardRow[] | null }> } } } };
    };
  })
    .from("risk_assessment_hazards")
    .select("id, org_id, risk_assessment_id, hazard, who_at_risk, likelihood, severity, risk_rating, control_measures, residual_likelihood, residual_severity, residual_rating, sort_order, created_at")
    .eq("risk_assessment_id", id)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  return { ra, hazards: hazards ?? [] };
}

/**
 * Every revision in a RAMS series (by root), newest first — for the lineage rail
 * on the detail page. Pinned to the ACTIVE org, not merely RLS-scoped.
 */
export async function getRevisionSiblings(
  orgId: string,
  rootId: string,
): Promise<RevisionSibling[]> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: RevisionSibling[] | null }> } } } };
  })
    .from("risk_assessments")
    .select("id, reference, revision_number, status")
    .eq("root_risk_assessment_id", rootId)
    .eq("org_id", orgId)
    .order("revision_number", { ascending: false });
  return data ?? [];
}

/** Members of the ACTIVE org who can be named as the assessor. */
export async function listAssessors(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const supabase = await createClient();
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { order: (k: string, o: { ascending: boolean }) => Promise<{ data: Array<{ user_id: string; users: { full_name: string | null; email: string | null } | null }> | null }> } } };
  })
    .from("memberships")
    .select("user_id, users(full_name, email)")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  return (data ?? []).map((m) => ({
    id: m.user_id,
    name: m.users?.full_name || m.users?.email || "Member",
  }));
}

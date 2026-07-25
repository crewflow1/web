import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { HsSnapshot } from "@/lib/health-safety/signals";

/**
 * Gather the H&S dashboard signals in a small, fixed set of bounded, RLS-scoped
 * queries (user JWT → the caller's org only). Mirrors server/services/
 * retention-snapshot.ts. Deterministic; no cron, no N+1 — the two cross-reference
 * signals (active-job-without-RAMS, high-residual) diff bounded id lists in JS.
 */

const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
type CountRes = { count: number | null };
type DataRes = { data: Row[] | null };
type Q = {
  from: (t: string) => {
    select: (c: string, o?: { count: "exact"; head: true }) => {
      eq: (k: string, v: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  };
};

export async function buildHealthSafetySnapshot(orgId: string): Promise<HsSnapshot> {
  const supabase = await createClient();
  const s = supabase as unknown as Q;
  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + DAY_MS).toISOString();
  const today = nowIso.slice(0, 10);

  const [
    draftRes, reviewRes, expiringRes, expiredRes,
    activeJobsRes, issuedRamsJobsRes, highResidualRes, issuedRamsRes,
  ] = (await Promise.all([
    s.from("risk_assessments").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "draft"),
    s.from("risk_assessments").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "issued").not("review_date", "is", null).lt("review_date", today),
    s.from("permits_to_work").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("status", ["issued", "active"]).gte("valid_until", nowIso).lte("valid_until", soonIso),
    s.from("permits_to_work").select("id", { count: "exact", head: true }).eq("org_id", orgId).in("status", ["issued", "active"]).lt("valid_until", nowIso),
    s.from("jobs").select("id").eq("org_id", orgId).eq("status", "in-progress"),
    s.from("risk_assessments").select("job_id").eq("org_id", orgId).eq("status", "issued").not("job_id", "is", null),
    s.from("risk_assessment_hazards").select("risk_assessment_id").eq("org_id", orgId).gte("residual_rating", 16),
    s.from("risk_assessments").select("id").eq("org_id", orgId).eq("status", "issued"),
  ])) as [CountRes, CountRes, CountRes, CountRes, DataRes, DataRes, DataRes, DataRes];

  const activeJobIds = (activeJobsRes.data ?? []).map((r) => r.id as string);
  const ramsJobIds = new Set((issuedRamsJobsRes.data ?? []).map((r) => r.job_id as string));
  const activeJobsNoCurrentRams = activeJobIds.filter((id) => !ramsJobIds.has(id)).length;

  const issuedRamsIds = new Set((issuedRamsRes.data ?? []).map((r) => r.id as string));
  const highResidualRams = new Set(
    (highResidualRes.data ?? [])
      .map((r) => r.risk_assessment_id as string)
      .filter((id) => issuedRamsIds.has(id)),
  ).size;

  return {
    ramsDraft: draftRes.count ?? 0,
    ramsReviewOverdue: reviewRes.count ?? 0,
    permitsExpiringSoon: expiringRes.count ?? 0,
    permitsExpiredLive: expiredRes.count ?? 0,
    activeJobsNoCurrentRams,
    highResidualRams,
  };
}

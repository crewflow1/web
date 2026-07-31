import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import type { JobBudgetRow } from "@/lib/jobs/budget";

/**
 * Job cost baseline — the read layer for `job_budgets` (20261072).
 *
 * The SUPPLY side (what an approved variation adds to the plan) is NOT read
 * here. It lives on `quotes` itself — `cost_labour / cost_materials /
 * cost_subcontractors / cost_misc` and the GENERATED `cost_total` (20261073) —
 * and the commercial page already selects the quotes it needs, so it maps those
 * columns straight into the composer. There is deliberately no second
 * per-variation cost store and no second read: one commercial source of truth.
 *
 * THE ACCOUNTING BOUNDARY: reads only, and nothing here touches the actual-cost
 * ledger. A budget is a PLAN, so a planned figure must never reach `finances` —
 * it would be double-counted against the real supplier bill and would silently
 * inflate the job's cost (the same hazard operational stock shipped on, CEO
 * decision D1). The actuals this module's figures are compared with are read by
 * the CALLER and passed in; there is no ledger write path anywhere in the slice.
 *
 * SCOPING — three belts, per the job-site-hub doctrine:
 *   1. RLS, via the caller's client (the user's JWT in the app).
 *   2. `org_id` PINNED on every read. `current_org_ids()` returns EVERY org the
 *      viewer belongs to, so RLS alone BLENDS orgs for a dual-org member — the
 *      defect class this product has shipped six fixes for.
 *   3. The narrowing key (job_id / quote ids) pinned too.
 *
 * LOUD READS: every read binds `error` and throws `readFailure`. An empty budget
 * panel must mean "no baseline", never "the query failed" — a silently-failed
 * read here would tell an owner their job is on plan.
 *
 * Neither table is in the generated Supabase types yet, so both go through the
 * established loose-client cast (the job-page idiom). The cast is TypeScript-only
 * and changes nothing about the RLS-scoped runtime client.
 */

type Row = Record<string, unknown>;
type Builder = PromiseLike<{ data: Row[] | null; error: unknown }> & {
  select: (c: string) => Builder;
  eq: (k: string, v: unknown) => Builder;
  is: (k: string, v: unknown) => Builder;
  order: (k: string, o: { ascending: boolean }) => Builder;
  limit: (n: number) => Builder;
};
export type JobBudgetClient = { from: (t: string) => Builder };

const BUDGET_COLS =
  "id, revision, total_cost, labour_cost, materials_cost, subcontractors_cost, " +
  "misc_cost, target_margin_pct, note, created_by, created_at, superseded_at";


export type JobBudgetRevision = JobBudgetRow & {
  id: string;
  created_by: string | null;
  superseded_at: string | null;
};

/**
 * The CURRENT baseline for a job, or null when it has none.
 *
 * `superseded_at IS NULL` is the current-revision predicate, and
 * `job_budgets_one_current` (a partial unique index) is what makes it single —
 * so this is a one-row read by construction, not a "take the newest" guess.
 */
export async function loadCurrentJobBudget(
  client: JobBudgetClient,
  orgId: string,
  jobId: string,
): Promise<JobBudgetRevision | null> {
  const res = await client
    .from("job_budgets")
    .select(BUDGET_COLS)
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .is("superseded_at", null)
    .limit(1);
  if (res.error) throw readFailure("job budget: current revision", res.error);
  const rows = (res.data ?? []) as unknown as JobBudgetRevision[];
  return rows[0] ?? null;
}

/**
 * Every revision for a job, newest first — the audit trail that makes a
 * re-baseline visible. Ordered by `revision` (unique per job by index), so the
 * order is total and stable.
 */
export async function loadJobBudgetHistory(
  client: JobBudgetClient,
  orgId: string,
  jobId: string,
): Promise<JobBudgetRevision[]> {
  const res = await client
    .from("job_budgets")
    .select(BUDGET_COLS)
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("revision", { ascending: false });
  if (res.error) throw readFailure("job budget: revision history", res.error);
  return (res.data ?? []) as unknown as JobBudgetRevision[];
}

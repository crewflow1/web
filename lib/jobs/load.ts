import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";

/**
 * Active-org-scoped loads for a single job addressed by URL id.
 *
 * The bug these guard against: CrewFlow users can belong to MORE THAN ONE
 * organisation, and the app tracks an "active org" (the `active_org_id`
 * cookie, resolved per request by `requireOrgContext()`). The RLS helper
 * `current_org_ids()` is deliberately permissive — it returns EVERY org the
 * viewer belongs to, because RLS's job is the outer boundary ("you cannot see
 * an org you are not a member of"), not the inner one.
 *
 * So RLS is NOT scoping. A page that did
 *
 *     supabase.from("jobs").select(...).eq("id", id).maybeSingle()
 *
 * would happily return a job belonging to a DIFFERENT org that the viewer also
 * happens to be a member of. The row then renders inside the ACTIVE org's
 * shell — its navigation, its totals — and any subsequent write performed with
 * the active org's assumptions lands against another org's row.
 *
 * That is a correctness / data-integrity defect, not a cross-tenant breach:
 * the viewer is a legitimate member of both orgs. The fix is to constrain
 * every by-id load to the active org as well, so a row in a non-active org is
 * INDISTINGUISHABLE from one that does not exist — callers `notFound()` on
 * null exactly as they already did for a genuinely missing job.
 *
 * These helpers are the chokepoint for the `/jobs/[id]/**` route family so the
 * predicate cannot be forgotten one page at a time. They take the Supabase
 * client as an argument (rather than building one from cookies) so the
 * integration suite can drive them with a real multi-org user's JWT.
 */

type JobsClient = SupabaseClient<Database>;

/**
 * Minimal PostgREST surface used here. `select()` takes a runtime-built
 * column string, which the generated types cannot narrow, so the client is
 * accessed through this shape — the same cast style already used elsewhere in
 * the app for dynamically-selected reads.
 */
type LooseClient = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): { maybeSingle(): Promise<{ data: unknown; error: SupabaseReadError | null }> };
      };
    };
  };
};

/**
 * Load one job by id, constrained to `orgId` (the ACTIVE org).
 *
 * Returns null when the job does not exist OR belongs to another org — the
 * two cases are deliberately indistinguishable to the caller. Callers must
 * treat null as "not found" (`notFound()`), which is what they already do.
 *
 * Note this deliberately does NOT switch the viewer's active org to match the
 * URL. Whether opening another org's job link should offer to switch org is a
 * product decision, not something a scoping fix may assume.
 */
export async function loadJobForOrg<T = { id: string }>(
  supabase: JobsClient,
  jobId: string,
  orgId: string,
  columns: string = "id",
): Promise<T | null> {
  const { data, error } = await (supabase as unknown as LooseClient)
    .from("jobs")
    .select(columns)
    .eq("id", jobId)
    .eq("org_id", orgId)
    .maybeSingle();
  // Loud fail: every job page funnels through this loader — a transient query
  // failure must throw, never alias the deliberate not-found/other-org null.
  if (error) throw readFailure("jobs: load by id", error);
  return (data as T | null) ?? null;
}

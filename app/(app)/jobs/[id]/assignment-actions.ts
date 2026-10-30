"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { hasCapability } from "@/server/auth/capabilities";
import { createAdminClient } from "@/lib/supabase/admin";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Job assignments — server actions (migration 20261242000000).
 *
 * Owner/admin add and remove workers on a job's crew. Backed by the
 * SERVICE-ROLE-ONLY `job_assignments` table (RLS on, client grants revoked), so
 * every statement here goes through `createAdminClient()` — a user-JWT client
 * cannot read or write that table at all.
 *
 * AUTHORIZATION. Both actions gate on the `jobs:manage` capability via
 * `hasCapability` (owner always; admin only with the grant; any other role
 * never) and return a graceful `FormState` error on denial rather than
 * redirecting — the panel keeps rendering and shows the message. The capability
 * check runs BEFORE the admin client is ever constructed, so a denied caller
 * never reaches a privileged read or write.
 *
 * ACTIVE-ORG PINNING. `ctx.org.id` pins every statement. RLS is bypassed by the
 * admin client, so the org pin is the scoping boundary here: the job-in-org read
 * refuses a job that is not in the caller's active org, and the composite FK
 * (job_id, org_id) → jobs(id, org_id) makes a cross-tenant assignment
 * structurally impossible even if the pin were ever dropped.
 *
 * NAVIGATION. These are in-place panel actions: they `revalidatePath` the job
 * page and return `FormState` WITHOUT a `redirectTo`, so <StateForm> re-renders
 * the assignments section in place (no deep-route navigation, so the Next 15.5
 * stranded-commit race that drove progress-actions' redirectTo pattern does not
 * apply — nothing navigates).
 */

const idSchema = z.string().uuid();

/**
 * The `job_assignments` table and the `assigned_to` nulling are not in the
 * generated Supabase `Database` types (the table is new and types.ts is frozen
 * here), so the admin client is accessed through this minimal structural type —
 * the same cast idiom `server/auth/capabilities.ts` uses for
 * `membership_permissions`.
 */
type DbResult = { error: { message: string } | null };
type SingleResult<T> = { data: T | null; error: { message: string } | null };

type JobRow = { id: string; assigned_to: string | null };
type MemberRow = { user_id: string };

interface SelectFilter<T> {
  eq: (column: string, value: unknown) => SelectFilter<T>;
  maybeSingle: () => Promise<SingleResult<T>>;
}
interface WriteFilter extends PromiseLike<DbResult> {
  eq: (column: string, value: unknown) => WriteFilter;
}
type AdminLike = {
  from: (table: string) => {
    select: <T>(columns: string) => SelectFilter<T>;
    upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => PromiseLike<DbResult>;
    update: (values: Record<string, unknown>) => WriteFilter;
    delete: () => WriteFilter;
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<DbResult>;
};

const NO_PERMISSION =
  "You don't have permission to change who's assigned to this job.";
const BAD_LINK = "That job link looks wrong — reload and try again.";
const NOT_IN_ORG =
  "That job isn't in this workspace — switch workspace and try again.";

/**
 * Assign a worker to a job. Idempotent: upserts on (job_id, user_id), so
 * re-assigning the same worker is a no-op rather than a duplicate row.
 */
export async function assignWorker(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();

  if (!idSchema.safeParse(jobId).success) return formError(BAD_LINK);

  // AUTHZ FIRST — before the admin client is ever constructed.
  if (!(await hasCapability(ctx, user, "jobs", "manage"))) {
    return formError(NO_PERMISSION);
  }

  const userId = formData.get("user_id");
  const parsedUser = idSchema.safeParse(typeof userId === "string" ? userId : "");
  if (!parsedUser.success) {
    return formError("Pick a worker to assign.");
  }
  const workerId = parsedUser.data;

  const admin = createAdminClient() as unknown as AdminLike;

  // The job must be in the caller's ACTIVE org (friendly refusal, not an FK error).
  const { data: job, error: jobError } = await admin
    .from("jobs")
    .select<JobRow>("id, assigned_to")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError || !job) return formError(NOT_IN_ORG);

  // The worker must be a member of the job's org — never assign a non-member
  // (and never a member of another of the caller's orgs).
  const { data: member, error: memberError } = await admin
    .from("memberships")
    .select<MemberRow>("user_id")
    .eq("org_id", ctx.org.id)
    .eq("user_id", workerId)
    .maybeSingle();
  if (memberError) {
    return formError("Couldn't check that person's membership. Try again.");
  }
  if (!member) {
    return formError("That person isn't a member of this workspace.");
  }

  const { error } = await admin.from("job_assignments").upsert(
    {
      org_id: ctx.org.id,
      job_id: jobId,
      user_id: workerId,
      assigned_by: user.id,
    },
    { onConflict: "job_id,user_id" },
  );
  if (error) {
    console.error("[job-assignments] assign failed", error);
    return formError("Couldn't assign that worker. Refresh and try again.");
  }

  revalidatePath(`/jobs/${jobId}`);
  return formSuccess({ successMessage: "Worker assigned." });
}

/**
 * Remove a worker from a job.
 *
 * REMOVAL REVOKES ACCESS: if the removed worker is ALSO the job's legacy single
 * `assigned_to` primary assignee, that column is nulled too — so removing someone
 * from the crew cannot leave them with access via the old single-assignee path.
 * Both writes happen inside the ONE transactional remove_job_worker RPC
 * (20261246000000), so the crew row and the legacy primary can never end up in a
 * half-revoked state. Org-pinned (p_org_id) inside the function.
 */
export async function removeWorker(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();

  if (!idSchema.safeParse(jobId).success) return formError(BAD_LINK);

  if (!(await hasCapability(ctx, user, "jobs", "manage"))) {
    return formError(NO_PERMISSION);
  }

  const userId = formData.get("user_id");
  const parsedUser = idSchema.safeParse(typeof userId === "string" ? userId : "");
  if (!parsedUser.success) {
    return formError("That assignment link looks wrong — reload and try again.");
  }
  const workerId = parsedUser.data;

  const admin = createAdminClient() as unknown as AdminLike;

  // The job must be in the caller's ACTIVE org (friendly refusal, not a silent
  // no-op). The RPC is org-pinned too, but this gives the operator a clear message.
  const { data: job, error: jobError } = await admin
    .from("jobs")
    .select<JobRow>("id, assigned_to")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError || !job) return formError(NOT_IN_ORG);

  // One transactional revoke: delete the crew row AND null jobs.assigned_to if it
  // points at this worker — atomically, so no stale assignment path survives.
  const { error } = await admin.rpc("remove_job_worker", {
    p_job_id: jobId,
    p_org_id: ctx.org.id,
    p_user_id: workerId,
  });
  if (error) {
    console.error("[job-assignments] remove failed", error);
    return formError("Couldn't remove that worker. Refresh and try again.");
  }

  revalidatePath(`/jobs/${jobId}`);
  return formSuccess({ successMessage: "Worker removed." });
}

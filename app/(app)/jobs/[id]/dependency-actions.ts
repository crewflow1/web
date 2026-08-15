"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Milestone dependency server action (migration 20261132000002).
 *
 * Records the WHOLE edge set for a baseline through the atomic, cycle-checking
 * `set_milestone_dependencies` RPC (the only write path). SECURITY INVOKER +
 * admin-only RLS is the real gate; this action adds no second gate. Returns
 * FormState and navigates via `redirectTo` (a document load), never redirect(),
 * mirroring programme-actions.ts and the deep-swap-race rule.
 *
 * The form submits, per successor milestone, a `deps_<milestoneId>` multi-value
 * of its predecessor milestone ids. The RPC re-validates that every endpoint
 * belongs to the baseline and that the set is acyclic.
 */

const idSchema = z.string().uuid();
const jobUrl = (jobId: string, params: string): string => `/jobs/${jobId}?${params}`;

const RPC_SENTENCES = [
  "a baseline and an organisation are required",
  "that baseline is not in this workspace",
  "a milestone cannot depend on itself",
  "a dependency references a milestone outside this baseline",
  "these dependencies form a loop",
  "a dependency needs both",
];

function friendlyRpcError(message: string | undefined): string {
  const m = (message ?? "").trim();
  if (m && RPC_SENTENCES.some((s) => m.includes(s))) return m;
  return "Couldn't save the dependencies. Check the links and try again.";
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function setMilestoneDependencies(
  jobId: string,
  baselineId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success || !idSchema.safeParse(baselineId).success) {
    return formError("That programme link looks wrong — reload and try again.");
  }

  // The successor milestone ids the form rendered (a hidden, comma-separated
  // allowlist), so a forged deps_<id> field for a milestone outside the form is
  // ignored here (and refused again by the RPC).
  const successorIds = String(formData.get("milestone_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => idSchema.safeParse(s).success);

  const edges: Array<{ milestone_id: string; depends_on_milestone_id: string }> = [];
  for (const succ of successorIds) {
    const preds = formData
      .getAll(`deps_${succ}`)
      .map((v) => String(v))
      .filter((v) => idSchema.safeParse(v).success && v !== succ);
    for (const pred of preds) {
      edges.push({ milestone_id: succ, depends_on_milestone_id: pred });
    }
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { error } = await supabase.rpc("set_milestone_dependencies", {
    p_baseline_id: baselineId,
    p_org_id: ctx.org.id,
    p_edges: edges,
  });
  if (error) {
    console.error("[job-milestone-deps] set failed", error);
    return formError(friendlyRpcError(error.message));
  }

  return formSuccess({ redirectTo: jobUrl(jobId, "saved=dependencies#programme") });
}

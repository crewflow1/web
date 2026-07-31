"use server";

import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { loadJobForOrg } from "@/lib/jobs/load";
import { formError, formSuccess, validateFormData, type FormState } from "@/lib/forms/state";
import { round2 } from "@/lib/money";

/**
 * Job cost baseline — the write path (20261072).
 *
 * THE ACCOUNTING BOUNDARY: this action writes a PLAN and nothing else. It never
 * touches `finances`. A planned figure in the actual-cost ledger would be
 * double-counted against the real supplier bill and would silently inflate the
 * job's cost — the same hazard operational stock ships under (CEO decision D1).
 * Pinned by __tests__/security/job-budgets.test.ts.
 *
 * AUTHORISATION IS DOUBLED. The role check here produces a sentence; the DB
 * policies (`is_org_admin` on job_budgets insert/update) are the real boundary,
 * so a direct PostgREST caller holding a member's JWT is refused too. The RPC is
 * SECURITY INVOKER precisely so those policies still apply to it.
 *
 * ACTIVE-ORG PIN. The job is resolved through `loadJobForOrg`, the /jobs/[id]
 * chokepoint, so a dual-org member cannot set a baseline on the other company's
 * job by URL; and `p_org_id` is always `ctx.org.id`, never a value from the
 * request.
 *
 * NO `revalidatePath`. This route is four segments deep
 * (app/(app)/jobs/[id]/commercial), which is the deep-swap commit race: Next
 * 15.5 drops the client-side navigation while the server work lands, so the save
 * commits, the POST returns 200, and `useActionState` never sees the state — the
 * form sits on "Saving…" and the operator saves it twice. Every write returns
 * `redirectTo` and the form hard-navigates with `window.location.assign`, which
 * fetches the destination fresh. The route is dynamic (it reads cookies via the
 * Supabase server client), so there is no cache entry to invalidate anyway.
 */

const money = z.coerce
  .number()
  .min(0, "Cannot be negative")
  .max(100_000_000, "Unrealistic value");

const optionalMoney = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  money.optional(),
);

const budgetSchema = z
  .object({
    /** Present and non-empty ⇒ the operator opted into bucket detail. */
    detail: z.preprocess((v) => v === "on" || v === "true" || v === "1", z.boolean()),
    total_cost: optionalMoney,
    labour_cost: optionalMoney,
    materials_cost: optionalMoney,
    subcontractors_cost: optionalMoney,
    misc_cost: optionalMoney,
    target_margin_pct: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce
        .number()
        .min(0, "A target margin cannot be negative")
        .max(95, "A target margin cannot exceed 95%")
        .optional(),
    ),
    note: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().max(2000).optional(),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.detail) {
      // Detail is ALL FOUR OR NONE (the DB CHECK says the same thing). A partial
      // breakdown leaves a remainder no tile can name honestly.
      for (const k of [
        "labour_cost",
        "materials_cost",
        "subcontractors_cost",
        "misc_cost",
      ] as const) {
        if (v[k] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: "Enter a figure (0 is fine) — the breakdown must account for the whole total",
          });
        }
      }
    }
  });

export type BudgetFormValues = z.infer<typeof budgetSchema>;

function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Record a cost baseline, or a revision of one.
 *
 * When bucket detail is supplied the TOTAL IS DERIVED FROM IT (Σ of the four),
 * so the two can never disagree — the DB CHECK is the backstop, not the
 * mechanism. Every pound has to land in a named bucket; `misc` is where the ones
 * you cannot name go, which is exactly where `mapToCostBucket` sends every
 * unrecognised ACTUAL cost, so plan and actual share one taxonomy by
 * construction.
 */
export async function setJobBudget(
  jobId: string,
  _prev: FormState<BudgetFormValues>,
  formData: FormData,
): Promise<FormState<BudgetFormValues>> {
  const { ctx } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    return formError("Only an owner or admin can set a job's budget.");
  }

  const parsed = validateFormData(formData, budgetSchema);
  if (!parsed.ok) return parsed.state;
  const data = parsed.data;

  const supabase = await createClient();
  // ACTIVE-ORG PIN — a job outside the active org is simply not found.
  const job = await loadJobForOrg<{ id: string }>(supabase, jobId, ctx.org.id, "id");
  if (!job) return formError("Job not found.");

  const buckets = data.detail
    ? {
        labour: round2(data.labour_cost ?? 0),
        materials: round2(data.materials_cost ?? 0),
        subcontractors: round2(data.subcontractors_cost ?? 0),
        misc: round2(data.misc_cost ?? 0),
      }
    : null;

  const total = buckets
    ? round2(buckets.labour + buckets.materials + buckets.subcontractors + buckets.misc)
    : round2(data.total_cost ?? 0);

  if (total <= 0 && data.target_margin_pct === undefined) {
    return formError(
      "Enter a budget figure or a target margin — a baseline of nothing is not a baseline.",
    );
  }

  const rpc = supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
  };
  const { error } = await rpc.rpc("set_job_budget", {
    p_job_id: jobId,
    p_org_id: ctx.org.id, // ACTIVE-ORG PIN — never a value from the request
    p_total_cost: total,
    p_labour_cost: buckets?.labour ?? null,
    p_materials_cost: buckets?.materials ?? null,
    p_subcontractors_cost: buckets?.subcontractors ?? null,
    p_misc_cost: buckets?.misc ?? null,
    p_target_margin_pct: data.target_margin_pct ?? null,
    p_note: data.note ?? null,
  });

  if (error) {
    // NEVER echo raw Postgres text to the browser: it can carry column names,
    // constraint bodies and row values (the house rule pinned by
    // loud-read-failures.test.ts). Map the two refusals an operator can actually
    // cause, and log the rest.
    const raw = error.message ?? "";
    if (/job_budgets_revision_needs_reason/.test(raw)) {
      return formError(
        "Say why the budget is changing — a revision needs a reason so the original stays defensible.",
        data,
      );
    }
    if (/row-level security|permission denied/i.test(raw)) {
      return formError("Only an owner or admin can set a job's budget.", data);
    }
    console.error("[job-budget] setJobBudget rejected", error);
    return formError("That budget could not be saved. Check the figures and try again.", data);
  }

  return formSuccess<BudgetFormValues>({
    successMessage: "Budget saved.",
    redirectTo: `/jobs/${jobId}/commercial`,
  });
}

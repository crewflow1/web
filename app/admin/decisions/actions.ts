"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  createDecision,
  decide,
  type Decider,
  type DecisionOutcome,
} from "@/server/services/hq-decisions";

/**
 * HQ Decision Centre — server actions.
 *
 * THIN WRAPPERS, deliberately. The Decision Centre service
 * (server/services/hq-decisions.ts) is the ONE authority on transitions: it owns the
 * super-admin gate (isSuperAdminEmail inside deciderGate), the idempotency rules, and
 * the audit writes; the DB trigger beneath it is the unbypassable enforcer. These
 * actions add NO state logic and touch NO table — they parse the form, name the
 * decider, call the service, and translate its result into a redirect. There is no
 * direct hq_decisions access here, ever.
 *
 * Gating: every action re-checks isSuperAdminEmail before calling the service (which
 * checks again). The /admin/* layout already 404s non-allowlisted users; this is the
 * same defence-in-depth the Approval Console carries.
 */

async function requireAdmin(): Promise<Decider & { email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

function backTo(params: Record<string, string>, path = "/admin/decisions"): never {
  const sp = new URLSearchParams(params);
  revalidatePath(path);
  redirect(`${path}?${sp.toString()}`);
}

/** Human-readable translation of the service's error vocabulary. */
function describeError(error: string): string {
  switch (error) {
    case "not_found":
      return "Decision not found.";
    case "not_active":
      return "Already decided — this decision is in a terminal state.";
    case "forbidden":
      return "You are not a permitted decision-maker.";
    case "reason_required":
      return "A reason is required for this outcome.";
    case "delay_until_required":
      return "A revisit date is required to delay a decision.";
    case "delegate_to_required":
      return "A delegate is required to delegate a decision.";
    case "title_required":
      return "A title is required.";
    default:
      return "Couldn't apply the decision — try again.";
  }
}

const trimmedOrNull = z
  .string()
  .max(5000)
  .optional()
  .transform((v) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  });

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  problem: trimmedOrNull,
  recommendation: trimmedOrNull,
  business_impact: trimmedOrNull,
  revenue_impact: trimmedOrNull,
  demand: trimmedOrNull,
  engineering_cost: trimmedOrNull,
  risk: trimmedOrNull,
  timeline: trimmedOrNull,
});

export async function createDecisionAction(formData: FormData): Promise<void> {
  const creator = await requireAdmin();
  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    problem: formData.get("problem"),
    recommendation: formData.get("recommendation"),
    business_impact: formData.get("business_impact"),
    revenue_impact: formData.get("revenue_impact"),
    demand: formData.get("demand"),
    engineering_cost: formData.get("engineering_cost"),
    risk: formData.get("risk"),
    timeline: formData.get("timeline"),
  });
  if (!parsed.success) backTo({ error: "A title is required." });

  const d = parsed.data;
  const res = await createDecision({
    creator,
    title: d.title,
    problem: d.problem,
    recommendation: d.recommendation,
    businessImpact: d.business_impact,
    revenueImpact: d.revenue_impact,
    demand: d.demand,
    engineeringCost: d.engineering_cost,
    risk: d.risk,
    timeline: d.timeline,
  });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "created" });
}

const decideSchema = z.object({
  id: z.string().uuid(),
  outcome: z.enum(["approve", "reject", "delay", "delegate"]),
  reason: z.string().trim().max(2000).optional(),
  delay_until: z.string().trim().max(20).optional(),
  delegate_to: z.string().trim().max(200).optional(),
});

export async function decideAction(formData: FormData): Promise<void> {
  const decider = await requireAdmin();
  const parsed = decideSchema.safeParse({
    id: formData.get("id"),
    outcome: formData.get("outcome"),
    reason: formData.get("reason") ?? undefined,
    delay_until: formData.get("delay_until") ?? undefined,
    delegate_to: formData.get("delegate_to") ?? undefined,
  });
  if (!parsed.success) backTo({ error: "Invalid decision input." });

  const { id, outcome, reason, delay_until, delegate_to } = parsed.data;
  const detailPath = `/admin/decisions/${id}`;

  // Delegate accepts a delegate user id (uuid). Validate it here so a malformed
  // value fails loudly rather than at the DB FK.
  let delegateTo: string | null = delegate_to ?? null;
  if (outcome === "delegate") {
    const asUuid = z.string().uuid().safeParse(delegate_to);
    if (!asUuid.success) backTo({ error: "A valid delegate user id is required." }, detailPath);
    delegateTo = asUuid.data;
  }

  const res = await decide({
    id,
    decider,
    outcome: outcome as DecisionOutcome,
    reason,
    delayUntil: delay_until ?? null,
    delegateTo,
  });
  if (!res.ok) backTo({ error: describeError(res.error) }, detailPath);
  backTo({ saved: OUTCOME_SAVED[outcome] }, detailPath);
}

const OUTCOME_SAVED: Record<DecisionOutcome, string> = {
  approve: "approved",
  reject: "rejected",
  delay: "delayed",
  delegate: "delegated",
};

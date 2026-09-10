"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import {
  abandonSaga,
  advanceStep,
  createSaga,
  type Actor,
} from "@/server/services/hq-workflow";

/**
 * HQ Workflow-Saga — server actions.
 *
 * THIN WRAPPERS, deliberately. The Workflow-Saga service
 * (server/services/hq-workflow.ts) is the ONE authority: it owns the super-admin gate
 * (isSuperAdminEmail inside actorGate), the deterministic decomposition, the
 * Task-Engine dispatch and the audit writes. These actions parse the form, name the
 * actor, call the service, and translate the result into a redirect. There is no
 * direct hq_workflow_sagas / hq_ai_tasks access here, ever.
 *
 * Gating: every action re-checks isSuperAdminEmail before calling the service (which
 * checks again). The /admin/* layout already 404s non-allowlisted users — the same
 * defence-in-depth the Decision Centre carries.
 */

async function requireAdmin(): Promise<Actor & { email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

function backTo(params: Record<string, string>, path = "/admin/workflow-sagas"): never {
  const sp = new URLSearchParams(params);
  revalidatePath(path);
  redirect(`${path}?${sp.toString()}`);
}

/**
 * Each AI-decomposition failure stage gets its OWN operator message
 * (2026-09-10 incident: one blended message made a broken internal-org
 * attribution indistinguishable from a dark model). Messages are stage-level
 * only — no provider errors, no prompt text, no secrets.
 */
function describeAiDecompositionFailure(reason: string): string {
  const base = "No saga was created. ";
  switch (reason) {
    case "model_dark":
      return base + "AI decomposition is not activated in this deployment (the high inference tier has no model binding or credential). Use a deterministic template, or ask an engineer to check /admin/ai-costs.";
    case "attribution_missing":
      return base + "HQ AI spend has nowhere to be billed: the internal budget organisation is not configured (CREWFLOW_INTERNAL_ORG_ID). An engineer must fix the deployment configuration — retrying will not help.";
    case "budget_refused":
      return base + "The AI budget refused the claim — the monthly ceiling is reached, or the budget store refused (an outage, or the configured internal budget organisation does not exist). Check /admin/ai-costs; if budget remains, this is a configuration issue, not spend.";
    case "duplicate_suppressed":
      return base + "An identical directive was decomposed very recently, so the duplicate was suppressed to avoid double spend. Change the title slightly, or wait a few minutes.";
    case "provider_failure":
      return base + "The model provider call failed (network or provider error). Nothing was charged beyond the failed attempt's floor. Safe to retry.";
    case "provider_invalid_response":
      return base + "The model returned an unusable response. Safe to retry; if it persists, report it as an engineering issue.";
    case "parse_failure":
      return base + "The model's response was not valid JSON and was refused. Safe to retry; if it persists, report it as an engineering issue.";
    case "plan_validation_failure":
      return base + "The model proposed a step graph that failed validation and was refused — an invalid plan is never persisted. Retry, or use a deterministic template.";
    default:
      return base + "AI decomposition is unavailable right now. Pick a deterministic template, or retry later.";
  }
}

function describeError(error: string): string {
  if (error.startsWith("ai_decomposition_unavailable")) {
    const reason = error.includes(":") ? error.slice(error.indexOf(":") + 1) : "";
    return describeAiDecompositionFailure(reason);
  }
  switch (error) {
    case "forbidden":
      return "You are not a permitted operator.";
    case "title_required":
      return "A title is required.";
    case "unknown_template":
      return "Pick a valid decomposition template.";
    case "not_found":
      return "Saga not found.";
    case "step_not_found":
      return "Step not found.";
    case "not_ready":
      return "This step's dependency has not completed yet.";
    case "saga_terminal":
      return "This saga is already finished or abandoned.";
    default:
      return error.startsWith("invalid_graph")
        ? "The decomposition produced an invalid graph."
        : "Couldn't apply the change — try again.";
  }
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  template_key: z.string().trim().min(1).max(100),
});

export async function createSagaAction(formData: FormData): Promise<void> {
  const creator = await requireAdmin();
  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    template_key: formData.get("template_key"),
  });
  if (!parsed.success) backTo({ error: "A title and a template are required." });

  const res = await createSaga({
    creator,
    title: parsed.data.title,
    templateKey: parsed.data.template_key,
  });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: "created" }, `/admin/workflow-sagas/${res.saga.saga.id}`);
}

const advanceSchema = z.object({
  saga_id: z.string().uuid(),
  step_id: z.string().uuid(),
});

export async function advanceStepAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const parsed = advanceSchema.safeParse({
    saga_id: formData.get("saga_id"),
    step_id: formData.get("step_id"),
  });
  if (!parsed.success) backTo({ error: "Invalid step reference." });

  const detailPath = `/admin/workflow-sagas/${parsed.data.saga_id}`;
  const res = await advanceStep({
    actor,
    sagaId: parsed.data.saga_id,
    stepId: parsed.data.step_id,
  });
  if (!res.ok) backTo({ error: describeError(res.error) }, detailPath);
  backTo({ saved: "advanced" }, detailPath);
}

const abandonSchema = z.object({ saga_id: z.string().uuid() });

export async function abandonSagaAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const parsed = abandonSchema.safeParse({ saga_id: formData.get("saga_id") });
  if (!parsed.success) backTo({ error: "Invalid saga reference." });

  const detailPath = `/admin/workflow-sagas/${parsed.data.saga_id}`;
  const res = await abandonSaga({ actor, sagaId: parsed.data.saga_id });
  if (!res.ok) backTo({ error: describeError(res.error) }, detailPath);
  backTo({ saved: "abandoned" }, detailPath);
}

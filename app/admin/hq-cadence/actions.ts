"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { setCadenceEnabled, type CadenceActor } from "@/server/services/hq-cadence";

/**
 * HQ cadence clock — server actions.
 *
 * THIN WRAPPERS. The cadence service (server/services/hq-cadence.ts) is the ONE
 * authority: it owns the super-admin gate (isSuperAdminEmail), the deterministic
 * next_run_at computation and the audit write. These actions parse the form, name
 * the actor, call the service, and translate the result into a redirect. There is
 * no direct hq_ai_schedules access here.
 *
 * Gating: the action re-checks isSuperAdminEmail before calling the service (which
 * checks again); the /admin/* layout already 404s non-allowlisted users — the same
 * defence-in-depth the Workflow-Saga board carries.
 */

const PATH = "/admin/hq-cadence";

async function requireAdmin(): Promise<CadenceActor> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

function backTo(params: Record<string, string>): never {
  const sp = new URLSearchParams(params);
  revalidatePath(PATH);
  redirect(`${PATH}?${sp.toString()}`);
}

function describeError(error: string): string {
  switch (error) {
    case "forbidden":
      return "You are not a permitted operator.";
    case "unknown_cadence":
      return "That cadence is not in the catalogue.";
    case "invalid_cron":
      return "The cadence's cron expression is invalid.";
    case "not_found":
      return "Cadence not found in the registry.";
    default:
      return "Couldn't apply the change — try again.";
  }
}

const schema = z.object({
  cadence_key: z.string().trim().min(1).max(100),
  enabled: z.enum(["true", "false"]),
});

export async function setCadenceEnabledAction(formData: FormData): Promise<void> {
  const actor = await requireAdmin();
  const parsed = schema.safeParse({
    cadence_key: formData.get("cadence_key"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.success) backTo({ error: "Invalid cadence toggle." });

  const enabled = parsed.data.enabled === "true";
  const res = await setCadenceEnabled({
    actor,
    cadenceKey: parsed.data.cadence_key,
    enabled,
  });
  if (!res.ok) backTo({ error: describeError(res.error) });
  backTo({ saved: enabled ? "enabled" : "paused" });
}

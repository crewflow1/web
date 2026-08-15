"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { setAutomationRuleEnabled } from "@/server/services/automation-rules";
import {
  createSchedule,
  deleteSchedule,
  setScheduleEnabled,
} from "@/server/services/automation-schedules";
import {
  createCustomRule,
  updateCustomRule,
  setCustomRuleEnabled,
  deleteCustomRule,
  decideApproval,
  type AutomationCustomRuleClient,
} from "@/server/services/automation-custom-rules";
import { isValidCron } from "@/lib/automation/cron";

/**
 * Settings → Automations — per-org rule overrides + schedules (20261096).
 *
 * AUTHORISATION IS DOUBLED, exactly like Settings → Budgets. The role check here
 * produces a redirect for the operator; the DB policies (`is_org_admin` on
 * automation_rules / automation_schedules insert/update/delete) are the REAL
 * boundary, and the tenant client below carries the user's JWT so those policies
 * apply. Every write PINS `org_id`.
 *
 * Route depth is 2 (`/settings/automations`), so a plain server-action
 * `redirect()` is safe — this is NOT the deep-swap (≥4 segments) navigation trap.
 */

function isManager(role: string): boolean {
  return role === "owner" || role === "admin";
}

const toggleRuleSchema = z.object({
  rule_key: z.string().min(1),
  enabled: z.enum(["true", "false"]),
});

const createScheduleSchema = z.object({
  rule_key: z.string().min(1),
  cron_expr: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine(isValidCron, "Enter a valid 5-field cron expression"),
});

const scheduleIdSchema = z.object({ schedule_id: z.string().uuid() });
const toggleScheduleSchema = z.object({
  schedule_id: z.string().uuid(),
  enabled: z.enum(["true", "false"]),
});

export async function toggleAutomationRule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = toggleRuleSchema.safeParse({
    rule_key: formData.get("rule_key") ?? "",
    enabled: formData.get("enabled") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=validation");
  }

  const enabled = parsed.data.enabled === "true";
  const supabase = await createClient();
  try {
    await setAutomationRuleEnabled(
      supabase as unknown as { from: (t: string) => never },
      ctx.org.id,
      parsed.data.rule_key,
      enabled,
      user.id,
    );
  } catch (e) {
    console.error("[settings/automations] rule toggle failed", e);
    redirect("/settings/automations?error=save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_rule.toggled",
    targetTable: "automation_rules",
    targetId: parsed.data.rule_key,
    metadata: { rule_key: parsed.data.rule_key, enabled },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=rule");
}

export async function createAutomationSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = createScheduleSchema.safeParse({
    rule_key: formData.get("rule_key") ?? "",
    cron_expr: formData.get("cron_expr") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=schedule_validation");
  }

  const supabase = await createClient();
  try {
    await createSchedule(
      supabase as unknown as { from: (t: string) => never },
      ctx.org.id,
      parsed.data.rule_key,
      parsed.data.cron_expr,
      user.id,
    );
  } catch (e) {
    console.error("[settings/automations] schedule create failed", e);
    redirect("/settings/automations?error=schedule_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_schedule.created",
    targetTable: "automation_schedules",
    targetId: parsed.data.rule_key,
    metadata: { rule_key: parsed.data.rule_key, cron_expr: parsed.data.cron_expr },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=schedule");
}

export async function toggleAutomationSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = toggleScheduleSchema.safeParse({
    schedule_id: formData.get("schedule_id") ?? "",
    enabled: formData.get("enabled") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=validation");
  }

  const enabled = parsed.data.enabled === "true";
  const supabase = await createClient();
  try {
    await setScheduleEnabled(
      supabase as unknown as { from: (t: string) => never },
      ctx.org.id,
      parsed.data.schedule_id,
      enabled,
    );
  } catch (e) {
    console.error("[settings/automations] schedule toggle failed", e);
    redirect("/settings/automations?error=save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_schedule.toggled",
    targetTable: "automation_schedules",
    targetId: parsed.data.schedule_id,
    metadata: { enabled },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=schedule");
}

export async function removeAutomationSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = scheduleIdSchema.safeParse({
    schedule_id: formData.get("schedule_id") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=validation");
  }

  const supabase = await createClient();
  try {
    await deleteSchedule(
      supabase as unknown as { from: (t: string) => never },
      ctx.org.id,
      parsed.data.schedule_id,
    );
  } catch (e) {
    console.error("[settings/automations] schedule delete failed", e);
    redirect("/settings/automations?error=delete_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_schedule.deleted",
    targetTable: "automation_schedules",
    targetId: parsed.data.schedule_id,
    metadata: {},
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=schedule_deleted");
}

// ── Custom rules (the no-code builder) ────────────────────────────────────────
//
// Same doubled authorisation as the toggles above: the role check redirects the
// operator; the automation_custom_rules / automation_approvals admin-write RLS
// policies are the REAL boundary, and the tenant client carries the user's JWT so
// those policies apply. The DEFINITION is validated in the service via
// validateCustomRuleDefinition — the injection chokepoint — before any persist.
// Route depth is 2, so a plain redirect() is safe (not the deep-swap ≥4 trap).

const createCustomRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(""),
  definition: z.string().min(1).max(20_000),
});
const editCustomRuleSchema = createCustomRuleSchema.extend({
  rule_id: z.string().uuid(),
});
const ruleIdSchema = z.object({ rule_id: z.string().uuid() });
const toggleCustomRuleSchema = z.object({
  rule_id: z.string().uuid(),
  enabled: z.enum(["true", "false"]),
});
const decideApprovalSchema = z.object({
  approval_id: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional().default(""),
});

/** Parse the builder's JSON payload safely — a malformed string is a validation
 *  error, never an exception that 500s the action. */
function parseDefinitionJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function customClient(supabase: unknown): AutomationCustomRuleClient {
  return supabase as unknown as AutomationCustomRuleClient;
}

export async function createCustomRuleAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = createCustomRuleSchema.safeParse({
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? "",
    definition: formData.get("definition") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=custom_validation");
  }
  const definition = parseDefinitionJson(parsed.data.definition);
  if (definition === null) {
    redirect("/settings/automations?error=custom_validation");
  }

  const supabase = await createClient();
  let newId = "";
  try {
    newId = await createCustomRule(
      customClient(supabase),
      ctx.org.id,
      {
        name: parsed.data.name,
        description: parsed.data.description || null,
        definition,
      },
      user.id,
    );
  } catch (e) {
    console.error("[settings/automations] custom rule create failed", e);
    redirect("/settings/automations?error=custom_save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_custom_rule.created",
    targetTable: "automation_custom_rules",
    targetId: newId,
    metadata: { name: parsed.data.name },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=custom_rule");
}

export async function updateCustomRuleAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = editCustomRuleSchema.safeParse({
    rule_id: formData.get("rule_id") ?? "",
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? "",
    definition: formData.get("definition") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=custom_validation");
  }
  const definition = parseDefinitionJson(parsed.data.definition);
  if (definition === null) {
    redirect("/settings/automations?error=custom_validation");
  }

  const supabase = await createClient();
  try {
    await updateCustomRule(
      customClient(supabase),
      ctx.org.id,
      parsed.data.rule_id,
      {
        name: parsed.data.name,
        description: parsed.data.description || null,
        definition,
      },
      user.id,
    );
  } catch (e) {
    console.error("[settings/automations] custom rule update failed", e);
    redirect("/settings/automations?error=custom_save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_custom_rule.updated",
    targetTable: "automation_custom_rules",
    targetId: parsed.data.rule_id,
    metadata: { name: parsed.data.name },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=custom_rule");
}

export async function toggleCustomRuleAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = toggleCustomRuleSchema.safeParse({
    rule_id: formData.get("rule_id") ?? "",
    enabled: formData.get("enabled") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=custom_validation");
  }
  const enabled = parsed.data.enabled === "true";
  const supabase = await createClient();
  try {
    await setCustomRuleEnabled(
      customClient(supabase),
      ctx.org.id,
      parsed.data.rule_id,
      enabled,
    );
  } catch (e) {
    console.error("[settings/automations] custom rule toggle failed", e);
    redirect("/settings/automations?error=custom_save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_custom_rule.toggled",
    targetTable: "automation_custom_rules",
    targetId: parsed.data.rule_id,
    metadata: { enabled },
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=custom_rule");
}

export async function deleteCustomRuleAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = ruleIdSchema.safeParse({ rule_id: formData.get("rule_id") ?? "" });
  if (!parsed.success) {
    redirect("/settings/automations?error=custom_validation");
  }
  const supabase = await createClient();
  try {
    await deleteCustomRule(customClient(supabase), ctx.org.id, parsed.data.rule_id);
  } catch (e) {
    console.error("[settings/automations] custom rule delete failed", e);
    redirect("/settings/automations?error=custom_save_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "automation_custom_rule.deleted",
    targetTable: "automation_custom_rules",
    targetId: parsed.data.rule_id,
    metadata: {},
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=custom_rule_deleted");
}

export async function decideApprovalAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) {
    redirect("/settings/automations?error=forbidden");
  }
  const parsed = decideApprovalSchema.safeParse({
    approval_id: formData.get("approval_id") ?? "",
    decision: formData.get("decision") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    redirect("/settings/automations?error=custom_validation");
  }
  const supabase = await createClient();
  try {
    await decideApproval(
      customClient(supabase),
      ctx.org.id,
      parsed.data.approval_id,
      user.id,
      parsed.data.decision,
      parsed.data.note || null,
    );
  } catch (e) {
    console.error("[settings/automations] approval decision failed", e);
    redirect("/settings/automations?error=approval_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: `automation_approval.${parsed.data.decision}`,
    targetTable: "automation_approvals",
    targetId: parsed.data.approval_id,
    metadata: {},
  });

  revalidatePath("/settings/automations");
  redirect("/settings/automations?saved=approval");
}

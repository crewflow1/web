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

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { cadenceToInterval, createScheduleSchema } from "@/lib/assets/inspection-schedule";

/**
 * Inspection schedule actions (M4b-2). Schedules are STANDING RULES that
 * generate work automatically, so writes are admin-only — enforced at RLS AND
 * here in the action (the dual-gate pattern). Generation itself is the cron
 * generator; these actions only manage the rules.
 */

type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
type InsertOne = {
  insert: (row: unknown) => {
    select: (c: string) => {
      single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  };
};
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function createInspectionSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const parsed = createScheduleSchema.safeParse({
    asset_id: assetId,
    template_id: formData.get("template_id"),
    cadence: formData.get("cadence"),
    custom_days: formData.get("custom_days"),
    next_due: formData.get("next_due"),
    lead_time_days: formData.get("lead_time_days"),
    required_for_assignment: formData.get("required_for_assignment") === "on",
  });
  if (!parsed.success) redirect(`/assets/${assetId}?error=schedule_invalid`);

  const interval = cadenceToInterval(parsed.data.cadence, parsed.data.custom_days);
  const tenant = await createClient();
  const { data, error } = await (
    tenant.from("asset_inspection_schedules" as never) as unknown as InsertOne
  )
    .insert({
      org_id: ctx.org.id,
      asset_id: assetId,
      template_id: parsed.data.template_id,
      interval_days: interval.interval_days,
      interval_months: interval.interval_months,
      next_due: parsed.data.next_due,
      lead_time_days: parsed.data.lead_time_days,
      required_for_assignment: parsed.data.required_for_assignment,
      active: true,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-schedule] create failed", error);
    redirect(`/assets/${assetId}?error=schedule_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_schedule_created",
    targetTable: "asset_inspection_schedules",
    targetId: data.id,
    metadata: { asset_id: assetId, template_id: parsed.data.template_id, next_due: parsed.data.next_due },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=schedule`);
}

export async function toggleInspectionSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  const nextActive = String(formData.get("next_active") ?? "") === "true";
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_inspection_schedules" as never) as unknown as UpdateChain
  )
    .update({ active: nextActive }, { count: "exact" })
    .eq("id", scheduleId)
    .eq("org_id", ctx.org.id);
  if (error || !count) {
    console.error("[asset-schedule] toggle failed", error);
    redirect(`/assets/${assetId}?error=schedule_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: nextActive ? "asset.inspection_schedule_resumed" : "asset.inspection_schedule_paused",
    targetTable: "asset_inspection_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=${nextActive ? "schedule_resumed" : "schedule_paused"}`);
}

export async function deleteInspectionSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const tenant = await createClient();
  // Generated inspections keep their history (schedule_id → null via FK).
  const { error, count } = await (
    tenant.from("asset_inspection_schedules" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", scheduleId)
    .eq("org_id", ctx.org.id);
  if (error || !count) {
    console.error("[asset-schedule] delete failed", error);
    redirect(`/assets/${assetId}?error=schedule_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_schedule_deleted",
    targetTable: "asset_inspection_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=schedule_deleted`);
}

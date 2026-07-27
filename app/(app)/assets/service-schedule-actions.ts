"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { z } from "zod";
import { SCHEDULE_CADENCES, cadenceToInterval } from "@/lib/assets/inspection-schedule";
import { MAINTENANCE_TYPES } from "@/lib/assets/maintenance";

const createServiceScheduleSchema = z
  .object({
    asset_id: z.string().uuid(),
    maintenance_type: z.enum(["preventive", "service", "calibration"] as const),
    title: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(160).optional()),
    cadence: z.enum(SCHEDULE_CADENCES),
    custom_days: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(1).max(3660).optional()),
    next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a due date"),
    lead_time_days: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(0).max(365).default(14)),
    supplier_id: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().uuid().optional()),
  })
  .superRefine((v, ctx) => {
    if (v.cadence === "custom_days" && v.custom_days == null) {
      ctx.addIssue({ code: "custom", message: "Give the interval in days", path: ["custom_days"] });
    }
  });
void MAINTENANCE_TYPES;

/**
 * SERVICE schedule actions (M5b) — the maintenance twin of the proven M4b-2
 * inspection-schedule actions. Standing rules ⇒ admin-only writes at RLS AND
 * here (dual gate); the cron generator owns generation.
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

export async function createServiceSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const parsed = createServiceScheduleSchema.safeParse({
    asset_id: assetId,
    maintenance_type: formData.get("maintenance_type"),
    title: formData.get("title"),
    cadence: formData.get("cadence"),
    custom_days: formData.get("custom_days"),
    next_due: formData.get("next_due"),
    lead_time_days: formData.get("lead_time_days"),
    supplier_id: formData.get("supplier_id"),
  });
  if (!parsed.success) redirect(`/assets/${assetId}?error=schedule_invalid`);

  const interval = cadenceToInterval(parsed.data.cadence, parsed.data.custom_days);
  const tenant = await createClient();
  const { data, error } = await (
    tenant.from("asset_service_schedules" as never) as unknown as InsertOne
  )
    .insert({
      org_id: ctx.org.id,
      asset_id: assetId,
      maintenance_type: parsed.data.maintenance_type,
      title: parsed.data.title ?? null,
      interval_days: interval.interval_days,
      interval_months: interval.interval_months,
      next_due: parsed.data.next_due,
      lead_time_days: parsed.data.lead_time_days,
      supplier_id: parsed.data.supplier_id ?? null,
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
    action: "asset.service_schedule_created",
    targetTable: "asset_service_schedules",
    targetId: data.id,
    metadata: { asset_id: assetId, maintenance_type: parsed.data.maintenance_type, next_due: parsed.data.next_due },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=schedule`);
}

export async function toggleServiceSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  const nextActive = String(formData.get("next_active") ?? "") === "true";
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_service_schedules" as never) as unknown as UpdateChain
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
    action: nextActive ? "asset.service_schedule_resumed" : "asset.service_schedule_paused",
    targetTable: "asset_service_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=${nextActive ? "schedule_resumed" : "schedule_paused"}`);
}

export async function deleteServiceSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const tenant = await createClient();
  // Generated inspections keep their history (schedule_id → null via FK).
  const { error, count } = await (
    tenant.from("asset_service_schedules" as never) as unknown as DeleteChain
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
    action: "asset.service_schedule_deleted",
    targetTable: "asset_service_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=schedule_deleted`);
}

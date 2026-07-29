"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { cadenceToInterval, createScheduleSchema } from "@/lib/assets/inspection-schedule";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Inspection schedule actions (M4b-2). Schedules are STANDING RULES that
 * generate work automatically, so writes are admin-only — enforced at RLS AND
 * here in the action (the dual-gate pattern). Generation itself is the cron
 * generator; these actions only manage the rules.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`:
 * a same-route ?saved= redirect back to /assets/[id] swaps the page segment
 * itself and loses the Next 15.5 stranded-commit race (upstream
 * vercel/next.js#83386) — the row is written but the URL never changes and no
 * error surfaces. See components/forms/StateForm.tsx. No revalidatePath,
 * deliberately: these surfaces render per-request (cookie-authed reads, no
 * Next data cache), so revalidating only added weight to the racy action
 * response.
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

export async function createInspectionSchedule(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

  const parsed = createScheduleSchema.safeParse({
    asset_id: assetId,
    template_id: formData.get("template_id"),
    cadence: formData.get("cadence"),
    custom_days: formData.get("custom_days"),
    next_due: formData.get("next_due"),
    lead_time_days: formData.get("lead_time_days"),
    required_for_assignment: formData.get("required_for_assignment") === "on",
  });
  if (!parsed.success) return formError("Please check the schedule details.");

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
    return formError("Couldn't save the schedule. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_schedule_created",
    targetTable: "asset_inspection_schedules",
    targetId: data.id,
    metadata: { asset_id: assetId, template_id: parsed.data.template_id, next_due: parsed.data.next_due },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=schedule` });
}

export async function toggleInspectionSchedule(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  const nextActive = String(formData.get("next_active") ?? "") === "true";
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_inspection_schedules" as never) as unknown as UpdateChain
  )
    .update({ active: nextActive }, { count: "exact" })
    .eq("id", scheduleId)
    .eq("org_id", ctx.org.id);
  if (error || !count) {
    console.error("[asset-schedule] toggle failed", error);
    return formError("Couldn't save the schedule. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: nextActive ? "asset.inspection_schedule_resumed" : "asset.inspection_schedule_paused",
    targetTable: "asset_inspection_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=${nextActive ? "schedule_resumed" : "schedule_paused"}` });
}

export async function deleteInspectionSchedule(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const scheduleId = String(formData.get("schedule_id") ?? "");
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

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
    return formError("Couldn't save the schedule. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.inspection_schedule_deleted",
    targetTable: "asset_inspection_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=schedule_deleted` });
}

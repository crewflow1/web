"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { FLEET_COMPLIANCE_TYPES, FLEET_COMPLIANCE_LABELS } from "@/lib/fleet/compliance";
import { vehicleIdSchema } from "@/lib/fleet/schema";

/**
 * Fleet compliance actions — MOT, insurance, road tax and service, carried on
 * the EXISTING `asset_service_schedules` + `asset_maintenance_cases` engines.
 * No new scheduler, no second completion record. See 20261057000000.
 *
 * ACTIVE-ORG PINNING: every write carries `ctx.org.id` — the schedule writes as
 * an explicit `.eq("org_id", ctx.org.id)` predicate, the completion as the
 * RPC's `p_org_id`, which every statement inside it is scoped by. RLS alone
 * would not do this: `is_org_admin(org_id)` passes for every org the caller
 * administers, not just the active one.
 */

type InsertChain = {
  insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};
type RpcChain = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const blankToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker — format must be YYYY-MM-DD");

const scheduleSchema = z
  .object({
    asset_id: z.string().uuid(),
    maintenance_type: z.enum(FLEET_COMPLIANCE_TYPES),
    next_due: isoDate,
    // Exactly one cadence, or neither for a one-off — mirrors
    // asset_service_schedules_interval_check.
    interval_months: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(120).optional(),
    ),
    interval_days: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(3660).optional(),
    ),
    lead_time_days: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(365).default(14),
    ),
    supplier_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  })
  .refine((d) => d.interval_days == null || d.interval_months == null, {
    message: "Pick a cadence in months OR days, not both.",
    path: ["interval_months"],
  });

const completionSchema = z.object({
  asset_id: z.string().uuid(),
  case_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  schedule_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  maintenance_type: z.enum(FLEET_COMPLIANCE_TYPES),
  completed_on: isoDate,
  next_due: z.preprocess(blankToUndefined, isoDate.optional()),
  odometer_miles: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(0).max(3_000_000).optional(),
  ),
  supplier_id: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  work_performed: z.string().trim().min(1, "Record what was done — it is the evidence.").max(4000),
});

function fs(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function firstError(e: z.ZodError): string {
  const fields = e.flatten().fieldErrors;
  return Object.values(fields).flat()[0] ?? e.flatten().formErrors[0] ?? "validation";
}

/**
 * Create a standing compliance obligation. Writes `asset_service_schedules`,
 * whose RLS is ADMIN-ONLY on write (20261003000000) — a member's insert returns
 * no error and zero rows, so this is count-gated and reports a refusal.
 */
export async function saveComplianceSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = scheduleSchema.safeParse({
    asset_id: fs(formData, "asset_id"),
    maintenance_type: fs(formData, "maintenance_type"),
    next_due: fs(formData, "next_due"),
    interval_months: fs(formData, "interval_months"),
    interval_days: fs(formData, "interval_days"),
    lead_time_days: fs(formData, "lead_time_days"),
    supplier_id: fs(formData, "supplier_id"),
  });
  const assetId = fs(formData, "asset_id");
  if (!parsed.success) {
    redirect(
      `/fleet/vehicles/${assetId}?error=${encodeURIComponent(firstError(parsed.error))}#compliance`,
    );
  }
  const d = parsed.data!;

  const tenant = await createClient();
  const { error } = await (
    tenant.from("asset_service_schedules" as never) as unknown as InsertChain
  ).insert({
    org_id: ctx.org.id,
    asset_id: d.asset_id,
    maintenance_type: d.maintenance_type,
    title: `${FLEET_COMPLIANCE_LABELS[d.maintenance_type]}`,
    next_due: d.next_due,
    interval_months: d.interval_months ?? null,
    interval_days: d.interval_days ?? null,
    lead_time_days: d.lead_time_days,
    supplier_id: d.supplier_id ?? null,
    active: true,
    created_by: user.id,
  });
  if (error) {
    console.error("[fleet] saveComplianceSchedule failed", error);
    const code = error.message.toLowerCase().includes("not in org")
      ? "cross_org_reference"
      : "schedule_failed";
    redirect(`/fleet/vehicles/${assetId}?error=${code}#compliance`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.compliance.scheduled",
    targetTable: "asset_service_schedules",
    targetId: d.asset_id,
    metadata: { maintenance_type: d.maintenance_type, next_due: d.next_due },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/compliance");
  revalidatePath(`/fleet/vehicles/${d.asset_id}`);
  redirect(`/fleet/vehicles/${d.asset_id}?saved=scheduled#compliance`);
}

/** Stop tracking an obligation. Deactivates rather than deletes — history stays. */
export async function deactivateComplianceSchedule(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const scheduleId = fs(formData, "schedule_id");
  const assetId = fs(formData, "asset_id");
  if (!vehicleIdSchema.safeParse(scheduleId).success) {
    redirect(`/fleet/vehicles/${assetId}?error=bad_id#compliance`);
  }

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_service_schedules" as never) as unknown as UpdateChain
  )
    .update({ active: false }, { count: "exact" })
    .eq("id", scheduleId)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[fleet] deactivateComplianceSchedule failed", error);
    redirect(`/fleet/vehicles/${assetId}?error=schedule_failed#compliance`);
  }
  if (!count) redirect(`/fleet/vehicles/${assetId}?error=forbidden#compliance`);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.compliance.deactivated",
    targetTable: "asset_service_schedules",
    targetId: scheduleId,
    metadata: { asset_id: assetId },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/compliance");
  revalidatePath(`/fleet/vehicles/${assetId}`);
  redirect(`/fleet/vehicles/${assetId}?saved=schedule_stopped#compliance`);
}

/**
 * Record that an obligation was met: completes the maintenance case AND rolls
 * the schedule forward, atomically (see the RPC header in 20261057000000 for
 * why a half-write here is dangerous rather than merely untidy).
 */
export async function recordComplianceCompletion(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = fs(formData, "asset_id");
  const parsed = completionSchema.safeParse({
    asset_id: assetId,
    case_id: fs(formData, "case_id"),
    schedule_id: fs(formData, "schedule_id"),
    maintenance_type: fs(formData, "maintenance_type"),
    completed_on: fs(formData, "completed_on"),
    next_due: fs(formData, "next_due"),
    odometer_miles: fs(formData, "odometer_miles"),
    supplier_id: fs(formData, "supplier_id"),
    work_performed: fs(formData, "work_performed"),
  });
  if (!parsed.success) {
    redirect(
      `/fleet/vehicles/${assetId}?error=${encodeURIComponent(firstError(parsed.error))}#compliance`,
    );
  }
  const d = parsed.data!;

  const tenant = await createClient();
  const { error } = await (tenant as unknown as RpcChain).rpc(
    "record_fleet_compliance_completion",
    {
      p_org_id: ctx.org.id,
      p_asset_id: d.asset_id,
      p_case_id: d.case_id ?? null,
      p_schedule_id: d.schedule_id ?? null,
      p_case_type: d.maintenance_type,
      p_title: `${FLEET_COMPLIANCE_LABELS[d.maintenance_type]} — ${d.completed_on}`,
      p_completed_on: d.completed_on,
      p_odometer_miles: d.odometer_miles ?? null,
      p_supplier_id: d.supplier_id ?? null,
      p_work_performed: d.work_performed,
      p_next_due: d.next_due ?? null,
      p_completed_by: user.id,
    },
  );
  if (error) {
    console.error("[fleet] recordComplianceCompletion failed", error);
    const m = error.message.toLowerCase();
    const code = m.includes("not found")
      ? "not_found"
      : m.includes("frozen")
        ? "case_frozen"
        : m.includes("not in org")
          ? "cross_org_reference"
          : "completion_failed";
    redirect(`/fleet/vehicles/${assetId}?error=${code}#compliance`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "fleet.compliance.completed",
    targetTable: "asset_maintenance_cases",
    targetId: d.asset_id,
    metadata: {
      maintenance_type: d.maintenance_type,
      completed_on: d.completed_on,
      next_due: d.next_due ?? null,
    },
  });

  revalidatePath("/fleet");
  revalidatePath("/fleet/compliance");
  revalidatePath(`/fleet/vehicles/${d.asset_id}`);
  redirect(`/fleet/vehicles/${d.asset_id}?saved=completed#compliance`);
}

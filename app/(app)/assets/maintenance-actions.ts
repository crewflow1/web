"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { emitNotifications } from "@/server/services/notifications-service";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  assertCaseTransition,
  caseCostsSchema,
  friendlyMaintenanceError,
  reportCaseSchema,
  type MaintenanceStatus,
} from "@/lib/assets/maintenance";

/**
 * Maintenance-case actions (M5a). One shared flow for every entry point
 * (breakdown report, failed inspection, planned work). The pure module owns
 * transition legality; the DB guard (20261002) owns the invariants; costs are
 * admin-only at RLS AND here (dual gate). Every change is audited; transitions
 * are count-gated on the from-status so stale forms no-op.
 */

type InsertOne = {
  insert: (row: unknown) => {
    select: (c: string) => {
      single: () => Promise<{
        data: { id: string } | null;
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};
type LoadOne = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => { maybeSingle: () => Promise<{ data: CaseRow | null; error: SupabaseReadError | null }> };
    };
  };
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ error: { message: string; code?: string } | null; count: number | null }>;
      };
    };
  };
};
type UpsertOne = {
  upsert: (row: unknown, opts: { onConflict: string }) => Promise<{ error: { message: string; code?: string } | null }>;
};

type CaseRow = {
  id: string;
  asset_id: string;
  status: MaintenanceStatus;
  title: string;
  reinspection_required: boolean;
  work_performed: string | null;
  out_of_service: boolean;
  downtime_start: string | null;
  schedule_id: string | null;
  source_inspection_id: string | null;
};

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function loadCase(orgId: string, id: string): Promise<CaseRow | null> {
  const tenant = await createClient();
  const { data, error } = await (tenant.from("asset_maintenance_cases" as never) as unknown as LoadOne)
    .select("id, asset_id, status, title, reinspection_required, work_performed, out_of_service, downtime_start, schedule_id, source_inspection_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  // Loud fail: every caller treats null as "?error=case_missing" — a query
  // failure must not wear that banner.
  if (error) throw readFailure("maintenance: load case", error);
  return data;
}

export async function reportMaintenanceCase(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = reportCaseSchema.safeParse({
    asset_id: formData.get("asset_id"),
    case_type: formData.get("case_type"),
    priority: formData.get("priority"),
    title: formData.get("title"),
    description: formData.get("description"),
    source_inspection_id: formData.get("source_inspection_id"),
    supplier_id: formData.get("supplier_id"),
    out_of_service: formData.get("out_of_service") === "on",
    reinspection_required: formData.get("reinspection_required") === "on",
  });
  if (!parsed.success) {
    redirect(`/assets/${String(formData.get("asset_id") ?? "")}?error=case_invalid`);
  }
  const input = parsed.data;

  const tenant = await createClient();
  const { data, error } = await (
    tenant.from("asset_maintenance_cases" as never) as unknown as InsertOne
  )
    .insert({
      org_id: ctx.org.id,
      asset_id: input.asset_id,
      case_type: input.case_type,
      priority: input.priority,
      status: "reported",
      title: input.title,
      description: input.description ?? null,
      source_inspection_id: input.source_inspection_id ?? null,
      supplier_id: input.supplier_id ?? null,
      out_of_service: input.out_of_service,
      downtime_start: input.out_of_service ? new Date().toISOString() : null,
      // A case born from a failed safety inspection requires re-inspection.
      reinspection_required: input.reinspection_required || !!input.source_inspection_id,
      reported_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-maintenance] report failed", error);
    redirect(
      `/assets/${input.asset_id}?error=${encodeURIComponent(friendlyMaintenanceError(error?.code, error?.message))}`,
    );
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.maintenance_case_reported",
    targetTable: "asset_maintenance_cases",
    targetId: data.id,
    metadata: { asset_id: input.asset_id, case_type: input.case_type, out_of_service: input.out_of_service },
  });
  // Exactly-once by construction: one emission per successful insert.
  await emitNotifications([
    {
      org_id: ctx.org.id,
      user_id: null,
      audience: "customer",
      type: "maintenance.reported",
      category: "system",
      priority: input.priority === "high" ? "high" : "medium",
      title: `Maintenance reported — ${input.title}`,
      body: input.out_of_service ? "The asset is marked out of service." : null,
      action_url: `/assets/${input.asset_id}`,
      source_module: "assets",
      source_id: data.id,
      metadata: { asset_id: input.asset_id, case_type: input.case_type },
    },
  ]).catch((e) => console.error("[asset-maintenance] notify failed", e));

  revalidatePath(`/assets/${input.asset_id}`);
  redirect(`/assets/${input.asset_id}?saved=case_reported`);
}

export async function transitionMaintenanceCase(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const caseId = String(formData.get("case_id") ?? "");
  const to = String(formData.get("to") ?? "") as MaintenanceStatus;
  const workPerformed = String(formData.get("work_performed") ?? "").trim();
  const cancellationReason = String(formData.get("cancellation_reason") ?? "").trim();

  const row = await loadCase(ctx.org.id, caseId);
  if (!row) redirect(`/assets?error=case_missing`);
  const assetUrl = `/assets/${row.asset_id}`;

  const evidence = workPerformed || row.work_performed || "";
  try {
    assertCaseTransition(row.status, to, {
      reinspectionRequired: row.reinspection_required,
      workEvidencePresent: evidence.trim().length > 0,
    });
  } catch {
    redirect(`${assetUrl}?error=case_transition`);
  }

  const patch: Record<string, unknown> = { status: to };
  if (workPerformed) patch.work_performed = workPerformed;
  if (to === "completed") {
    patch.completed_at = new Date().toISOString();
    patch.completed_by = user.id;
    patch.out_of_service = false;
    if (row.out_of_service && row.downtime_start) patch.downtime_end = new Date().toISOString();
  }
  if (to === "cancelled") {
    patch.cancelled_at = new Date().toISOString();
    patch.cancelled_by = user.id;
    patch.cancellation_reason = cancellationReason || null;
  }
  if (to === "reported") {
    // Explicit reopen: prior cancellation stamps stay in the audit log.
    patch.cancelled_at = null;
    patch.cancelled_by = null;
    patch.cancellation_reason = null;
  }

  const tenant = await createClient();
  // Count-gated on the from-status: a stale form no-ops instead of clobbering.
  const { error, count } = await (
    tenant.from("asset_maintenance_cases" as never) as unknown as UpdateChain
  )
    .update(patch, { count: "exact" })
    .eq("id", caseId)
    .eq("org_id", ctx.org.id)
    .eq("status", row.status);
  if (error) {
    console.error("[asset-maintenance] transition failed", error);
    redirect(
      `${assetUrl}?error=${encodeURIComponent(friendlyMaintenanceError(error.code, error.message))}`,
    );
  }
  if (!count) redirect(`${assetUrl}?error=case_stale`);

  // M5c: completing a schedule-generated case writes the service history back
  // (informational — cycle advancement happened at generation).
  if (to === "completed" && row.schedule_id) {
    const { error: writebackError } = await (
      tenant.from("asset_service_schedules" as never) as unknown as {
        update: (p: unknown) => {
          eq: (k: string, v: unknown) => {
            eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
          };
        };
      }
    )
      .update({ last_completed_at: new Date().toISOString() })
      .eq("id", row.schedule_id)
      .eq("org_id", ctx.org.id);
    if (writebackError) console.error("[asset-maintenance] schedule writeback failed", writebackError);
  }

  // M5c: raise attention exactly-once (transition is count-gated) when the case
  // reaches the return-to-service gate.
  if (to === "ready_for_return_to_service") {
    await emitNotifications([
      {
        org_id: ctx.org.id,
        user_id: null,
        audience: "customer",
        type: "maintenance.ready_for_return",
        category: "system",
        priority: "medium",
        title: `Ready to return to service — ${row.title}`,
        body: "Repair work and any required re-inspection are done. Authorise the return from the asset's maintenance section.",
        action_url: `/assets/${row.asset_id}`,
        source_module: "assets",
        source_id: caseId,
        metadata: { asset_id: row.asset_id },
      },
    ]).catch((e) => console.error("[asset-maintenance] notify failed", e));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action:
      to === "completed"
        ? "asset.maintenance_case_completed"
        : to === "cancelled"
          ? "asset.maintenance_case_cancelled"
          : to === "reported" && row.status === "cancelled"
            ? "asset.maintenance_case_reopened"
            : "asset.maintenance_case_transitioned",
    targetTable: "asset_maintenance_cases",
    targetId: caseId,
    metadata: { asset_id: row.asset_id, from: row.status, to },
  });

  revalidatePath(assetUrl);
  redirect(`${assetUrl}?saved=case_updated`);
}

export async function upsertCaseCosts(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  // Costs are commercially sensitive: admin-only in the ACTION and at RLS.
  if (!isAdmin(ctx.membership.role)) redirect(`/assets/${assetId}?error=forbidden`);

  const parsed = caseCostsSchema.safeParse({
    case_id: formData.get("case_id"),
    cost_parts: formData.get("cost_parts") || 0,
    cost_labour: formData.get("cost_labour") || 0,
    cost_external: formData.get("cost_external") || 0,
    cost_notes: formData.get("cost_notes"),
  });
  if (!parsed.success) redirect(`/assets/${assetId}?error=case_invalid`);

  const tenant = await createClient();
  const { error } = await (
    tenant.from("asset_maintenance_case_costs" as never) as unknown as UpsertOne
  ).upsert(
    {
      case_id: parsed.data.case_id,
      org_id: ctx.org.id,
      cost_parts: parsed.data.cost_parts,
      cost_labour: parsed.data.cost_labour,
      cost_external: parsed.data.cost_external,
      cost_notes: parsed.data.cost_notes ?? null,
      updated_by: user.id,
    },
    { onConflict: "case_id" },
  );
  if (error) {
    console.error("[asset-maintenance] costs failed", error);
    redirect(`/assets/${assetId}?error=case_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.maintenance_costs_updated",
    targetTable: "asset_maintenance_case_costs",
    targetId: parsed.data.case_id,
    metadata: { asset_id: assetId },
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(`/assets/${assetId}?saved=case_costs`);
}

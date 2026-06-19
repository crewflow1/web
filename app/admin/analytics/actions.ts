"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireHq } from "@/server/auth/hq";
import { recomputeAllOrgs } from "@/server/services/hq-health-recompute";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Analytics (HQ-6) — server actions.
 *
 * Operator-driven actions that complement the nightly cron:
 *   - recomputeHealthNow: manual trigger when the operator wants
 *     fresh scores without waiting for midnight.
 *
 * Every action re-checks isSuperAdminEmail + writes the summary to
 * admin_activity_log so the audit trail records who ran it.
 */

export async function recomputeHealthNow(): Promise<void> {
  const admin = await requireHq();
  const summary = await recomputeAllOrgs("manual", admin);

  // One audit row for the operator-triggered batch run, separate
  // from the per-org rows the engine writes when scores change.
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "health.batch_recomputed",
    targetTable: "health_score_events",
    targetId: "batch",
    metadata: {
      trigger: summary.trigger,
      processed: summary.processed,
      changed: summary.changed,
      errors: summary.errors,
      duration_ms: summary.durationMs,
    },
  });

  revalidatePath("/admin/analytics");
  redirect(
    `/admin/analytics?saved=1&processed=${summary.processed}&changed=${summary.changed}`,
  );
}

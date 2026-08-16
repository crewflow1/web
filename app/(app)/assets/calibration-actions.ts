"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  recordCalibrationSchema,
  friendlyCalibrationError,
} from "@/lib/assets/calibration";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Calibration certificate register actions (P3W2). RECORDS a certificate issued
 * by an external lab (never issues one — see lib/assets/calibration.ts). Member
 * CRUD, admin delete (the maintenance-cases posture: calibration is org record).
 *
 * When a certificate carries a next-due date AND is linked to a calibration
 * schedule, the DB AFTER trigger (20261145000001) rolls that schedule forward,
 * so the next expiry surfaces through the EXISTING maintenance-due generator,
 * notifications and fleet-compliance surfaces — no parallel nudge engine.
 *
 * Returns `FormState` + navigates via `redirectTo` through <StateForm>, never
 * `redirect()` (the Next 15.5 stranded-commit race on same-route redirects).
 */

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

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
type DeleteChain = {
  delete: (opts?: { count?: string }) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null; count: number | null }>;
    };
  };
};

export async function recordCalibrationCertificate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");

  const parsed = recordCalibrationSchema.safeParse({
    asset_id: assetId,
    schedule_id: formData.get("schedule_id"),
    certificate_number: formData.get("certificate_number"),
    calibrated_by: formData.get("calibrated_by"),
    calibration_date: formData.get("calibration_date"),
    next_due_date: formData.get("next_due_date"),
    result: formData.get("result"),
    standard: formData.get("standard"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Please check the certificate details.");
  }
  const c = parsed.data;

  const tenant = await createClient();
  // org_id is always the ACTIVE org; the composite FKs + guard trigger enforce
  // that the asset and any linked schedule are same-org (and the schedule is a
  // calibration schedule for THIS asset).
  const { data, error } = await (
    tenant.from("asset_calibration_certificates" as never) as unknown as InsertOne
  )
    .insert({
      org_id: ctx.org.id,
      asset_id: assetId,
      schedule_id: c.schedule_id ?? null,
      certificate_number: c.certificate_number,
      calibrated_by: c.calibrated_by,
      calibration_date: c.calibration_date,
      next_due_date: c.next_due_date ?? null,
      result: c.result,
      standard: c.standard ?? null,
      notes: c.notes ?? null,
      recorded_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-calibration] record failed", error);
    return formError(friendlyCalibrationError(error?.code, error?.message));
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.calibration_certificate_recorded",
    targetTable: "asset_calibration_certificates",
    targetId: data.id,
    metadata: {
      asset_id: assetId,
      certificate_number: c.certificate_number,
      next_due_date: c.next_due_date ?? null,
      schedule_id: c.schedule_id ?? null,
    },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=calibration` });
}

export async function deleteCalibrationCertificate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const assetId = String(formData.get("asset_id") ?? "");
  const certId = String(formData.get("cert_id") ?? "");
  if (!isAdmin(ctx.membership.role)) return formError("Only an owner or admin can do that.");

  const tenant = await createClient();
  const { error, count } = await (
    tenant.from("asset_calibration_certificates" as never) as unknown as DeleteChain
  )
    .delete({ count: "exact" })
    .eq("id", certId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[asset-calibration] delete failed", error);
    return formError("Couldn't delete the certificate. Try again.");
  }
  if (!count) return formError("That certificate could not be found.");

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "asset.calibration_certificate_deleted",
    targetTable: "asset_calibration_certificates",
    targetId: certId,
    metadata: { asset_id: assetId },
  });
  return formSuccess({ redirectTo: `/assets/${assetId}?saved=calibration_deleted` });
}

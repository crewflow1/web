"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  flagForReverification,
  recordVerification,
  upsertCisProfile,
} from "@/server/services/cis";
import {
  cisProfileSchema,
  cisReverificationSchema,
  cisVerificationSchema,
} from "@/lib/cis/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * CIS M1 server actions — subcontractor identity + manual HMRC verification.
 *
 * OWNER/ADMIN ONLY. A server action is a POST endpoint, so a non-admin member
 * can replay it regardless of what the UI shows — the role is therefore
 * re-checked here. That check exists to produce a good message; the REAL
 * boundary is the admin-only RLS on `cis_subcontractors`, which refuses a
 * direct PostgREST caller identically.
 *
 * NO HMRC INTEGRATION EXISTS. `recordVerification` stores an outcome an admin
 * obtained from HMRC themselves. Nothing here calls HMRC, and nothing simulates
 * a call — see the provider seam in lib/cis/verification.ts.
 */

const isManager = (role: string): boolean => role === "owner" || role === "admin";

const idSchema = z.string().uuid();

type Values = Record<string, unknown>;

const FORBIDDEN = "Only an owner or admin can manage CIS details.";

function revalidate(supplierId: string): void {
  revalidatePath(`/suppliers/${supplierId}/cis`);
  revalidatePath(`/suppliers/${supplierId}`);
}

// ---------------------------------------------------------------------------
// Identity — create or update the profile
// ---------------------------------------------------------------------------

export async function saveCisProfile(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  const parsed = validateFormData(formData, cisProfileSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await upsertCisProfile(ctx.org.id, supplierId, parsed.data, user.id);
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.profile.saved",
    targetTable: "cis_subcontractors",
    targetId: supplierId,
    // Identifiers are NEVER written to the audit metadata — only whether one is held.
    metadata: { legal_name: parsed.data.legal_name, has_utr: Boolean(parsed.data.utr) },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({ successMessage: "CIS details saved." });
}

// ---------------------------------------------------------------------------
// Verification — record a manual HMRC outcome
// ---------------------------------------------------------------------------

export async function saveCisVerification(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  const parsed = validateFormData(formData, cisVerificationSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await recordVerification(ctx.org.id, supplierId, parsed.data, user.id);
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.verification.recorded",
    targetTable: "cis_subcontractors",
    targetId: supplierId,
    metadata: {
      cis_status: result.data.cis_status,
      deduction_rate: result.data.deduction_rate,
      source: "manual",
    },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage: `Verification recorded — ${result.data.deduction_rate}% deduction.`,
  });
}

// ---------------------------------------------------------------------------
// Re-verification flag
// ---------------------------------------------------------------------------

export async function requestCisReverification(
  supplierId: string,
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  const parsed = validateFormData(formData, cisReverificationSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await flagForReverification(
    ctx.org.id,
    supplierId,
    user.id,
    parsed.data.reason ?? null,
  );
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.reverification.requested",
    targetTable: "cis_subcontractors",
    targetId: supplierId,
    metadata: {},
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage: "Flagged for re-verification. No deduction rate applies until HMRC confirms one.",
  });
}

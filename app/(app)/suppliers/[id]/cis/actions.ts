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
import { isHmrcConnectable } from "@/lib/integrations/hmrc/oauth";
import { requestHmrcCisVerification } from "@/lib/integrations/hmrc/cis-verify";
import { CIS_STATUS_LABELS } from "@/lib/cis/types";
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
 * TWO VERIFICATION PATHS, ONE WRITE AUTHORITY. `saveCisVerification` stores an
 * outcome an admin obtained from HMRC themselves (the only live path today).
 * `verifyCisWithHmrc` asks HMRC's online verification service via the G5 DARK
 * adapter (lib/integrations/hmrc/cis-verify.ts) — it refuses with a plain
 * message unless HMRC is connectable (credentials + flag, never today), makes
 * ZERO network calls while dark, and when live records its answer through the
 * SAME recordVerification write (source='hmrc_api'). Nothing here simulates an
 * HMRC call — see the provider seam in lib/cis/verification.ts.
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
// Verification — request one from HMRC online (dark until activation)
// ---------------------------------------------------------------------------

/**
 * Ask HMRC to verify this subcontractor and record the answer. ADMIN-GATED
 * like every action here; the adapter refuses before any network call while
 * HMRC is not connectable, so in production today this returns the honest
 * "not connected" message and does nothing else. No form fields: the
 * identifiers come from the stored profile and contractor details, never from
 * the browser.
 */
export async function verifyCisWithHmrc(
  supplierId: string,
  _prev: FormState<Values>,
  _formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);
  if (!idSchema.safeParse(supplierId).success) return formError("Invalid supplier id.");

  // Belt-and-braces: the adapter dark-guards too, but refusing here keeps the
  // action from doing ANY reads when the surface should not exist at all.
  if (!isHmrcConnectable()) {
    return formError(
      "HMRC online verification is not connected. Verify with HMRC's CIS online service or the CIS helpline, then record the result here.",
    );
  }

  const result = await requestHmrcCisVerification({
    orgId: ctx.org.id,
    supplierId,
    actorId: user.id,
  });
  if (!result.ok) return formError(result.message);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.verification.recorded",
    targetTable: "cis_subcontractors",
    targetId: supplierId,
    metadata: {
      cis_status: result.profile.cis_status,
      deduction_rate: result.profile.deduction_rate,
      source: "hmrc_api",
      was_stale: result.wasStale,
    },
  }).catch(() => {});

  revalidate(supplierId);
  return formSuccess({
    successMessage: `HMRC verified — ${CIS_STATUS_LABELS[result.profile.cis_status]}, reference ${result.receipt.verificationNumber}.`,
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

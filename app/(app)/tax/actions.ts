"use server";

import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import { startOfQuarterIso } from "@/lib/tax/compute";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";
import {
  prepareVatReturn,
  prepareCis300Return,
} from "@/server/services/hmrc-connections";

/**
 * Tax actions — the INTERNAL "prepare & hold" wire-up for HMRC VAT / CIS300
 * returns. These build a FROZEN internal record from CrewFlow's OWN tax figures
 * and store it in hmrc_submissions (status 'prepared'). They do NOT file to HMRC:
 * there is no submit/network path here — that stays legally recognition-gated
 * (see lib/integrations/hmrc/oauth.ts and migration 20261099).
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-insert RLS on hmrc_submissions / hmrc_connections (20261099) is the real
 * boundary, enforced under the caller's JWT. Org-pinned via ctx.org.id — never a
 * client-supplied org — so a multi-org admin cannot prepare against another org.
 *
 * Plain form-actions (FormData → void) so the /tax page needs no client JS; on
 * success the page revalidates and the new prepared/held row appears.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/** Prepare + hold this quarter's VAT return as an internal frozen record. */
export async function prepareVatReturnAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may prepare a VAT return.");
  }

  // A caller may pass an explicit quarter start; default to the current quarter.
  const raw = String(formData.get("quarterStart") ?? "").trim();
  const quarterStartIso = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw : startOfQuarterIso();

  const res = await prepareVatReturn({
    orgId: ctx.org.id,
    preparedBy: user.id,
    quarterStartIso,
  });
  if (!res.ok) {
    throw new Error(res.error || "Could not prepare the VAT return.");
  }

  revalidatePath("/tax");
}

/** Prepare + hold a CIS300 monthly return as an internal frozen record. */
export async function prepareCis300ReturnAction(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    throw new Error("Only an owner or admin may prepare a CIS300 return.");
  }

  // A caller may pass an explicit tax-month end (yyyy-mm-dd); default to the
  // tax month containing today.
  const raw = String(formData.get("taxMonthEnd") ?? "").trim();
  const taxMonthEnd = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : cisTaxMonthEnd(new Date().toISOString());
  if (!taxMonthEnd) {
    throw new Error("Could not resolve the CIS tax month.");
  }

  const res = await prepareCis300Return({
    orgId: ctx.org.id,
    preparedBy: user.id,
    taxMonthEnd,
  });
  if (!res.ok) {
    throw new Error(res.error || "Could not prepare the CIS300 return.");
  }

  revalidatePath("/tax");
}

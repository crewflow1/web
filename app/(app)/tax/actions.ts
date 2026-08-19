"use server";

import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { startOfVatPeriodIso } from "@/lib/tax/compute";
import { readOrgSettings } from "@/lib/org-config/service";
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

  // The org's HMRC stagger fixes the VAT period; resolve it once and use it both
  // for the default period start and to size the frozen return's window (a
  // monthly filer's return covers one month, not three).
  const supabase = await createClient();
  const orgSettings = await readOrgSettings(supabase, ctx.org.id);
  const stagger = orgSettings.vat_stagger;

  // A caller may pass an explicit period start; default to the current period for
  // the org's stagger (the page always posts the matching value).
  const raw = String(formData.get("quarterStart") ?? "").trim();
  const quarterStartIso = /^\d{4}-\d{2}-\d{2}/.test(raw)
    ? raw
    : startOfVatPeriodIso(stagger);

  const res = await prepareVatReturn({
    orgId: ctx.org.id,
    preparedBy: user.id,
    quarterStartIso,
    stagger,
    // The org's output-VAT basis and FRS config drive the frozen 9-box figures.
    // Both default to the pre-scheme behaviour (cash / FRS off) inside the service.
    scheme: orgSettings.vat_scheme,
    flatRateConfig: orgSettings.flat_rate_config,
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

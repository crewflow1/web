"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { startOfVatPeriodIso } from "@/lib/tax/compute";
import { readOrgSettings } from "@/lib/org-config/service";
import { cisTaxMonthEnd } from "@/lib/cis/tax-month";
import {
  prepareVatReturn,
  prepareCis300Return,
} from "@/server/services/hmrc-connections";
import { isHmrcConnectable } from "@/lib/integrations/hmrc/oauth";
import type { FraudHeaderContext } from "@/lib/integrations/hmrc/fraud-headers";
import {
  submitVatReturn,
  submitCis300Return,
  submitFpsReturn,
} from "@/server/services/hmrc-submit";

/**
 * Tax actions — the INTERNAL "prepare & hold" wire-up for HMRC VAT / CIS300
 * returns, plus the recognition-gated SUBMIT wire-up.
 *
 * PREPARE builds a FROZEN internal record from CrewFlow's OWN tax figures and
 * stores it in hmrc_submissions (status 'prepared'). Preparing never files to
 * HMRC — it is pure composition, available dark.
 *
 * SUBMIT advances a prepared return through the submit orchestrator
 * (server/services/hmrc-submit.ts). It is DOUBLY dark-gated: this action refuses
 * with an honest reason while HMRC is not connectable (flag + client creds —
 * BOTH absent today), and the orchestrator repeats the same guard before any DB
 * claim or network call, so no path reaches HMRC's network dark. Above both sits
 * the LEGAL gate: HMRC vendor recognition — filing stays structurally impossible
 * until recognition, and the /tax page renders the submit affordance ONLY when
 * connectable, so the control does not exist dark.
 *
 * AUTHORISATION IS DOUBLED. The role check here refuses a non-admin loudly; the
 * admin-insert RLS on hmrc_submissions / hmrc_connections (20261099) is the real
 * boundary, enforced under the caller's JWT (the submit orchestrator runs
 * service-role but org-pins every query to ctx.org.id). Org-pinned via
 * ctx.org.id — never a client-supplied org — so a multi-org admin cannot prepare
 * or submit against another org.
 *
 * Plain form-actions (FormData → void) so the /tax page needs no client JS; on
 * success the page revalidates and the row's new state appears.
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

const SUBMIT_KINDS = ["vat_return", "cis300", "fps"] as const;
type SubmitKind = (typeof SUBMIT_KINDS)[number];

function isSubmitKind(v: string): v is SubmitKind {
  return (SUBMIT_KINDS as readonly string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fraud-prevention context the server genuinely knows about this request:
 * the authenticated user, the forwarding-resolved public IP chain and the
 * browser user agent. HMRC's fraud-header spec wants richer client-side signals
 * (screen, timezone, device id) — those are enrichment the submit page can add
 * at activation; the builder emits a compliant header set from what is present.
 */
async function requestFraudContext(userId: string): Promise<FraudHeaderContext> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for") ?? "";
  const publicIps = fwd
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    userId,
    publicIps: publicIps.length > 0 ? publicIps : undefined,
    publicIpTimestamp: publicIps.length > 0 ? new Date().toISOString() : undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

/**
 * Submit a PREPARED return (VAT / CIS300 / FPS) to HMRC via the orchestrator.
 *
 * GATES, IN ORDER: (1) input validation; (2) auth + org + admin; (3) the HONEST
 * dark refusal — while HMRC is not connectable (recognition + creds + flag
 * absent, ALWAYS today) this throws the real reason BEFORE the orchestrator is
 * even invoked, and the orchestrator's own dark guard (+ the adapters') repeats
 * it, so no code path reaches HMRC's network dark. The orchestrator owns
 * idempotency (atomic prepared|held → submitting claim) and the outcome states.
 */
export async function submitHmrcReturnAction(formData: FormData): Promise<void> {
  const kindRaw = String(formData.get("kind") ?? "");
  if (!isSubmitKind(kindRaw)) {
    throw new Error("Unknown HMRC return kind.");
  }
  const submissionId = String(formData.get("submissionId") ?? "").trim();
  if (!UUID_RE.test(submissionId)) {
    throw new Error("Unknown HMRC submission.");
  }

  const { ctx, user } = await requireOrgContext();
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    throw new Error("Only an owner or admin may submit a return to HMRC.");
  }

  // HONEST DARK REFUSAL — before the orchestrator, before any DB claim.
  if (!isHmrcConnectable()) {
    throw new Error(
      "Submitting to HMRC is not available: CrewFlow is not yet recognised by " +
        "HMRC as filing software and no HMRC connection is configured. Returns " +
        "stay prepared & held internally.",
    );
  }

  const params = {
    orgId: ctx.org.id,
    submissionId,
    submittedBy: user.id,
    fraudContext: await requestFraudContext(user.id),
  };
  const result =
    kindRaw === "vat_return"
      ? await submitVatReturn(params)
      : kindRaw === "cis300"
        ? await submitCis300Return(params)
        : await submitFpsReturn(params);

  if (!result.ok) {
    throw new Error(result.message);
  }

  revalidatePath("/tax");
}

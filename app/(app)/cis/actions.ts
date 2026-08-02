"use server";

import { revalidatePath } from "next/cache";

import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  issueStatement,
  markReturnExported,
  prepareReturn,
  upsertContractorProfile,
  withdrawStatement,
} from "@/server/services/cis-statements";
import { queueCisStatementEmails } from "@/server/services/cis-statement-emails";
import {
  cisContractorProfileSchema,
  cisReturnPrepareSchema,
  cisStatementIssueSchema,
  cisStatementWithdrawSchema,
} from "@/lib/cis/contractor";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * H2-CIS M4 server actions — statements and the monthly return DATASET.
 *
 * ── NOTHING HERE FILES ANYTHING WITH HMRC ───────────────────────────────────
 * There is no submission action in this file and no HTTP call to HMRC anywhere
 * behind it. `exportReturn` records that the operator downloaded figures from
 * CrewFlow — an act CrewFlow genuinely performed. It is deliberately not called
 * "submit", "file" or "send", because a user reading an action name should not
 * be able to infer a filing that did not happen.
 *
 * OWNER/ADMIN ONLY. A server action is a POST endpoint, so a non-admin member
 * can replay it regardless of what the UI shows — the role is re-checked here.
 * That check exists to produce a good message; the REAL boundary is the
 * admin-only RLS on every M4 table plus the `is_org_admin` gate inside each RPC,
 * which refuse a direct PostgREST caller identically.
 */

const isManager = (role: string): boolean => role === "owner" || role === "admin";

const FORBIDDEN = "Only an owner or admin can manage CIS statements and returns.";

type Values = Record<string, unknown>;

function revalidate(): void {
  revalidatePath("/cis");
}

// ---------------------------------------------------------------------------
// The contractor's own CIS identity
// ---------------------------------------------------------------------------

/**
 * Without this, no statement can be issued: HMRC requires the contractor's own
 * name and employer PAYE reference on every one (CIS340 3.15). The reference is
 * collected, never derived from the organisation record.
 */
export async function saveContractorProfile(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const parsed = validateFormData(formData, cisContractorProfileSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await upsertContractorProfile(ctx.org.id, parsed.data, user.id);
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.contractor_profile.saved",
    targetTable: "cis_contractor_profiles",
    targetId: ctx.org.id,
    // Tax identifiers are NEVER written to audit metadata — only whether held.
    metadata: { has_paye_reference: true, has_utr: Boolean(parsed.data.contractor_utr) },
  }).catch(() => {});

  revalidate();
  return formSuccess({ successMessage: "CIS contractor details saved." });
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Issue — or REISSUE — a payment and deduction statement.
 *
 * Reissuing does not edit the earlier statement. It issues a new one that
 * supersedes it, because the subcontractor already holds the first document and
 * quietly changing our copy of it would make the two disagree with no trace.
 */
export async function issueCisStatement(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const parsed = validateFormData(formData, cisStatementIssueSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await issueStatement(
    ctx.org.id,
    parsed.data.supplier_id,
    parsed.data.tax_month_end,
  );
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.statement.issued",
    targetTable: "cis_statements",
    targetId: result.data,
    metadata: { tax_month_end: parsed.data.tax_month_end },
  }).catch(() => {});

  revalidate();
  revalidatePath(`/cis/statements/${result.data}`);
  return formSuccess({ successMessage: "Statement issued." });
}

/**
 * Withdraw a statement that should no longer be relied on — the honest
 * close-out when every payment it covered has been voided and there is
 * therefore nothing left to reissue.
 */
export async function withdrawCisStatement(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const parsed = validateFormData(formData, cisStatementWithdrawSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await withdrawStatement(
    ctx.org.id,
    parsed.data.statement_id,
    parsed.data.reason,
  );
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.statement.withdrawn",
    targetTable: "cis_statements",
    targetId: parsed.data.statement_id,
    metadata: {},
  }).catch(() => {});

  revalidate();
  revalidatePath(`/cis/statements/${parsed.data.statement_id}`);
  return formSuccess({
    successMessage: "Statement withdrawn. Tell the subcontractor it no longer applies.",
  });
}

// ---------------------------------------------------------------------------
// The monthly return dataset
// ---------------------------------------------------------------------------

/**
 * Assemble and freeze the CIS300-shape figures for a tax month.
 *
 * PREPARES. DOES NOT FILE. A month with no payments prepares a NIL return,
 * because GOV.UK requires a return showing payments were 0 — the obligation
 * exists whether or not anyone was paid.
 */
export async function prepareCisReturn(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const parsed = validateFormData(formData, cisReturnPrepareSchema);
  if (!parsed.ok) return parsed.state as FormState<Values>;

  const result = await prepareReturn(ctx.org.id, parsed.data.tax_month_end);
  if (!result.ok) return formError(result.error, parsed.data as Values);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.monthly_return.prepared",
    targetTable: "cis_monthly_returns",
    targetId: result.data,
    metadata: { tax_month_end: parsed.data.tax_month_end },
  }).catch(() => {});

  revalidate();
  return formSuccess({
    successMessage:
      "Return figures prepared. CrewFlow does not file them — submit them to HMRC yourself.",
  });
}

/**
 * Record that the operator took the figures out of CrewFlow.
 *
 * NOT A FILING. The name, the action label, the status and the success message
 * all say "export" for the same reason: nothing was sent to HMRC.
 */
export async function exportCisReturn(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const returnId = String(formData.get("return_id") ?? "");
  if (!returnId) return formError("Choose a prepared return.");

  const result = await markReturnExported(ctx.org.id, returnId);
  if (!result.ok) return formError(result.error);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.monthly_return.exported",
    targetTable: "cis_monthly_returns",
    targetId: returnId,
    metadata: {},
  }).catch(() => {});

  revalidate();
  return formSuccess({
    successMessage: "Marked as exported. This records your download — it does not file the return.",
  });
}

// ---------------------------------------------------------------------------
// Emailing statements to subcontractors
// ---------------------------------------------------------------------------

/**
 * Email the current (issued, statutory) payment & deduction statements for a tax
 * month to the subcontractors they belong to.
 *
 * ── NOT A FILING ────────────────────────────────────────────────────────────
 * Giving a subcontractor their statement is an obligation owed to the
 * SUBCONTRACTOR (CIS340 3.15), not a submission to HMRC — the name is "email",
 * never "file" or "submit". It puts the document onto CrewFlow's existing
 * outbound email queue; the shared drain sends it via Resend, and with no email
 * provider configured (the production default) nothing leaves the building.
 *
 * IDEMPOTENT: a statement is queued at most once (keyed on its number), so
 * re-running over an unchanged month queues nothing new. Gross-paid (non-
 * statutory) statements and subcontractors with no email on file are skipped and
 * reported, never sent silently.
 *
 * OWNER/ADMIN ONLY — re-checked here for a good message; the real boundary is
 * the admin-only RLS on cis_statements the service reads through.
 */
export async function emailCisStatements(
  _prev: FormState<Values>,
  formData: FormData,
): Promise<FormState<Values>> {
  const { ctx, user } = await requireOrgContext();
  if (!isManager(ctx.membership.role)) return formError(FORBIDDEN);

  const taxMonthEnd = String(formData.get("tax_month_end") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taxMonthEnd)) {
    return formError("Choose a tax month.");
  }

  let result;
  try {
    result = await queueCisStatementEmails({ orgId: ctx.org.id, taxMonthEnd });
  } catch {
    return formError("Could not queue statement emails. Try again.");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "cis.statements.emailed",
    targetTable: "cis_statements",
    targetId: ctx.org.id,
    // Counts only — never a recipient address or a tax identifier.
    metadata: {
      tax_month_end: taxMonthEnd,
      queued: result.queued,
      already_queued: result.alreadyQueued,
      no_email: result.noEmail,
      not_statutory: result.notStatutory,
    },
  }).catch(() => {});

  revalidate();

  const parts = [`${result.queued} statement${result.queued === 1 ? "" : "s"} queued to send`];
  if (result.alreadyQueued > 0) parts.push(`${result.alreadyQueued} already sent`);
  if (result.noEmail > 0) parts.push(`${result.noEmail} with no email on file`);
  if (result.notStatutory > 0) parts.push(`${result.notStatutory} paid gross (not required)`);
  return formSuccess({ successMessage: `${parts.join(" · ")}.` });
}

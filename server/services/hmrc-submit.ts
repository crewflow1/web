import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  decryptStoredTokens,
  isHmrcConnectable,
} from "@/lib/integrations/hmrc/oauth";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";
import {
  buildFraudPreventionHeaders,
  type FraudHeaderContext,
  type VendorContext,
} from "@/lib/integrations/hmrc/fraud-headers";
import {
  submitVatReturnToHmrc,
  type HmrcVatReceipt,
} from "@/lib/integrations/hmrc/vat-submit";
import {
  submitCis300ReturnToHmrc,
  type HmrcCisReceipt,
} from "@/lib/integrations/hmrc/cis-submit";
import {
  submitFpsReturnToHmrc,
  type HmrcFpsReceipt,
} from "@/lib/integrations/hmrc/rti-fps-submit";

import type { MtdVatReturn } from "@/lib/integrations/hmrc/vat-return";
import type { Cis300Return } from "@/lib/integrations/hmrc/cis-return";
import type { FpsReturn } from "@/lib/integrations/hmrc/rti-fps";

/**
 * HMRC — the SUBMIT orchestrator: the state machine that advances a PREPARED
 * return (MTD VAT 9-box, CIS300 monthly, or RTI FPS) through an actual HMRC
 * submission. DARK / recognition-gated.
 *
 * Three orchestrators live here — `submitVatReturn`, `submitCis300Return`,
 * `submitFpsReturn`. They are byte-for-byte the SAME state machine (dark guard →
 * load → decrypt → atomic claim → adapter POST → persist receipt / revert),
 * differing only in the submission `kind` they accept, the provider adapter they
 * call, and the HMRC handle they hand it (VAT: the connection's VRN; CIS/RTI: the
 * employer/contractor PAYE reference carried in the frozen payload).
 *
 * This is deliberately SEPARATE from server/services/hmrc-connections.ts (the
 * tenant-facing service, whose token-FREE-reads invariant the security suite
 * proves): submitting needs the ENCRYPTED token columns, which are stripped from
 * the authenticated read surface by a column privilege (20261099) and are only
 * readable by service_role. So — exactly like the calendar/accounting token
 * stores — this module runs under the service-role admin client (RLS bypass),
 * ORG-PINNING every query in code.
 *
 * ── DARK BY DEFAULT (refuse before submit) ──────────────────────────────────
 * `submitVatReturn` REFUSES before touching the DB claim or the network unless:
 *   - HMRC is connectable (client creds + NEXT_PUBLIC_FEATURE_HMRC_CONNECT), AND
 *   - a token-encryption key is present (so stored tokens can be decrypted and any
 *     refreshed token re-encrypted before write).
 * Both are false today, so this whole path is unreachable in production — the
 * external gates (HMRC vendor recognition + credentials) are what activation flips.
 *
 * ── IDEMPOTENCY: one period is NEVER double-submitted ────────────────────────
 * The submission is CLAIMED with an atomic guarded UPDATE
 * (status prepared|held → submitting, gated in the WHERE clause on the current
 * status). Postgres row-locks the row, so of two concurrent submits exactly one
 * flips prepared→submitting and proceeds; the other matches zero rows and is
 * refused (`already_submitting`). A return already in a terminal state
 * (submitted/accepted/rejected/submitting) is likewise refused (`not_submittable`)
 * BEFORE any HMRC call. There is no way to POST the same period twice.
 *
 * ── OUTCOME → STATE ─────────────────────────────────────────────────────────
 *   HMRC accepts        → status='accepted', receipt columns populated, connection
 *                         last_sync_at bumped.
 *   HMRC rejects (biz)  → status='rejected', submit_error set (a 400/403 validation
 *                         failure the return itself caused; no retry helps).
 *   transient / auth    → REVERT status→'prepared', submit_error noted, period stays
 *                         retriable. A dead OAuth grant additionally flips the
 *                         connection to status='error' so the admin is prompted to
 *                         reconnect (mirrors the calendar terminal-failure writer).
 */

export type SubmitVatResult =
  | { ok: true; status: "accepted"; receipt: HmrcVatReceipt }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "not_found"
        | "not_submittable"
        | "already_submitting"
        | "rejected"
        | "error";
      message: string;
      /** The OAuth grant is dead — the org must reconnect HMRC before retrying. */
      terminal?: boolean;
    };

// hmrc_connections / hmrc_submissions post-date the generated types.ts; reach
// them through a minimal structural cast (the token-store / accounting idiom).
type DbResult<T> = { data: T | null; error: { message: string } | null };
interface SelectBuilder<T> extends PromiseLike<DbResult<T[]>> {
  eq(col: string, val: unknown): SelectBuilder<T>;
  in(col: string, vals: unknown[]): SelectBuilder<T>;
  maybeSingle(): PromiseLike<DbResult<T>>;
}
interface UpdateBuilder<T> extends PromiseLike<DbResult<T[]>> {
  eq(col: string, val: unknown): UpdateBuilder<T>;
  in(col: string, vals: unknown[]): UpdateBuilder<T>;
  select(cols?: string): UpdateBuilder<T>;
}
interface LooseTable {
  select(cols: string): SelectBuilder<Record<string, unknown>>;
  update(row: Record<string, unknown>): UpdateBuilder<Record<string, unknown>>;
}
type LooseAdmin = { from(t: string): LooseTable };

type SubmissionRow = {
  id: string;
  org_id: string;
  kind: string;
  status: string;
  period_key: string;
  payload: unknown;
};

type ConnectionTokenRow = {
  id: string;
  status: string;
  hmrc_vrn: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
};

/** Persist refreshed tokens after a silent renewal, encrypted before write. Service-role, org-pinned. */
async function persistRefreshedTokens(
  admin: LooseAdmin,
  orgId: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {
    access_token: encryptToken(tokens.accessToken),
    token_expires_at: tokens.expiresAt,
  };
  // A null refresh token means HMRC did not rotate it — keep the existing one.
  if (tokens.refreshToken !== null) row.refresh_token = encryptToken(tokens.refreshToken);
  const { error } = await admin
    .from("hmrc_connections")
    .update(row)
    .eq("org_id", orgId)
    .eq("provider", "hmrc");
  if (error) {
    // Coarse signal only — never the token payload.
    console.error("[hmrc] failed to persist refreshed tokens", { message: error.message });
  }
}

/** Flip the connection to status='error' after a TERMINAL (dead-grant) submit failure. Never throws. */
async function markConnectionError(
  admin: LooseAdmin,
  orgId: string,
  message: string,
): Promise<void> {
  const { error } = await admin
    .from("hmrc_connections")
    .update({ status: "error", last_error: message, last_sync_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("provider", "hmrc");
  if (error) {
    console.error("[hmrc] failed to record connection error", { message: error.message });
  }
}

/**
 * Submit a PREPARED VAT return to HMRC and advance its state. Org-pinned, loud,
 * idempotent, dark-gated. See the module doc for the full state machine.
 */
export async function submitVatReturn(params: {
  orgId: string;
  submissionId: string;
  submittedBy: string;
  fraudContext?: FraudHeaderContext;
  vendor?: VendorContext;
}): Promise<SubmitVatResult> {
  const { orgId, submissionId, submittedBy } = params;

  // ── DARK GUARD FIRST — refuse before any DB claim or network call. ──────────
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no VAT return can be submitted.",
    };
  }
  // A connectable HMRC MUST have a token-encryption key, or stored tokens cannot
  // be decrypted (and a refreshed token cannot be re-encrypted). Refuse loudly.
  if (!isTokenEncryptionConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set; refusing to submit.",
    };
  }

  const admin = createAdminClient() as unknown as LooseAdmin;

  // ── load the prepared submission (service-role, org-pinned) ─────────────────
  const { data: subData, error: subErr } = await admin
    .from("hmrc_submissions")
    .select("id, org_id, kind, status, period_key, payload")
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (subErr) throw readFailure("hmrc submit: load submission", subErr);
  const submission = subData as unknown as SubmissionRow | null;
  if (!submission) {
    return { ok: false, reason: "not_found", message: "No such VAT submission for this org." };
  }
  if (submission.kind !== "vat_return") {
    return { ok: false, reason: "not_submittable", message: "Submission is not a VAT return." };
  }
  // A return already in flight or terminal is NOT re-submittable — the pre-claim
  // idempotency check (the atomic claim below is the race-proof guard).
  if (submission.status !== "prepared" && submission.status !== "held") {
    return {
      ok: false,
      reason: "not_submittable",
      message: `VAT return is '${submission.status}', not submittable.`,
    };
  }

  // ── load the connection + ENCRYPTED tokens (service-role only) ──────────────
  const { data: connData, error: connErr } = await admin
    .from("hmrc_connections")
    .select("id, status, hmrc_vrn, access_token, refresh_token, token_expires_at")
    .eq("org_id", orgId)
    .eq("provider", "hmrc")
    .maybeSingle();
  if (connErr) throw readFailure("hmrc submit: load connection", connErr);
  const connection = connData as unknown as ConnectionTokenRow | null;
  if (!connection || connection.status !== "connected" || !connection.access_token || !connection.hmrc_vrn) {
    return {
      ok: false,
      reason: "not_connected",
      message: "HMRC is not connected for this org; cannot submit.",
    };
  }

  // Decrypt on use, immediately before the HMRC call. decryptToken throws on a
  // wrong key or any tamper, so a corrupted token is never silently submitted.
  const tokens = decryptStoredTokens({
    accessToken: connection.access_token,
    refreshToken: connection.refresh_token,
  });

  // ── ATOMIC CLAIM — the double-submit guard ──────────────────────────────────
  // prepared|held → submitting, gated on the current status in the WHERE clause.
  // Exactly one concurrent caller flips the row; the other matches zero rows.
  const { data: claimData, error: claimErr } = await admin
    .from("hmrc_submissions")
    .update({
      status: "submitting",
      submitted_at: new Date().toISOString(),
      submitted_by: submittedBy,
      submit_error: null,
    })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .in("status", ["prepared", "held"])
    .select("id");
  if (claimErr) throw readFailure("hmrc submit: claim", claimErr);
  const claimed = ((claimData ?? []) as unknown as Array<{ id: string }>).length > 0;
  if (!claimed) {
    // Another submit won the race (or the row moved states between read and claim).
    return {
      ok: false,
      reason: "already_submitting",
      message: "This VAT period is already being submitted.",
    };
  }

  // ── build the mandatory fraud-prevention headers + POST to HMRC ─────────────
  const fraudHeaders = buildFraudPreventionHeaders(params.fraudContext ?? {}, params.vendor ?? {});
  const result = await submitVatReturnToHmrc({
    vrn: connection.hmrc_vrn,
    payload: submission.payload as MtdVatReturn,
    tokens,
    fraudHeaders,
  });

  // Persist any refreshed tokens regardless of the submit outcome (the refresh
  // happened; the new access token must not be lost).
  if (result.refreshed) {
    await persistRefreshedTokens(admin, orgId, result.refreshed);
  }

  // ── record the terminal state ───────────────────────────────────────────────
  if (result.ok) {
    const { error: accErr } = await admin
      .from("hmrc_submissions")
      .update({
        status: "accepted",
        hmrc_processing_date: result.receipt.processingDate,
        hmrc_form_bundle_number: result.receipt.formBundleNumber,
        hmrc_charge_ref_number: result.receipt.chargeRefNumber,
        hmrc_payment_indicator: result.receipt.paymentIndicator,
        submit_error: null,
      })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (accErr) throw readFailure("hmrc submit: record accepted", accErr);
    // A successful submit re-asserts a healthy connection.
    await admin
      .from("hmrc_connections")
      .update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null })
      .eq("org_id", orgId)
      .eq("provider", "hmrc");
    return { ok: true, status: "accepted", receipt: result.receipt };
  }

  // HMRC BUSINESS rejection — the return itself was refused. Terminal 'rejected'.
  if (result.rejected) {
    const { error: rejErr } = await admin
      .from("hmrc_submissions")
      .update({ status: "rejected", submit_error: result.message })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (rejErr) throw readFailure("hmrc submit: record rejected", rejErr);
    return { ok: false, reason: "rejected", message: result.message };
  }

  // TRANSIENT or dead-grant failure — REVERT the claim so the period stays
  // retriable; note the error for the operator. A dead grant additionally flips
  // the connection to 'error' so the admin is prompted to reconnect.
  const { error: revErr } = await admin
    .from("hmrc_submissions")
    .update({ status: "prepared", submitted_at: null, submitted_by: null, submit_error: result.message })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .eq("status", "submitting");
  if (revErr) throw readFailure("hmrc submit: revert claim", revErr);
  if (result.terminal) {
    await markConnectionError(admin, orgId, result.message);
  }
  return { ok: false, reason: "error", message: result.message, terminal: result.terminal === true };
}

// ---------------------------------------------------------------------------
// CIS300 + RTI FPS submit orchestrators — the same state machine as VAT above.
//
// hmrc_submissions already carries the CIS300 ('cis300') and FPS ('fps') kinds
// (migrations 20261099 / 20261156), the submit lifecycle states and the generic
// receipt columns (migration 20261130 — processing date / form-bundle number /
// charge ref / payment indicator, shared across all kinds). So NO new migration
// is needed: CIS and RTI reuse the exact columns and CHECKs VAT already added,
// storing HMRC's async submission reference (a correlation id) in the shared
// `hmrc_form_bundle_number` slot — HMRC's unique submission reference, whatever
// its per-API name. The append-only + service-role-write invariants are unchanged.
// ---------------------------------------------------------------------------

export type SubmitCis300Result =
  | { ok: true; status: "accepted"; receipt: HmrcCisReceipt }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "not_found"
        | "not_submittable"
        | "already_submitting"
        | "rejected"
        | "error";
      message: string;
      /** The OAuth grant is dead — the org must reconnect HMRC before retrying. */
      terminal?: boolean;
    };

/**
 * Submit a PREPARED CIS300 monthly return to HMRC and advance its state. Org-pinned,
 * loud, idempotent, dark-gated — the SAME state machine as submitVatReturn. The
 * contractor's HMRC handle (the employer PAYE reference the scheme files under) is
 * read from the frozen payload's `contractor` block, not the connection (which
 * carries the VAT VRN); a return whose payload names no contractor reference is
 * refused BEFORE the claim, since HMRC cannot route it.
 */
export async function submitCis300Return(params: {
  orgId: string;
  submissionId: string;
  submittedBy: string;
  fraudContext?: FraudHeaderContext;
  vendor?: VendorContext;
}): Promise<SubmitCis300Result> {
  const { orgId, submissionId, submittedBy } = params;

  // ── DARK GUARD FIRST — refuse before any DB claim or network call. ──────────
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no CIS300 return can be submitted.",
    };
  }
  if (!isTokenEncryptionConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set; refusing to submit.",
    };
  }

  const admin = createAdminClient() as unknown as LooseAdmin;

  // ── load the prepared submission (service-role, org-pinned) ─────────────────
  const { data: subData, error: subErr } = await admin
    .from("hmrc_submissions")
    .select("id, org_id, kind, status, period_key, payload")
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (subErr) throw readFailure("hmrc submit: load cis submission", subErr);
  const submission = subData as unknown as SubmissionRow | null;
  if (!submission) {
    return { ok: false, reason: "not_found", message: "No such CIS300 submission for this org." };
  }
  if (submission.kind !== "cis300") {
    return { ok: false, reason: "not_submittable", message: "Submission is not a CIS300 return." };
  }
  if (submission.status !== "prepared" && submission.status !== "held") {
    return {
      ok: false,
      reason: "not_submittable",
      message: `CIS300 return is '${submission.status}', not submittable.`,
    };
  }

  // The contractor's HMRC handle rides in the frozen payload (not the connection).
  const payload = submission.payload as Cis300Return;
  const contractorRef =
    (payload?.contractor?.employerPayeReference ?? payload?.contractor?.utr ?? "").trim();
  if (contractorRef.length === 0) {
    return {
      ok: false,
      reason: "not_submittable",
      message: "The prepared CIS300 return names no contractor reference; cannot submit.",
    };
  }

  // ── load the connection + ENCRYPTED tokens (service-role only) ──────────────
  const { data: connData, error: connErr } = await admin
    .from("hmrc_connections")
    .select("id, status, hmrc_vrn, access_token, refresh_token, token_expires_at")
    .eq("org_id", orgId)
    .eq("provider", "hmrc")
    .maybeSingle();
  if (connErr) throw readFailure("hmrc submit: load connection", connErr);
  const connection = connData as unknown as ConnectionTokenRow | null;
  if (!connection || connection.status !== "connected" || !connection.access_token) {
    return {
      ok: false,
      reason: "not_connected",
      message: "HMRC is not connected for this org; cannot submit.",
    };
  }

  const tokens = decryptStoredTokens({
    accessToken: connection.access_token,
    refreshToken: connection.refresh_token,
  });

  // ── ATOMIC CLAIM — the double-submit guard ──────────────────────────────────
  const { data: claimData, error: claimErr } = await admin
    .from("hmrc_submissions")
    .update({
      status: "submitting",
      submitted_at: new Date().toISOString(),
      submitted_by: submittedBy,
      submit_error: null,
    })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .in("status", ["prepared", "held"])
    .select("id");
  if (claimErr) throw readFailure("hmrc submit: claim cis", claimErr);
  const claimed = ((claimData ?? []) as unknown as Array<{ id: string }>).length > 0;
  if (!claimed) {
    return {
      ok: false,
      reason: "already_submitting",
      message: "This CIS300 return is already being submitted.",
    };
  }

  // ── build the mandatory fraud-prevention headers + POST to HMRC ─────────────
  const fraudHeaders = buildFraudPreventionHeaders(params.fraudContext ?? {}, params.vendor ?? {});
  const result = await submitCis300ReturnToHmrc({
    contractorRef,
    payload,
    tokens,
    fraudHeaders,
  });

  if (result.refreshed) {
    await persistRefreshedTokens(admin, orgId, result.refreshed);
  }

  // ── record the terminal state ───────────────────────────────────────────────
  if (result.ok) {
    const { error: accErr } = await admin
      .from("hmrc_submissions")
      .update({
        status: "accepted",
        hmrc_processing_date: result.receipt.processingDate,
        // The shared submission-reference slot: HMRC's correlation id for CIS.
        hmrc_form_bundle_number: result.receipt.submissionReference,
        hmrc_charge_ref_number: result.receipt.chargeRefNumber,
        submit_error: null,
      })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (accErr) throw readFailure("hmrc submit: record cis accepted", accErr);
    await admin
      .from("hmrc_connections")
      .update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null })
      .eq("org_id", orgId)
      .eq("provider", "hmrc");
    return { ok: true, status: "accepted", receipt: result.receipt };
  }

  if (result.rejected) {
    const { error: rejErr } = await admin
      .from("hmrc_submissions")
      .update({ status: "rejected", submit_error: result.message })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (rejErr) throw readFailure("hmrc submit: record cis rejected", rejErr);
    return { ok: false, reason: "rejected", message: result.message };
  }

  const { error: revErr } = await admin
    .from("hmrc_submissions")
    .update({ status: "prepared", submitted_at: null, submitted_by: null, submit_error: result.message })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .eq("status", "submitting");
  if (revErr) throw readFailure("hmrc submit: revert cis claim", revErr);
  if (result.terminal) {
    await markConnectionError(admin, orgId, result.message);
  }
  return { ok: false, reason: "error", message: result.message, terminal: result.terminal === true };
}

export type SubmitFpsResult =
  | { ok: true; status: "accepted"; receipt: HmrcFpsReceipt }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "not_found"
        | "not_submittable"
        | "already_submitting"
        | "rejected"
        | "error";
      message: string;
      /** The OAuth grant is dead — the org must reconnect HMRC before retrying. */
      terminal?: boolean;
    };

/**
 * Submit a PREPARED RTI Full Payment Submission to HMRC and advance its state.
 * Org-pinned, loud, idempotent, dark-gated — the SAME state machine as
 * submitVatReturn. The employer's HMRC handle (the PAYE reference the scheme files
 * under) is read from the frozen payload's `employer` block; an FPS whose payload
 * names no employer reference is refused BEFORE the claim, since HMRC cannot route it.
 */
export async function submitFpsReturn(params: {
  orgId: string;
  submissionId: string;
  submittedBy: string;
  fraudContext?: FraudHeaderContext;
  vendor?: VendorContext;
}): Promise<SubmitFpsResult> {
  const { orgId, submissionId, submittedBy } = params;

  // ── DARK GUARD FIRST — refuse before any DB claim or network call. ──────────
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no FPS can be submitted.",
    };
  }
  if (!isTokenEncryptionConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set; refusing to submit.",
    };
  }

  const admin = createAdminClient() as unknown as LooseAdmin;

  // ── load the prepared submission (service-role, org-pinned) ─────────────────
  const { data: subData, error: subErr } = await admin
    .from("hmrc_submissions")
    .select("id, org_id, kind, status, period_key, payload")
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (subErr) throw readFailure("hmrc submit: load fps submission", subErr);
  const submission = subData as unknown as SubmissionRow | null;
  if (!submission) {
    return { ok: false, reason: "not_found", message: "No such FPS submission for this org." };
  }
  if (submission.kind !== "fps") {
    return { ok: false, reason: "not_submittable", message: "Submission is not an FPS." };
  }
  if (submission.status !== "prepared" && submission.status !== "held") {
    return {
      ok: false,
      reason: "not_submittable",
      message: `FPS is '${submission.status}', not submittable.`,
    };
  }

  // The employer's HMRC handle rides in the frozen payload (not the connection).
  const payload = submission.payload as FpsReturn;
  const employerRef = (payload?.employer?.employerPayeReference ?? "").trim();
  if (employerRef.length === 0) {
    return {
      ok: false,
      reason: "not_submittable",
      message: "The prepared FPS names no employer PAYE reference; cannot submit.",
    };
  }

  // ── load the connection + ENCRYPTED tokens (service-role only) ──────────────
  const { data: connData, error: connErr } = await admin
    .from("hmrc_connections")
    .select("id, status, hmrc_vrn, access_token, refresh_token, token_expires_at")
    .eq("org_id", orgId)
    .eq("provider", "hmrc")
    .maybeSingle();
  if (connErr) throw readFailure("hmrc submit: load connection", connErr);
  const connection = connData as unknown as ConnectionTokenRow | null;
  if (!connection || connection.status !== "connected" || !connection.access_token) {
    return {
      ok: false,
      reason: "not_connected",
      message: "HMRC is not connected for this org; cannot submit.",
    };
  }

  const tokens = decryptStoredTokens({
    accessToken: connection.access_token,
    refreshToken: connection.refresh_token,
  });

  // ── ATOMIC CLAIM — the double-submit guard ──────────────────────────────────
  const { data: claimData, error: claimErr } = await admin
    .from("hmrc_submissions")
    .update({
      status: "submitting",
      submitted_at: new Date().toISOString(),
      submitted_by: submittedBy,
      submit_error: null,
    })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .in("status", ["prepared", "held"])
    .select("id");
  if (claimErr) throw readFailure("hmrc submit: claim fps", claimErr);
  const claimed = ((claimData ?? []) as unknown as Array<{ id: string }>).length > 0;
  if (!claimed) {
    return {
      ok: false,
      reason: "already_submitting",
      message: "This FPS is already being submitted.",
    };
  }

  // ── build the mandatory fraud-prevention headers + POST to HMRC ─────────────
  const fraudHeaders = buildFraudPreventionHeaders(params.fraudContext ?? {}, params.vendor ?? {});
  const result = await submitFpsReturnToHmrc({
    employerRef,
    payload,
    tokens,
    fraudHeaders,
  });

  if (result.refreshed) {
    await persistRefreshedTokens(admin, orgId, result.refreshed);
  }

  // ── record the terminal state ───────────────────────────────────────────────
  if (result.ok) {
    const { error: accErr } = await admin
      .from("hmrc_submissions")
      .update({
        status: "accepted",
        hmrc_processing_date: result.receipt.processingDate,
        // The shared submission-reference slot: HMRC's correlation id for RTI.
        hmrc_form_bundle_number: result.receipt.submissionReference,
        submit_error: null,
      })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (accErr) throw readFailure("hmrc submit: record fps accepted", accErr);
    await admin
      .from("hmrc_connections")
      .update({ status: "connected", last_sync_at: new Date().toISOString(), last_error: null })
      .eq("org_id", orgId)
      .eq("provider", "hmrc");
    return { ok: true, status: "accepted", receipt: result.receipt };
  }

  if (result.rejected) {
    const { error: rejErr } = await admin
      .from("hmrc_submissions")
      .update({ status: "rejected", submit_error: result.message })
      .eq("id", submissionId)
      .eq("org_id", orgId)
      .eq("status", "submitting");
    if (rejErr) throw readFailure("hmrc submit: record fps rejected", rejErr);
    return { ok: false, reason: "rejected", message: result.message };
  }

  const { error: revErr } = await admin
    .from("hmrc_submissions")
    .update({ status: "prepared", submitted_at: null, submitted_by: null, submit_error: result.message })
    .eq("id", submissionId)
    .eq("org_id", orgId)
    .eq("status", "submitting");
  if (revErr) throw readFailure("hmrc submit: revert fps claim", revErr);
  if (result.terminal) {
    await markConnectionError(admin, orgId, result.message);
  }
  return { ok: false, reason: "error", message: result.message, terminal: result.terminal === true };
}

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  decryptStoredTokens,
  isHmrcConnectable,
  refreshAccessTokens,
} from "./oauth";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";
import {
  buildFraudPreventionHeaders,
  type FraudHeaderContext,
  type VendorContext,
} from "./fraud-headers";
import {
  canonicaliseVerificationReference,
  needsReverification,
  rateForStatus,
  type CisVerificationRequest,
} from "@/lib/cis/verification";
import { getCisProfile, recordVerification } from "@/server/services/cis";
import { getContractorProfile } from "@/server/services/cis-statements";

import type { CisOutcomeStatus, CisSubcontractor, CisVerificationSource } from "@/lib/cis/types";

/**
 * HMRC CIS subcontractor VERIFICATION — the provider HTTP half of asking HMRC
 * "what rate do I deduct for this subcontractor?", plus its orchestrator.
 * DARK / recognition-gated. This is the `hmrc` implementation of the provider
 * seam declared in lib/cis/verification.ts (CisVerificationProvider's rules 1–4
 * are honoured here; see each one called out below).
 *
 * THE REAL CONTRACT. HMRC's CIS verification service takes the CONTRACTOR's
 * identity (UTR + Accounts Office reference — the pair HMRC keys a CIS scheme
 * lookup on) and the SUBCONTRACTOR's identity (UTR, plus company number for a
 * company, plus names), and answers with:
 *   - a verification number ('V' + 10 digits, optional trailing letter(s) when
 *     the subcontractor could not be matched), and
 *   - a tax treatment: gross / net / higher / unmatched.
 * The deduction rate FOLLOWS from the treatment and is never chosen here:
 *   gross → gross (0%) · net → standard_20 (20%) ·
 *   higher → higher_30 (30%) · unmatched → failed (30%, the higher rate per
 *   HMRC, kept distinct so the operator can see the 30% came from a failed
 *   match). The mapping goes treatment → CisStatus, and the RATE is derived by
 *   the same rateForStatus authority the manual path uses (seam rule 3).
 *
 * It mirrors lib/integrations/hmrc/cis-submit.ts EXACTLY — the same dark
 * guard, the same 401→refresh→retry, the same rejected/terminal/transient
 * classification, the same fraud-prevention headers — differing only in the
 * endpoint, the payload, and the receipt vocabulary.
 *
 * ── READY vs ACTIVATED ──────────────────────────────────────────────────────
 * READY (this build): the code below is complete and tested against a stubbed
 * transport. It is DARK: `verifyCisSubcontractorWithHmrc` and
 * `requestHmrcCisVerification` both REFUSE (typed `not_configured`, ZERO
 * network) unless `isHmrcConnectable()` — HMRC client credentials AND
 * NEXT_PUBLIC_FEATURE_HMRC_CONNECT, the two-switch guard — and the single
 * `fetch` in this module lives strictly AFTER that guard, so it is
 * structurally unreachable today. No response is ever synthesised (seam rule
 * 1): when HMRC cannot be reached or answers something unreadable, the caller
 * gets a typed error and NOTHING is recorded.
 *
 * ACTIVATED (config + process, no further code): set HMRC_CLIENT_ID +
 * HMRC_CLIENT_SECRET + INTEGRATION_TOKEN_ENCRYPTION_KEY, flip
 * NEXT_PUBLIC_FEATURE_HMRC_CONNECT, complete HMRC vendor recognition, and have
 * the org connect via the existing OAuth flow (scope read:cis/write:cis). The
 * exact endpoint path/envelope are finalised at recognition, like the sibling
 * submit adapters; the shape here mirrors HMRC's organisations REST platform
 * (Bearer + versioned Accept + fraud headers).
 *
 * ── ONE WRITE AUTHORITY ─────────────────────────────────────────────────────
 * This module NEVER touches `cis_subcontractors` itself. A successful HMRC
 * answer is recorded through server/services/cis.ts `recordVerification` with
 * source='hmrc_api' — the exact write (and guard chain, and rate derivation)
 * the manual workflow uses. The adapter only SUPPLIES the values (seam rule 3),
 * and the reference recorded is the one HMRC issued, verbatim (seam rule 2).
 * Rule 4 (stale verification blocks payment) is enforced elsewhere and stays
 * enforced: the 20261175 gate refuses stale-rate deductions in the DB, and
 * `needsReverification` (the passthrough over that same staleness authority)
 * is surfaced on the outcome so callers can show why a verification was due.
 */

/** The source recorded on outcomes this adapter obtained. */
export const HMRC_API_VERIFICATION_SOURCE: CisVerificationSource = "hmrc_api";

/** HMRC CIS production base — same platform base as the CIS300 submit adapter. */
const CIS_API_BASE = "https://api.service.hmrc.gov.uk/organisations/cis";

// ---------------------------------------------------------------------------
// Tax treatment → status mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** HMRC's verification tax treatments. `higher` = matched but unregistered; `unmatched` = no match found. */
export const HMRC_CIS_TAX_TREATMENTS = ["gross", "net", "higher", "unmatched"] as const;

export type HmrcCisTaxTreatment = (typeof HMRC_CIS_TAX_TREATMENTS)[number];

/**
 * Map HMRC's tax treatment to the domain status. Returns null for anything the
 * contract does not define — an unknown treatment is a provider contract
 * violation and must surface as an ERROR, never a guessed rate (seam rule 1).
 *
 * The deduction rate is then rateForStatus(status): 0 / 20 / 30 / 30. This
 * function deliberately returns a STATUS, not a rate, so the status→rate
 * authority stays single.
 */
export function statusForTaxTreatment(treatment: string): CisOutcomeStatus | null {
  switch (treatment.trim().toLowerCase()) {
    case "gross":
      return "gross";
    case "net":
      return "standard_20";
    case "higher":
      return "higher_30";
    case "unmatched":
      return "failed";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The provider HTTP half (mirrors cis-submit.ts)
// ---------------------------------------------------------------------------

/** What HMRC's verification answer carries, already mapped to the domain. */
export type HmrcCisVerificationReceipt = {
  /** The verification number HMRC issued — recorded verbatim, never invented. */
  verificationNumber: string;
  /** HMRC's treatment, as answered. */
  taxTreatment: HmrcCisTaxTreatment;
  /** The domain status the treatment maps to. */
  status: CisOutcomeStatus;
  /** Derived via rateForStatus — informational; the recorder re-derives it. */
  deductionRate: number;
  /** ISO yyyy-mm-dd date HMRC reported for the verification, when it did. */
  verifiedAt: string | null;
};

type RefreshedTokens = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

export type CisVerifyResult =
  | {
      ok: true;
      receipt: HmrcCisVerificationReceipt;
      /** Present only when a 401 forced a refresh; the orchestrator persists these. */
      refreshed?: RefreshedTokens;
    }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      /** HMRC BUSINESS rejection of the request itself (400/403) — bad identifiers. */
      rejected?: boolean;
      /** The OAuth grant is dead (401 after refresh+retry, or invalid_grant) — re-consent. */
      terminal?: boolean;
      /** Present when a 401 forced a refresh before the failure; persist + reuse. */
      refreshed?: RefreshedTokens;
    };

/** Read a string field off HMRC's JSON answer defensively (null when absent/foreign). */
function readStr(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** The yyyy-mm-dd part of an HMRC date/timestamp, or null — never a guessed date. */
function isoDateOrNull(value: string | null): string | null {
  if (!value) return null;
  const m = ISO_DATE_PREFIX.exec(value.trim());
  return m ? m[1]! : null;
}

/**
 * POST a CIS verification request to HMRC. Dark-gated: REFUSES (no fetch)
 * unless HMRC is connectable. On a 401 the stored refresh token renews the
 * access token and the request is retried once; the refreshed tokens are
 * returned so the orchestrator can persist them.
 */
export async function verifyCisSubcontractorWithHmrc(params: {
  request: CisVerificationRequest;
  tokens: { accessToken: string; refreshToken: string | null };
  fraudHeaders: Record<string, string>;
}): Promise<CisVerifyResult> {
  const { request, tokens, fraudHeaders } = params;

  // DARK GUARD FIRST. No credentials/flag → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not configured; no CIS verification was requested.",
    };
  }

  const url = `${CIS_API_BASE}/${encodeURIComponent(request.contractorUtr)}/verifications`;
  const bodyJson = JSON.stringify({
    contractor: {
      utr: request.contractorUtr,
      accountsOfficeReference: request.contractorAccountsOfficeReference,
    },
    subcontractor: {
      name: request.legalName,
      tradingName: request.tradingName,
      utr: request.utr,
      companyNumber: request.companyNumber,
      type: request.subcontractorType,
    },
  });

  const doFetch = (accessToken: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        // Bearer token — decrypted by the orchestrator immediately before this call.
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        // HMRC's organisations APIs are versioned via the Accept header.
        accept: "application/vnd.hmrc.1.0+json",
        // HMRC MANDATES the fraud-prevention headers on every API call.
        ...fraudHeaders,
      },
      body: bodyJson,
    });

  let refreshed: RefreshedTokens | undefined;
  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);

    // 401 → refresh the access token and retry ONCE.
    if (res.status === 401 && tokens.refreshToken) {
      const r = await refreshAccessTokens({ refreshToken: tokens.refreshToken });
      if (!r.ok) {
        // A dead grant (invalid_grant) is TERMINAL — re-consent required.
        return {
          ok: false,
          reason: "error",
          message: `token refresh failed: ${r.message}`,
          terminal: r.terminal === true,
        };
      }
      refreshed = r.tokens;
      res = await doFetch(r.tokens.accessToken);
    }
  } catch (e) {
    // A thrown request is a TRANSIENT network failure. NOTHING is recorded —
    // an unreachable HMRC must block, never fall back to a guessed rate.
    return {
      ok: false,
      reason: "error",
      message: `cis verification request failed: ${e instanceof Error ? e.message : "network error"}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  if (!res.ok) {
    // 401 here (after the one refresh+retry) ⇒ the grant is dead ⇒ TERMINAL.
    if (res.status === 401) {
      return {
        ok: false,
        reason: "error",
        message: "cis verification returned 401 after token refresh; re-consent required",
        terminal: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 400 / 403 ⇒ HMRC BUSINESS rejection of the request (bad contractor
    // identifiers, malformed subcontractor identity). No retry helps.
    if (res.status === 400 || res.status === 403) {
      return {
        ok: false,
        reason: "error",
        message: `cis verification rejected by HMRC (${res.status})`,
        rejected: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 5xx / 429 / anything else ⇒ TRANSIENT — the operator may retry.
    return {
      ok: false,
      reason: "error",
      message: `cis verification returned ${res.status}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  // Success: HMRC returns the verification number + tax treatment.
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // A 2xx with an unreadable body is a provider contract violation, NOT a
    // verification — nothing may be recorded from it.
    return {
      ok: false,
      reason: "error",
      message: "cis verification returned an unreadable body",
      ...(refreshed ? { refreshed } : {}),
    };
  }

  const verificationNumber = readStr(json, ["verificationNumber", "verificationReference"]);
  const treatmentRaw = readStr(json, ["taxTreatment", "matchResult"]);
  const status = treatmentRaw !== null ? statusForTaxTreatment(treatmentRaw) : null;

  // Seam rule 1: NEVER synthesise. A 2xx that names no verification number, an
  // unknown treatment, or an implausible reference is a contract violation —
  // refuse rather than guess an outcome or truncate a reference into a new one.
  if (!verificationNumber || verificationNumber.trim().length === 0 || verificationNumber.length > 40) {
    return {
      ok: false,
      reason: "error",
      message: "cis verification answered without a usable verification number",
      ...(refreshed ? { refreshed } : {}),
    };
  }
  if (treatmentRaw === null || status === null) {
    return {
      ok: false,
      reason: "error",
      message: `cis verification answered with an unknown tax treatment${treatmentRaw ? ` '${treatmentRaw}'` : ""}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  const rate = rateForStatus(status);
  if (rate === null) {
    // Structurally unreachable (every outcome status has a rate); refuse loudly
    // rather than record a pair the domain would refuse anyway.
    return {
      ok: false,
      reason: "error",
      message: "cis verification mapped to a status with no rate",
      ...(refreshed ? { refreshed } : {}),
    };
  }

  return {
    ok: true,
    receipt: {
      verificationNumber: verificationNumber.trim(),
      taxTreatment: treatmentRaw.trim().toLowerCase() as HmrcCisTaxTreatment,
      status,
      deductionRate: rate,
      verifiedAt: isoDateOrNull(readStr(json, ["verificationDate", "processingDate"])),
    },
    ...(refreshed ? { refreshed } : {}),
  };
}

// ---------------------------------------------------------------------------
// The orchestrator — load identities + tokens, ask HMRC, record via the ONE authority
// ---------------------------------------------------------------------------

// hmrc_connections post-dates the generated types.ts; reach it through the
// same minimal structural cast server/services/hmrc-submit.ts uses.
type DbResult<T> = { data: T | null; error: { message: string } | null };
interface SelectBuilder<T> extends PromiseLike<DbResult<T[]>> {
  eq(col: string, val: unknown): SelectBuilder<T>;
  maybeSingle(): PromiseLike<DbResult<T>>;
}
interface UpdateBuilder<T> extends PromiseLike<DbResult<T[]>> {
  eq(col: string, val: unknown): UpdateBuilder<T>;
}
interface LooseTable {
  select(cols: string): SelectBuilder<Record<string, unknown>>;
  update(row: Record<string, unknown>): UpdateBuilder<Record<string, unknown>>;
}
type LooseAdmin = { from(t: string): LooseTable };

type ConnectionTokenRow = {
  status: string;
  access_token: string | null;
  refresh_token: string | null;
};

/** Persist refreshed tokens after a silent renewal, encrypted before write. Service-role, org-pinned. */
async function persistRefreshedTokens(
  admin: LooseAdmin,
  orgId: string,
  tokens: RefreshedTokens,
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

/** Flip the connection to status='error' after a TERMINAL (dead-grant) failure. Never throws. */
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

export type RequestHmrcCisVerificationResult =
  | {
      ok: true;
      /** The profile AFTER the outcome was recorded (status/rate/reference fresh). */
      profile: CisSubcontractor;
      receipt: HmrcCisVerificationReceipt;
      /**
       * needsReverification PASSTHROUGH: whether the profile's PREVIOUS
       * verification was stale (per the 20261175 staleness authority) at the
       * moment this verification was requested — i.e. whether this run was a
       * due re-verification rather than a discretionary re-check.
       */
      wasStale: boolean;
    }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "no_profile"
        | "no_utr"
        | "no_contractor_identity"
        | "rejected"
        | "error";
      message: string;
      /** The OAuth grant is dead — the org must reconnect HMRC before retrying. */
      terminal?: boolean;
    };

/**
 * Ask HMRC to verify one subcontractor and record the answer. Dark-gated,
 * org-pinned, loud. The write goes through recordVerification (source
 * 'hmrc_api') — the SAME single authority the manual path uses — so the guard
 * chain, the rate derivation and the DB constraints apply identically.
 *
 * Reads run on the tenant (user-JWT) client via the existing admin-gated CIS
 * services; ONLY the encrypted-token read uses the service-role client (the
 * token columns are stripped from the authenticated surface by design),
 * exactly like the submit orchestrators.
 */
export async function requestHmrcCisVerification(params: {
  orgId: string;
  supplierId: string;
  actorId: string;
  fraudContext?: FraudHeaderContext;
  vendor?: VendorContext;
}): Promise<RequestHmrcCisVerificationResult> {
  const { orgId, supplierId, actorId } = params;

  // ── DARK GUARD FIRST — refuse before any read or network call. ────────────
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        "HMRC online verification is not connected. Verify with HMRC's CIS online " +
        "service or the CIS helpline and record the result manually.",
    };
  }
  // A connectable HMRC MUST have a token-encryption key, or stored tokens
  // cannot be decrypted (and a refreshed token cannot be re-encrypted).
  if (!isTokenEncryptionConfigured()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "INTEGRATION_TOKEN_ENCRYPTION_KEY is not set; refusing to contact HMRC.",
    };
  }

  // ── the subcontractor's identity (tenant client, admin-only RLS) ──────────
  const profile = await getCisProfile(orgId, supplierId);
  if (!profile) {
    return {
      ok: false,
      reason: "no_profile",
      message: "Add the subcontractor's CIS details before requesting a verification.",
    };
  }
  if (!profile.utr) {
    return {
      ok: false,
      reason: "no_utr",
      message: "Record the subcontractor's UTR first — HMRC can't verify anyone without one.",
    };
  }

  // ── the contractor's OWN identity (HMRC keys the lookup on UTR + AO ref) ──
  const contractor = await getContractorProfile(orgId);
  const contractorUtr = contractor?.contractor_utr?.trim() ?? "";
  const contractorAoRef = contractor?.accounts_office_reference?.trim() ?? "";
  if (contractorUtr.length === 0 || contractorAoRef.length === 0) {
    return {
      ok: false,
      reason: "no_contractor_identity",
      message:
        "HMRC verifies against your own UTR and Accounts Office reference. Add both " +
        "under your CIS contractor details before requesting an online verification.",
    };
  }

  // The needsReverification passthrough — computed BEFORE the new outcome
  // lands, so the caller can say "this was due" vs "this was a re-check".
  const today = new Date().toISOString().slice(0, 10);
  const wasStale = needsReverification(
    {
      cis_status: profile.cis_status,
      verified_at: profile.verified_at,
      verification_expires_at: profile.verification_expires_at,
    },
    today,
  );

  // ── the org's HMRC connection + ENCRYPTED tokens (service-role only) ──────
  const admin = createAdminClient() as unknown as LooseAdmin;
  const { data: connData, error: connErr } = await admin
    .from("hmrc_connections")
    .select("status, access_token, refresh_token")
    .eq("org_id", orgId)
    .eq("provider", "hmrc")
    .maybeSingle();
  if (connErr) throw readFailure("hmrc verify: load connection", connErr);
  const connection = connData as unknown as ConnectionTokenRow | null;
  if (!connection || connection.status !== "connected" || !connection.access_token) {
    return {
      ok: false,
      reason: "not_connected",
      message: "HMRC is not connected for this organisation; cannot verify online.",
    };
  }

  // Decrypt on use, immediately before the HMRC call. decryptToken throws on a
  // wrong key or any tamper, so a corrupted token is never silently used.
  const tokens = decryptStoredTokens({
    accessToken: connection.access_token,
    refreshToken: connection.refresh_token,
  });

  const request: CisVerificationRequest = {
    legalName: profile.legal_name,
    tradingName: profile.trading_name,
    utr: profile.utr,
    companyNumber: profile.company_number,
    subcontractorType: profile.subcontractor_type,
    contractorUtr,
    contractorAccountsOfficeReference: contractorAoRef,
  };

  const fraudHeaders = buildFraudPreventionHeaders(params.fraudContext ?? {}, params.vendor ?? {});
  const result = await verifyCisSubcontractorWithHmrc({ request, tokens, fraudHeaders });

  // Persist any refreshed tokens regardless of the outcome (the refresh
  // happened; the new access token must not be lost).
  if (result.refreshed) {
    await persistRefreshedTokens(admin, orgId, result.refreshed);
  }

  if (!result.ok) {
    if (result.reason === "not_configured") {
      return { ok: false, reason: "not_configured", message: result.message };
    }
    if (result.rejected) {
      return {
        ok: false,
        reason: "rejected",
        message:
          "HMRC refused the verification request — check the subcontractor's UTR and " +
          "your contractor details, then try again or verify via HMRC's own service.",
      };
    }
    if (result.terminal) {
      await markConnectionError(admin, orgId, result.message);
      return {
        ok: false,
        reason: "error",
        terminal: true,
        message: "HMRC no longer accepts this connection — reconnect HMRC, then try again.",
      };
    }
    return {
      ok: false,
      reason: "error",
      message: "HMRC could not be reached. Nothing was recorded — try again shortly.",
    };
  }

  // ── record via the ONE write authority ────────────────────────────────────
  // The verification date: HMRC's own, when it reported one; otherwise the day
  // the request was made — an OBSERVED fact (the verification just happened),
  // never an invented HMRC value. The reference is HMRC's, verbatim; it is
  // canonicalised only when that is loss-free (whitespace/case), never mangled.
  const verifiedAt = result.receipt.verifiedAt ?? today;
  const reference =
    canonicaliseVerificationReference(result.receipt.verificationNumber) ??
    result.receipt.verificationNumber;

  const recorded = await recordVerification(
    orgId,
    supplierId,
    {
      cis_status: result.receipt.status,
      verification_reference: reference,
      verified_at: verifiedAt,
      verification_expires_at: undefined,
    },
    actorId,
    HMRC_API_VERIFICATION_SOURCE,
  );

  if (!recorded.ok) {
    // The verification DID happen at HMRC — say so honestly, but the profile
    // was not updated, so nothing pretends it was.
    return {
      ok: false,
      reason: "error",
      message: `HMRC answered, but the result could not be recorded: ${recorded.error}`,
    };
  }

  return { ok: true, profile: recorded.data, receipt: result.receipt, wasStale };
}

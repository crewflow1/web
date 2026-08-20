import "server-only";

import { isHmrcConnectable, refreshAccessTokens } from "./oauth";

import type { Cis300Return } from "./cis-return";

/**
 * HMRC CIS300 monthly return — the SUBMIT adapter: the provider HTTP half of
 * filing a prepared CIS300 return. DARK / recognition-gated.
 *
 * This is the ONLY code in the substrate that POSTs a CIS300 monthly return to
 * HMRC. It takes an already-composed CIS300 payload (lib/integrations/hmrc/
 * cis-return.ts), the contractor's HMRC handle (the employer PAYE reference the
 * scheme files under), an access/refresh token pair (decrypted by the orchestrator
 * immediately before the call) and the mandatory fraud-prevention headers, and
 * POSTs to HMRC's CIS "submit monthly return" endpoint. On a 401 it refreshes the
 * access token once and retries. It returns HMRC's receipt (processingDate /
 * submissionReference / chargeRefNumber) on success, or a classified failure.
 *
 * It mirrors lib/integrations/hmrc/vat-submit.ts EXACTLY — the same dark guard,
 * the same 401→refresh→retry, the same terminal/rejected/transient classification
 * — differing only in the endpoint, the payload type, and the receipt vocabulary
 * (a CIS async submission answers with a correlation id / receipt reference rather
 * than a VAT form-bundle number).
 *
 * ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
 * `submitCis300ReturnToHmrc` REFUSES (returns not_configured, NO `fetch`) when
 * HMRC is not connectable — the network call is structurally unreachable without
 * the HMRC client credentials AND NEXT_PUBLIC_FEATURE_HMRC_CONNECT (two-switch).
 * The single `fetch` lives strictly AFTER that guard. No token is ever logged.
 *
 * ── LEGAL / RECOGNITION BOUNDARY ────────────────────────────────────────────
 * Even once connectable, HMRC rejects a CIS submission from software it has not
 * RECOGNISED (a legal/commercial vendor-recognition gate + fraud-header
 * conformance). This adapter is the engineering half built AROUND that external
 * gate: activation is client creds + flag + HMRC recognition, all config/process,
 * no further code. Until then this never runs (the orchestrator's dark guard and
 * this module's own guard both refuse). The exact CIS endpoint path and envelope
 * are finalised at recognition; the shape here mirrors HMRC's organisations REST
 * platform (Bearer + versioned Accept + fraud headers) the recognised seam uses.
 *
 * ── FAILURE CLASSIFICATION (identical to VAT) ───────────────────────────────
 *   rejected  — HMRC answered a BUSINESS validation failure (400 / 403 with a
 *               CIS error body: bad tax month, scheme mismatch, duplicate return).
 *               The return is genuinely refused; the orchestrator records
 *               status='rejected'. No retry would help.
 *   terminal  — the OAuth grant is dead: a 401 that survived one refresh+retry,
 *               or a refresh that returned invalid_grant. Re-consent required.
 *   (neither) — TRANSIENT (5xx / 429 / network / a 2xx contract violation): the
 *               period is left retriable (orchestrator reverts to 'prepared').
 */

/** HMRC CIS production base. The submit endpoint is `/{contractorRef}/monthly-returns`. */
const CIS_API_BASE = "https://api.service.hmrc.gov.uk/organisations/cis";

/**
 * HMRC's success receipt for a submitted CIS300 return. Every field is optional
 * per the CIS contract. `submissionReference` is HMRC's async submission handle
 * (a correlation id) — the CIS analogue of a VAT form-bundle number.
 */
export type HmrcCisReceipt = {
  /** ISO 8601 timestamp HMRC recorded the submission. */
  processingDate: string | null;
  /** HMRC's unique submission reference (correlation id) for this monthly return. */
  submissionReference: string | null;
  /** The charge reference for the resulting CIS deductions liability, when one is due. */
  chargeRefNumber: string | null;
};

type RefreshedTokens = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

export type CisSubmitResult =
  | {
      ok: true;
      receipt: HmrcCisReceipt;
      /** Present only when a 401 forced a refresh; the orchestrator persists these. */
      refreshed?: RefreshedTokens;
    }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      /** HMRC BUSINESS rejection of the return itself (400/403) — record 'rejected'. */
      rejected?: boolean;
      /** The OAuth grant is dead (401 after refresh+retry, or invalid_grant) — re-consent. */
      terminal?: boolean;
      /** Present when a 401 forced a refresh before the failure; persist + reuse. */
      refreshed?: RefreshedTokens;
    };

/** Read a string field off HMRC's JSON receipt defensively (null when absent/foreign). */
function readStr(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * POST a prepared CIS300 return to HMRC's CIS submit endpoint. Dark-gated: refuses
 * (no fetch) unless HMRC is connectable. On a 401 the stored refresh token renews
 * the access token and the request is retried once; the refreshed tokens are
 * returned so the orchestrator can persist them.
 */
export async function submitCis300ReturnToHmrc(params: {
  /** The contractor's HMRC handle — the employer PAYE reference the scheme files under. */
  contractorRef: string;
  payload: Cis300Return;
  tokens: { accessToken: string; refreshToken: string | null };
  fraudHeaders: Record<string, string>;
}): Promise<CisSubmitResult> {
  const { contractorRef, payload, tokens, fraudHeaders } = params;

  // DARK GUARD FIRST. No credentials/flag → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not configured; no CIS300 return was submitted.",
    };
  }

  const url = `${CIS_API_BASE}/${encodeURIComponent(contractorRef)}/monthly-returns`;
  const bodyJson = JSON.stringify(payload);

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
    // A thrown request is a TRANSIENT network failure — the grant is not proven
    // dead and the return is not proven rejected, so leave the period retriable.
    return {
      ok: false,
      reason: "error",
      message: `cis submit request failed: ${e instanceof Error ? e.message : "network error"}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  if (!res.ok) {
    // 401 here (after the one refresh+retry) ⇒ the grant is dead ⇒ TERMINAL.
    if (res.status === 401) {
      return {
        ok: false,
        reason: "error",
        message: "cis submit returned 401 after token refresh; re-consent required",
        terminal: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 400 / 403 ⇒ HMRC BUSINESS rejection of the return (bad tax month, scheme
    // mismatch, duplicate return, malformed lines). No retry helps — the
    // orchestrator records status='rejected' with this error.
    if (res.status === 400 || res.status === 403) {
      return {
        ok: false,
        reason: "error",
        message: `cis submit rejected by HMRC (${res.status})`,
        rejected: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 5xx / 429 / anything else ⇒ TRANSIENT — leave the period retriable.
    return {
      ok: false,
      reason: "error",
      message: `cis submit returned ${res.status}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  // Success: HMRC returns 200/201 with the submission receipt.
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // A 2xx with an unreadable body is a provider contract violation, NOT a proven
    // filing — treat as transient so the period is not wrongly marked accepted.
    return {
      ok: false,
      reason: "error",
      message: "cis submit returned an unreadable receipt body",
      ...(refreshed ? { refreshed } : {}),
    };
  }

  return {
    ok: true,
    receipt: {
      processingDate: readStr(json, ["processingDate"]),
      // HMRC's async submission handle — correlation id preferred, submission id fallback.
      submissionReference: readStr(json, ["correlationId", "submissionId", "formBundleNumber"]),
      chargeRefNumber: readStr(json, ["chargeRefNumber"]),
    },
    ...(refreshed ? { refreshed } : {}),
  };
}

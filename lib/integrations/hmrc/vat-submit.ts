import "server-only";

import { isHmrcConnectable, refreshAccessTokens } from "./oauth";

import type { MtdVatReturn } from "./vat-return";

/**
 * HMRC MTD VAT — the SUBMIT adapter: the provider HTTP half of filing a prepared
 * 9-box return. DARK / recognition-gated.
 *
 * This is the ONLY code in the substrate that POSTs a VAT return to HMRC. It
 * takes an already-composed 9-box payload (lib/integrations/hmrc/vat-return.ts),
 * an access/refresh token pair (decrypted by the orchestrator immediately before
 * the call) and the mandatory fraud-prevention headers, and POSTs to the MTD VAT
 * "submit VAT return" endpoint. On a 401 it refreshes the access token once and
 * retries. It returns the HMRC receipt (processingDate / formBundleNumber /
 * chargeRefNumber / paymentIndicator) on success, or a classified failure.
 *
 * ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
 * `submitVatReturnToHmrc` REFUSES (returns not_configured, NO `fetch`) when HMRC
 * is not connectable — the network call is structurally unreachable without the
 * HMRC client credentials AND NEXT_PUBLIC_FEATURE_HMRC_CONNECT (two-switch). The
 * single `fetch` lives strictly AFTER that guard. No token is ever logged.
 *
 * ── LEGAL / RECOGNITION BOUNDARY ────────────────────────────────────────────
 * Even once connectable, HMRC rejects a submission from software it has not
 * RECOGNISED (a legal/commercial vendor-recognition gate + fraud-header
 * conformance). This adapter is the engineering half built AROUND that external
 * gate: activation is client creds + flag + HMRC recognition, all config/process,
 * no further code. Until then this never runs (the orchestrator's dark guard and
 * this module's own guard both refuse).
 *
 * ── FAILURE CLASSIFICATION ──────────────────────────────────────────────────
 *   rejected  — HMRC answered a BUSINESS validation failure (400 / 403 with a
 *               VAT error body: bad period key, VRN mismatch, duplicate period).
 *               The return is genuinely refused; the orchestrator records
 *               status='rejected' with the error. No retry would help.
 *   terminal  — the OAuth grant is dead: a 401 that survived one refresh+retry,
 *               or a refresh that returned invalid_grant. Re-consent required.
 *   (neither) — TRANSIENT (5xx / 429 / network / a 2xx contract violation): the
 *               period is left retriable (orchestrator reverts to 'prepared').
 */

/** HMRC MTD VAT production base. The submit endpoint is `/{vrn}/returns`. */
const VAT_API_BASE = "https://api.service.hmrc.gov.uk/organisations/vat";

/** HMRC's success receipt for a submitted VAT return. Every field is optional per the MTD contract. */
export type HmrcVatReceipt = {
  /** ISO 8601 timestamp HMRC recorded the submission. */
  processingDate: string | null;
  /** HMRC's unique submission reference. */
  formBundleNumber: string | null;
  /** The payment reference for the resulting VAT liability, when one is due. */
  chargeRefNumber: string | null;
  /** HMRC's payment/repayment indicator ("DD" | "BANK" | ...), when present. */
  paymentIndicator: string | null;
};

type RefreshedTokens = { accessToken: string; refreshToken: string | null; expiresAt: string | null };

export type VatSubmitResult =
  | {
      ok: true;
      receipt: HmrcVatReceipt;
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
function readStr(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * POST a prepared 9-box VAT return to HMRC's MTD VAT submit endpoint. Dark-gated:
 * refuses (no fetch) unless HMRC is connectable. On a 401 the stored refresh
 * token renews the access token and the request is retried once; the refreshed
 * tokens are returned so the orchestrator can persist them.
 */
export async function submitVatReturnToHmrc(params: {
  vrn: string;
  payload: MtdVatReturn;
  tokens: { accessToken: string; refreshToken: string | null };
  fraudHeaders: Record<string, string>;
}): Promise<VatSubmitResult> {
  const { vrn, payload, tokens, fraudHeaders } = params;

  // DARK GUARD FIRST. No credentials/flag → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not configured; no VAT return was submitted.",
    };
  }

  const url = `${VAT_API_BASE}/${encodeURIComponent(vrn)}/returns`;
  const bodyJson = JSON.stringify(payload);

  const doFetch = (accessToken: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        // Bearer token — decrypted by the orchestrator immediately before this call.
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        // MTD VAT is versioned via the Accept header.
        accept: "application/vnd.hmrc.1.0+json",
        // HMRC MANDATES the fraud-prevention headers on every MTD call.
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
      message: `vat submit request failed: ${e instanceof Error ? e.message : "network error"}`,
      ...(refreshed ? { refreshed } : {}),
    };
  }

  if (!res.ok) {
    // 401 here (after the one refresh+retry) ⇒ the grant is dead ⇒ TERMINAL.
    if (res.status === 401) {
      return {
        ok: false,
        reason: "error",
        message: "vat submit returned 401 after token refresh; re-consent required",
        terminal: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 400 / 403 ⇒ HMRC BUSINESS rejection of the return (bad period key, VRN
    // mismatch, duplicate period, malformed boxes). No retry helps — the
    // orchestrator records status='rejected' with this error.
    if (res.status === 400 || res.status === 403) {
      return {
        ok: false,
        reason: "error",
        message: `vat submit rejected by HMRC (${res.status})`,
        rejected: true,
        ...(refreshed ? { refreshed } : {}),
      };
    }
    // 5xx / 429 / anything else ⇒ TRANSIENT — leave the period retriable.
    return {
      ok: false,
      reason: "error",
      message: `vat submit returned ${res.status}`,
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
      message: "vat submit returned an unreadable receipt body",
      ...(refreshed ? { refreshed } : {}),
    };
  }

  return {
    ok: true,
    receipt: {
      processingDate: readStr(json, "processingDate"),
      formBundleNumber: readStr(json, "formBundleNumber"),
      chargeRefNumber: readStr(json, "chargeRefNumber"),
      paymentIndicator: readStr(json, "paymentIndicator"),
    },
    ...(refreshed ? { refreshed } : {}),
  };
}

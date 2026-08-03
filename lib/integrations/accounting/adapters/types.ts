/**
 * Accounting export — the provider ADAPTER seam.
 *
 * The CSV path (lib/integrations/accounting/csv.ts) needs no credentials and
 * ships live. The API push to a bookkeeping package does: it is a DARK seam
 * behind each provider's OAuth. This file defines the contract every provider
 * satisfies, so activation is only ever "supply the credentials + flag", never a
 * code change to the export pipeline.
 *
 * THE DARK-BY-DEFAULT INVARIANT. An adapter reports `isAvailable()` false
 * whenever the connect substrate is not connectable for it (flag off OR client
 * credentials absent) — which is ALWAYS, today. When unavailable,
 * `pushInvoices` / `pushPayments` MUST return an `unavailable` result WITHOUT
 * constructing a client and WITHOUT making any network request. A provider is
 * never contacted without credentials; the single `fetch` per push lives
 * strictly AFTER the `isAvailable()` guard, so it is structurally unreachable
 * dark. The security suite proves this against the adapter source.
 *
 * TOKENS COME FROM THE CONNECTION, NOT THE ENV. A push acts on ONE org's
 * connected book, so the per-org access token + provider handle (Xero tenant id /
 * QBO realm id) are resolved from `accounting_connections` (service-role read of
 * the encrypted token columns) and handed in via {@link AccountingPushInput}.
 * The adapter itself holds no per-tenant env — only the OAuth CLIENT credentials
 * gate `isAvailable()`.
 */

import type { CanonicalAccountingRow } from "../canonical";

export type AccountingProvider = "xero" | "quickbooks";

/**
 * Everything an adapter needs to push ONE org's rows to its connected book —
 * resolved (and DECRYPTED) by the connections service only AFTER the connectable
 * guard, so none of this exists on the dark path.
 */
export type AccountingPushInput = {
  /** The canonical rows to push (invoices for pushInvoices, payments for pushPayments). */
  rows: readonly CanonicalAccountingRow[];
  /** DECRYPTED access token for the connected org. */
  accessToken: string;
  /** Xero tenant id — required by the `Xero-tenant-id` header. Null for QBO. */
  tenantId?: string | null;
  /** QBO realm id — the company path segment. Null for Xero. */
  realmId?: string | null;
  /**
   * Refresh-and-persist callback. On a provider 401 the adapter calls this ONCE
   * to obtain a fresh DECRYPTED access token; the callback owns the real refresh
   * (provider token endpoint) AND the encrypted persistence of the new tokens.
   * Returns the new access token, or null when refresh is impossible (no refresh
   * token / the refresh itself failed) — in which case the adapter does NOT retry.
   */
  refresh: () => Promise<string | null>;
};

/**
 * The outcome of a push attempt.
 *   - ok               — rows accepted by the provider (unreachable today).
 *   - unavailable      — credentials absent; nothing was sent (the dark path).
 *   - error            — credentials present but the push failed.
 */
export type AccountingPushResult =
  | { ok: true; provider: AccountingProvider; pushed: number }
  | {
      ok: false;
      provider: AccountingProvider;
      reason: "unavailable" | "error";
      message: string;
    };

export interface AccountingAdapter {
  readonly provider: AccountingProvider;
  /**
   * True only when this build has the provider's OAuth credentials. A pure
   * env check — no network, never throws. Drives readiness and the UI's
   * connected/coming-soon state.
   */
  isAvailable(): boolean;
  /** Push invoice (sale) rows. Returns `unavailable` — no network — when dark. */
  pushInvoices(input: AccountingPushInput): Promise<AccountingPushResult>;
  /** Push payment (receipt) rows. Returns `unavailable` — no network — when dark. */
  pushPayments(input: AccountingPushInput): Promise<AccountingPushResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: AccountingProvider,
  message: string,
): AccountingPushResult {
  return { ok: false, provider, reason: "unavailable", message };
}

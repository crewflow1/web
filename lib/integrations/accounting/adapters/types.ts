/**
 * Accounting export — the provider ADAPTER seam.
 *
 * The CSV path (lib/integrations/accounting/csv.ts) needs no credentials and
 * ships live. The API push to a bookkeeping package does: it is a DARK seam
 * behind each provider's OAuth. This file defines the contract every provider
 * satisfies, so activation is only ever "supply the credentials", never a code
 * change to the export pipeline.
 *
 * THE DARK-BY-DEFAULT INVARIANT. An adapter reports `isAvailable()` false
 * whenever its OAuth credentials are absent from the environment — which is
 * ALWAYS, today. When unavailable, `pushInvoices` / `pushPayments` MUST return
 * an `unavailable` result WITHOUT constructing a client and WITHOUT making any
 * network request. A provider is never contacted without credentials; there is
 * no code path from "no credentials" to `fetch`. The security suite proves this
 * against the adapter source.
 */

import type { CanonicalAccountingRow } from "../canonical";

export type AccountingProvider = "xero" | "quickbooks";

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
  pushInvoices(
    rows: readonly CanonicalAccountingRow[],
  ): Promise<AccountingPushResult>;
  /** Push payment (receipt) rows. Returns `unavailable` — no network — when dark. */
  pushPayments(
    rows: readonly CanonicalAccountingRow[],
  ): Promise<AccountingPushResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: AccountingProvider,
  message: string,
): AccountingPushResult {
  return { ok: false, provider, reason: "unavailable", message };
}

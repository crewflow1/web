/**
 * Banking feed — the aggregator ADAPTER seam.
 *
 * Pulling statements from a bank via an Open Banking aggregator (TrueLayer /
 * Plaid / Nordigen-GoCardless) is a DARK seam behind the aggregator's OAuth. This
 * file defines the contract every aggregator satisfies, so activation is only
 * ever "supply the credentials + FCA authorisation", never a code change to the
 * reconciliation pipeline that consumes the mapped statements.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * Account Information Services are FCA-regulated. An adapter must NEVER contact a
 * live bank/aggregator before AISP authorisation exists. The dark-by-default
 * invariant below is the technical guarantee.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * An adapter reports `isAvailable()` false whenever the connect substrate is not
 * connectable for it (flag off / no credentials / provider unbound) — which is
 * ALWAYS, today. When unavailable, `fetchStatements` MUST return an `unavailable`
 * result WITHOUT constructing a client and WITHOUT making any network request.
 * An aggregator is never contacted without credentials; there is no code path
 * from "no credentials" to `fetch`. The security suite proves this against the
 * adapter source.
 */

import type { AggregatorStatement } from "../statement-map";

export type BankingProvider = "truelayer" | "plaid" | "nordigen";

/**
 * The outcome of a statement fetch.
 *   - ok           — statements returned by the aggregator (unreachable today).
 *   - unavailable  — not connectable; nothing was fetched (the dark path).
 *   - error        — connectable but the fetch failed.
 */
export type BankFetchResult =
  | { ok: true; provider: BankingProvider; statements: AggregatorStatement[] }
  | {
      ok: false;
      provider: BankingProvider;
      reason: "unavailable" | "error";
      message: string;
    };

/** What an adapter needs to pull statements for a connected org (unreachable dark). */
export type BankFetchInput = {
  /** DECRYPTED access token — only ever resolved after the connectable guard. */
  accessToken: string;
  /** The aggregator connection reference bound to this org. */
  connectionRef: string;
  /** Only pull transactions booked on/after this ISO date, when supported. */
  since?: string | null;
};

export interface BankingAdapter {
  readonly provider: BankingProvider;
  /**
   * True only when the connect substrate is connectable for this provider. A
   * pure env check — no network, never throws. Drives readiness and the UI's
   * connected/coming-soon state.
   */
  isAvailable(): boolean;
  /**
   * Pull statements/transactions for a connected org. Returns `unavailable` — no
   * network — when dark. The ONLY network call lives strictly AFTER the
   * availability guard.
   */
  fetchStatements(input: BankFetchInput): Promise<BankFetchResult>;
}

/** The `unavailable` result — the ONLY outcome the dark path may produce. */
export function unavailable(
  provider: BankingProvider,
  message: string,
): BankFetchResult {
  return { ok: false, provider, reason: "unavailable", message };
}

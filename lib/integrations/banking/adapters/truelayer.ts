import "server-only";

import { isBankingProviderConnectable } from "../oauth";
import type {
  BankFetchInput,
  BankFetchResult,
  BankingAdapter,
} from "./types";
import { unavailable } from "./types";
import {
  normalizeTrueLayerTransactions,
  type AggregatorStatement,
  type TrueLayerTransaction,
} from "../statement-map";

/** TrueLayer Data API base — the ONLY host this adapter contacts, and only after the guard. */
const TRUELAYER_DATA_API = "https://api.truelayer.com";

/**
 * First-sync backfill window (days) used when there is no `since` (never synced).
 * Bounds the very first pull so activation does not fetch an unbounded ~2-year
 * history; steady-state runs extend forward via the sync engine's overlap window.
 */
const FIRST_SYNC_BACKFILL_DAYS = 90;

/**
 * TrueLayer banking adapter — DARK.
 *
 * This adapter is a SEAM, not a live integration. It reports itself unavailable
 * whenever the connect substrate is not connectable (which is ALWAYS today) and
 * fetches NOTHING. There is deliberately NO TrueLayer SDK import at module scope
 * and NO client construction: a credential alone could not cause a network call,
 * and the absence of one guarantees the dark path. The single `fetch` lives
 * strictly AFTER the `isAvailable()` guard, so it is structurally unreachable
 * dark.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * TrueLayer's Data API is an Account Information Service. This adapter must NEVER
 * contact TrueLayer before FCA AISP authorisation (or agent permission under
 * TrueLayer) exists. Activation is a configuration + LEGAL act, not code.
 *
 * ACTIVATION (future): once connectable, the guarded body below pulls the account
 * transactions from the TrueLayer Data API and normalises them via
 * `normalizeTrueLayerTransactions` into the provider-agnostic shape the mapper
 * consumes. Until then this stays a no-op that can never reach a TrueLayer server.
 */
export class TrueLayerAdapter implements BankingAdapter {
  readonly provider = "truelayer" as const;

  isAvailable(): boolean {
    return isBankingProviderConnectable(this.provider);
  }

  async fetchStatements(input: BankFetchInput): Promise<BankFetchResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the
    // network. The fetch body below is unreachable until the substrate is
    // connectable (flag + credentials + FCA authorisation).
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "TrueLayer bank feed is not connected. Obtain FCA AISP authorisation and " +
          "configure the aggregator credentials to enable statement pulls.",
      );
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    // Every `fetch` below is strictly after the guard above. Two API calls:
    // (1) enumerate accounts, (2) per account pull settled transactions over a
    // date range. A 401/403 on either surfaces `unauthorized` so the caller
    // refreshes the token and retries once.
    let accountsRes: Response;
    try {
      accountsRes = await this.get("/data/v1/accounts", input.accessToken);
    } catch (e) {
      return this.networkError(e);
    }
    const accountsAuth = this.authFailure(accountsRes.status);
    if (accountsAuth) return accountsAuth;
    if (!accountsRes.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `TrueLayer /accounts returned ${accountsRes.status}`,
      };
    }

    const accountsJson = (await accountsRes.json()) as {
      results?: Array<{ account_id?: string; display_name?: string }>;
    };
    const accounts = (accountsJson.results ?? []).filter(
      (a): a is { account_id: string; display_name?: string } =>
        typeof a.account_id === "string" && a.account_id.length > 0,
    );

    // TrueLayer's transactions endpoint takes an explicit ISO from/to window. We
    // pull from `since` (or a bounded 90-day first-sync default) up to now; the
    // sync engine re-runs an overlapping window and the DB dedupes on provider_tx_id.
    const from = this.fromParam(input.since);
    const to = new Date().toISOString();

    const statements: AggregatorStatement[] = [];
    for (const acct of accounts) {
      const path =
        `/data/v1/accounts/${encodeURIComponent(acct.account_id)}/transactions` +
        `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      let txRes: Response;
      try {
        txRes = await this.get(path, input.accessToken);
      } catch (e) {
        return this.networkError(e);
      }
      const txAuth = this.authFailure(txRes.status);
      if (txAuth) return txAuth;
      if (!txRes.ok) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `TrueLayer /transactions returned ${txRes.status}`,
        };
      }
      const txJson = (await txRes.json()) as { results?: TrueLayerTransaction[] };
      statements.push({
        accountId: acct.account_id,
        accountName: acct.display_name ?? null,
        // The native TrueLayer shape → provider-agnostic transactions is done by
        // the pure `normalizeTrueLayerTransactions` mapper so the arithmetic
        // (sign / date) lives once and is unit-tested.
        transactions: normalizeTrueLayerTransactions(txJson.results ?? []),
      });
    }

    return { ok: true, provider: this.provider, statements };
  }

  /** One authenticated GET against the TrueLayer Data API. No secret is logged. */
  private get(path: string, accessToken: string): Promise<Response> {
    return fetch(`${TRUELAYER_DATA_API}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  }

  /** Map a 401/403 to the `unauthorized` outcome (drives refresh→retry); else null. */
  private authFailure(status: number): BankFetchResult | null {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unauthorized",
        message: `TrueLayer rejected the access token (${status}).`,
      };
    }
    return null;
  }

  private networkError(e: unknown): BankFetchResult {
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `TrueLayer fetch failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  /**
   * Resolve the `from` window: the `since` day, else a bounded first-sync
   * default (FIRST_SYNC_BACKFILL_DAYS back).
   *
   * A `null` since means "never synced" — the very first pull. Defaulting to a
   * ~2-year window there made the first sync unbounded: it fetched every line the
   * account had, feeding thousands of candidate ids into the dedupe read and the
   * insert path on activation. A 90-day window is a sensible first-sync backfill
   * (steady-state runs then extend forward via the 7-day overlap window in
   * bank-sync.ts, so no ongoing transaction is missed). TrueLayer's /transactions
   * endpoint returns the full window's `results` in one response with no cursor,
   * so this date cap is the bound on the first pull's size.
   */
  private fromParam(since: string | null | undefined): string {
    if (since && since.length > 0) {
      // Accept a plain date or a full ISO timestamp; TrueLayer wants ISO.
      return since.length === 10 ? `${since}T00:00:00Z` : since;
    }
    const backfill = new Date();
    backfill.setUTCDate(backfill.getUTCDate() - FIRST_SYNC_BACKFILL_DAYS);
    return backfill.toISOString();
  }
}

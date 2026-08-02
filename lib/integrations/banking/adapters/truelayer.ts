import "server-only";

import { isBankingProviderConnectable } from "../oauth";
import type {
  BankFetchInput,
  BankFetchResult,
  BankingAdapter,
} from "./types";
import { unavailable } from "./types";
import { normalizeTrueLayerTransactions, type AggregatorStatement } from "../statement-map";

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
    // The ONLY network call in this adapter, strictly after the guard above.
    let res: Response;
    try {
      res = await fetch("https://api.truelayer.com/data/v1/accounts", {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: "application/json",
        },
      });
    } catch (e) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `TrueLayer fetch failed: ${e instanceof Error ? e.message : "network error"}`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `TrueLayer returned ${res.status}`,
      };
    }

    // At activation: for each account, pull /accounts/{id}/transactions and
    // normalise. The native TrueLayer shape → provider-agnostic transactions is
    // done by the pure `normalizeTrueLayerTransactions` mapper so the arithmetic
    // (sign / date) lives once and is unit-tested.
    const json = (await res.json()) as {
      results?: Array<{ account_id?: string; display_name?: string }>;
    };
    const statements: AggregatorStatement[] = (json.results ?? []).map((acct) => ({
      accountId: acct.account_id ?? "",
      accountName: acct.display_name ?? null,
      // Activation wires the per-account transactions fetch here; the normaliser
      // is the seam that keeps the mapper provider-agnostic.
      transactions: normalizeTrueLayerTransactions([]),
    }));

    return { ok: true, provider: this.provider, statements };
  }
}

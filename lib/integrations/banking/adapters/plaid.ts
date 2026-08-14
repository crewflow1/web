import "server-only";

import { isBankingProviderConnectable, resolveBankingClientCredentials } from "../oauth";
import type {
  BankFetchInput,
  BankFetchResult,
  BankingAdapter,
} from "./types";
import { unavailable } from "./types";
import {
  normalizePlaidTransactions,
  type AggregatorStatement,
  type PlaidTransaction,
} from "../statement-map";

/**
 * Plaid API host. Plaid ships THREE environments on distinct hosts
 * (sandbox / development / production); the default is production and an operator
 * may point PLAID_API_BASE_URL at another Plaid host. The override is
 * SSRF-guarded (see resolveApiBase) so it can NEVER be re-pointed at an internal
 * address, an IP literal, or a non-Plaid domain — the only host this adapter
 * contacts, and only after the guard.
 */
const PLAID_DEFAULT_API = "https://production.plaid.com";
/** The only domain a PLAID_API_BASE_URL override may resolve to. */
const PLAID_ALLOWED_DOMAIN = "plaid.com";

/**
 * First-sync backfill window (days) when there is no `since` (never synced).
 * Bounds the very first pull so activation does not fetch an unbounded history;
 * steady-state runs extend forward via the sync engine's overlap window. Matches
 * the sibling TrueLayer adapter's first-sync bound.
 */
const FIRST_SYNC_BACKFILL_DAYS = 90;

/**
 * Max transactions per `/transactions/get` page (Plaid's ceiling is 500) and the
 * page cap that bounds the offset loop so a pathological `total_transactions`
 * cannot run the pull forever and blow the cron budget. 40 pages × 500 = 20,000
 * transactions per org window — far beyond any realistic CrewFlow tenant while
 * staying inside the bank-sync pass budget.
 */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * Plaid banking adapter — DARK.
 *
 * A SEAM, not a live integration. It reports itself unavailable whenever the
 * connect substrate is not connectable (which is ALWAYS today) and fetches
 * NOTHING. There is deliberately NO Plaid SDK import at module scope and NO client
 * construction: a credential alone could not cause a network call, and the absence
 * of one guarantees the dark path. Every `fetch` lives strictly AFTER the
 * `isAvailable()` guard, so it is structurally unreachable dark.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * Plaid's transactions product is an Account Information Service. This adapter
 * must NEVER contact Plaid before FCA AISP authorisation (or agent permission)
 * exists. Activation is a configuration + LEGAL act, not code.
 *
 * ── PLAID AUTH MODEL (differs from TrueLayer/Nordigen) ──────────────────────
 * Plaid does NOT use a Bearer token. Every Data API request authenticates with
 * the app `client_id` + `secret` (from BANKING_CLIENT_ID/SECRET, resolved via the
 * oauth seam) AND the per-item `access_token` (input.accessToken, the stored,
 * decrypted token) in the JSON body. `input.connectionRef` is the Plaid item_id;
 * it is not needed for the transactions pull (the access_token identifies the
 * item) but is carried for parity with the interface.
 *
 * ACTIVATION (future): once connectable, the guarded body below pulls the item's
 * transactions from `/transactions/get` over a bounded date window with OFFSET
 * pagination (F-1), groups them per account, and normalises via
 * `normalizePlaidTransactions` into the provider-agnostic shape the mapper
 * consumes (Plaid signs money-out positive — the normaliser flips it). Until then
 * this stays a no-op that can never reach a Plaid server.
 */
export class PlaidAdapter implements BankingAdapter {
  readonly provider = "plaid" as const;

  isAvailable(): boolean {
    return isBankingProviderConnectable(this.provider);
  }

  async fetchStatements(input: BankFetchInput): Promise<BankFetchResult> {
    // DARK GUARD FIRST. With no credentials we return without touching the
    // network. Everything below is unreachable until the substrate is connectable
    // (flag + credentials + FCA authorisation).
    if (!this.isAvailable()) {
      return unavailable(
        this.provider,
        "Plaid bank feed is not connected. Obtain FCA AISP authorisation and " +
          "configure the aggregator credentials to enable statement pulls.",
      );
    }

    // Post-guard, credentials are guaranteed present; refuse defensively if not
    // (never construct a request without the secret it needs).
    const client = resolveBankingClientCredentials();
    if (!client) {
      return unavailable(
        this.provider,
        "Plaid bank feed is not connected (no client credentials).",
      );
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    const base = resolveApiBase();
    const startDate = this.fromParam(input.since);
    const endDate = new Date().toISOString().slice(0, 10);

    // OFFSET PAGINATION (F-1). `/transactions/get` returns `total_transactions`
    // for the window and one page of `transactions`; loop offset until we have
    // them all, bounded by MAX_PAGES. Accounts come back on every page — capture
    // them once so every account (even one with no tx in the window) yields a
    // statement.
    const allTx: PlaidTransaction[] = [];
    let accounts: Array<{ account_id?: string | null; name?: string | null; official_name?: string | null }> = [];
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      let res: Response;
      try {
        res = await this.post(`${base}/transactions/get`, {
          client_id: client.clientId,
          secret: client.clientSecret,
          access_token: input.accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: PAGE_SIZE, offset },
        });
      } catch (e) {
        return this.networkError(e);
      }
      const auth = this.authFailure(res.status);
      if (auth) return auth;
      if (!res.ok) {
        return {
          ok: false,
          provider: this.provider,
          reason: "error",
          message: `Plaid /transactions/get returned ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        accounts?: Array<{ account_id?: string | null; name?: string | null; official_name?: string | null }>;
        transactions?: PlaidTransaction[];
        total_transactions?: number;
      };
      // Bind the external-API fields to locals BEFORE coalescing so the loud-read
      // shape ledger never mistakes this HTTP JSON for a Supabase read (the
      // sibling adapters do the same for `results` / `data`).
      const pageAccounts = json.accounts;
      const pageTx = json.transactions;
      const pageTotal = json.total_transactions;
      if (page === 0 && pageAccounts && pageAccounts.length > 0) accounts = pageAccounts;
      if (pageTx && pageTx.length > 0) allTx.push(...pageTx);
      total = typeof pageTotal === "number" ? pageTotal : allTx.length;
      // Advance; stop early if the provider returned a short page (defends against
      // a total that never converges).
      if (!pageTx || pageTx.length === 0) break;
      offset += pageTx.length;
    }

    // Group transactions per account so the mapper writes one bank_statement per
    // account (as TrueLayer does). Accounts with no transactions in the window
    // still appear as an empty statement.
    const statements: AggregatorStatement[] = accounts
      .filter((a): a is { account_id: string; name?: string | null; official_name?: string | null } =>
        typeof a.account_id === "string" && a.account_id.length > 0,
      )
      .map((a) => ({
        accountId: a.account_id,
        accountName: a.official_name ?? a.name ?? null,
        transactions: normalizePlaidTransactions(
          allTx.filter((t) => t.account_id === a.account_id),
        ),
      }));

    // Defensive: if Plaid returned transactions but no accounts array (should not
    // happen), fall back to a single synthetic statement so nothing is dropped.
    if (statements.length === 0 && allTx.length > 0) {
      statements.push({
        accountId: input.connectionRef,
        accountName: null,
        transactions: normalizePlaidTransactions(allTx),
      });
    }

    return { ok: true, provider: this.provider, statements };
  }

  /** One authenticated POST against the Plaid API. No secret is logged. */
  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  /** Map a 401/403 to the `unauthorized` outcome (drives refresh→retry); else null. */
  private authFailure(status: number): BankFetchResult | null {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        provider: this.provider,
        reason: "unauthorized",
        message: `Plaid rejected the access token (${status}).`,
      };
    }
    return null;
  }

  private networkError(e: unknown): BankFetchResult {
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `Plaid fetch failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  /**
   * Resolve the `start_date` window: the `since` day, else a bounded first-sync
   * default (FIRST_SYNC_BACKFILL_DAYS back). Plaid wants `YYYY-MM-DD`.
   */
  private fromParam(since: string | null | undefined): string {
    if (since && since.length >= 10) return since.slice(0, 10);
    const backfill = new Date();
    backfill.setUTCDate(backfill.getUTCDate() - FIRST_SYNC_BACKFILL_DAYS);
    return backfill.toISOString().slice(0, 10);
  }
}

/**
 * Resolve the Plaid API base URL — SSRF GUARD. An operator override
 * (PLAID_API_BASE_URL) must be https and resolve to the Plaid domain; anything
 * else (an IP literal, an internal host, a non-Plaid domain, or an unparseable
 * value) falls back to the production host. This is the banking analogue of the
 * webhook SSRF policy: a tenant/operator-influenced value can never steer the
 * adapter at an arbitrary host. Pure — no network.
 */
function resolveApiBase(): string {
  const override = process.env.PLAID_API_BASE_URL;
  if (typeof override !== "string" || override.trim().length === 0) {
    return PLAID_DEFAULT_API;
  }
  try {
    const u = new URL(override.trim());
    if (u.protocol !== "https:") return PLAID_DEFAULT_API;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (host === PLAID_ALLOWED_DOMAIN || host.endsWith(`.${PLAID_ALLOWED_DOMAIN}`)) {
      return `${u.protocol}//${u.host}`;
    }
    return PLAID_DEFAULT_API;
  } catch {
    return PLAID_DEFAULT_API;
  }
}

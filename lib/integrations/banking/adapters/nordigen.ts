import "server-only";

import { isBankingProviderConnectable } from "../oauth";
import type {
  BankFetchInput,
  BankFetchResult,
  BankingAdapter,
} from "./types";
import { unavailable } from "./types";
import {
  normalizeNordigenTransactions,
  type AggregatorStatement,
  type NordigenTransaction,
} from "../statement-map";

/**
 * Nordigen / GoCardless Bank Account Data API host. The default is the production
 * host; an operator may point NORDIGEN_API_BASE_URL at a self-hosted proxy. The
 * override is SSRF-guarded (see resolveApiBase) so it can NEVER be re-pointed at
 * an internal address, an IP literal, or a non-GoCardless domain — the only host
 * this adapter contacts, and only after the guard.
 */
const NORDIGEN_DEFAULT_API = "https://bankaccountdata.gocardless.com";
/** The only domain a NORDIGEN_API_BASE_URL override may resolve to. */
const NORDIGEN_ALLOWED_DOMAIN = "gocardless.com";

/**
 * First-sync backfill window (days) when there is no `since` (never synced).
 * Bounds the very first pull so activation does not fetch an unbounded history;
 * steady-state runs extend forward via the sync engine's overlap window. Matches
 * the sibling adapters' first-sync bound.
 */
const FIRST_SYNC_BACKFILL_DAYS = 90;

/**
 * Max accounts iterated per requisition — a bound so a pathological requisition
 * cannot run the pull forever and blow the cron budget. A real requisition binds
 * a handful of accounts; 50 is far beyond any realistic tenant.
 */
const MAX_ACCOUNTS = 50;

/**
 * Nordigen / GoCardless Bank Account Data adapter — DARK.
 *
 * A SEAM, not a live integration. It reports itself unavailable whenever the
 * connect substrate is not connectable (which is ALWAYS today) and fetches
 * NOTHING. There is deliberately NO SDK import at module scope and NO client
 * construction: a credential alone could not cause a network call, and the absence
 * of one guarantees the dark path. Every `fetch` lives strictly AFTER the
 * `isAvailable()` guard, so it is structurally unreachable dark.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * GoCardless Bank Account Data is an Account Information Service. This adapter
 * must NEVER contact the aggregator before FCA AISP authorisation (or agent
 * permission) exists. Activation is a configuration + LEGAL act, not code.
 *
 * ── NORDIGEN MODEL ──────────────────────────────────────────────────────────
 * `input.connectionRef` is the REQUISITION id — the handle bound to the tenant's
 * consent — and `input.accessToken` is the Bearer access token (minted via the
 * /token/new/ flow, refreshed by the oauth seam). The pull is two steps:
 *   (1) GET /api/v2/requisitions/{ref}/  → the account ids the consent covers,
 *   (2) per account, GET /api/v2/accounts/{id}/transactions/?date_from=…  → the
 *       booked transactions, normalised via `normalizeNordigenTransactions` into
 *       the provider-agnostic shape the mapper consumes (Nordigen amounts are
 *       signed decimal STRINGS; the normaliser owns the sign).
 * Only BOOKED transactions are imported — pending lines are not settled and would
 * churn/duplicate against their eventual booked form (which carries the stable id
 * the dedupe key relies on).
 */
export class NordigenAdapter implements BankingAdapter {
  readonly provider = "nordigen" as const;

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
        "Nordigen (GoCardless Bank Account Data) bank feed is not connected. Obtain " +
          "FCA AISP authorisation and configure the aggregator credentials to enable " +
          "statement pulls.",
      );
    }

    if (!input.connectionRef) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: "Nordigen requires a requisition reference; none was bound to this connection.",
      };
    }

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────────
    const base = resolveApiBase();
    const dateFrom = this.fromParam(input.since);

    // (1) The requisition names the account ids the tenant's consent covers.
    let reqRes: Response;
    try {
      reqRes = await this.get(
        `${base}/api/v2/requisitions/${encodeURIComponent(input.connectionRef)}/`,
        input.accessToken,
      );
    } catch (e) {
      return this.networkError(e);
    }
    const reqAuth = this.authFailure(reqRes.status);
    if (reqAuth) return reqAuth;
    if (!reqRes.ok) {
      return {
        ok: false,
        provider: this.provider,
        reason: "error",
        message: `Nordigen /requisitions returned ${reqRes.status}`,
      };
    }
    const reqJson = (await reqRes.json()) as { accounts?: string[] };
    // Bind before coalescing (loud-read shape ledger parity with the siblings).
    const reqAccounts = reqJson.accounts;
    const accountIds = (reqAccounts ?? [])
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, MAX_ACCOUNTS);

    // (2) Per account, pull the booked transactions for the window.
    const statements: AggregatorStatement[] = [];
    for (const accountId of accountIds) {
      const path =
        `${base}/api/v2/accounts/${encodeURIComponent(accountId)}/transactions/` +
        `?date_from=${encodeURIComponent(dateFrom)}`;
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
          message: `Nordigen /transactions returned ${txRes.status}`,
        };
      }
      const txJson = (await txRes.json()) as {
        transactions?: { booked?: NordigenTransaction[]; pending?: NordigenTransaction[] };
      };
      // Bind before coalescing; import ONLY booked (settled) transactions.
      const booked = txJson.transactions?.booked;
      statements.push({
        accountId,
        accountName: null,
        transactions: normalizeNordigenTransactions(booked ?? []),
      });
    }

    return { ok: true, provider: this.provider, statements };
  }

  /** One authenticated GET against the GoCardless API. No secret is logged. */
  private get(url: string, accessToken: string): Promise<Response> {
    return fetch(url, {
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
        message: `Nordigen rejected the access token (${status}).`,
      };
    }
    return null;
  }

  private networkError(e: unknown): BankFetchResult {
    return {
      ok: false,
      provider: this.provider,
      reason: "error",
      message: `Nordigen fetch failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  /**
   * Resolve the `date_from` window: the `since` day, else a bounded first-sync
   * default (FIRST_SYNC_BACKFILL_DAYS back). GoCardless wants `YYYY-MM-DD`.
   */
  private fromParam(since: string | null | undefined): string {
    if (since && since.length >= 10) return since.slice(0, 10);
    const backfill = new Date();
    backfill.setUTCDate(backfill.getUTCDate() - FIRST_SYNC_BACKFILL_DAYS);
    return backfill.toISOString().slice(0, 10);
  }
}

/**
 * Resolve the GoCardless API base URL — SSRF GUARD. An operator override
 * (NORDIGEN_API_BASE_URL) must be https and resolve to the GoCardless domain;
 * anything else (an IP literal, an internal host, a non-GoCardless domain, or an
 * unparseable value) falls back to the production host. The banking analogue of
 * the webhook SSRF policy: an operator-influenced value can never steer the
 * adapter at an arbitrary host. Pure — no network.
 */
function resolveApiBase(): string {
  const override = process.env.NORDIGEN_API_BASE_URL;
  if (typeof override !== "string" || override.trim().length === 0) {
    return NORDIGEN_DEFAULT_API;
  }
  try {
    const u = new URL(override.trim());
    if (u.protocol !== "https:") return NORDIGEN_DEFAULT_API;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (host === NORDIGEN_ALLOWED_DOMAIN || host.endsWith(`.${NORDIGEN_ALLOWED_DOMAIN}`)) {
      return `${u.protocol}//${u.host}`;
    }
    return NORDIGEN_DEFAULT_API;
  } catch {
    return NORDIGEN_DEFAULT_API;
  }
}

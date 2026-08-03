import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  getBankingAdapter,
  bankingProviderReady,
  type BankingProvider,
} from "@/lib/integrations/banking/adapters";
import {
  refreshAccessToken,
  resolveActiveBankingProvider,
  decryptStoredTokens,
} from "@/lib/integrations/banking/oauth";
import { encryptToken } from "@/lib/integrations/token-crypto";
import {
  mapStatementToLines,
  type BankStatementLineInsert,
} from "@/lib/integrations/banking/statement-map";

/**
 * Bank-feed SYNC ENGINE — the (dark) activation path that pulls an org's bank
 * transactions via the aggregator and writes them into the EXISTING
 * bank_statement_lines reconciliation tables, idempotently.
 *
 * ── WHY A SEPARATE FILE FROM bank-connections.ts ────────────────────────────
 * The tenant-facing service (bank-connections.ts) is deliberately token-FREE: it
 * never selects a token column, so no tenant surface can read a secret back. THIS
 * engine, by contrast, MUST read the encrypted tokens to call the aggregator, so
 * it runs ONLY under the service-role admin client (never a tenant JWT) and lives
 * apart so the token-free invariant of the tenant service stays structurally
 * true. It is invoked by the CRON_SECRET-gated /api/cron/bank-sync route.
 *
 * ── FCA LEGAL BOUNDARY + DARK-BY-DEFAULT ────────────────────────────────────
 * Account Information Services are FCA-regulated. The engine REFUSES before any
 * network call or DB read when the provider is not ready (no credentials / flag
 * off / unbound / FCA-ungated) — `bankingProviderReady` is false today, so a run
 * is a `skipped_dark` no-op that touches nothing. The adapter itself also refuses
 * before fetch; this engine's guard is the outer belt.
 *
 * ── TOKEN LIFECYCLE ─────────────────────────────────────────────────────────
 * Tokens are stored AES-256-GCM encrypted (token-crypto). The engine decrypts on
 * use, PROACTIVELY refreshes when the stored expiry is past/near, and REACTIVELY
 * refreshes + retries once on an `unauthorized` fetch. A refreshed token is
 * re-encrypted and written back. No secret is ever logged.
 *
 * ── IDEMPOTENCY (#456 org-pinned) ───────────────────────────────────────────
 * Every fetched transaction carries the aggregator's stable id
 * (provider_tx_id, 20261109). Before inserting, the engine reads back which of the
 * candidate ids already exist for THIS org and inserts only the new ones, under a
 * fresh bank_statements parent created only when there is something to insert. The
 * partial UNIQUE index (org_id, provider_tx_id) is the belt-and-suspenders under a
 * race. A re-run over an overlapping window therefore adds ZERO duplicate lines
 * and ZERO empty parent statements. All writes are org-pinned to the row's org.
 */

/** How close to expiry (ms) triggers a proactive refresh before the fetch. */
const REFRESH_SKEW_MS = 60_000;
/** Overlap window (days) subtracted from last_sync_at so a boundary tx is never missed (dedupe absorbs it). */
const SYNC_OVERLAP_DAYS = 7;
/**
 * How many provider_tx_ids to send per dedupe `.in()` query.
 *
 * supabase-js `.in()` on a `.select()` is a GET — every id is serialised into the
 * URL query string. A first sync feeds the FULL candidate list (potentially
 * thousands of ~50-char TrueLayer ids), which overflows the ~8KB request-line
 * limit (→ 414/400) at only a few hundred ids and throws the whole read. At 100
 * ids the `provider_tx_id=in.(...)` filter stays well under the limit even for
 * long (~55-char) ids — measured against the local PostgREST/Kong stack, which
 * already returns 414 for a 200-id batch of such ids. The dedupe read is chunked
 * at this size and the returned id sets unioned; every chunk keeps the org_id pin.
 */
const DEDUPE_IN_CHUNK = 100;

export type BankSyncOutcome =
  | "mapped"
  | "no_new"
  | "skipped_dark"
  | "not_connected"
  | "error";

export type BankSyncResult = {
  ok: boolean;
  orgId: string;
  provider: BankingProvider;
  outcome: BankSyncOutcome;
  inserted: number;
  message: string;
};

/** A connection row INCLUDING the encrypted token columns — service-role only. */
export type StoredBankConnection = {
  orgId: string;
  provider: BankingProvider;
  status: string;
  connectionRef: string | null;
  accessTokenCipher: string | null;
  refreshTokenCipher: string | null;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
};

/**
 * The DB gateway the engine writes/reads through. Abstracted so a test can drive
 * the engine against an in-memory fake without a live Supabase. The default
 * implementation uses the service-role admin client.
 */
export interface BankSyncGateway {
  /** All `connected` connections for the bound provider across every org (service-role). */
  listConnected(provider: BankingProvider): Promise<StoredBankConnection[]>;
  /** Persist refreshed tokens (already encrypted) for a connection. */
  saveRefreshedTokens(
    orgId: string,
    provider: BankingProvider,
    tokens: { accessTokenCipher: string; refreshTokenCipher: string | null; tokenExpiresAt: string | null },
  ): Promise<void>;
  /** Which of `providerTxIds` already exist for this org (dedupe read, org-pinned). */
  existingProviderTxIds(orgId: string, providerTxIds: string[]): Promise<Set<string>>;
  /** Create a bank_statements parent row and return its id (org-pinned). */
  createStatement(orgId: string, filename: string, lineCount: number): Promise<string>;
  /** Insert statement lines (org-pinned), skipping any that collide on the dedupe key. */
  insertLines(rows: BankStatementLineInsert[]): Promise<void>;
  /** Stamp last_sync_at (+ optional last_error / status) on a connection. */
  markSynced(
    orgId: string,
    provider: BankingProvider,
    fields: { lastError: string | null; status?: string },
  ): Promise<void>;
}

/** Is the stored expiry absent or within the skew window (⇒ refresh first)? */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t - Date.now() <= REFRESH_SKEW_MS;
}

/** Derive the `since` date from last_sync_at minus an overlap window; null when never synced. */
function sinceFrom(lastSyncAt: string | null): string | null {
  if (!lastSyncAt) return null;
  const t = Date.parse(lastSyncAt);
  if (Number.isNaN(t)) return null;
  const d = new Date(t - SYNC_OVERLAP_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Sync ONE connection. Dark-safe (refuses before fetch when the provider is not
 * ready). Never throws — failures are captured into the result + last_error.
 */
export async function syncBankConnection(
  conn: StoredBankConnection,
  gateway: BankSyncGateway,
): Promise<BankSyncResult> {
  const { provider, orgId } = conn;
  const adapter = getBankingAdapter(provider);

  // OUTER DARK GUARD: refuse before any fetch or token decrypt.
  if (!adapter.isAvailable()) {
    return {
      ok: false,
      orgId,
      provider,
      outcome: "skipped_dark",
      inserted: 0,
      message: `${provider} bank feed is not connected; nothing was fetched.`,
    };
  }

  if (conn.status !== "connected" || !conn.connectionRef || !conn.accessTokenCipher) {
    return {
      ok: false,
      orgId,
      provider,
      outcome: "not_connected",
      inserted: 0,
      message: `${provider} is not fully connected for this org.`,
    };
  }

  try {
    // Decrypt-on-use, then proactively refresh if the token is expired/near.
    let { accessToken, refreshToken } = decryptStoredTokens({
      accessToken: conn.accessTokenCipher,
      refreshToken: conn.refreshTokenCipher,
    });

    if (isExpired(conn.tokenExpiresAt) && refreshToken) {
      const refreshed = await refreshAndPersist(orgId, provider, refreshToken, gateway);
      if (!refreshed.ok) {
        await gateway.markSynced(orgId, provider, { lastError: refreshed.message, status: "error" });
        return { ok: false, orgId, provider, outcome: "error", inserted: 0, message: refreshed.message };
      }
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken;
    }

    const since = sinceFrom(conn.lastSyncAt);
    let fetched = await adapter.fetchStatements({
      accessToken,
      connectionRef: conn.connectionRef,
      since,
    });

    // Reactive refresh: on an unauthorized fetch, refresh once and retry once.
    if (!fetched.ok && fetched.reason === "unauthorized" && refreshToken) {
      const refreshed = await refreshAndPersist(orgId, provider, refreshToken, gateway);
      if (!refreshed.ok) {
        await gateway.markSynced(orgId, provider, { lastError: refreshed.message, status: "error" });
        return { ok: false, orgId, provider, outcome: "error", inserted: 0, message: refreshed.message };
      }
      accessToken = refreshed.accessToken;
      fetched = await adapter.fetchStatements({
        accessToken,
        connectionRef: conn.connectionRef,
        since,
      });
    }

    if (!fetched.ok) {
      const outcome: BankSyncOutcome = fetched.reason === "unavailable" ? "skipped_dark" : "error";
      if (outcome === "error") {
        await gateway.markSynced(orgId, provider, { lastError: fetched.message, status: "error" });
      }
      return { ok: false, orgId, provider, outcome, inserted: 0, message: fetched.message };
    }

    // Map every fetched statement to candidate lines (bank_statement_id is filled
    // only after we know there are NEW lines to write).
    const PLACEHOLDER = "";
    const candidates = fetched.statements.flatMap((s) =>
      mapStatementToLines(s, { orgId, bankStatementId: PLACEHOLDER }),
    );

    const candidateIds = candidates
      .map((r) => r.provider_tx_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const existing = await gateway.existingProviderTxIds(orgId, candidateIds);

    // Dedupe within this batch too (an aggregator could echo a tx twice).
    const seen = new Set<string>();
    const newLines = candidates.filter((r) => {
      const id = r.provider_tx_id;
      if (!id) return true; // lines without an id can't be deduped; keep them
      if (existing.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (newLines.length === 0) {
      await gateway.markSynced(orgId, provider, { lastError: null });
      return { ok: true, orgId, provider, outcome: "no_new", inserted: 0, message: "No new transactions." };
    }

    const filename = `${provider} feed ${new Date().toISOString().slice(0, 10)}`;
    const statementId = await gateway.createStatement(orgId, filename, newLines.length);
    const rows = newLines.map((r) => ({ ...r, bank_statement_id: statementId }));
    await gateway.insertLines(rows);
    await gateway.markSynced(orgId, provider, { lastError: null });

    return {
      ok: true,
      orgId,
      provider,
      outcome: "mapped",
      inserted: rows.length,
      message: `Imported ${rows.length} new transactions.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "bank sync failed";
    // Do not log the token payload — only a coarse failure signal.
    console.error("[banking] sync failed", { provider, orgId, message });
    await gateway.markSynced(orgId, provider, { lastError: message, status: "error" }).catch(() => {});
    return { ok: false, orgId, provider, outcome: "error", inserted: 0, message };
  }
}

/** Refresh the access token and persist the (re-encrypted) result. */
async function refreshAndPersist(
  orgId: string,
  provider: BankingProvider,
  refreshToken: string,
  gateway: BankSyncGateway,
): Promise<{ ok: true; accessToken: string; refreshToken: string } | { ok: false; message: string }> {
  const res = await refreshAccessToken({ provider, refreshToken });
  if (!res.ok) return { ok: false, message: res.message };
  const newRefresh = res.tokens.refreshToken ?? refreshToken;
  await gateway.saveRefreshedTokens(orgId, provider, {
    accessTokenCipher: encryptToken(res.tokens.accessToken),
    refreshTokenCipher: encryptToken(newRefresh),
    tokenExpiresAt: res.tokens.expiresAt,
  });
  return { ok: true, accessToken: res.tokens.accessToken, refreshToken: newRefresh };
}

/**
 * Sync EVERY connected org for the bound provider. Dark-safe: returns a single
 * `skipped_dark` summary WITHOUT touching the DB when no provider is ready.
 * Invoked by the cron route. Never throws.
 */
export async function runBankSync(
  gateway: BankSyncGateway = createAdminGateway(),
): Promise<{ ran: boolean; provider: BankingProvider | null; results: BankSyncResult[] }> {
  const provider = resolveActiveBankingProvider();
  if (!provider || !bankingProviderReady(provider)) {
    return { ran: false, provider, results: [] };
  }
  const connections = await gateway.listConnected(provider);
  const results: BankSyncResult[] = [];
  for (const conn of connections) {
    results.push(await syncBankConnection(conn, gateway));
  }
  return { ran: true, provider, results };
}

// ── Default gateway over the service-role admin client ────────────────────────
// The ONLY place the encrypted token columns are read back, and only under the
// service role (never a tenant JWT). All writes are org-pinned to the row's org.

type LooseAdmin = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
        in: (col: string, vals: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
    insert: (row: unknown) => {
      select: (c: string) => {
        single: () => PromiseLike<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    } & PromiseLike<{ error: { message: string } | null }>;
    upsert: (
      rows: unknown,
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ) => PromiseLike<{ error: { message: string } | null }>;
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
      };
    };
  };
};

export function createAdminGateway(): BankSyncGateway {
  const admin = createAdminClient() as unknown as LooseAdmin;

  return {
    async listConnected(provider) {
      const { data, error } = await admin
        .from("bank_connections")
        .select(
          "org_id, provider, status, connection_ref, access_token, refresh_token, token_expires_at, last_sync_at",
        )
        .eq("provider", provider)
        .eq("status", "connected");
      if (error) throw new Error(`bank-sync: listConnected failed: ${error.message}`);
      return ((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
        orgId: String(r.org_id),
        provider: r.provider as BankingProvider,
        status: String(r.status),
        connectionRef: (r.connection_ref as string | null) ?? null,
        accessTokenCipher: (r.access_token as string | null) ?? null,
        refreshTokenCipher: (r.refresh_token as string | null) ?? null,
        tokenExpiresAt: (r.token_expires_at as string | null) ?? null,
        lastSyncAt: (r.last_sync_at as string | null) ?? null,
      }));
    },

    async saveRefreshedTokens(orgId, provider, tokens) {
      const { error } = await admin
        .from("bank_connections")
        .update({
          access_token: tokens.accessTokenCipher,
          refresh_token: tokens.refreshTokenCipher,
          token_expires_at: tokens.tokenExpiresAt,
        })
        .eq("org_id", orgId)
        .eq("provider", provider);
      if (error) throw new Error(`bank-sync: saveRefreshedTokens failed: ${error.message}`);
    },

    async existingProviderTxIds(orgId, providerTxIds) {
      if (providerTxIds.length === 0) return new Set();
      // CHUNKED: `.in()` on a `.select()` is a GET, so the ids ride in the URL
      // query string. A first sync's full candidate list overflows the request-
      // line limit (→ 414/400) in ONE query; split into DEDUPE_IN_CHUNK batches
      // and union the returned id sets. Every batch keeps the org_id pin.
      const set = new Set<string>();
      for (let i = 0; i < providerTxIds.length; i += DEDUPE_IN_CHUNK) {
        const batch = providerTxIds.slice(i, i + DEDUPE_IN_CHUNK);
        const { data, error } = await admin
          .from("bank_statement_lines")
          .select("provider_tx_id")
          .eq("org_id", orgId)
          .in("provider_tx_id", batch);
        if (error) throw new Error(`bank-sync: existingProviderTxIds failed: ${error.message}`);
        for (const r of (data as Array<{ provider_tx_id: string | null }>) ?? []) {
          if (r.provider_tx_id) set.add(r.provider_tx_id);
        }
      }
      return set;
    },

    async createStatement(orgId, filename, lineCount) {
      const { data, error } = await admin
        .from("bank_statements")
        .insert({ org_id: orgId, filename, line_count: lineCount })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(`bank-sync: createStatement failed: ${error?.message ?? "no id"}`);
      }
      return data.id;
    },

    async insertLines(rows) {
      const { error } = await admin
        .from("bank_statement_lines")
        .upsert(rows, { onConflict: "org_id,provider_tx_id", ignoreDuplicates: true });
      if (error) throw new Error(`bank-sync: insertLines failed: ${error.message}`);
    },

    async markSynced(orgId, provider, fields) {
      const patch: Record<string, unknown> = {
        last_sync_at: new Date().toISOString(),
        last_error: fields.lastError,
      };
      if (fields.status) patch.status = fields.status;
      const { error } = await admin
        .from("bank_connections")
        .update(patch)
        .eq("org_id", orgId)
        .eq("provider", provider);
      if (error) throw new Error(`bank-sync: markSynced failed: ${error.message}`);
    },
  };
}

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
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
import { safeBatchWrite } from "@/lib/supabase/safe-batch-write";
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
/**
 * Minimum wait (ms) before a connection that recorded a TRANSIENT error is retried.
 *
 * Transient failures keep the connection status='connected' (so the cron keeps
 * selecting it) and stamp last_error, but DO NOT advance last_sync_at (the success-
 * only sync cursor). This floor is measured from updated_at — bumped by the row
 * trigger on the failure write, so it tracks the last ATTEMPT — and stops a hard-
 * down provider from being re-hit on back-to-back ticks (e.g. a manual cron
 * re-trigger) while still guaranteeing recovery on the next scheduled 6-hourly run.
 * A FIXED floor — not exponential — is deliberate: a
 * growing backoff would need a per-connection failure counter (a new column ⇒ a
 * migration), and the scheduled cadence already bounds steady-state retries.
 */
const RETRY_BACKOFF_MS = 30 * 60_000;

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

/** The outcome of writing the mapped lines, splitting transient from constraint errors. */
export type BankLinesWriteResult = {
  /** Rows actually inserted (new; duplicates ignored), summed across chunks/rows. */
  inserted: number;
  /** A DB constraint violation was seen and contained via per-row fallback — TERMINAL. */
  constraintError: string | null;
  /** A non-constraint (network/infra) write error — caller keeps the feed live to self-heal. */
  transientError: string | null;
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
  /**
   * The SYNC CURSOR: the timestamp of the last SUCCESSFUL sync (or null when never
   * synced). The `since` window derives SOLELY from this (sinceFrom), so it must be
   * advanced ONLY when a fetch actually succeeds — never on a transient/terminal
   * failure, or a single blip would fast-forward the cursor past unimported days.
   */
  lastSyncAt: string | null;
  /**
   * Row-level last-write time, bumped by the DB trigger on EVERY update (including
   * failure writes that leave last_sync_at untouched). Anchors the retry backoff in
   * `isDueForSync` so a recovering connection is retried on schedule off the last
   * ATTEMPT, without conflating attempt-time with the success-only sync cursor.
   */
  updatedAt?: string | null;
  /**
   * The last recorded sync error, or null when healthy. On a status='connected'
   * row a non-null value means "recovering from a TRANSIENT failure" (terminal
   * failures flip status to 'error' and are never listed by the cron). Drives the
   * retry backoff in `isDueForSync`.
   */
  lastError?: string | null;
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
  /**
   * Insert statement lines (org-pinned) via the SHARED chunked + per-row-fallback
   * safe writer, skipping any that collide on the dedupe key. Returns how many
   * actually landed and, per the batch-poisoning containment, whether a DB
   * constraint (contained per-row → TERMINAL) or a transient error (→ keep live)
   * occurred. NEVER throws for a row/infra error — those are reported, not raised.
   */
  insertLines(rows: BankStatementLineInsert[]): Promise<BankLinesWriteResult>;
  /**
   * Delete a bank_statements parent (org-pinned). Used to drop an ORPHAN parent
   * when no line landed — a parent must never be left behind with a non-zero
   * line_count and zero children.
   */
  deleteStatement(orgId: string, statementId: string): Promise<void>;
  /** Reconcile a parent's line_count to the number of lines that actually inserted (org-pinned). */
  updateStatementLineCount(orgId: string, statementId: string, lineCount: number): Promise<void>;
  /**
   * Record the outcome of a sync attempt on a connection: always writes last_error
   * (and status only when provided, per the C47 transient/terminal split). Advances
   * the last_sync_at CURSOR **only** when `advanceSyncCursor` is true — i.e. on a
   * SUCCESS. Failure paths must leave last_sync_at untouched, or a transient blip
   * would fast-forward the sync window past unimported days (defeating the 90-day
   * first-sync backfill and orphaning transactions across a multi-day outage).
   */
  markSynced(
    orgId: string,
    provider: BankingProvider,
    fields: { lastError: string | null; status?: string; advanceSyncCursor?: boolean },
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
        // TERMINAL (dead grant) ⇒ flip to 'error' so the cron stops selecting it
        // until re-consent. TRANSIENT ⇒ record last_error but keep the connection
        // 'connected' (via markSynced with NO status) so a later tick retries it.
        await gateway.markSynced(orgId, provider, {
          lastError: refreshed.message,
          ...(refreshed.terminal ? { status: "error" } : {}),
        });
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
        // Same transient-vs-terminal split as the proactive refresh above.
        await gateway.markSynced(orgId, provider, {
          lastError: refreshed.message,
          ...(refreshed.terminal ? { status: "error" } : {}),
        });
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
      if (fetched.reason === "unavailable") {
        // Dark path: nothing was fetched and nothing is written.
        return { ok: false, orgId, provider, outcome: "skipped_dark", inserted: 0, message: fetched.message };
      }
      // 'unauthorized' here means the token was STILL rejected after a refresh+retry
      // (or there was no refresh token) ⇒ TERMINAL: the consent is dead, so flip to
      // 'error' and stop auto-selecting until re-consent. A plain 'error' is a
      // TRANSIENT fetch failure (5xx / network) ⇒ record last_error but keep the
      // connection 'connected' so the next eligible tick retries it. Conflating the
      // two is what silently stranded a feed forever on a single blip.
      const terminal = fetched.reason === "unauthorized";
      await gateway.markSynced(orgId, provider, {
        lastError: fetched.message,
        ...(terminal ? { status: "error" } : {}),
      });
      return { ok: false, orgId, provider, outcome: "error", inserted: 0, message: fetched.message };
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
      // SELF-HEAL: a successful tick clears last_error AND restores status to
      // 'connected', so a connection that had recorded a prior transient error
      // recovers on its own (markSynced only writes status when we pass it). This
      // is a SUCCESS, so advance the sync cursor (last_sync_at).
      await gateway.markSynced(orgId, provider, {
        lastError: null,
        status: "connected",
        advanceSyncCursor: true,
      });
      return { ok: true, orgId, provider, outcome: "no_new", inserted: 0, message: "No new transactions." };
    }

    const filename = `${provider} feed ${new Date().toISOString().slice(0, 10)}`;
    // The parent must exist before its lines (the FK bank_statement_id), but it must
    // NEVER be left as an orphan with a non-zero line_count if nothing lands. Create
    // it, write via the chunked + per-row-fallback safe writer, then reconcile:
    // delete the parent if zero lines landed, or fix its line_count to what actually
    // inserted. Line count is stamped up front and corrected below, never guessed.
    const statementId = await gateway.createStatement(orgId, filename, newLines.length);
    const rows = newLines.map((r) => ({ ...r, bank_statement_id: statementId }));
    const write = await gateway.insertLines(rows);

    if (write.transientError !== null) {
      // A non-constraint write failure (network / 5xx / DB blip) — not a bad row.
      // Drop the orphan parent, keep the connection 'connected' (no status), and do
      // NOT advance the cursor, so a later tick re-fetches the same window and
      // self-heals. Never strand a live feed on a blip (C47).
      await gateway.deleteStatement(orgId, statementId);
      const message = `line insert failed: ${write.transientError}`;
      await gateway.markSynced(orgId, provider, { lastError: message });
      return { ok: false, orgId, provider, outcome: "error", inserted: write.inserted, message };
    }

    if (write.inserted === 0) {
      // Every candidate row was rejected by a DB constraint the mapper does not yet
      // mirror (schema drift). Drop the empty parent (no orphan) and go TERMINAL:
      // the same poison would re-deliver every tick, so surface reconnect/repair
      // (status='error') rather than silently looping the identical window forever.
      await gateway.deleteStatement(orgId, statementId);
      const message = `all ${rows.length} lines rejected by a DB constraint: ${write.constraintError}`;
      await gateway.markSynced(orgId, provider, { lastError: message, status: "error" });
      return { ok: false, orgId, provider, outcome: "error", inserted: 0, message };
    }

    // >= 1 line landed. Reconcile the parent's line_count so it never overstates its
    // children (a partial per-row fallback drops the bad rows).
    if (write.inserted !== newLines.length) {
      await gateway.updateStatementLineCount(orgId, statementId, write.inserted);
    }

    if (write.constraintError !== null) {
      // Some lines landed, some were rejected by a constraint the mapper doesn't yet
      // mirror. Keep the good lines but go TERMINAL (no cursor advance) to surface
      // the repair, mirroring the telematics posture — do NOT self-heal this pass.
      const message = `some lines rejected by a DB constraint: ${write.constraintError}`;
      await gateway.markSynced(orgId, provider, { lastError: message, status: "error" });
      return { ok: false, orgId, provider, outcome: "error", inserted: write.inserted, message };
    }

    // Clean success. SELF-HEAL on the mapped path (see the no_new branch above):
    // restore status='connected', clear last_error, and advance the sync cursor.
    await gateway.markSynced(orgId, provider, {
      lastError: null,
      status: "connected",
      advanceSyncCursor: true,
    });

    return {
      ok: true,
      orgId,
      provider,
      outcome: "mapped",
      inserted: write.inserted,
      message: `Imported ${write.inserted} new transactions.`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "bank sync failed";
    // Do not log the token payload — only a coarse failure signal.
    console.error("[banking] sync failed", { provider, orgId, message });
    // An unexpected throw here is almost always TRANSIENT (a DB blip in the dedupe
    // read / insert, a decrypt hiccup) rather than a dead grant. Record last_error
    // but do NOT flip status to 'error' — keeping it 'connected' means the next
    // eligible tick retries instead of silently stranding the feed forever. A truly
    // persistent fault stays visible via last_error rather than becoming invisible.
    await gateway.markSynced(orgId, provider, { lastError: message }).catch(() => {});
    return { ok: false, orgId, provider, outcome: "error", inserted: 0, message };
  }
}

/** Refresh the access token and persist the (re-encrypted) result. */
async function refreshAndPersist(
  orgId: string,
  provider: BankingProvider,
  refreshToken: string,
  gateway: BankSyncGateway,
): Promise<
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; message: string; terminal: boolean }
> {
  const res = await refreshAccessToken({ provider, refreshToken });
  // A refresh failure is TERMINAL only for a dead grant (invalid_grant / 400 /
  // 401 / 403); a network/5xx blip is transient and must stay retriable.
  if (!res.ok) return { ok: false, message: res.message, terminal: res.terminal === true };
  const newRefresh = res.tokens.refreshToken ?? refreshToken;
  await gateway.saveRefreshedTokens(orgId, provider, {
    accessTokenCipher: encryptToken(res.tokens.accessToken),
    refreshTokenCipher: encryptToken(newRefresh),
    tokenExpiresAt: res.tokens.expiresAt,
  });
  return { ok: true, accessToken: res.tokens.accessToken, refreshToken: newRefresh };
}

/**
 * Whether a listed (status='connected') connection is due for a sync attempt now.
 *
 * A HEALTHY connection (no last_error) is always due — steady-state behaviour is
 * unchanged. A connection still 'connected' but carrying a last_error is one
 * recovering from a TRANSIENT failure; it is gated behind RETRY_BACKOFF_MS measured
 * from updated_at (bumped by the row trigger on the failure write, so it tracks the
 * last ATTEMPT) so a hard-down provider is not hammered on back-to-back ticks.
 * Anchoring on updated_at — NOT last_sync_at — is deliberate: last_sync_at is the
 * success-only sync cursor and no longer moves on a failure, so a recovering
 * connection would otherwise be pinned to its last-SUCCESS time and either retried
 * forever or (once the cursor stopped advancing) never backed off correctly.
 * Terminal failures never reach here (they are status='error', which the cron does
 * not list), so they are never auto-retried.
 */
export function isDueForSync(conn: StoredBankConnection, now: number = Date.now()): boolean {
  if (!conn.lastError) return true;
  if (!conn.updatedAt) return true;
  const t = Date.parse(conn.updatedAt);
  if (Number.isNaN(t)) return true;
  return now - t >= RETRY_BACKOFF_MS;
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
    // Skip a connection still inside its transient-error backoff window; it stays
    // 'connected' and becomes due again on a later tick (see isDueForSync).
    if (!isDueForSync(conn)) continue;
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
      opts: { onConflict: string; ignoreDuplicates: boolean; count?: string },
    ) => PromiseLike<{ error: { message: string; code?: string } | null; count?: number | null }>;
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
      };
    };
    delete: () => {
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
      // F-1: the sync cron must process EVERY connected org. A single unpaginated
      // read is clamped to PostgREST max_rows (1000), silently skipping orgs
      // beyond that; page the full set on a stable (org_id) order.
      const { data, error } = await fetchAllRows<Record<string, unknown>>(
        (from, to) =>
          (
            admin
              .from("bank_connections")
              .select(
                "org_id, provider, status, connection_ref, access_token, refresh_token, token_expires_at, last_sync_at, updated_at, last_error",
              )
              .eq("provider", provider)
              .eq("status", "connected") as unknown as {
              order: (
                k: string,
                o: { ascending: boolean },
              ) => {
                range: (
                  from: number,
                  to: number,
                ) => PromiseLike<{
                  data: Record<string, unknown>[] | null;
                  error: unknown;
                }>;
              };
            }
          )
            .order("org_id", { ascending: true })
            .range(from, to),
      );
      if (error) {
        const msg =
          (error as { message?: string } | null)?.message ?? String(error);
        throw new Error(`bank-sync: listConnected failed: ${msg}`);
      }
      return (data ?? []).map((r) => ({
        orgId: String(r.org_id),
        provider: r.provider as BankingProvider,
        status: String(r.status),
        connectionRef: (r.connection_ref as string | null) ?? null,
        accessTokenCipher: (r.access_token as string | null) ?? null,
        refreshTokenCipher: (r.refresh_token as string | null) ?? null,
        tokenExpiresAt: (r.token_expires_at as string | null) ?? null,
        lastSyncAt: (r.last_sync_at as string | null) ?? null,
        updatedAt: (r.updated_at as string | null) ?? null,
        lastError: (r.last_error as string | null) ?? null,
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
      // BATCH-POISONING containment: route through the SHARED safe writer so ONE
      // uninsertable line can never abort the org's whole batch. The idempotency
      // contract (onConflict + ignoreDuplicates) lives in this closure, so chunking
      // preserves it exactly; count:"exact" gives the true newly-inserted count for
      // the parent's line_count reconciliation. NEVER throws for a row/infra error —
      // it is returned to the engine (transient → keep live; constraint → TERMINAL).
      const res = await safeBatchWrite(rows, (chunk) =>
        admin
          .from("bank_statement_lines")
          .upsert(chunk, {
            onConflict: "org_id,provider_tx_id",
            ignoreDuplicates: true,
            count: "exact",
          }),
      );
      return {
        inserted: res.written,
        constraintError: res.constraintError,
        transientError: res.transientError,
      };
    },

    async deleteStatement(orgId, statementId) {
      const { error } = await admin
        .from("bank_statements")
        .delete()
        .eq("id", statementId)
        .eq("org_id", orgId);
      if (error) throw new Error(`bank-sync: deleteStatement failed: ${error.message}`);
    },

    async updateStatementLineCount(orgId, statementId, lineCount) {
      const { error } = await admin
        .from("bank_statements")
        .update({ line_count: lineCount })
        .eq("id", statementId)
        .eq("org_id", orgId);
      if (error) throw new Error(`bank-sync: updateStatementLineCount failed: ${error.message}`);
    },

    async markSynced(orgId, provider, fields) {
      // last_error (and status, when given) are written on every outcome. The
      // last_sync_at CURSOR advances ONLY on success (advanceSyncCursor) — a
      // failure path must not touch it, or a single transient blip fast-forwards
      // the sync window past unimported days. updated_at is left to the row trigger
      // (bumped on any write), so isDueForSync's backoff still tracks the attempt.
      const patch: Record<string, unknown> = {
        last_error: fields.lastError,
      };
      if (fields.advanceSyncCursor) patch.last_sync_at = new Date().toISOString();
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

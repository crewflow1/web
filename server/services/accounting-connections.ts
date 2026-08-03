import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  buildAccountingExport,
  recordAccountingExport,
} from "@/server/services/accounting-export";
import {
  getAccountingAdapter,
  type AccountingProvider,
} from "@/lib/integrations/accounting/adapters";
import { refreshAccessToken } from "@/lib/integrations/accounting/oauth";
import { decryptToken, encryptToken } from "@/lib/integrations/token-crypto";

/**
 * Accounting connections service — org-pinned reads + admin writes over the
 * accounting_connections table, and the sync composition that ties the
 * connection to the (dark) provider-push adapter.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. Every query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected" — reporting a provider as not-connected when the read
 * merely errored is the precise lie loud reads exist to stop.
 *
 * ADMIN WRITES ARE DB-ENFORCED. Every write runs under the caller's JWT, so the
 * admin-write RLS on accounting_connections (20261095) is the real authorisation
 * — a non-admin's write is refused by the database, not merely by app code.
 *
 * DARK. This service never writes a token or a `connected` status: that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without provider client credentials. `syncToProvider` composes the existing
 * canonical mapper + the credential-gated push adapter and records
 * `skipped_dark` when the adapter is unavailable.
 */

export type AccountingConnection = {
  provider: AccountingProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  externalTenantId: string | null;
  realmId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const PROVIDERS: readonly AccountingProvider[] = ["xero", "quickbooks"];

/**
 * A minimal, token-FREE projection of the connection row. The token columns are
 * deliberately NEVER selected here — no tenant surface reads them back (the
 * webhook-secret idiom). Only the connection state the UI needs is returned.
 */
const SELECT_COLUMNS =
  "provider, status, external_tenant_id, realm_id, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  provider: string;
  status: string;
  external_tenant_id: string | null;
  realm_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

function toConnection(row: ConnectionRow): AccountingConnection {
  return {
    provider: row.provider as AccountingProvider,
    status: row.status as AccountingConnection["status"],
    externalTenantId: row.external_tenant_id,
    realmId: row.realm_id,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

/**
 * List every provider's connection state for one org, defaulting a provider with
 * no row yet to `disconnected`. Org-pinned, loud.
 */
export async function listAccountingConnections(
  orgId: string,
): Promise<AccountingConnection[]> {
  const supabase = await createClient();
  // accounting_connections post-dates the generated types.ts (the
  // expense_budgets idiom); cast to a minimal select builder.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          col: string,
          val: string,
        ) => PromiseLike<{ data: ConnectionRow[] | null; error: { message: string } | null }>;
      };
    };
  };
  const { data, error } = await loose
    .from("accounting_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId);
  if (error) throw readFailure("accounting connections: list", error);

  const byProvider = new Map<string, ConnectionRow>();
  for (const row of data ?? []) byProvider.set(row.provider, row);

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return row
      ? toConnection(row)
      : {
          provider,
          status: "disconnected" as const,
          externalTenantId: null,
          realmId: null,
          connectedAt: null,
          lastSyncAt: null,
          lastError: null,
        };
  });
}

/** Get a single provider's connection state for one org, or null when absent. Org-pinned, loud. */
export async function getAccountingConnection(
  orgId: string,
  provider: AccountingProvider,
): Promise<AccountingConnection | null> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: ConnectionRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("accounting_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw readFailure("accounting connections: get", error);
  return data ? toConnection(data) : null;
}

/**
 * Disconnect a provider: clear the tokens + account handle and set status back
 * to `disconnected`. Admin-gated by RLS (runs under the caller's JWT). Org-pinned.
 * Idempotent — disconnecting an already-disconnected provider is a no-op success.
 */
export async function disconnectAccountingProvider(
  orgId: string,
  provider: AccountingProvider,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (
            col: string,
            val: string,
          ) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await loose
    .from("accounting_connections")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      external_tenant_id: null,
      realm_id: null,
      connected_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[accounting] disconnect failed", { provider, message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type SyncResult = {
  ok: boolean;
  provider: AccountingProvider;
  status: "pushed" | "skipped_dark" | "error";
  pushed: number;
  message: string;
};

/**
 * The token columns of one connection — SERVICE-ROLE ONLY. The migration
 * (20261095) REVOKES SELECT on access_token / refresh_token / token_expires_at
 * from `authenticated`, so a caller-JWT read cannot see them; only the
 * service-role client can. This is why every function that touches a token below
 * uses `createAdminClient()`, org-pinned by (org_id, provider).
 */
type ConnectionSecrets = {
  status: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  external_tenant_id: string | null;
  realm_id: string | null;
};

/** Service-role read of one connection's secret columns. Org-pinned. Loud. */
async function readConnectionSecrets(
  orgId: string,
  provider: AccountingProvider,
): Promise<ConnectionSecrets | null> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => PromiseLike<{
              data: ConnectionSecrets | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    };
  };
  const { data, error } = await loose
    .from("accounting_connections")
    .select(
      "status, access_token, refresh_token, token_expires_at, external_tenant_id, realm_id",
    )
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw readFailure("accounting connections: secrets", error);
  return data ?? null;
}

/** Service-role write of refreshed tokens. Only refresh_token when rotated. Org-pinned. */
async function persistRefreshedTokens(
  orgId: string,
  provider: AccountingProvider,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const update: Record<string, unknown> = {
    access_token: encryptToken(tokens.accessToken),
    token_expires_at: tokens.expiresAt,
  };
  // Only overwrite the refresh token when the provider ROTATED it — a null means
  // "unchanged", so we keep the stored one rather than clobbering it.
  if (tokens.refreshToken !== null) {
    update.refresh_token = encryptToken(tokens.refreshToken);
  }
  const { error } = await loose
    .from("accounting_connections")
    .update(update)
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    // Never log the token payload — only a coarse failure signal.
    console.error("[accounting] token persist failed", { provider, message: error.message });
  }
}

/**
 * Refresh the access token for a connected org and persist the new (encrypted)
 * tokens, returning the fresh DECRYPTED access token or null when refresh is
 * impossible. Re-reads the CURRENT stored refresh token each call (service-role)
 * so provider refresh-token ROTATION between two pushes cannot use a stale token.
 * This same function is both the proactive-expiry refresh and the adapter's
 * reactive 401 `refresh` callback.
 */
async function refreshAndPersist(
  orgId: string,
  provider: AccountingProvider,
): Promise<string | null> {
  const secrets = await readConnectionSecrets(orgId, provider);
  if (!secrets?.refresh_token) return null;
  let plainRefresh: string;
  try {
    plainRefresh = decryptToken(secrets.refresh_token);
  } catch {
    return null;
  }
  const res = await refreshAccessToken({ provider, refreshToken: plainRefresh });
  if (!res.ok) return null;
  await persistRefreshedTokens(orgId, provider, {
    accessToken: res.tokens.accessToken,
    refreshToken: res.tokens.refreshToken,
    expiresAt: res.tokens.expiresAt,
  });
  return res.tokens.accessToken;
}

/** Is a token expired or within the refresh skew window? Unknown expiry ⇒ false (let a 401 handle it). */
function tokenExpiring(expiresAt: string | null, skewMs = 60_000): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? t - Date.now() <= skewMs : false;
}

/** Best-effort service-role stamp of last_sync_at / last_error after a push. Org-pinned. */
async function stampSyncOutcome(
  orgId: string,
  provider: AccountingProvider,
  lastError: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const loose = admin as unknown as {
    from: (t: string) => {
      update: (row: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
    };
  };
  await loose
    .from("accounting_connections")
    .update({ last_sync_at: new Date().toISOString(), last_error: lastError })
    .eq("org_id", orgId)
    .eq("provider", provider);
}

/**
 * Sync an org's finance rows to a provider by composing the EXISTING canonical
 * mapper (buildAccountingExport) with the push adapter.
 *
 * DARK: when the adapter is dark (flag off / no client credentials) NOTHING is
 * built or pushed — the adapter REFUSES before any network call — and an honest
 * `skipped_dark` is recorded in the export log and returned; never a fake
 * success, never a live call.
 *
 * LIVE (unreachable dark): resolve the org's DECRYPTED access token + provider
 * handle from the connection (service-role — the token columns are stripped from
 * the caller-JWT surface), proactively refresh a near-expiry token, and hand the
 * adapter a `refresh` callback for the reactive 401 path. Org-pinned; the export
 * log write is admin-gated by RLS.
 */
export async function syncToProvider(
  orgId: string,
  provider: AccountingProvider,
  actorId: string,
): Promise<SyncResult> {
  const adapter = getAccountingAdapter(provider);

  // Dark path: the adapter is not connectable, so we push nothing and record
  // the skip. This mirrors the reports/accounting action's honest-dark posture.
  if (!adapter.isAvailable()) {
    await recordAccountingExport({
      orgId,
      createdBy: actorId,
      format: provider,
      status: "skipped_dark",
      rowCount: 0,
      note: "provider adapter unavailable (flag off or no OAuth credentials) — nothing sent",
    });
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      pushed: 0,
      message: `${provider} is not connected; nothing was sent.`,
    };
  }

  // ── LIVE PATH (unreachable dark) ──────────────────────────────────────────
  // Resolve the org's tokens + handle (service-role: token columns are not on
  // the caller-JWT read surface).
  const secrets = await readConnectionSecrets(orgId, provider);
  if (!secrets || secrets.status !== "connected" || !secrets.access_token) {
    return {
      ok: false,
      provider,
      status: "error",
      pushed: 0,
      message: `${provider} is not connected for this org.`,
    };
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(secrets.access_token);
  } catch {
    return {
      ok: false,
      provider,
      status: "error",
      pushed: 0,
      message: `${provider} stored token is unreadable; reconnect the account.`,
    };
  }

  const refresh = () => refreshAndPersist(orgId, provider);
  // Proactively refresh a token that is expired or within the skew window so the
  // first call does not have to fail before refreshing.
  if (tokenExpiring(secrets.token_expires_at)) {
    const fresh = await refresh();
    if (fresh) accessToken = fresh;
  }

  const { rows } = await buildAccountingExport({ orgId });
  const invoiceRows = rows.filter((r) => r.type === "invoice");
  const paymentRows = rows.filter((r) => r.type === "payment");
  const base = {
    accessToken,
    tenantId: secrets.external_tenant_id,
    realmId: secrets.realm_id,
    refresh,
  };
  const invRes = await adapter.pushInvoices({ ...base, rows: invoiceRows });
  const payRes = await adapter.pushPayments({ ...base, rows: paymentRows });

  if (invRes.ok && payRes.ok) {
    await stampSyncOutcome(orgId, provider, null);
    await recordAccountingExport({
      orgId,
      createdBy: actorId,
      format: provider,
      status: "pushed",
      rowCount: rows.length,
    });
    return {
      ok: true,
      provider,
      status: "pushed",
      pushed: rows.length,
      message: `Pushed ${rows.length} rows to ${provider}.`,
    };
  }

  const message = !invRes.ok ? invRes.message : !payRes.ok ? payRes.message : "Push failed.";
  await stampSyncOutcome(orgId, provider, message);
  return { ok: false, provider, status: "error", pushed: 0, message };
}

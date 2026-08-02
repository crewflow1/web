import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  buildAccountingExport,
  recordAccountingExport,
} from "@/server/services/accounting-export";
import {
  getAccountingAdapter,
  type AccountingProvider,
} from "@/lib/integrations/accounting/adapters";

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
 * Sync an org's finance rows to a provider by composing the EXISTING canonical
 * mapper (buildAccountingExport) with the Wave-3 push adapter. When the adapter
 * is dark (no credentials) NOTHING is built or pushed: an honest `skipped_dark`
 * is recorded in the export log and returned — never a fake success, never a
 * live call. Org-pinned; the log write is admin-gated by RLS.
 */
export async function syncToProvider(
  orgId: string,
  provider: AccountingProvider,
  actorId: string,
): Promise<SyncResult> {
  const adapter = getAccountingAdapter(provider);

  // Dark path: the adapter has no credentials, so we push nothing and record
  // the skip. This mirrors the reports/accounting action's honest-dark posture.
  if (!adapter.isAvailable()) {
    await recordAccountingExport({
      orgId,
      createdBy: actorId,
      format: provider,
      status: "skipped_dark",
      rowCount: 0,
      note: "provider adapter unavailable (no OAuth credentials) — nothing sent",
    });
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      pushed: 0,
      message: `${provider} is not connected; nothing was sent.`,
    };
  }

  // Credentialed path (unreachable today). Build canonical rows and push; the
  // adapter still makes no live call in this build.
  const { rows } = await buildAccountingExport({ orgId });
  const invoiceRows = rows.filter((r) => r.type === "invoice");
  const paymentRows = rows.filter((r) => r.type === "payment");
  const invRes = await adapter.pushInvoices(invoiceRows);
  const payRes = await adapter.pushPayments(paymentRows);

  if (invRes.ok && payRes.ok) {
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
  return { ok: false, provider, status: "error", pushed: 0, message };
}

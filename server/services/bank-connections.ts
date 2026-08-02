import "server-only";

import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  getBankingAdapter,
  type BankingProvider,
} from "@/lib/integrations/banking/adapters";
import {
  mapStatementToLines,
  type BankStatementLineInsert,
} from "@/lib/integrations/banking/statement-map";

/**
 * Bank connections service — org-pinned reads + admin writes over the
 * bank_connections table, and the (dark) statement-sync composition that ties a
 * connection to the aggregator fetch adapter + the pure statement mapper.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * Account Information Services are FCA-regulated. `syncBankTransactions` NEVER
 * fetches while the adapter is dark; a live pull is unreachable before AISP
 * authorisation + credentials exist.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. Every query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected".
 *
 * DARK. This service never writes a token or a `connected` status: that only
 * happens after a real OAuth exchange in the callback route, which is unreachable
 * without aggregator credentials. `syncBankTransactions` refuses BEFORE any fetch
 * when the adapter is unavailable and records nothing.
 */

export type BankConnection = {
  provider: BankingProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  institutionId: string | null;
  institutionName: string | null;
  connectionRef: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

const PROVIDERS: readonly BankingProvider[] = ["truelayer", "plaid", "nordigen"];

/**
 * A minimal, token-FREE projection of the connection row. The token columns are
 * deliberately NEVER selected here — no tenant surface reads them back. Only the
 * connection state the UI needs is returned.
 */
const SELECT_COLUMNS =
  "provider, status, institution_id, institution_name, connection_ref, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  provider: string;
  status: string;
  institution_id: string | null;
  institution_name: string | null;
  connection_ref: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

function toConnection(row: ConnectionRow): BankConnection {
  return {
    provider: row.provider as BankingProvider,
    status: row.status as BankConnection["status"],
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    connectionRef: row.connection_ref,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

/**
 * List every aggregator's connection state for one org, defaulting a provider
 * with no row yet to `disconnected`. Org-pinned, loud.
 */
export async function listBankConnections(orgId: string): Promise<BankConnection[]> {
  const supabase = await createClient();
  // bank_connections post-dates the generated types.ts; cast to a minimal select
  // builder.
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
    .from("bank_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId);
  if (error) throw readFailure("bank connections: list", error);

  const byProvider = new Map<string, ConnectionRow>();
  for (const row of data ?? []) byProvider.set(row.provider, row);

  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return row
      ? toConnection(row)
      : {
          provider,
          status: "disconnected" as const,
          institutionId: null,
          institutionName: null,
          connectionRef: null,
          connectedAt: null,
          lastSyncAt: null,
          lastError: null,
        };
  });
}

/** Get a single aggregator's connection state for one org, or null when absent. Org-pinned, loud. */
export async function getBankConnection(
  orgId: string,
  provider: BankingProvider,
): Promise<BankConnection | null> {
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
    .from("bank_connections")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw readFailure("bank connections: get", error);
  return data ? toConnection(data) : null;
}

/**
 * Disconnect an aggregator: clear the tokens + connection handle and set status
 * back to `disconnected`. Admin-gated by RLS (runs under the caller's JWT).
 * Org-pinned. Idempotent.
 */
export async function disconnectBankProvider(
  orgId: string,
  provider: BankingProvider,
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
    .from("bank_connections")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      connection_ref: null,
      institution_id: null,
      institution_name: null,
      connected_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[banking] disconnect failed", { provider, message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type BankSyncResult = {
  ok: boolean;
  provider: BankingProvider;
  status: "mapped" | "skipped_dark" | "error";
  lineCount: number;
  message: string;
};

/**
 * Pull an org's bank transactions via the aggregator and map them onto
 * bank_statement_lines. DARK: when the adapter is unavailable (no credentials /
 * flag off / FCA-ungated) NOTHING is fetched — the adapter REFUSES before any
 * network call — and an honest `skipped_dark` is returned. This is the seam that,
 * at activation, feeds the EXISTING reconciliation tables; the actual insert is
 * activation work (there is no fetched data to insert while dark).
 *
 * REFUSE-BEFORE-FETCH is enforced by the adapter: `fetchStatements` returns
 * `unavailable` without touching the network. This service calls it and only
 * reaches the pure mapper when real data came back — impossible dark.
 */
export async function syncBankTransactions(
  orgId: string,
  provider: BankingProvider,
  bankStatementId: string,
): Promise<BankSyncResult> {
  const adapter = getBankingAdapter(provider);

  // Dark path: the adapter has no credentials, so it refuses before any fetch.
  if (!adapter.isAvailable()) {
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      lineCount: 0,
      message: `${provider} bank feed is not connected; nothing was fetched.`,
    };
  }

  // Credentialed path (unreachable today). The connection's decrypted token +
  // reference are resolved by the activation writer; the adapter still makes no
  // live call in this build. When real statements return, the pure mapper turns
  // them into bank_statement_lines rows for the existing reconciliation UI.
  const connection = await getBankConnection(orgId, provider);
  if (!connection || connection.status !== "connected" || !connection.connectionRef) {
    return {
      ok: false,
      provider,
      status: "error",
      lineCount: 0,
      message: `${provider} is not connected for this org.`,
    };
  }

  // NOTE: accessToken resolution (decrypt-on-use) is wired at activation; the
  // adapter guards the fetch, so this path cannot reach a live bank while dark.
  const fetched = await adapter.fetchStatements({
    accessToken: "",
    connectionRef: connection.connectionRef,
  });
  if (!fetched.ok) {
    return {
      ok: fetched.reason === "unavailable" ? false : false,
      provider,
      status: fetched.reason === "unavailable" ? "skipped_dark" : "error",
      lineCount: 0,
      message: fetched.message,
    };
  }

  const rows: BankStatementLineInsert[] = fetched.statements.flatMap((statement) =>
    mapStatementToLines(statement, { orgId, bankStatementId }),
  );
  // The insert of `rows` into bank_statement_lines is activation work.
  return {
    ok: true,
    provider,
    status: "mapped",
    lineCount: rows.length,
    message: `Mapped ${rows.length} transactions to statement lines.`,
  };
}

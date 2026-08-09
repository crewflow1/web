import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  buildAccountingExport,
  recordAccountingExport,
  recordPushedEntities,
  type PushedEntity,
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
  // Reset the PUSH-ONCE high-water-mark for this provider. The ledger records
  // what the now-disconnected account already accepted; leaving it in place means
  // a RECONNECT (necessarily a fresh, possibly DIFFERENT external tenant) would
  // have every id excluded from its export — the operator sees "already up to
  // date" while the new company's books never receive any history. Loud on
  // failure: a stale ledger is the exact silent-under-export hazard, so we surface
  // it rather than report a clean disconnect. Idempotent (a re-run deletes zero).
  const reset = await resetPushedLedger(supabase, orgId, provider);
  if (!reset.ok) return { ok: false, error: reset.error };
  return { ok: true };
}

/**
 * Reset the PUSH-ONCE ledger (accounting_pushed_entities) for one (org,
 * provider): delete every recorded high-water-mark row so the NEXT sync re-pushes
 * the full history. Called on an explicit DISCONNECT and on a REBIND to a
 * DIFFERENT external tenant (a reconnect that skipped an explicit disconnect) —
 * both leave the old account's high-water-mark stale against a fresh, empty
 * account.
 *
 * Runs under the CALLER's client (JWT) — the admin-DELETE RLS policy on
 * accounting_pushed_entities (20261110) is the real authorisation, so no
 * service-role escalation is needed (the caller is already the admin who drives
 * disconnect / connect). Org-pinned AND provider-pinned. Idempotent.
 */
export async function resetPushedLedger(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  provider: AccountingProvider,
): Promise<{ ok: boolean; error?: string }> {
  const loose = supabase as unknown as {
    from: (t: string) => {
      delete: () => {
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
    .from("accounting_pushed_entities")
    .delete()
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[accounting] ledger reset failed", { provider, message: error.message });
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
 *
 * PUSH-ONCE. The export is built with `excludePushedFor: provider`, so each sync
 * pushes ONLY invoices / payments not already recorded in the push-once ledger
 * (accounting_pushed_entities). On success we record EXACTLY the accepted prefix
 * (invRes.pushed / payRes.pushed) back to the ledger, so a re-run can never
 * re-send a row the provider already has. This is what makes activation clean:
 * adding an invoice later and re-syncing pushes only the new invoice, never a
 * duplicate of the earlier ones. A FAILED push records nothing for its failed
 * tail, so it is retried next sync.
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

  // PUSH-ONCE: only rows not already in the ledger for this provider, each row
  // carrying its immutable CrewFlow id as `sourceId`. `pushedInvoiceNumbers` is
  // the numbers of invoices created on a PRIOR successful run (excluded from
  // `rows`) — the payment-link gate below needs them.
  //
  // FAIL LOUD, NEVER MIS-POST. Building the export threads per-line VAT and asserts
  // each invoice's rate buckets reconcile to its header; a corrupt snapshot (lines
  // that disagree with the totals) throws. Catch it here and abort the push with a
  // clear message rather than crashing or posting a wrong-gross document.
  let rows: Awaited<ReturnType<typeof buildAccountingExport>>["rows"];
  let pushedInvoiceNumbers: Awaited<
    ReturnType<typeof buildAccountingExport>
  >["pushedInvoiceNumbers"];
  try {
    ({ rows, pushedInvoiceNumbers } = await buildAccountingExport({
      orgId,
      excludePushedFor: provider,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build the accounting export.";
    await stampSyncOutcome(orgId, provider, message);
    return { ok: false, provider, status: "error", pushed: 0, message };
  }
  const invoiceRows = rows.filter((r) => r.type === "invoice");
  const paymentRows = rows.filter((r) => r.type === "payment");
  const base = {
    accessToken,
    tenantId: secrets.external_tenant_id,
    realmId: secrets.realm_id,
    refresh,
  };
  const invRes = await adapter.pushInvoices({ ...base, rows: invoiceRows });

  // The count of invoices the provider ACCEPTED — full count on ok, the reported
  // prefix on a partial failure, 0 otherwise. Rows push in input order, so the
  // accepted invoices are exactly the leading `invAccepted` of `invoiceRows`.
  const invAccepted = invRes.ok ? invRes.pushed : invRes.pushed ?? 0;

  // ── PAYMENT-LINK GATE (launch blocker c53) ─────────────────────────────────
  // A payment may only be pushed once its invoice EXISTS at the provider: either
  // created in THIS run (the accepted invoice prefix) OR on a prior successful run
  // (already in the push-once ledger — `pushedInvoiceNumbers`). WITHOUT this gate,
  // pushing a payment whose invoice was NOT created strands it FOREVER: QBO accepts
  // a payment carrying no LinkedTxn as a 2xx UNAPPLIED receipt, we record it in the
  // ledger, and every future export excludes it — so the later-created invoice
  // never receives its payment. The gate keys on `invoice_number`, exactly what
  // each adapter resolves the invoice by (QBO DocNumber / Xero InvoiceNumber).
  //
  // SHARED, so it protects Xero too, without regressing Xero's self-heal: Xero
  // already returns non-2xx for a missing invoice, so a stranded payment was never
  // recorded there and retried. Under the gate that payment is simply not sent
  // this run; being neither pushed NOR recorded, it reappears in the next sync's
  // export and links once its invoice has landed — same end state, no wasted
  // failing POST that would also abort the rest of the payment batch.
  const createdInvoiceNumbers = new Set<string>(pushedInvoiceNumbers);
  for (const r of invoiceRows.slice(0, invAccepted)) {
    if (r.invoice_number) createdInvoiceNumbers.add(r.invoice_number);
  }
  const pushablePayments = paymentRows.filter((r) =>
    createdInvoiceNumbers.has(r.invoice_number),
  );

  const payRes = await adapter.pushPayments({ ...base, rows: pushablePayments });

  // The count of payments the provider accepted — over the GATED set, in input
  // order, so the accepted payments are the leading `payAccepted` of
  // `pushablePayments` (never the un-pushed, gated-out tail).
  const payAccepted = payRes.ok ? payRes.pushed : payRes.pushed ?? 0;

  // Record EXACTLY what landed — the accepted prefix — so it is excluded next
  // sync and a re-run never re-sends it. Payments are recorded from the GATED
  // set, so a gated-out payment is never recorded and re-links next sync once its
  // invoice exists. A row without a sourceId (never on this path) is skipped
  // defensively rather than mis-recorded.
  const accepted: PushedEntity[] = [
    ...invoiceRows
      .slice(0, invAccepted)
      .filter((r) => r.sourceId)
      .map((r) => ({ entityType: "invoice" as const, entityId: r.sourceId! })),
    ...pushablePayments
      .slice(0, payAccepted)
      .filter((r) => r.sourceId)
      .map((r) => ({ entityType: "payment" as const, entityId: r.sourceId! })),
  ];
  if (accepted.length > 0) {
    const rec = await recordPushedEntities({
      orgId,
      createdBy: actorId,
      provider,
      entities: accepted,
    });
    if (!rec.ok) {
      // Rows DID land at the provider; failing to record them is a push-once
      // hazard, so surface it loudly. The per-entity provider idempotency key is
      // the backstop that keeps a re-push a no-op within its retention window.
      console.error("[accounting] failed to record pushed entities", {
        provider,
        message: rec.error,
      });
    }
  }

  const pushed = invAccepted + payAccepted;

  if (invRes.ok && payRes.ok) {
    await stampSyncOutcome(orgId, provider, null);
    await recordAccountingExport({
      orgId,
      createdBy: actorId,
      format: provider,
      status: "pushed",
      rowCount: pushed,
    });
    return {
      ok: true,
      provider,
      status: "pushed",
      pushed,
      message:
        pushed === 0
          ? `${provider} is already up to date; nothing new to push.`
          : `Pushed ${pushed} new rows to ${provider}.`,
    };
  }

  const message = !invRes.ok ? invRes.message : !payRes.ok ? payRes.message : "Push failed.";
  await stampSyncOutcome(orgId, provider, message);
  // `pushed` reflects the rows that DID land before the failure (already recorded
  // above), so a retry pushes only the tail.
  return { ok: false, provider, status: "error", pushed, message };
}

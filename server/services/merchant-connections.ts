import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";
import { isMerchantConnectable } from "@/lib/integrations/merchants/connect";
import {
  getMerchantAdapter,
  type MerchantProvider,
} from "@/lib/integrations/merchants/adapters";
import { MERCHANT_PROVIDERS } from "@/lib/integrations/merchants/types";
import type {
  CatalogueItem,
  PurchaseOrderPayload,
} from "@/lib/integrations/merchants/types";

/**
 * Merchant connections service — org-pinned reads + admin writes over the
 * merchant_connections table, and the (dark) import/submit compositions that tie a
 * connection to the merchant adapter + the pure format helpers.
 *
 * ORG PINNING IS LOAD-BEARING. `current_org_ids()` (the RLS boundary) returns
 * EVERY org the caller belongs to, so a multi-org admin's unpinned read would
 * blend two companies' connection state. Every query here `.eq("org_id", orgId)`
 * on the caller-supplied active org.
 *
 * LOUD READS. A failed read throws via `readFailure` rather than degrading to a
 * silent "disconnected".
 *
 * DARK. The connect handshake (`connectMerchantProvider`) is the ONLY writer of a
 * `connected` status or an (encrypted) secret, and it REFUSES — before any DB
 * write — whenever the merchant is not connectable (flag off / no deployment
 * credentials / no endpoint), which is ALWAYS today. So no secret and no
 * `connected` row is reachable dark. `importMerchantCatalogue` /
 * `submitPurchaseOrderToMerchant` likewise refuse BEFORE any fetch when the
 * adapter is unavailable and change nothing.
 */

export type MerchantConnection = {
  provider: MerchantProvider;
  status: "disconnected" | "connecting" | "connected" | "error";
  externalAccountId: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};

/**
 * A minimal, secret-FREE projection of the connection row. The secret columns
 * (account_secret / secret_expires_at) are deliberately NEVER selected here — no
 * tenant surface reads them back. Only the connection state the UI needs.
 */
const SELECT_COLUMNS =
  "provider, status, external_account_id, connected_at, last_sync_at, last_error";

type ConnectionRow = {
  provider: string;
  status: string;
  external_account_id: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};

function toConnection(row: ConnectionRow): MerchantConnection {
  return {
    provider: row.provider as MerchantProvider,
    status: row.status as MerchantConnection["status"],
    externalAccountId: row.external_account_id,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  };
}

/** A disconnected placeholder for a merchant with no row yet. */
function placeholder(provider: MerchantProvider): MerchantConnection {
  return {
    provider,
    status: "disconnected",
    externalAccountId: null,
    connectedAt: null,
    lastSyncAt: null,
    lastError: null,
  };
}

/**
 * List the org's merchant connection state — one entry per known merchant,
 * placeholder-filled so the UI always renders every row. Org-pinned + secret-free
 * + loud.
 */
export async function listMerchantConnections(
  orgId: string,
): Promise<MerchantConnection[]> {
  const supabase = await createClient();
  // merchant_connections post-dates the generated types.ts; cast to a minimal
  // select builder. RLS (member-read) is the real authorisation for this read.
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          col: string,
          val: string,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            range: (
              from: number,
              to: number,
            ) => PromiseLike<{ data: ConnectionRow[] | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  const { data, error } = await fetchAllRows<ConnectionRow>((from, to) =>
    loose
      .from("merchant_connections")
      .select(SELECT_COLUMNS)
      .eq("org_id", orgId)
      .order("provider", { ascending: true })
      .range(from, to) as PromiseLike<PageResult<ConnectionRow>>,
  );
  if (error) {
    throw readFailure("merchant connections: list", error as Parameters<typeof readFailure>[1]);
  }
  const byProvider = new Map<string, MerchantConnection>();
  for (const row of data ?? []) {
    byProvider.set(row.provider, toConnection(row));
  }
  return MERCHANT_PROVIDERS.map((p) => byProvider.get(p) ?? placeholder(p));
}

/**
 * Admin disconnect — clears the secret + account handle and returns the row to
 * `disconnected`. Org-pinned; the admin-write RLS is the real authority.
 */
export async function disconnectMerchantProvider(
  orgId: string,
  provider: MerchantProvider,
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
    .from("merchant_connections")
    .update({
      status: "disconnected",
      account_secret: null,
      secret_expires_at: null,
      external_account_id: null,
      connected_at: null,
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) {
    console.error("[merchants] disconnect failed", { provider, message: error.message });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export type ConnectMerchantResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "invalid" | "error"; error: string };

/** The org's trade account number with the merchant: short, printable, no control chars. */
const ACCOUNT_HANDLE_RE = /^[\x20-\x7e]{1,64}$/;

/**
 * Admin CONNECT — the merchant connect handshake. Builders' merchants are NOT
 * OAuth: the deployment holds the integration credential + contract-provisioned
 * endpoint (env, per merchant), and connecting an ORG means binding its trade
 * ACCOUNT NUMBER (plus an optional per-org account secret the merchant issued)
 * to the merchant_connections row. So the genuine connect flow is this
 * form-driven write, not a redirect — the panel drives it via a server action.
 *
 * DARK GUARD FIRST. When the merchant is not connectable (flag off / no
 * deployment credential / no endpoint — ALWAYS today) this refuses honestly
 * BEFORE any DB access: no row is written, no secret is stored, and the caller
 * gets the real reason (awaiting a trade-account integration contract).
 *
 * SECRETS AT REST. An optional per-org account secret is AES-256-GCM encrypted
 * application-side (token-crypto) BEFORE the write — exactly as the
 * accounting/banking/telematics substrates store their tokens — and a secret
 * without INTEGRATION_TOKEN_ENCRYPTION_KEY is refused loudly rather than stored
 * in plaintext. The secret column is service-role-only on read (column
 * privilege, 20261124), so it never comes back to a tenant surface.
 *
 * AUTHORISATION IS DOUBLED. Runs under the caller's JWT: the admin-write RLS on
 * merchant_connections is the real boundary; the action layer refuses
 * non-admins loudly first. Org-pinned via the upsert's org_id. Idempotent: one
 * row per (org, provider) — reconnecting updates the same row.
 */
export async function connectMerchantProvider(params: {
  orgId: string;
  provider: MerchantProvider;
  accountNumber: string;
  accountSecret?: string | null;
  connectedBy: string;
}): Promise<ConnectMerchantResult> {
  const { orgId, provider, connectedBy } = params;

  // DARK GUARD FIRST — refuse before any DB write while not connectable.
  if (!isMerchantConnectable(provider)) {
    return {
      ok: false,
      reason: "not_configured",
      error:
        `${provider} is not configured in this deployment. A trade-account ` +
        `integration contract, its credentials and endpoint (and the merchants ` +
        `feature flag) are required before an account can be connected.`,
    };
  }

  const accountNumber = params.accountNumber.trim();
  if (!ACCOUNT_HANDLE_RE.test(accountNumber)) {
    return {
      ok: false,
      reason: "invalid",
      error: "Enter the trade account number the merchant issued (up to 64 characters).",
    };
  }

  const accountSecret = (params.accountSecret ?? "").trim();
  if (accountSecret.length > 0 && !isTokenEncryptionConfigured()) {
    // NEVER store a plaintext secret: no encryption key ⇒ loud refusal.
    return {
      ok: false,
      reason: "error",
      error:
        "INTEGRATION_TOKEN_ENCRYPTION_KEY is not configured; refusing to store an account secret.",
    };
  }

  const supabase = await createClient();
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("merchant_connections").upsert(
    {
      org_id: orgId,
      provider,
      status: "connected",
      external_account_id: accountNumber,
      // Encrypted at rest; null clears a previously stored secret on reconnect.
      account_secret: accountSecret.length > 0 ? encryptToken(accountSecret) : null,
      secret_expires_at: null,
      connected_by: connectedBy,
      connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "org_id,provider" },
  );
  if (error) {
    console.error("[merchants] connect failed", { provider, message: error.message });
    return { ok: false, reason: "error", error: error.message };
  }
  return { ok: true };
}

export type MerchantCatalogueSyncResult = {
  ok: boolean;
  provider: MerchantProvider;
  status: "imported" | "skipped_dark" | "error";
  itemCount: number;
  message: string;
  /** The parsed catalogue rows a live import would upsert. Empty dark. */
  items: CatalogueItem[];
};

/**
 * Import an org's price file via the merchant adapter and return the parsed
 * catalogue items. DARK: when the adapter is unavailable (no credentials / flag
 * off / no endpoint) NOTHING is fetched — the adapter REFUSES before any network
 * call — and an honest `skipped_dark` is returned.
 *
 * The actual UPSERT into merchant_catalogue_items is activation work (there is no
 * fetched data to write while dark); it runs as service-role because that table
 * has no authenticated writer.
 */
export async function importMerchantCatalogue(params: {
  provider: MerchantProvider;
  accountHandle: string;
  accountSecret?: string | null;
}): Promise<MerchantCatalogueSyncResult> {
  const { provider } = params;
  const adapter = getMerchantAdapter(provider);

  // Dark path: the adapter has no credentials, so it refuses before any fetch.
  if (!adapter.isAvailable()) {
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      itemCount: 0,
      message: `${provider} is not connected; nothing was imported.`,
      items: [],
    };
  }

  // LIVE (unreachable dark).
  const result = await adapter.importCatalogue({
    accountHandle: params.accountHandle,
    accountSecret: params.accountSecret ?? null,
  });
  if (!result.ok) {
    return {
      ok: false,
      provider,
      status: result.reason === "unavailable" ? "skipped_dark" : "error",
      itemCount: 0,
      message: result.message,
      items: [],
    };
  }
  return {
    ok: true,
    provider,
    status: "imported",
    itemCount: result.items.length,
    message: `imported ${result.items.length} catalogue items`,
    items: result.items,
  };
}

export type MerchantOrderSubmitResult = {
  ok: boolean;
  provider: MerchantProvider;
  status: "submitted" | "skipped_dark" | "rejected" | "error";
  externalOrderRef: string | null;
  message: string;
};

/**
 * Submit a purchase order to a merchant via the adapter. DARK: refuses before any
 * network call when the adapter is unavailable and submits nothing.
 *
 * THE SEAM. This is how the Purchase Orders core would connect INTO a merchant —
 * the PO core maps its row onto a {@link PurchaseOrderPayload} and calls this; the
 * adapter never reaches back into PO tables. This service does NOT modify any PO
 * row; a live submission's outcome is recorded (service-role) in
 * merchant_po_submissions at activation.
 */
export async function submitPurchaseOrderToMerchant(params: {
  provider: MerchantProvider;
  order: PurchaseOrderPayload;
  accountSecret?: string | null;
}): Promise<MerchantOrderSubmitResult> {
  const { provider } = params;
  const adapter = getMerchantAdapter(provider);

  if (!adapter.isAvailable()) {
    return {
      ok: false,
      provider,
      status: "skipped_dark",
      externalOrderRef: null,
      message: `${provider} is not connected; the order was not submitted.`,
    };
  }

  // LIVE (unreachable dark).
  const result = await adapter.submitPurchaseOrder({
    order: params.order,
    accountSecret: params.accountSecret ?? null,
  });
  if (!result.ok) {
    return {
      ok: false,
      provider,
      status: result.reason === "unavailable" ? "skipped_dark" : result.reason === "rejected" ? "rejected" : "error",
      externalOrderRef: null,
      message: result.message,
    };
  }
  return {
    ok: true,
    provider,
    status: "submitted",
    externalOrderRef: result.externalOrderRef,
    message: result.message,
  };
}

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { readFailure } from "@/lib/supabase/read-failure";
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
 * DARK. This service never writes a secret or a `connected` status: that only
 * happens after a real connect handshake, unreachable without merchant
 * credentials. `importMerchantCatalogue` / `submitPurchaseOrderToMerchant` refuse
 * BEFORE any fetch when the adapter is unavailable and change nothing.
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

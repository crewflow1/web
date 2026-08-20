import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";
import { safeBatchWrite } from "@/lib/supabase/safe-batch-write";
import { decryptToken, isTokenEncryptionConfigured } from "@/lib/integrations/token-crypto";
import {
  merchantProviderReady,
  type MerchantProvider,
} from "@/lib/integrations/merchants/adapters";
import {
  importMerchantCatalogue,
  submitPurchaseOrderToMerchant,
} from "@/server/services/merchant-connections";
import type {
  CatalogueItem,
  PurchaseOrderLine,
  PurchaseOrderPayload,
} from "@/lib/integrations/merchants/types";

/**
 * Merchant PERSISTENCE writers — the service-role callers that close the merchant
 * (Travis Perkins / Jewson cXML) integration from the app boundary all the way to
 * the data tables. The audit found the two composition halves (`importMerchant-
 * Catalogue` / `submitPurchaseOrderToMerchant` in merchant-connections.ts) fetch +
 * parse + build but had NO writer and NO caller, so a live merchant link could
 * never land a `merchant_catalogue_items` row or a `merchant_po_submissions`
 * outcome. This module is those two writers + their wiring seam.
 *
 * ── DARK GATE FIRST — zero DB, zero client construction ──────────────────────
 * Readiness (`merchantProviderReady`) is checked BEFORE anything: on a dark build
 * (feature flag off / no credentials / no endpoint — every environment today)
 * both functions return `ran: false` WITHOUT constructing a Supabase client,
 * reading a row, or contacting a merchant. Same posture the telematics sync uses
 * (readiness precedes createAdminClient), so activation is pure config.
 *
 * ── WHY SERVICE ROLE ────────────────────────────────────────────────────────
 * `merchant_catalogue_items` and `merchant_po_submissions` have NO authenticated
 * writer by design (20261124000001): a tenant JWT can only READ its own org's
 * catalogue + submission ledger, so a live import/submit is a service-role writer,
 * one of the legitimate elevated call sites lib/supabase/admin.ts enumerates. The
 * cross-tenant control is NOT the client — it is the COMPOSITE FKs on both tables
 * (connection_id carries org_id), so a row can never bind another org's
 * connection even under service_role. Every row written here carries the
 * CONNECTION's org_id and is org-pinned on every read.
 *
 * ── SECRETS ────────────────────────────────────────────────────────────────
 * The per-org `account_secret` is decrypted on use (only ever after the
 * connectable + connected gate) and handed to the seam; it is NEVER logged and
 * NEVER persisted into a data-table row. The submission ledger stores only a
 * short, non-secret response snippet.
 */

// ── The service-role builder shape ──────────────────────────────────────────
// The merchant tables post-date the generated types.ts, so the admin client is
// cast to this minimal builder; the composite FKs + append-only trigger are the
// DB authority regardless of the cast.
type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null };

type SelectChain<T> = PromiseLike<DbResult<T>> & {
  eq(col: string, val: string): SelectChain<T>;
  order(col: string, opts: { ascending: boolean }): SelectChain<T>;
  range(from: number, to: number): PromiseLike<DbResult<T>>;
  limit(n: number): PromiseLike<DbResult<T>>;
  maybeSingle(): PromiseLike<DbResult<T>>;
};

type UpdateChain = PromiseLike<{ error: { message: string } | null }> & {
  eq(col: string, val: string): UpdateChain;
};

type LooseDb = {
  from(t: string): {
    select(c: string): SelectChain<unknown>;
    upsert(
      rows: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates: boolean; count?: string },
    ): PromiseLike<{ error: { message: string; code?: string } | null; count: number | null }>;
    insert(
      rows: Record<string, unknown>,
    ): {
      select(c: string): { single(): PromiseLike<DbResult<{ id: string }>> };
    };
    update(row: Record<string, unknown>): UpdateChain;
  };
};

/** The connection row this module reads service-role (secret column included). */
type ConnectionRow = {
  id: string;
  status: string;
  external_account_id: string | null;
  account_secret: string | null;
};

/**
 * Resolve the org's connection for a merchant, service-role. Org-pinned on the
 * read so a connection can only ever be this org's. Returns null when no row
 * exists yet (never connected).
 */
async function readConnection(
  loose: LooseDb,
  orgId: string,
  provider: MerchantProvider,
): Promise<{ row: ConnectionRow | null; error: string | null }> {
  const { data, error } = (await (
    loose
      .from("merchant_connections")
      .select("id, status, external_account_id, account_secret") as SelectChain<ConnectionRow>
  )
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle()) as DbResult<ConnectionRow>;
  if (error) return { row: null, error: error.message };
  return { row: data, error: null };
}

/**
 * Decrypt the stored per-org account secret when present. NULL (dark) or absent →
 * null (the deployment credential is used by the adapter). Never logs the value.
 */
function resolveAccountSecret(row: ConnectionRow): string | null {
  if (!row.account_secret) return null;
  if (!isTokenEncryptionConfigured()) return null;
  return decryptToken(row.account_secret);
}

// ── 1. CATALOGUE IMPORT WRITER ──────────────────────────────────────────────

export type MerchantCatalogueImportOutcome = {
  /** false when dark: no client was constructed, nothing fetched. */
  ran: boolean;
  provider: MerchantProvider;
  status: "imported" | "skipped_dark" | "not_connected" | "error";
  /** Catalogue rows upserted (idempotent on the natural key). */
  written: number;
  message: string;
};

const CATALOGUE_CONFLICT = "org_id,provider,sku";
const CATALOGUE_WRITE_CHUNK = 500;

/** Map a parsed catalogue item onto a merchant_catalogue_items insert row. */
function toCatalogueRow(
  item: CatalogueItem,
  orgId: string,
  provider: MerchantProvider,
  connectionId: string,
): Record<string, unknown> {
  return {
    org_id: orgId,
    provider,
    connection_id: connectionId,
    sku: item.sku,
    description: item.description,
    unit: item.unit,
    pack_size: item.packSize,
    unit_price_pence: item.unitPricePence,
    currency: item.currency,
    vat_code: item.vatCode,
    effective_date: item.effectiveDate,
    imported_at: new Date().toISOString(),
  };
}

/**
 * Import a merchant's trade price file and UPSERT the parsed catalogue rows into
 * merchant_catalogue_items for an org.
 *
 * DARK-SAFE: returns `ran:false` / `skipped_dark` BEFORE any client construction
 * when the merchant is not connectable, and `not_connected` when the org has no
 * `connected` row — in both cases nothing is fetched and nothing is written.
 *
 * IDEMPOTENT: the write is an UPSERT on the table's natural key
 * (org_id, provider, sku), so a re-import updates each SKU's price in place rather
 * than duplicating it. Batched through the shared safe-batch-write helper so one
 * uninsertable row can never strand the whole import.
 *
 * ORG-SCOPED: every row carries the connection's org_id + connection_id, and the
 * composite FK refuses a row bound to another org's connection.
 */
export async function runMerchantCatalogueImport(params: {
  orgId: string;
  provider: MerchantProvider;
}): Promise<MerchantCatalogueImportOutcome> {
  const { orgId, provider } = params;

  // ── DARK GATE FIRST — before any client / DB / network ──────────────────────
  if (!merchantProviderReady(provider)) {
    return {
      ran: false,
      provider,
      status: "skipped_dark",
      written: 0,
      message: `${provider} is not connected; nothing was imported.`,
    };
  }

  const loose = createAdminClient() as unknown as LooseDb;

  const { row: conn, error: connErr } = await readConnection(loose, orgId, provider);
  if (connErr) {
    return { ran: true, provider, status: "error", written: 0, message: `connection read failed: ${connErr}` };
  }
  if (!conn || conn.status !== "connected" || !conn.external_account_id) {
    return {
      ran: true,
      provider,
      status: "not_connected",
      written: 0,
      message: `${provider} has no connected account; nothing was imported.`,
    };
  }

  // Fetch + parse through the existing composition (refuses before fetch when the
  // adapter is unavailable — impossible to reach here dark).
  const result = await importMerchantCatalogue({
    provider,
    accountHandle: conn.external_account_id,
    accountSecret: resolveAccountSecret(conn),
  });
  if (result.status === "skipped_dark") {
    return { ran: true, provider, status: "not_connected", written: 0, message: result.message };
  }
  if (!result.ok) {
    await recordConnectionSync(loose, orgId, provider, result.message);
    return { ran: true, provider, status: "error", written: 0, message: result.message };
  }

  const rows = result.items.map((item) => toCatalogueRow(item, orgId, provider, conn.id));
  const write = await safeBatchWrite(
    rows,
    (chunk) =>
      loose.from("merchant_catalogue_items").upsert(chunk as Record<string, unknown>[], {
        onConflict: CATALOGUE_CONFLICT,
        // A re-import UPDATES the price for an existing (org, provider, sku) rather
        // than duplicating it — the table's natural-key idempotency contract.
        ignoreDuplicates: false,
        count: "exact",
      }),
    { chunkSize: CATALOGUE_WRITE_CHUNK },
  );

  if (write.transientError !== null) {
    await recordConnectionSync(loose, orgId, provider, `catalogue write failed: ${write.transientError}`);
    return {
      ran: true,
      provider,
      status: "error",
      written: write.written,
      message: `catalogue write failed: ${write.transientError}`,
    };
  }

  await recordConnectionSync(loose, orgId, provider, write.constraintError);
  return {
    ran: true,
    provider,
    status: "imported",
    written: write.written,
    message: write.constraintError
      ? `imported ${write.written} catalogue items (${write.constraintError})`
      : `imported ${write.written} catalogue items`,
  };
}

/** Stamp last_sync_at + last_error on the connection after an import pass. */
async function recordConnectionSync(
  loose: LooseDb,
  orgId: string,
  provider: MerchantProvider,
  error: string | null,
): Promise<void> {
  await loose
    .from("merchant_connections")
    .update({ last_sync_at: new Date().toISOString(), last_error: error })
    .eq("org_id", orgId)
    .eq("provider", provider);
}

// ── 2. PO SUBMIT WRITER ─────────────────────────────────────────────────────

export type MerchantPoSubmitOutcome = {
  /** false when dark: no client was constructed, nothing submitted. */
  ran: boolean;
  provider: MerchantProvider;
  status:
    | "acknowledged"
    | "already_submitted"
    | "rejected"
    | "skipped_dark"
    | "not_connected"
    | "not_found"
    | "error";
  externalOrderRef: string | null;
  /** The ledger row id written for this attempt (null when none was written). */
  submissionId: string | null;
  message: string;
};

type PoHeaderRow = {
  id: string;
  number: string;
  status: string;
  supplier_reference: string | null;
  expected_date: string | null;
};
type PoLineRow = {
  description: string;
  qty: number | string | null;
  unit: string | null;
  unit_price: number | string | null;
  sort_order: number | null;
};
type CatalogueLookupRow = { sku: string; description: string; unit_price_pence: number | null };

/** Map a PO header + lines + catalogue index onto a provider-agnostic payload. */
function buildPayload(
  po: PoHeaderRow,
  lines: PoLineRow[],
  accountHandle: string,
  skuByDescription: Map<string, { sku: string; unitPricePence: number | null }>,
): PurchaseOrderPayload {
  const orderLines: PurchaseOrderLine[] = [...lines]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((li) => {
      const description = li.description;
      const matched = skuByDescription.get(description.trim().toLowerCase());
      // Resolve the merchant SKU from the org's imported catalogue (the coupling
      // between the two writers); fall back to the description as the code when the
      // line is not in the catalogue, so a mixed order is still buildable.
      const unitPricePence =
        li.unit_price != null ? Math.round(Number(li.unit_price) * 100) : matched?.unitPricePence ?? null;
      return {
        sku: matched?.sku ?? description.trim(),
        description,
        quantity: Number(li.qty ?? 0),
        unit: li.unit,
        unitPricePence,
      };
    });
  return {
    purchaseOrderId: po.id,
    reference: po.number,
    accountHandle,
    deliveryLines: [],
    requestedDeliveryDate: po.expected_date,
    currency: "GBP",
    lines: orderLines,
  };
}

/**
 * Submit a CrewFlow purchase order to a merchant electronically and RECORD the
 * outcome in merchant_po_submissions.
 *
 * DARK-SAFE: returns `ran:false` / `skipped_dark` BEFORE any client construction
 * when the merchant is not connectable; `not_connected` when the org has no
 * `connected` row. Nothing is submitted and no ledger row is written while dark —
 * both data tables stay empty until activation.
 *
 * IDEMPOTENT: before contacting the merchant it looks for an existing
 * `acknowledged` submission for this (org_id, purchase_order_id) — the ledger's
 * natural idempotency key — and short-circuits to `already_submitted` rather than
 * re-sending the order or writing a duplicate. A prior `rejected`/`error` attempt
 * does not block a retry (a new ledger row is appended, honouring the append-only
 * ledger).
 *
 * ORG-SCOPED: the PO is read org-pinned (a foreign PO is `not_found`); every
 * ledger row carries the connection's org_id + connection_id, and the composite FK
 * refuses a row bound to another org's connection.
 */
export async function submitPurchaseOrderToMerchantForOrg(params: {
  orgId: string;
  provider: MerchantProvider;
  purchaseOrderId: string;
  submittedBy: string | null;
}): Promise<MerchantPoSubmitOutcome> {
  const { orgId, provider, purchaseOrderId, submittedBy } = params;

  // ── DARK GATE FIRST — before any client / DB / network ──────────────────────
  if (!merchantProviderReady(provider)) {
    return {
      ran: false,
      provider,
      status: "skipped_dark",
      externalOrderRef: null,
      submissionId: null,
      message: `${provider} is not connected; the order was not submitted.`,
    };
  }

  const loose = createAdminClient() as unknown as LooseDb;

  const { row: conn, error: connErr } = await readConnection(loose, orgId, provider);
  if (connErr) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: `connection read failed: ${connErr}` };
  }
  if (!conn || conn.status !== "connected" || !conn.external_account_id) {
    return {
      ran: true,
      provider,
      status: "not_connected",
      externalOrderRef: null,
      submissionId: null,
      message: `${provider} has no connected account; the order was not submitted.`,
    };
  }

  // IDEMPOTENCY GUARD — an order already accepted by this merchant is never
  // re-sent. (org_id, purchase_order_id, status='acknowledged') is the natural key.
  const { data: prior, error: priorErr } = (await (
    loose
      .from("merchant_po_submissions")
      .select("id, external_order_ref") as SelectChain<{ id: string; external_order_ref: string | null }[]>
  )
    .eq("org_id", orgId)
    .eq("purchase_order_id", purchaseOrderId)
    .eq("status", "acknowledged")
    .limit(1)) as DbResult<{ id: string; external_order_ref: string | null }[]>;
  if (priorErr) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: `ledger read failed: ${priorErr.message}` };
  }
  if (prior && prior.length > 0) {
    return {
      ran: true,
      provider,
      status: "already_submitted",
      externalOrderRef: prior[0]!.external_order_ref,
      submissionId: prior[0]!.id,
      message: "this purchase order has already been accepted by the merchant.",
    };
  }

  // Read the PO header org-pinned — a foreign PO is not-found, never submitted.
  const { data: po, error: poErr } = (await (
    loose
      .from("purchase_orders")
      .select("id, number, status, supplier_reference, expected_date") as SelectChain<PoHeaderRow>
  )
    .eq("id", purchaseOrderId)
    .eq("org_id", orgId)
    .maybeSingle()) as DbResult<PoHeaderRow>;
  if (poErr) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: `purchase order read failed: ${poErr.message}` };
  }
  if (!po) {
    return { ran: true, provider, status: "not_found", externalOrderRef: null, submissionId: null, message: "purchase order not found." };
  }

  // Read the PO lines + the org's catalogue for this merchant (SKU resolution),
  // both org-pinned + paged (F-1).
  const { data: lines, error: linesErr } = await fetchAllRows<PoLineRow>((from, to) =>
    (loose
      .from("purchase_order_line_items")
      .select("description, qty, unit, unit_price, sort_order") as SelectChain<PoLineRow[]>)
      .eq("org_id", orgId)
      .eq("purchase_order_id", purchaseOrderId)
      .order("sort_order", { ascending: true })
      .range(from, to) as PromiseLike<PageResult<PoLineRow>>,
  );
  if (linesErr) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: `line-item read failed` };
  }
  if ((lines ?? []).length === 0) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: "purchase order has no lines to submit." };
  }

  const { data: catalogue, error: catErr } = await fetchAllRows<CatalogueLookupRow>((from, to) =>
    (loose
      .from("merchant_catalogue_items")
      .select("sku, description, unit_price_pence") as SelectChain<CatalogueLookupRow[]>)
      .eq("org_id", orgId)
      .eq("provider", provider)
      .order("sku", { ascending: true })
      .range(from, to) as PromiseLike<PageResult<CatalogueLookupRow>>,
  );
  // LOUD: a failed catalogue read must not silently degrade to description-only
  // SKUs (which could submit an order with the wrong codes) — refuse instead.
  if (catErr) {
    return { ran: true, provider, status: "error", externalOrderRef: null, submissionId: null, message: `catalogue read failed` };
  }
  const skuByDescription = new Map<string, { sku: string; unitPricePence: number | null }>();
  for (const c of catalogue ?? []) {
    skuByDescription.set(c.description.trim().toLowerCase(), { sku: c.sku, unitPricePence: c.unit_price_pence });
  }

  const payload = buildPayload(po, lines ?? [], conn.external_account_id, skuByDescription);

  // Submit through the existing seam (refuses before fetch when dark).
  const result = await submitPurchaseOrderToMerchant({
    provider,
    order: payload,
    accountSecret: resolveAccountSecret(conn),
  });
  if (result.status === "skipped_dark") {
    return { ran: true, provider, status: "not_connected", externalOrderRef: null, submissionId: null, message: result.message };
  }

  // Record the outcome (a real attempt — submitted / rejected / error — is a
  // ledger fact worth keeping; dark is the only outcome that writes nothing).
  const ledgerStatus = result.ok ? "acknowledged" : result.status === "rejected" ? "rejected" : "error";
  const submittedAt = result.ok ? new Date().toISOString() : null;
  const { data: ledger, error: ledgerErr } = await loose
    .from("merchant_po_submissions")
    .insert({
      org_id: orgId,
      provider,
      connection_id: conn.id,
      purchase_order_id: purchaseOrderId,
      status: ledgerStatus,
      request_format: "cxml",
      external_order_ref: result.externalOrderRef,
      // A short, NON-secret snippet only — the request body (which carries the
      // shared secret) is never stored.
      response_text: result.message.slice(0, 500),
      submitted_by: submittedBy,
      submitted_at: submittedAt,
    })
    .select("id")
    .single();
  if (ledgerErr) {
    return {
      ran: true,
      provider,
      status: "error",
      externalOrderRef: result.externalOrderRef,
      submissionId: null,
      message: `submission recorded outcome could not be persisted: ${ledgerErr.message}`,
    };
  }

  return {
    ran: true,
    provider,
    status: result.ok ? "acknowledged" : result.status === "rejected" ? "rejected" : "error",
    externalOrderRef: result.externalOrderRef,
    submissionId: ledger?.id ?? null,
    message: result.message,
  };
}

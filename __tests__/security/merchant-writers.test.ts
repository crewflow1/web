import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runMerchantCatalogueImport,
  submitPurchaseOrderToMerchantForOrg,
} from "@/server/services/merchant-writers";

/**
 * Merchant PERSISTENCE WRITERS (20261124) — trust-boundary + structural proofs.
 *
 * The audit found the merchant catalogue-import + PO-submit compositions had NO
 * writer and NO caller. This suite pins the NEW writers' invariants:
 *
 *   1. BEHAVIOURAL DARK-SAFE: with no credentials + flag off, BOTH writers refuse
 *      before constructing a client / touching the network and write nothing.
 *   2. STRUCTURAL: the dark readiness gate precedes createAdminClient (zero DB
 *      while dark); writes are service-role; the catalogue UPSERT uses the
 *      table's natural key (org_id, provider, sku); the ledger is INSERT-only
 *      (append-only); every read is org-pinned; no new anon/SECURITY DEFINER RPC.
 *   3. No source logs a secret.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const WRITERS = "server/services/merchant-writers.ts";
const SETTINGS_ACTIONS = "app/(app)/settings/integrations/actions.ts";
const PO_ACTIONS = "app/(app)/purchase-orders/actions.ts";

const ENV_KEYS = [
  "NEXT_PUBLIC_FEATURE_MERCHANTS",
  "MERCHANT_JEWSON_API_KEY",
  "MERCHANT_JEWSON_ENDPOINT",
  "MERCHANT_JEWSON_PRICE_FILE_URL",
  "MERCHANT_TRAVIS_PERKINS_API_KEY",
  "MERCHANT_TRAVIS_PERKINS_ENDPOINT",
];

// ---------------------------------------------------------------------------
// 1. BEHAVIOURAL — the writers are dark-safe (no client, no fetch, no write)
// ---------------------------------------------------------------------------

describe("merchant writers refuse before any client/fetch while dark", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("catalogue import returns ran:false / skipped_dark and writes nothing", async () => {
    const out = await runMerchantCatalogueImport({ orgId: "org-1", provider: "jewson" });
    expect(out.ran).toBe(false);
    expect(out.status).toBe("skipped_dark");
    expect(out.written).toBe(0);
  });

  it("PO submit returns ran:false / skipped_dark and submits nothing", async () => {
    const out = await submitPurchaseOrderToMerchantForOrg({
      orgId: "org-1",
      provider: "jewson",
      purchaseOrderId: "00000000-0000-0000-0000-000000000000",
      submittedBy: null,
    });
    expect(out.ran).toBe(false);
    expect(out.status).toBe("skipped_dark");
    expect(out.submissionId).toBeNull();
    expect(out.externalOrderRef).toBeNull();
  });

  it("a credential WITHOUT the flag stays dark (two-switch)", async () => {
    process.env.MERCHANT_JEWSON_API_KEY = "key";
    process.env.MERCHANT_JEWSON_ENDPOINT = "https://gw.example.com/cxml";
    // flag deliberately off
    const out = await runMerchantCatalogueImport({ orgId: "org-1", provider: "jewson" });
    expect(out.ran).toBe(false);
    expect(out.status).toBe("skipped_dark");
  });
});

// ---------------------------------------------------------------------------
// 2. STRUCTURAL — dark-gate-first, service-role, natural-key, append-only
// ---------------------------------------------------------------------------

describe("merchant writers — structural invariants", () => {
  const code = codeOf(read(WRITERS));

  it("the readiness gate precedes createAdminClient (zero DB while dark)", () => {
    const catStart = code.indexOf("export async function runMerchantCatalogueImport");
    const subStart = code.indexOf("export async function submitPurchaseOrderToMerchantForOrg");
    expect(catStart).toBeGreaterThan(-1);
    expect(subStart).toBeGreaterThan(-1);
    for (const [name, start, end] of [
      ["catalogue", catStart, subStart],
      ["submit", subStart, code.length],
    ] as const) {
      const body = code.slice(start, end);
      const gateIdx = body.indexOf("merchantProviderReady(provider)");
      const adminIdx = body.indexOf("createAdminClient(");
      expect(gateIdx, `${name}: readiness gate present`).toBeGreaterThan(-1);
      expect(adminIdx, `${name}: createAdminClient present`).toBeGreaterThan(-1);
      expect(gateIdx, `${name}: gate precedes client`).toBeLessThan(adminIdx);
      expect(body).toMatch(/ran:\s*false/);
    }
  });

  it("catalogue write is a service-role UPSERT on the natural key (org_id, provider, sku)", () => {
    expect(code).toMatch(/createAdminClient\(\)/);
    expect(code).toMatch(/merchant_catalogue_items/);
    expect(code).toMatch(/onConflict:\s*CATALOGUE_CONFLICT/);
    expect(code).toMatch(/CATALOGUE_CONFLICT\s*=\s*"org_id,provider,sku"/);
    // A re-import UPDATES rather than duplicates — ignoreDuplicates:false.
    expect(code).toMatch(/ignoreDuplicates:\s*false/);
  });

  it("the submission ledger is INSERT-only (append-only) — never updated", () => {
    // The writer INSERTs into the ledger and never UPDATEs it (the DB trigger
    // makes an UPDATE impossible anyway).
    expect(code).toMatch(/from\("merchant_po_submissions"\)[\s\S]{0,80}\.insert\(/);
    expect(code).not.toMatch(/from\("merchant_po_submissions"\)[\s\S]{0,80}\.update\(/);
  });

  it("idempotency guard: an acknowledged submission short-circuits the re-send", () => {
    expect(code).toMatch(/\.eq\("status",\s*"acknowledged"\)/);
    expect(code).toMatch(/already_submitted/);
  });

  it("every merchant-table read/write is org-pinned", () => {
    // catalogue upsert rows + ledger insert carry org_id; reads pin org_id.
    expect(code).toMatch(/\.eq\("org_id",\s*orgId\)/);
    expect(code).toMatch(/org_id:\s*orgId/);
  });

  it("pins each written row to the CONNECTION's id (composite-FK completeness)", () => {
    expect(code).toMatch(/connection_id:\s*conn\.id/);
  });

  it("adds NO new anon/authenticated SECURITY DEFINER RPC (service-role writes only)", () => {
    expect(code).not.toMatch(/security\s+definer/i);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("never persists or logs the account secret", () => {
    // The secret is decrypted on use and flows ONLY to the adapter seam, never
    // into a persisted row.
    expect(code).toMatch(/accountSecret:\s*resolveAccountSecret\(conn\)/);
    // No persisted-row builder names account_secret (it is never written to a row).
    const catalogueRow = code.slice(
      code.indexOf("function toCatalogueRow"),
      code.indexOf("function toCatalogueRow") + 700,
    );
    expect(catalogueRow).toMatch(/org_id:\s*orgId/); // sanity: we sliced the builder
    expect(catalogueRow).not.toMatch(/account_secret/);
    const ledgerInsert = code.slice(
      code.indexOf('.from("merchant_po_submissions")\n    .insert('),
      code.indexOf('.select("id")\n    .single();'),
    );
    expect(ledgerInsert).toMatch(/purchase_order_id:/); // sanity: we sliced the insert
    expect(ledgerInsert).not.toMatch(/account_secret/);
    const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/account_?secret/i);
      expect(call).not.toMatch(/api_?key/i);
      expect(call).not.toMatch(/sharedSecret/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. WIRING — admin-gated catalogue action; PO-core submit action
// ---------------------------------------------------------------------------

describe("merchant writer wiring", () => {
  it("the catalogue import action is admin-gated + org-pinned", () => {
    const code = codeOf(read(SETTINGS_ACTIONS));
    expect(code).toMatch(/export async function importMerchantCatalogueAction/);
    const start = code.indexOf("export async function importMerchantCatalogueAction");
    const body = code.slice(start, start + 900);
    expect(body).toMatch(/isMerchantProvider\(/);
    expect(body).toMatch(/isAdminRole\(ctx\.membership\.role\)/);
    expect(body).toMatch(/runMerchantCatalogueImport\(\{\s*orgId:\s*ctx\.org\.id/);
  });

  it("the PO-core submit action validates the provider + org-pins via ctx.org.id", () => {
    const code = codeOf(read(PO_ACTIONS));
    expect(code).toMatch(/export async function submitPurchaseOrderToMerchantAction/);
    const start = code.indexOf("export async function submitPurchaseOrderToMerchantAction");
    const body = code.slice(start, start + 1200);
    expect(body).toMatch(/isMerchantProvider\(/);
    expect(body).toMatch(/submitPurchaseOrderToMerchantForOrg\(\{[\s\S]*orgId:\s*ctx\.org\.id/);
    expect(body).toMatch(/purchaseOrderId:\s*id/);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isMerchantConnectable,
  merchantsFeatureEnabled,
  resolveMerchantConfig,
  isMerchantProvider,
  MERCHANT_PROVIDERS,
} from "@/lib/integrations/merchants/connect";
import {
  getMerchantAdapter,
  getMerchantReadiness,
  merchantProviderReady,
} from "@/lib/integrations/merchants/adapters";

/**
 * Builders' merchant CONNECT (20261124) — trust-boundary proofs.
 *
 * Section 1: the connect resolver is DARK. With no credentials, no endpoint and
 * the feature flag off, no merchant is connectable; every adapter reports itself
 * unavailable. A credential alone cannot reach a live call — the two-switch gate
 * (flag + credentials/endpoint) holds, and above it a commercial contract gate.
 *
 * Section 2: merchant_connections RLS is DB-enforced admin-write / member-read,
 * org-pinned, with UNIQUE(org,provider), a composite (id,org_id) key, a CHECK that
 * a `connected` row must name an account (no fake connected state), and the secret
 * columns stripped from the authenticated read surface by a COLUMN privilege.
 *
 * Section 3: merchant_catalogue_items + merchant_po_submissions are org-pinned with
 * COMPOSITE FKs to merchant_connections (cross-tenant binding), the ledger is
 * append-only, both are member-read with NO authenticated writer, and NEITHER
 * foreign-keys into purchase_orders (the PO core is untouched).
 *
 * Section 4: the adapters + service REFUSE before any fetch while dark, every
 * outbound URL passes the shared SSRF guard, and no source logs a secret.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_CONN = "supabase/migrations/20261124000000_merchant_connections.sql";
const MIG_DATA = "supabase/migrations/20261124000001_merchant_catalogue_and_orders.sql";
const CONNECT = "lib/integrations/merchants/connect.ts";
const SERVICE = "server/services/merchant-connections.ts";
const CXML_ADAPTER = "lib/integrations/merchants/adapters/cxml-merchant.ts";
const PENDING = "lib/integrations/merchants/adapters/pending.ts";
const CXML = "lib/integrations/merchants/cxml.ts";
const PRICE_FILE = "lib/integrations/merchants/price-file.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sqlConn = sqlOnly(read(MIG_CONN));
const sqlData = sqlOnly(read(MIG_DATA));

const ENV_KEYS = [
  "NEXT_PUBLIC_FEATURE_MERCHANTS",
  "MERCHANT_JP_CORRY_API_KEY",
  "MERCHANT_JP_CORRY_ENDPOINT",
  "MERCHANT_JP_CORRY_PRICE_FILE_URL",
  "MERCHANT_JEWSON_API_KEY",
  "MERCHANT_JEWSON_ENDPOINT",
  "MERCHANT_JEWSON_PRICE_FILE_URL",
  "MERCHANT_TRAVIS_PERKINS_API_KEY",
  "MERCHANT_TRAVIS_PERKINS_ENDPOINT",
  "MERCHANT_TRAVIS_PERKINS_PRICE_FILE_URL",
  "MERCHANT_HALDANE_FISHER_API_KEY",
  "MERCHANT_HALDANE_FISHER_ENDPOINT",
  "MERCHANT_HALDANE_FISHER_PRICE_FILE_URL",
];

// ---------------------------------------------------------------------------
// 1. THE CONNECT RESOLVER IS DARK — no connectable merchant without credentials
// ---------------------------------------------------------------------------

describe("merchant connect resolver is dark without credentials", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("no merchant is connectable when credentials + flag are absent", () => {
    expect(merchantsFeatureEnabled()).toBe(false);
    for (const p of MERCHANT_PROVIDERS) {
      expect(isMerchantConnectable(p)).toBe(false);
      expect(resolveMerchantConfig(p)).toBeNull();
      expect(merchantProviderReady(p)).toBe(false);
    }
  });

  it("credentials + endpoint WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.MERCHANT_JEWSON_API_KEY = "key";
    process.env.MERCHANT_JEWSON_ENDPOINT = "https://gw.example.com/cxml";
    // Flag deliberately left off.
    expect(isMerchantConnectable("jewson")).toBe(false);
  });

  it("flag + API key WITHOUT an endpoint are not connectable (no host to call)", () => {
    process.env.NEXT_PUBLIC_FEATURE_MERCHANTS = "true";
    process.env.MERCHANT_JEWSON_API_KEY = "key";
    // No endpoint — there is no default host anywhere in the build.
    expect(isMerchantConnectable("jewson")).toBe(false);
  });

  it("only a FULLY-configured merchant is connectable, and only with all switches on", () => {
    process.env.NEXT_PUBLIC_FEATURE_MERCHANTS = "true";
    process.env.MERCHANT_JEWSON_API_KEY = "key";
    process.env.MERCHANT_JEWSON_ENDPOINT = "https://gw.example.com/cxml";
    expect(isMerchantConnectable("jewson")).toBe(true);
    // Every other merchant stays dark — per-merchant gating, not global.
    expect(isMerchantConnectable("travis_perkins")).toBe(false);
    expect(isMerchantConnectable("jp_corry")).toBe(false);
    expect(isMerchantConnectable("haldane_fisher")).toBe(false);
  });

  it("readiness reports every merchant false while dark", () => {
    const readiness = getMerchantReadiness();
    for (const p of MERCHANT_PROVIDERS) expect(readiness[p]).toBe(false);
  });

  it("rejects an unknown provider string (route/form guard)", () => {
    expect(isMerchantProvider("jewson")).toBe(true);
    expect(isMerchantProvider("wickes")).toBe(false);
    expect(isMerchantProvider("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. merchant_connections — RLS, tenancy, no fake connected state
// ---------------------------------------------------------------------------

describe("merchant_connections RLS + shape", () => {
  it("enables RLS", () => {
    expect(sqlConn).toMatch(
      /alter table public\.merchant_connections enable row level security/i,
    );
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sqlConn).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert / update / delete gated on is_org_admin()", () => {
    expect(sqlConn).toMatch(
      /create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
    expect(sqlConn).toMatch(
      /create policy[^;]*admins can update[^;]*for update[\s\S]*is_org_admin\(/i,
    );
    expect(sqlConn).toMatch(
      /create policy[^;]*admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i,
    );
  });

  it("is org-pinned with cascade teardown + composite candidate key", () => {
    expect(sqlConn).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sqlConn).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });

  it("has ONE connection per (org, provider)", () => {
    expect(sqlConn).toMatch(/unique\s*\(org_id,\s*provider\)/i);
  });

  it("constrains provider and status to the documented vocabularies", () => {
    expect(sqlConn).toMatch(
      /provider\s+text not null check \(provider in \('jp_corry', 'jewson', 'travis_perkins', 'haldane_fisher'\)\)/i,
    );
    expect(sqlConn).toMatch(
      /status\s+text not null default 'disconnected'[\s\S]*check \(status in \('disconnected', 'connecting', 'connected', 'error'\)\)/i,
    );
  });

  it("FORBIDS a fake connected state: connected requires an account handle", () => {
    expect(sqlConn).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or external_account_id is not null\s*\)/i,
    );
  });

  it("carries a secret column but the migration writes nothing (dark)", () => {
    expect(sqlConn).toMatch(/account_secret\s+text/i);
    expect(sqlConn).not.toMatch(/insert\s+into\s+public\.merchant_connections/i);
  });

  it("STRIPS the secret columns from the authenticated read surface (column privilege)", () => {
    expect(sqlConn).toMatch(/revoke\s+all\s+on\s+table\s+public\.merchant_connections\s+from\s+anon/i);
    expect(sqlConn).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.merchant_connections\s+from\s+authenticated/i,
    );
    const grant = sqlConn.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.merchant_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/account_secret/i);
    expect(cols).not.toMatch(/secret_expires_at/i);
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bprovider\b/i);
    expect(cols).toMatch(/external_account_id/i);
  });
});

// ---------------------------------------------------------------------------
// 3. catalogue + submissions — org-pinned, composite-FK, append-only, PO-safe
// ---------------------------------------------------------------------------

describe("merchant data tables tenancy + append-only", () => {
  it("catalogue binds connection_id via a COMPOSITE FK to merchant_connections (id, org_id)", () => {
    expect(sqlData).toMatch(
      /foreign key \(connection_id, org_id\) references public\.merchant_connections \(id, org_id\)/i,
    );
  });

  it("both data tables are org-pinned with cascade teardown", () => {
    const org = /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/gi;
    expect((sqlData.match(org) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("catalogue upserts on (org, provider, sku) — one price row per SKU", () => {
    expect(sqlData).toMatch(/unique\s*\(org_id,\s*provider,\s*sku\)/i);
  });

  it("the submission ledger is APPEND-ONLY: a BEFORE UPDATE trigger raises", () => {
    expect(sqlData).toMatch(/create trigger merchant_po_submissions_immutable before update/i);
    expect(sqlData).toMatch(/append-only and cannot be updated/i);
  });

  it("does NOT foreign-key into purchase_orders (PO core untouched)", () => {
    expect(sqlData).not.toMatch(/references\s+public\.purchase_orders/i);
    expect(sqlData).not.toMatch(/alter table\s+public\.purchase_orders/i);
  });

  it("both data tables are member-read with NO authenticated writer, anon revoked", () => {
    expect(sqlData).toMatch(
      /create policy[^;]*merchant_catalogue_items: members can select[^;]*for select/i,
    );
    expect(sqlData).toMatch(
      /create policy[^;]*merchant_po_submissions: members can select[^;]*for select/i,
    );
    expect(sqlData).not.toMatch(/create policy[^;]*merchant_catalogue_items[^;]*for insert/i);
    expect(sqlData).not.toMatch(/create policy[^;]*merchant_po_submissions[^;]*for insert/i);
    expect(sqlData).toMatch(/revoke\s+all\s+on\s+table\s+public\.merchant_catalogue_items\s+from\s+anon/i);
    expect(sqlData).toMatch(/revoke\s+all\s+on\s+table\s+public\.merchant_po_submissions\s+from\s+anon/i);
  });
});

// ---------------------------------------------------------------------------
// 4. ADAPTERS + SERVICE — refuse-before-fetch, SSRF-guarded, no leak
// ---------------------------------------------------------------------------

describe("merchant adapters refuse before any fetch", () => {
  it("the cXML adapter's EVERY fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(CXML_ADAPTER));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const firstFetch = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstFetch).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstFetch);
    // No SDK import / client construction at module scope.
    expect(code).not.toMatch(/^import .*axios/im);
  });

  it("the cXML adapter validates the endpoint through the shared SSRF guard before fetch", () => {
    const code = codeOf(read(CXML_ADAPTER));
    expect(code).toMatch(/assertPublicWebhookUrl\(/);
    // The SSRF assertion precedes the network call in both methods.
    const guardIdx = code.indexOf("assertPublicWebhookUrl(");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    // Redirects refused (a redirect is a second, unvetted URL).
    expect(code).toMatch(/redirect:\s*"error"/);
  });

  it("the pending adapter contains NO fetch at all (dark-safe skeleton)", () => {
    const code = codeOf(read(PENDING));
    expect(code).not.toMatch(/fetch\(/);
    expect(code).toMatch(/if \(!this\.isAvailable\(\)\)/);
  });

  it("adapters refuse behaviourally when dark (no network, unavailable result)", async () => {
    const original = { ...process.env };
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      for (const p of MERCHANT_PROVIDERS) {
        const adapter = getMerchantAdapter(p);
        expect(adapter.isAvailable()).toBe(false);
        const cat = await adapter.importCatalogue({ accountHandle: "acct" });
        expect(cat.ok).toBe(false);
        if (!cat.ok) expect(cat.reason).toBe("unavailable");
        const ord = await adapter.submitPurchaseOrder({
          order: {
            purchaseOrderId: "po1",
            reference: "PO-1",
            accountHandle: "acct",
            deliveryLines: [],
            requestedDeliveryDate: null,
            currency: "GBP",
            lines: [{ sku: "X", description: "d", quantity: 1, unit: null, unitPricePence: 100 }],
          },
        });
        expect(ord.ok).toBe(false);
        if (!ord.ok) expect(ord.reason).toBe("unavailable");
      }
    } finally {
      process.env = { ...original };
    }
  });
});

describe("merchant service — org-pinned, loud, secret-free, refuse-before-fetch", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on reads and reads loudly", () => {
    expect(code).toMatch(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/);
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("NEVER selects a secret column back to a tenant surface", () => {
    expect(code).not.toMatch(/SELECT_COLUMNS[\s\S]{0,200}account_secret/i);
    expect(code).not.toMatch(/select[\s\S]{0,120}account_secret/i);
  });

  it("import + submit record skipped_dark and refuse before the adapter call when dark", () => {
    expect(code).toMatch(/status:\s*"skipped_dark"/);
    const guardIdx = code.indexOf("adapter.isAvailable()");
    const importIdx = code.indexOf("adapter.importCatalogue(");
    const submitIdx = code.indexOf("adapter.submitPurchaseOrder(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(importIdx);
    expect(guardIdx).toBeLessThan(submitIdx);
  });
});

describe("no secret is ever logged", () => {
  it("no source logs a credential or an account secret", () => {
    for (const f of [CONNECT, SERVICE, CXML_ADAPTER, PENDING, CXML, PRICE_FILE]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/api_?key/i);
        expect(call).not.toMatch(/account_?secret/i);
        expect(call).not.toMatch(/sharedSecret/i);
      }
    }
  });
});

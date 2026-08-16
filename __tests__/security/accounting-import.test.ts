import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAccountingImportAdapter,
  type AccountingPullInput,
} from "@/lib/integrations/accounting/adapters";

/**
 * Direct-API import (PULL) connectors — trust-boundary proofs.
 *
 * Section 1: the PULL adapters ARE DARK. With no OAuth credentials the Xero /
 * QuickBooks pull methods report unavailable and read NOTHING — no client, no
 * network — exactly like their push twins. A credential alone cannot cause a live
 * call, and its absence guarantees the dark path.
 *
 * Section 2: the pull SERVICE refuses BEFORE fetch — it checks the adapter's
 * availability before it ever resolves a token or contacts a provider.
 *
 * Section 3: reusing the token seam did NOT widen the token-read surface — the
 * connections service still has EXACTLY ONE select of a token column (the single
 * service-role helper), and no new file logs a secret.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const XERO = "lib/integrations/accounting/adapters/xero.ts";
const QBO = "lib/integrations/accounting/adapters/quickbooks.ts";
const SERVICE = "server/services/accounting-import.ts";
const CONNECTIONS = "server/services/accounting-connections.ts";
const NORMALISE = "lib/imports/connector-normalise.ts";

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const OAUTH_ENV = [
  "FEATURE_ACCOUNTING_CONNECT",
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET",
  "QBO_CLIENT_ID",
  "QBO_CLIENT_SECRET",
];

// ---------------------------------------------------------------------------
// 1. THE PULL ADAPTERS ARE DARK — nothing read without credentials
// ---------------------------------------------------------------------------

describe("pull adapters are dark without credentials", () => {
  const original = { ...process.env };
  const clear = () => {
    for (const k of OAUTH_ENV) delete process.env[k];
  };
  const DARK_INPUT: AccountingPullInput = {
    accessToken: "",
    tenantId: "T",
    realmId: "R",
    refresh: async () => null,
  };

  it("report unavailable and read NOTHING on the dark path (no network)", async () => {
    clear();
    for (const p of ["xero", "quickbooks"] as const) {
      const a = getAccountingImportAdapter(p);
      expect(a.isAvailable()).toBe(false);
      // If a `fetch` were reached it would throw in this test env; a clean
      // `unavailable` return proves the pull never touched the network.
      const contacts = await a.pullContacts(DARK_INPUT);
      const invoices = await a.pullInvoices(DARK_INPUT);
      expect(contacts.ok).toBe(false);
      expect(invoices.ok).toBe(false);
      if (!contacts.ok) expect(contacts.reason).toBe("unavailable");
      if (!invoices.ok) expect(invoices.reason).toBe("unavailable");
    }
    process.env = { ...original };
  });

  it("credentials WITHOUT the feature flag are still dark (two-switch)", async () => {
    clear();
    process.env.XERO_CLIENT_ID = "id";
    process.env.XERO_CLIENT_SECRET = "secret";
    // FEATURE_ACCOUNTING_CONNECT deliberately left off.
    const a = getAccountingImportAdapter("xero");
    expect(a.isAvailable()).toBe(false);
    const res = await a.pullContacts(DARK_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unavailable");
    process.env = { ...original };
  });

  it("each pull method guards on isAvailable and refuses via pullUnavailable", () => {
    for (const f of [XERO, QBO]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/pullContacts\s*\(/);
      expect(code).toMatch(/pullInvoices\s*\(/);
      expect(code).toMatch(/this\.isAvailable\(\)/);
      expect(code).toMatch(/pullUnavailable/);
      // No provider SDK — the only network is the guarded `fetch`.
      expect(code).not.toMatch(/from\s+["']xero-node["']/);
      expect(code).not.toMatch(/from\s+["']node-quickbooks["']/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE PULL SERVICE REFUSES BEFORE FETCH
// ---------------------------------------------------------------------------

describe("pull service refuses before fetch", () => {
  const code = codeOf(read(SERVICE));

  it("checks availability BEFORE resolving a token or pulling", () => {
    const availAt = code.indexOf("adapter.isAvailable()");
    // The CALL SITES (not the import lines) of the token resolution + the pull.
    const resolveAt = code.indexOf("resolveProviderAccess(orgId");
    const pullAt = code.indexOf("adapter.pullContacts");
    expect(availAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(-1);
    // The availability guard precedes both the token resolution and the pull.
    expect(availAt).toBeLessThan(resolveAt);
    expect(availAt).toBeLessThan(pullAt);
    expect(code).toMatch(/skipped_dark/);
  });

  it("scopes the pull to the ACTIVE org only (org-pinned token resolution)", () => {
    // The token/handle come from resolveProviderAccess(orgId, provider) — the
    // caller-supplied active org — so a pull can only read the org's OWN book.
    expect(code).toMatch(/resolveProviderAccess\(\s*orgId\s*,\s*provider\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE TOKEN SEAM WAS REUSED, NOT WIDENED
// ---------------------------------------------------------------------------

describe("token seam reuse did not widen the read surface", () => {
  it("the connections service still has EXACTLY ONE token-column select", () => {
    const code = codeOf(read(CONNECTIONS));
    const tokenSelects = code.match(/\.select\([^)]*access_token/g) ?? [];
    expect(tokenSelects.length).toBe(1);
  });

  it("resolveProviderAccess reuses the single service-role secret reader", () => {
    const code = codeOf(read(CONNECTIONS));
    expect(code).toMatch(/export async function resolveProviderAccess/);
    // It reads via the existing helper rather than adding its own token select.
    const seg = code.slice(code.indexOf("export async function resolveProviderAccess"));
    expect(seg).toMatch(/readConnectionSecrets\(orgId,\s*provider\)/);
  });

  it("no new connector source logs a secret or a token", () => {
    for (const f of [SERVICE, NORMALISE, XERO, QBO]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/access_?token/i);
        expect(call).not.toMatch(/refresh_?token/i);
        expect(call).not.toMatch(/client_?secret/i);
      }
    }
  });
});

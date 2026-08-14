import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isBankingProviderConnectable,
  bankingConnectFeatureEnabled,
  resolveActiveBankingProvider,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  BANKING_PROVIDERS,
} from "@/lib/integrations/banking/oauth";

/**
 * BANK-FEED OAUTH CONNECT (20261100) — trust-boundary proofs.
 *
 * Section 1: the OAuth resolver is DARK. With no client credentials, no bound
 * provider and the feature flag off, no aggregator is connectable;
 * buildAuthorizeUrl REFUSES with no URL / no PKCE material; exchangeCodeForTokens
 * REFUSES with no network call. A credential alone cannot reach a live call — the
 * token-exchange `fetch` is unreachable dark, and above it all sits the FCA legal
 * gate.
 *
 * Section 2: bank_connections RLS is DB-enforced admin-write / member-read,
 * org-pinned, with UNIQUE(org,provider), a composite (id,org_id) key and a CHECK
 * that a `connected` row must name a connection handle (no fake connected state).
 * The token columns are stripped from the authenticated read surface.
 *
 * Section 3: the routes gate on auth + org + admin, validate the provider, and
 * short-circuit BEFORE any token exchange while dark. The adapters refuse before
 * fetch. The service is org-pinned, loud, and never selects a token column. No
 * secret is logged anywhere.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261100000000_bank_connections.sql";
const OAUTH = "lib/integrations/banking/oauth.ts";
const CONNECT = "app/api/integrations/banking/[provider]/connect/route.ts";
const CALLBACK = "app/api/integrations/banking/[provider]/callback/route.ts";
const SERVICE = "server/services/bank-connections.ts";
const ADAPTER_TL = "lib/integrations/banking/adapters/truelayer.ts";
const ADAPTER_PLAID = "lib/integrations/banking/adapters/plaid.ts";
const ADAPTER_NORDIGEN = "lib/integrations/banking/adapters/nordigen.ts";
const ADAPTER_PENDING = "lib/integrations/banking/adapters/pending.ts";
const STATEMENT_MAP = "lib/integrations/banking/statement-map.ts";

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

const sql = sqlOnly(read(MIG));

const OAUTH_ENV = [
  "BANKING_CLIENT_ID",
  "BANKING_CLIENT_SECRET",
  "BANKING_PROVIDER",
  "NEXT_PUBLIC_FEATURE_BANKING_CONNECT",
];

// ---------------------------------------------------------------------------
// 1. THE OAUTH RESOLVER IS DARK — no connect, no exchange, without credentials
// ---------------------------------------------------------------------------

describe("banking OAuth resolver is dark without credentials", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("no provider is connectable when credentials + flag + binding are absent", () => {
    expect(bankingConnectFeatureEnabled()).toBe(false);
    expect(resolveActiveBankingProvider()).toBeNull();
    for (const p of BANKING_PROVIDERS) {
      expect(isBankingProviderConnectable(p)).toBe(false);
    }
  });

  it("credentials + binding WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.BANKING_CLIENT_ID = "id";
    process.env.BANKING_CLIENT_SECRET = "secret";
    process.env.BANKING_PROVIDER = "truelayer";
    // Flag deliberately left off.
    expect(isBankingProviderConnectable("truelayer")).toBe(false);
  });

  it("flag + credentials WITHOUT a bound provider are not connectable", () => {
    process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
    process.env.BANKING_CLIENT_ID = "id";
    process.env.BANKING_CLIENT_SECRET = "secret";
    // BANKING_PROVIDER deliberately unset.
    for (const p of BANKING_PROVIDERS) {
      expect(isBankingProviderConnectable(p)).toBe(false);
    }
  });

  it("only the bound provider could be connectable (the others stay dark)", () => {
    process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT = "true";
    process.env.BANKING_CLIENT_ID = "id";
    process.env.BANKING_CLIENT_SECRET = "secret";
    process.env.BANKING_PROVIDER = "truelayer";
    expect(isBankingProviderConnectable("plaid")).toBe(false);
    expect(isBankingProviderConnectable("nordigen")).toBe(false);
  });

  it("buildAuthorizeUrl REFUSES with no URL / no PKCE material when dark", () => {
    for (const p of BANKING_PROVIDERS) {
      const res = buildAuthorizeUrl(p, "https://app.example/callback");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("exchangeCodeForTokens REFUSES with NO network call when dark", async () => {
    // If a `fetch` were reached it would throw in this test env; a clean
    // `not_configured` return proves the exchange never touched the network.
    for (const p of BANKING_PROVIDERS) {
      const res = await exchangeCodeForTokens({
        provider: p,
        code: "irrelevant",
        codeVerifier: "irrelevant",
        redirectUri: "https://app.example/callback",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("the ONLY fetch lives AFTER the connectable guard (structural dark path)", () => {
    const code = codeOf(read(OAUTH));
    const fetchIdx = code.indexOf("fetch(");
    expect(fetchIdx).toBeGreaterThan(-1);
    const guardIdx = code.indexOf('reason: "not_configured"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. bank_connections — RLS, tenancy, no fake connected state, token columns
// ---------------------------------------------------------------------------

describe("bank_connections RLS + shape", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.bank_connections enable row level security/i,
    );
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert / update / delete gated on is_org_admin()", () => {
    expect(sql).toMatch(
      /create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*admins can update[^;]*for update[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i,
    );
  });

  it("is org-pinned with cascade teardown + composite candidate key", () => {
    expect(sql).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });

  it("has ONE connection per (org, provider)", () => {
    expect(sql).toMatch(/unique\s*\(org_id,\s*provider\)/i);
  });

  it("constrains provider and status to the documented vocabularies", () => {
    expect(sql).toMatch(
      /provider\s+text not null check \(provider in \('truelayer', 'plaid', 'nordigen'\)\)/i,
    );
    expect(sql).toMatch(
      /status\s+text not null default 'disconnected'[\s\S]*check \(status in \('disconnected', 'connecting', 'connected', 'error'\)\)/i,
    );
  });

  it("FORBIDS a fake connected state: connected requires a connection handle", () => {
    expect(sql).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or connection_ref is not null\s*\)/i,
    );
  });

  it("carries token columns but writes nothing (dark: never populated)", () => {
    expect(sql).toMatch(/access_token\s+text/i);
    expect(sql).toMatch(/refresh_token\s+text/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.bank_connections/i);
  });

  it("STRIPS the token columns from the authenticated read surface (column privilege)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.bank_connections\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.bank_connections\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.bank_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/access_token/i);
    expect(cols).not.toMatch(/refresh_token/i);
    expect(cols).not.toMatch(/token_expires_at/i);
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bprovider\b/i);
    expect(cols).toMatch(/\bconnection_ref\b/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ROUTES + ADAPTERS + SERVICE — gated, dark, refuse-before-fetch
// ---------------------------------------------------------------------------

describe("banking connect routes are gated + dark", () => {
  it("both routes require org context and gate on owner/admin", () => {
    for (const f of [CONNECT, CALLBACK]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/requireOrgContext\(\)/);
      expect(code).toMatch(/role === "owner"/);
      expect(code).toMatch(/role === "admin"/);
      expect(code).toMatch(/unknown_provider/);
    }
  });

  it("connect returns not_configured (no redirect) when the provider is dark", () => {
    const code = codeOf(read(CONNECT));
    expect(code).toMatch(/buildAuthorizeUrl\(/);
    expect(code).toMatch(/not_configured/);
    expect(code).toMatch(/if\s*\(\s*!authorize\.ok\s*\)/);
  });

  it("callback SHORT-CIRCUITS before any token exchange while dark", () => {
    const code = codeOf(read(CALLBACK));
    const guardIdx = code.indexOf("isBankingProviderConnectable(provider)");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(exchangeIdx);
    // Constant-time anti-CSRF; never a bare string compare on the token.
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/state !== stateCookie/);
  });

  it("callback encrypts tokens BEFORE the DB write and enforces the encryption tripwire", () => {
    const code = codeOf(read(CALLBACK));
    // Tripwire: refuse the exchange when no encryption key.
    const tripwireIdx = code.indexOf("isTokenEncryptionConfigured()");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(tripwireIdx).toBeGreaterThan(-1);
    expect(tripwireIdx).toBeLessThan(exchangeIdx);
    // The DB write wraps tokens in encryptToken — never a plaintext token column.
    expect(code).toMatch(/access_token:\s*encryptToken\(/);
    expect(code).toMatch(/encryptToken\(refreshToken\)/);
  });

  it("callback never writes a connected row without a connection handle", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/no_account/);
    expect(code).toMatch(/status:\s*"connected"/);
  });

  it("callback CLEARS the single-use PKCE/state cookies (no replay in the 600s window)", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/function clearOAuthCookies/);
    expect(code).toMatch(/res\.cookies\.set\(\s*STATE_COOKIE\(provider\)\s*,\s*""/);
    expect(code).toMatch(/res\.cookies\.set\(\s*VERIFIER_COOKIE\(provider\)\s*,\s*""/);
    expect(code).toMatch(/maxAge:\s*0/);
    expect(code).toMatch(/clearOAuthCookies\(res, provider\)/);
  });
});

describe("banking adapters REFUSE before fetch (no live bank call dark)", () => {
  it("the TrueLayer adapter's ONLY fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(ADAPTER_TL));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    // No SDK/client construction at module scope — the only network is `fetch`.
    expect(code).not.toMatch(/^import .*truelayer-client/im);
  });

  it("the Plaid adapter's ONLY fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(ADAPTER_PLAID));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    // No SDK/client construction — the only network is `fetch`, and no plaid pkg.
    expect(code).not.toMatch(/from\s+["'][^"']*plaid[^"']*["']/i);
  });

  it("the Nordigen adapter's ONLY fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(ADAPTER_NORDIGEN));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(code).not.toMatch(/from\s+["'][^"']*(nordigen|gocardless)[^"']*["']/i);
  });

  it("both new adapters SSRF-guard the API-base override to the provider domain", () => {
    // An operator host override can never be re-pointed at an internal address —
    // the override must be https AND resolve to the provider's own domain, else
    // the adapter falls back to the production host.
    const plaid = codeOf(read(ADAPTER_PLAID));
    expect(plaid).toMatch(/protocol !== "https:"/);
    expect(plaid).toMatch(/PLAID_ALLOWED_DOMAIN|plaid\.com/);
    const nordigen = codeOf(read(ADAPTER_NORDIGEN));
    expect(nordigen).toMatch(/protocol !== "https:"/);
    expect(nordigen).toMatch(/NORDIGEN_ALLOWED_DOMAIN|gocardless\.com/);
  });

  it("the pending adapter has NO fetch at all (no live bank call reachable)", () => {
    const code = codeOf(read(ADAPTER_PENDING));
    expect(code).not.toMatch(/fetch\(/);
    expect(code).toMatch(/if \(!this\.isAvailable\(\)\)/);
  });

  it("the statement mapper is PURE — no network, no server-only, no clock", () => {
    const code = codeOf(read(STATEMENT_MAP));
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/Date\.now\(/);
  });
});

describe("bank connections service — org-pinned, loud, token-free reads, refuse-before-fetch", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on reads and reads loudly", () => {
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("NEVER selects a token column back to a tenant surface", () => {
    expect(code).not.toMatch(/select[\s\S]{0,120}access_token/i);
    expect(code).not.toMatch(/SELECT_COLUMNS[\s\S]{0,10}=[\s\S]{0,200}access_token/i);
  });

  it("sync REFUSES before fetch: the availability guard precedes fetchStatements", () => {
    const guardIdx = code.indexOf("adapter.isAvailable()");
    const fetchIdx = code.indexOf("adapter.fetchStatements(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
  });
});

describe("no secret is ever logged", () => {
  it("no source logs a client secret or a token", () => {
    for (const f of [OAUTH, CONNECT, CALLBACK, SERVICE, ADAPTER_TL, ADAPTER_PLAID, ADAPTER_NORDIGEN, ADAPTER_PENDING]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/client_?secret/i);
        expect(call).not.toMatch(/access_?token/i);
        expect(call).not.toMatch(/refresh_?token/i);
        expect(call).not.toMatch(/codeVerifier/i);
      }
    }
  });
});

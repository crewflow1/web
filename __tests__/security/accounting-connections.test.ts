import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isXeroConnectable,
  isQuickbooksConnectable,
  isSageConnectable,
  isProviderConnectable,
  accountingConnectFeatureEnabled,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  resolveXeroTenantId,
  resolveSageBusinessId,
} from "@/lib/integrations/accounting/oauth";

/**
 * Accounting OAUTH CONNECT (20261095) — trust-boundary proofs.
 *
 * Section 1: the OAuth resolver is DARK. With no client credentials (and the
 * feature flag off) no provider is connectable; buildAuthorizeUrl REFUSES with
 * no URL / no PKCE material; exchangeCodeForTokens REFUSES with no network call.
 * A credential alone cannot reach a live call — the token-exchange `fetch` is
 * unreachable dark.
 *
 * Section 2: accounting_connections RLS is DB-enforced admin-write / member-read,
 * org-pinned, with UNIQUE(org,provider) and a CHECK that a `connected` row must
 * name a provider account (no fake connected state).
 *
 * Section 3: the routes gate on auth + org + admin, validate the provider, and
 * short-circuit BEFORE any token exchange while dark. The service is org-pinned,
 * loud, and never selects a token column. No secret is logged anywhere.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261095000000_accounting_connections.sql";
const OAUTH = "lib/integrations/accounting/oauth.ts";
const CONNECT = "app/api/integrations/accounting/[provider]/connect/route.ts";
const CALLBACK = "app/api/integrations/accounting/[provider]/callback/route.ts";
const SERVICE = "server/services/accounting-connections.ts";

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
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET",
  "QBO_CLIENT_ID",
  "QBO_CLIENT_SECRET",
  "SAGE_CLIENT_ID",
  "SAGE_CLIENT_SECRET",
  "FEATURE_ACCOUNTING_CONNECT",
];

// ---------------------------------------------------------------------------
// 1. THE OAUTH RESOLVER IS DARK — no connect, no exchange, without credentials
// ---------------------------------------------------------------------------

describe("accounting OAuth resolver is dark without credentials", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("no provider is connectable when credentials + flag are absent", () => {
    expect(accountingConnectFeatureEnabled()).toBe(false);
    expect(isXeroConnectable()).toBe(false);
    expect(isQuickbooksConnectable()).toBe(false);
    expect(isSageConnectable()).toBe(false);
    expect(isProviderConnectable("xero")).toBe(false);
    expect(isProviderConnectable("quickbooks")).toBe(false);
    expect(isProviderConnectable("sage")).toBe(false);
  });

  it("credentials WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.XERO_CLIENT_ID = "id";
    process.env.XERO_CLIENT_SECRET = "secret";
    // Flag deliberately left off.
    expect(isXeroConnectable()).toBe(false);
  });

  it("buildAuthorizeUrl REFUSES with no URL / no PKCE material when dark", () => {
    for (const p of ["xero", "quickbooks", "sage"] as const) {
      const res = buildAuthorizeUrl(p, "https://app.example/callback");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("exchangeCodeForTokens REFUSES with NO network call when dark", async () => {
    // If a `fetch` were reached it would throw in this test env; a clean
    // `not_configured` return proves the exchange never touched the network.
    for (const p of ["xero", "quickbooks", "sage"] as const) {
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

  it("the FIRST fetch lives AFTER the connectable guard (structural dark path)", () => {
    const code = codeOf(read(OAUTH));
    const fetchIdx = code.indexOf("fetch(");
    expect(fetchIdx).toBeGreaterThan(-1);
    // The first guard returns not_configured before the first fetch offset.
    const guardIdx = code.indexOf("reason: \"not_configured\"");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("refreshAccessToken REFUSES with NO network call when dark", async () => {
    for (const p of ["xero", "quickbooks", "sage"] as const) {
      const res = await refreshAccessToken({ provider: p, refreshToken: "irrelevant" });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("resolveXeroTenantId REFUSES with NO network call when dark", async () => {
    const res = await resolveXeroTenantId("irrelevant-access-token");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("resolveSageBusinessId REFUSES with NO network call when dark", async () => {
    const res = await resolveSageBusinessId("irrelevant-access-token");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("refreshAccessToken guards (not_configured) BEFORE the refresh helper call", () => {
    const code = codeOf(read(OAUTH));
    const seg = code.slice(code.indexOf("export async function refreshAccessToken"));
    const guardIdx = seg.indexOf("reason: \"not_configured\"");
    const callIdx = seg.indexOf("refreshOAuthToken(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(callIdx);
  });

  it("resolveXeroTenantId guards (not_configured) BEFORE its fetch", () => {
    const code = codeOf(read(OAUTH));
    const seg = code.slice(code.indexOf("export async function resolveXeroTenantId"));
    const guardIdx = seg.indexOf("reason: \"not_configured\"");
    const fetchIdx = seg.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });
});

describe("accounting connection tokens are service-role only (column-privilege honoured)", () => {
  const code = codeOf(read(SERVICE));

  it("reads + writes the token columns via the service-role admin client", () => {
    // The migration REVOKES SELECT on the token columns from `authenticated`, so
    // the live push MUST use createAdminClient() to read/refresh them.
    expect(code).toMatch(/createAdminClient\(\)/);
    expect(code).toMatch(/access_token/);
  });

  it("never adds a token column to the caller-JWT SELECT projection", () => {
    // The tenant-facing SELECT_COLUMNS constant stays token-free.
    expect(code).not.toMatch(/SELECT_COLUMNS[\s\S]{0,10}=[\s\S]{0,200}access_token/i);
  });

  it("encrypts before persisting a refreshed token and decrypts on use", () => {
    expect(code).toMatch(/encryptToken\(/);
    expect(code).toMatch(/decryptToken\(/);
  });
});

// ---------------------------------------------------------------------------
// 2. accounting_connections — RLS, tenancy, no fake connected state
// ---------------------------------------------------------------------------

describe("accounting_connections RLS + shape", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.accounting_connections enable row level security/i,
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
    expect(sql).toMatch(/provider\s+text not null check \(provider in \('xero', 'quickbooks'\)\)/i);
    expect(sql).toMatch(
      /status\s+text not null default 'disconnected'[\s\S]*check \(status in \('disconnected', 'connecting', 'connected', 'error'\)\)/i,
    );
  });

  it("FORBIDS a fake connected state: connected requires an account handle", () => {
    expect(sql).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or external_tenant_id is not null\s*or realm_id is not null\s*\)/i,
    );
  });

  it("carries token columns but grants no special privilege (dark: never written)", () => {
    // The slots exist for activation…
    expect(sql).toMatch(/access_token\s+text/i);
    expect(sql).toMatch(/refresh_token\s+text/i);
    // …but the migration writes nothing and adds no trigger that could.
    expect(sql).not.toMatch(/insert\s+into\s+public\.accounting_connections/i);
  });

  it("STRIPS the token columns from the authenticated read surface (column privilege)", () => {
    // RLS is row-level; the token columns are excluded by a COLUMN privilege:
    // revoke the table-wide SELECT, then grant SELECT back on the non-token
    // columns only. anon loses all access.
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.accounting_connections\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.accounting_connections\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.accounting_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    // The safe-column grant MUST NOT name any token column.
    expect(cols).not.toMatch(/access_token/i);
    expect(cols).not.toMatch(/refresh_token/i);
    expect(cols).not.toMatch(/token_expires_at/i);
    // …and it MUST still expose the state columns members legitimately read.
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bprovider\b/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ROUTES + SERVICE — gated, dark-short-circuit, org-pinned, no leak
// ---------------------------------------------------------------------------

describe("accounting connect routes are gated + dark", () => {
  it("both routes require org context and gate on owner/admin", () => {
    for (const f of [CONNECT, CALLBACK]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/requireOrgContext\(\)/);
      expect(code).toMatch(/role === "owner"/);
      expect(code).toMatch(/role === "admin"/);
      // Unknown provider is refused.
      expect(code).toMatch(/unknown_provider/);
    }
  });

  it("connect returns not_configured (no redirect) when the provider is dark", () => {
    const code = codeOf(read(CONNECT));
    expect(code).toMatch(/buildAuthorizeUrl\(/);
    expect(code).toMatch(/not_configured/);
    // The refusal path returns JSON status 200, not a redirect to a provider.
    expect(code).toMatch(/if\s*\(\s*!authorize\.ok\s*\)/);
  });

  it("callback SHORT-CIRCUITS before any token exchange while dark", () => {
    const code = codeOf(read(CALLBACK));
    // The connectable check gates the exchange; it appears before the exchange call.
    const guardIdx = code.indexOf("isProviderConnectable(provider)");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(exchangeIdx);
    // And it verifies OAuth state (anti-CSRF) CONSTANT-TIME before trusting the
    // callback — never a bare string `!==` compare on a security token.
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/state !== stateCookie/);
  });

  it("callback never writes a connected row without an account handle", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/no_account/);
    expect(code).toMatch(/status:\s*"connected"/);
  });

  it("callback CLEARS the single-use PKCE/state cookies (no replay in the 600s window)", () => {
    const code = codeOf(read(CALLBACK));
    // A helper expires BOTH the state and verifier cookies…
    expect(code).toMatch(/function clearOAuthCookies/);
    expect(code).toMatch(/res\.cookies\.set\(\s*STATE_COOKIE\(provider\)\s*,\s*""/);
    expect(code).toMatch(/res\.cookies\.set\(\s*VERIFIER_COOKIE\(provider\)\s*,\s*""/);
    expect(code).toMatch(/maxAge:\s*0/);
    // …and every live-path exit (backToReports) invokes it, so a consumed
    // state+verifier pair cannot be replayed within the cookie window.
    expect(code).toMatch(/clearOAuthCookies\(res, provider\)/);
  });
});

describe("accounting connections service — org-pinned, loud, token-free reads", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on reads and reads loudly", () => {
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("NEVER selects a token column back to a TENANT (caller-JWT) surface", () => {
    // The caller-JWT projection constant carries no token field — the tenant read
    // surface (listAccountingConnections / getAccountingConnection) is token-free.
    expect(code).not.toMatch(/SELECT_COLUMNS[\s\S]{0,10}=[\s\S]{0,200}access_token/i);
    // The ONLY select that names a token column is the SERVICE-ROLE helper, which
    // reads via createAdminClient — the column-privilege boundary (migration
    // 20261095 revokes token SELECT from `authenticated`) demands service-role.
    const seg = code.slice(code.indexOf("async function readConnectionSecrets"));
    expect(seg).toMatch(/createAdminClient\(\)/);
    expect(seg).toMatch(/\.select\(\s*\n?\s*["'][^"']{0,40}access_token/);
    // The caller-JWT client (createClient) never selects a token column: every
    // createClient()-backed read uses the token-free SELECT_COLUMNS.
    const tokenSelects = code.match(/\.select\([^)]*access_token/g) ?? [];
    expect(tokenSelects.length).toBe(1);
  });

  it("syncToProvider records skipped_dark when the adapter is dark", () => {
    expect(code).toMatch(/isAvailable\(\)/);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
  });
});

describe("no secret is ever logged", () => {
  it("no source logs a client secret or a token", () => {
    for (const f of [OAUTH, CONNECT, CALLBACK, SERVICE]) {
      const code = codeOf(read(f));
      // Search each console.* call for a secret/token identifier.
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

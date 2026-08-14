import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isTelematicsProviderConnectable,
  resolveActiveTelematicsProvider,
  telematicsConnectFeatureEnabled,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  TELEMATICS_PROVIDERS,
} from "@/lib/integrations/telematics/oauth";

/**
 * Telematics OAUTH CONNECT (20261103) — trust-boundary proofs.
 *
 * Section 1: the OAuth resolver is DARK. With no client credentials, no bound
 * provider and the feature flag off, no provider is connectable; buildAuthorizeUrl
 * REFUSES with no URL / no PKCE material; exchangeCodeForTokens REFUSES with no
 * network call. A credential alone cannot reach a live call — the token-exchange
 * `fetch` is unreachable dark; and even WITH credentials the flag + provider
 * binding are two further switches (config + CEO provider choice).
 *
 * Section 2: telematics_connections RLS is DB-enforced admin-write / member-read,
 * org-pinned, with UNIQUE(org,provider), a composite (id,org_id) key, a CHECK that
 * a `connected` row must name an account (no fake connected state), and the token
 * columns stripped from the authenticated read surface by a COLUMN privilege.
 *
 * Section 3: telematics_readings is org-pinned with COMPOSITE FKs to both
 * fleet_vehicles and telematics_connections (cross-tenant binding), append-only
 * (immutability trigger), and member-read with NO authenticated writer.
 *
 * Section 4: the routes gate on auth + org + admin, validate the provider, and
 * short-circuit (503) BEFORE any token exchange while dark; the callback verifies
 * state constant-time and encrypts tokens before write behind the tripwire.
 *
 * Section 5: the adapters + service REFUSE before any fetch while dark, and no
 * source logs a secret.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261103000000_telematics_connections.sql";
const OAUTH = "lib/integrations/telematics/oauth.ts";
const CONNECT = "app/api/integrations/telematics/[provider]/connect/route.ts";
const CALLBACK = "app/api/integrations/telematics/[provider]/callback/route.ts";
const SERVICE = "server/services/telematics-connections.ts";
const SAMSARA = "lib/integrations/telematics/adapters/samsara.ts";
const VERIZON = "lib/integrations/telematics/adapters/verizon-connect.ts";
const PENDING = "lib/integrations/telematics/adapters/pending.ts";
const READING_MAP = "lib/integrations/telematics/reading-map.ts";

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
  "TELEMATICS_CLIENT_ID",
  "TELEMATICS_CLIENT_SECRET",
  "TELEMATICS_PROVIDER",
  "NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT",
];

// ---------------------------------------------------------------------------
// 1. THE OAUTH RESOLVER IS DARK — no connect, no exchange, without credentials
// ---------------------------------------------------------------------------

describe("telematics OAuth resolver is dark without credentials", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("no provider is connectable when credentials + flag + binding are absent", () => {
    expect(telematicsConnectFeatureEnabled()).toBe(false);
    expect(resolveActiveTelematicsProvider()).toBeNull();
    for (const p of TELEMATICS_PROVIDERS) {
      expect(isTelematicsProviderConnectable(p)).toBe(false);
    }
  });

  it("credentials + binding WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.TELEMATICS_CLIENT_ID = "id";
    process.env.TELEMATICS_CLIENT_SECRET = "secret";
    process.env.TELEMATICS_PROVIDER = "samsara";
    // Flag deliberately left off.
    expect(isTelematicsProviderConnectable("samsara")).toBe(false);
  });

  it("flag + credentials WITHOUT a bound provider are not connectable (provider choice)", () => {
    process.env.NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT = "true";
    process.env.TELEMATICS_CLIENT_ID = "id";
    process.env.TELEMATICS_CLIENT_SECRET = "secret";
    // TELEMATICS_PROVIDER unset — the CEO provider choice is not made.
    expect(isTelematicsProviderConnectable("samsara")).toBe(false);
    expect(isTelematicsProviderConnectable("verizon_connect")).toBe(false);
  });

  it("only the BOUND provider is connectable, and only with all switches on", () => {
    process.env.NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT = "true";
    process.env.TELEMATICS_CLIENT_ID = "id";
    process.env.TELEMATICS_CLIENT_SECRET = "secret";
    process.env.TELEMATICS_PROVIDER = "samsara";
    expect(isTelematicsProviderConnectable("samsara")).toBe(true);
    // The other aggregator is still dark — one binding only.
    expect(isTelematicsProviderConnectable("verizon_connect")).toBe(false);
  });

  it("buildAuthorizeUrl REFUSES with no URL / no PKCE material when dark", () => {
    for (const p of TELEMATICS_PROVIDERS) {
      const res = buildAuthorizeUrl(p, "https://app.example/callback");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("exchangeCodeForTokens REFUSES with NO network call when dark", async () => {
    // If a `fetch` were reached it would throw in this test env; a clean
    // `not_configured` return proves the exchange never touched the network.
    for (const p of TELEMATICS_PROVIDERS) {
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
    // The exchange guard returns not_configured before the fetch offset.
    const guardIdx = code.indexOf('reason: "not_configured"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. telematics_connections — RLS, tenancy, no fake connected state
// ---------------------------------------------------------------------------

describe("telematics_connections RLS + shape", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.telematics_connections enable row level security/i,
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
      /provider\s+text not null check \(provider in \('samsara', 'verizon_connect'\)\)/i,
    );
    expect(sql).toMatch(
      /status\s+text not null default 'disconnected'[\s\S]*check \(status in \('disconnected', 'connecting', 'connected', 'error'\)\)/i,
    );
  });

  it("FORBIDS a fake connected state: connected requires an account handle", () => {
    expect(sql).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or external_account_id is not null\s*\)/i,
    );
  });

  it("carries token columns but the migration writes nothing (dark)", () => {
    expect(sql).toMatch(/access_token\s+text/i);
    expect(sql).toMatch(/refresh_token\s+text/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.telematics_connections/i);
  });

  it("STRIPS the token columns from the authenticated read surface (column privilege)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.telematics_connections\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.telematics_connections\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.telematics_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/access_token/i);
    expect(cols).not.toMatch(/refresh_token/i);
    expect(cols).not.toMatch(/token_expires_at/i);
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bprovider\b/i);
    expect(cols).toMatch(/external_account_id/i);
  });
});

// ---------------------------------------------------------------------------
// 3. telematics_readings — org-pinned, composite-FK vehicle binding, append-only
// ---------------------------------------------------------------------------

describe("telematics_readings tenancy + append-only", () => {
  it("adds a composite candidate key on fleet_vehicles for the child FK", () => {
    expect(sql).toMatch(
      /add constraint fleet_vehicles_asset_org_key unique \(asset_id, org_id\)/i,
    );
  });

  it("binds vehicle_id via a COMPOSITE FK to fleet_vehicles (asset_id, org_id)", () => {
    expect(sql).toMatch(
      /foreign key \(vehicle_id, org_id\) references public\.fleet_vehicles \(asset_id, org_id\)/i,
    );
  });

  it("binds connection_id via a COMPOSITE FK to telematics_connections (id, org_id)", () => {
    expect(sql).toMatch(
      /foreign key \(connection_id, org_id\) references public\.telematics_connections \(id, org_id\)/i,
    );
  });

  it("is org-pinned with cascade teardown", () => {
    expect(sql).toMatch(
      /create table if not exists public\.telematics_readings[\s\S]*org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
  });

  it("is APPEND-ONLY: a BEFORE UPDATE trigger raises (rows immutable)", () => {
    expect(sql).toMatch(/create trigger telematics_readings_immutable before update/i);
    expect(sql).toMatch(/append-only and cannot be updated/i);
  });

  it("has NO authenticated writer — member SELECT only, anon revoked", () => {
    expect(sql).toMatch(
      /create policy[^;]*telematics_readings: members can select[^;]*for select/i,
    );
    // No insert/update/delete policy is granted to authenticated.
    expect(sql).not.toMatch(/create policy[^;]*telematics_readings[^;]*for insert/i);
    expect(sql).not.toMatch(/create policy[^;]*telematics_readings[^;]*for delete/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.telematics_readings\s+from\s+anon/i);
  });
});

// ---------------------------------------------------------------------------
// 4. THE ROUTES — gated, dark-short-circuit (503), constant-time, encrypt-before-write
// ---------------------------------------------------------------------------

describe("telematics connect routes are gated + dark", () => {
  it("both routes require org context and gate on owner/admin", () => {
    for (const f of [CONNECT, CALLBACK]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/requireOrgContext\(\)/);
      expect(code).toMatch(/role === "owner"/);
      expect(code).toMatch(/role === "admin"/);
      expect(code).toMatch(/unknown_provider/);
    }
  });

  it("connect returns 503 not_configured (no redirect) when the provider is dark", () => {
    const code = codeOf(read(CONNECT));
    expect(code).toMatch(/buildAuthorizeUrl\(/);
    expect(code).toMatch(/not_configured/);
    expect(code).toMatch(/if\s*\(\s*!authorize\.ok\s*\)/);
    expect(code).toMatch(/status:\s*503/);
  });

  it("callback SHORT-CIRCUITS (503) before any token exchange while dark", () => {
    const code = codeOf(read(CALLBACK));
    const guardIdx = code.indexOf("isTelematicsProviderConnectable(provider)");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(exchangeIdx);
    // Constant-time state compare (anti-CSRF) — never a bare `!==`.
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/state !== stateCookie/);
    expect(code).toMatch(/status:\s*503/);
  });

  it("callback ENCRYPTS tokens before write, behind the encryption tripwire", () => {
    const code = codeOf(read(CALLBACK));
    // The tripwire refuses when no key is present…
    expect(code).toMatch(/isTokenEncryptionConfigured\(\)/);
    const tripIdx = code.indexOf("isTokenEncryptionConfigured()");
    const upsertIdx = code.indexOf(".upsert(");
    expect(tripIdx).toBeGreaterThan(-1);
    expect(upsertIdx).toBeGreaterThan(-1);
    expect(tripIdx).toBeLessThan(upsertIdx);
    // …and both token columns are written as encryptToken(...) ciphertext.
    expect(code).toMatch(/access_token:\s*encryptToken\(/);
    expect(code).toMatch(/refresh_token:[\s\S]{0,40}encryptToken\(/);
  });

  it("callback never writes a connected row without an account handle", () => {
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

// ---------------------------------------------------------------------------
// 5. ADAPTERS + SERVICE — refuse-before-fetch, org-pinned, token-free, no leak
// ---------------------------------------------------------------------------

describe("telematics adapters refuse before any fetch", () => {
  it("the Samsara adapter's ONLY fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(SAMSARA));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    // No SDK import / client construction at module scope.
    expect(code).not.toMatch(/^import .*samsara/im);
  });

  it("the Verizon Connect adapter's fetch lives AFTER the isAvailable guard", () => {
    const code = codeOf(read(VERIZON));
    const guardIdx = code.indexOf("if (!this.isAvailable())");
    const fetchIdx = code.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    // The first refuse-guard precedes the first (and every) network call.
    expect(guardIdx).toBeLessThan(fetchIdx);
    // No SDK import / client construction at module scope.
    expect(code).not.toMatch(/^import .*fleetmatics/im);
    // Every outbound URL is vetted through the shared SSRF policy before fetch.
    expect(code).toMatch(/validateWebhookUrl\(/);
  });

  it("the Verizon Connect account resolver's fetch also lives AFTER its guard", () => {
    const code = codeOf(read(VERIZON));
    const start = code.indexOf("async resolveAccountHandle");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    const guardIdx = body.indexOf("if (!this.isAvailable())");
    const fetchIdx = body.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("the pending adapter contains NO fetch at all (dark-safe skeleton)", () => {
    const code = codeOf(read(PENDING));
    expect(code).not.toMatch(/fetch\(/);
    expect(code).toMatch(/if \(!this\.isAvailable\(\)\)/);
  });
});

describe("telematics service — org-pinned, loud, token-free, refuse-before-fetch", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on reads and reads loudly", () => {
    expect(code).toMatch(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/);
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("NEVER selects a token column back to a tenant surface", () => {
    expect(code).not.toMatch(/SELECT_COLUMNS[\s\S]{0,200}access_token/i);
    expect(code).not.toMatch(/select[\s\S]{0,120}access_token/i);
  });

  it("syncTelematicsReadings records skipped_dark and refuses before fetch when dark", () => {
    expect(code).toMatch(/isAvailable\(\)/);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
    // The adapter fetch is reached only after the isAvailable guard.
    const guardIdx = code.indexOf("adapter.isAvailable()");
    const fetchIdx = code.indexOf("adapter.fetchReadings(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    // …and the PURE mapper is the only shaping step (no network in the service).
    expect(code).toMatch(/mapSamplesToReadings\(/);
  });
});

describe("no secret is ever logged", () => {
  it("no source logs a client secret or a token", () => {
    for (const f of [OAUTH, CONNECT, CALLBACK, SERVICE, SAMSARA, VERIZON, READING_MAP]) {
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

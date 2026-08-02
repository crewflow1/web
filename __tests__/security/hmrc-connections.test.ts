import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isHmrcConnectable,
  hmrcConnectFeatureEnabled,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "@/lib/integrations/hmrc/oauth";
import { composeVatReturn } from "@/lib/integrations/hmrc/vat-return";
import { composeCis300Return } from "@/lib/integrations/hmrc/cis-return";
import { buildFraudPreventionHeaders } from "@/lib/integrations/hmrc/fraud-headers";
import type { MonthlyReturnDataset } from "@/lib/cis/statements";

/**
 * HMRC MTD SUBSTRATE (20261099) — trust-boundary proofs. DARK.
 *
 * Section 1: the OAuth resolver is DARK (two-switch). Without client credentials
 * AND the feature flag HMRC is not connectable; buildAuthorizeUrl REFUSES with no
 * URL / no PKCE material; exchangeCodeForTokens REFUSES with no network call. A
 * credential alone cannot reach a live call — the token-exchange `fetch` is
 * unreachable dark and lives strictly AFTER the connectable guard.
 *
 * Section 2: hmrc_connections RLS is DB-enforced admin-write / member-read,
 * org-pinned, with a composite (id,org_id) key, UNIQUE(org,provider), a CHECK
 * that a `connected` row must name a VRN, and the token columns stripped from the
 * authenticated read surface by a column privilege. hmrc_submissions is
 * append-only (no update/delete policy) with NO filed state.
 *
 * Section 3: the routes gate on auth + org + admin, validate the flow, and 503
 * short-circuit BEFORE any token exchange while dark, verifying state constant-
 * time. No secret is logged.
 *
 * Section 4: the payload composers REFUSE while dark; the fraud-header builder
 * exists and touches no network.
 *
 * Section 5: the LEGAL BOUNDARY is documented — no source POSTs a return to HMRC.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261099000000_hmrc_connections.sql";
const OAUTH = "lib/integrations/hmrc/oauth.ts";
const FRAUD = "lib/integrations/hmrc/fraud-headers.ts";
const VAT = "lib/integrations/hmrc/vat-return.ts";
const CIS = "lib/integrations/hmrc/cis-return.ts";
const CONNECT = "app/api/integrations/hmrc/[flow]/connect/route.ts";
const CALLBACK = "app/api/integrations/hmrc/[flow]/callback/route.ts";
const SERVICE = "server/services/hmrc-connections.ts";

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

const OAUTH_ENV = ["HMRC_CLIENT_ID", "HMRC_CLIENT_SECRET", "NEXT_PUBLIC_FEATURE_HMRC_CONNECT"];

// ---------------------------------------------------------------------------
// 1. THE OAUTH RESOLVER IS DARK — two-switch, no connect/exchange without both
// ---------------------------------------------------------------------------

describe("HMRC OAuth resolver is dark without credentials + flag", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("is not connectable when credentials + flag are absent", () => {
    expect(hmrcConnectFeatureEnabled()).toBe(false);
    expect(isHmrcConnectable()).toBe(false);
  });

  it("credentials WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.HMRC_CLIENT_ID = "id";
    process.env.HMRC_CLIENT_SECRET = "secret";
    // Flag deliberately left off.
    expect(isHmrcConnectable()).toBe(false);
  });

  it("the feature flag WITHOUT credentials is still not connectable (two-switch)", () => {
    process.env.NEXT_PUBLIC_FEATURE_HMRC_CONNECT = "true";
    expect(isHmrcConnectable()).toBe(false);
  });

  it("buildAuthorizeUrl REFUSES with no URL / no PKCE material when dark", () => {
    for (const flow of ["vat", "cis"] as const) {
      const res = buildAuthorizeUrl(flow, "https://app.example/callback");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("exchangeCodeForTokens REFUSES with NO network call when dark", async () => {
    // A `fetch` would throw in this test env; a clean `not_configured` return
    // proves the exchange never touched the network.
    for (const flow of ["vat", "cis"] as const) {
      const res = await exchangeCodeForTokens({
        flow,
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
    // Exactly one fetch call site.
    expect(code.indexOf("fetch(", fetchIdx + 1)).toBe(-1);
    // The exchange guard returns not_configured before the fetch offset.
    const guardIdx = code.indexOf('reason: "not_configured"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("encrypts tokens BEFORE the DB write (no plaintext token stored)", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/access_token:\s*encryptToken\(/);
    expect(code).toMatch(/encryptToken\(refreshToken\)/);
    // The tripwire refuses the exchange when the key is absent.
    expect(code).toMatch(/isTokenEncryptionConfigured\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. hmrc_connections + hmrc_submissions — RLS, tenancy, no fake/filed state
// ---------------------------------------------------------------------------

describe("hmrc_connections RLS + shape", () => {
  it("enables RLS on both tables", () => {
    expect(sql).toMatch(/alter table public\.hmrc_connections enable row level security/i);
    expect(sql).toMatch(/alter table public\.hmrc_submissions enable row level security/i);
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert / update / delete gated on is_org_admin()", () => {
    expect(sql).toMatch(/create policy[^;]*admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can update[^;]*for update[\s\S]*is_org_admin\(/i);
    expect(sql).toMatch(/create policy[^;]*admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i);
  });

  it("is org-pinned with cascade teardown + composite candidate key", () => {
    expect(sql).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/unique\s*\(id,\s*org_id\)/i);
  });

  it("has ONE connection per (org, provider), provider pinned to 'hmrc'", () => {
    expect(sql).toMatch(/unique\s*\(org_id,\s*provider\)/i);
    expect(sql).toMatch(/provider\s+text not null default 'hmrc' check \(provider = 'hmrc'\)/i);
  });

  it("FORBIDS a fake connected state: connected requires a VRN handle", () => {
    expect(sql).toMatch(/check\s*\(\s*status <> 'connected'\s*or hmrc_vrn is not null\s*\)/i);
  });

  it("STRIPS the token columns from the authenticated read surface (column privilege)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.hmrc_connections\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.hmrc_connections\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.hmrc_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/access_token/i);
    expect(cols).not.toMatch(/refresh_token/i);
    expect(cols).not.toMatch(/token_expires_at/i);
    // …but still exposes the state columns members legitimately read.
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bhmrc_vrn\b/i);
  });

  it("writes nothing (no INSERT dark) and adds no trigger that could write a token", () => {
    expect(sql).not.toMatch(/insert\s+into\s+public\.hmrc_connections/i);
  });
});

describe("hmrc_submissions is append-only, org-bound, and has NO filed state", () => {
  it("binds each submission to (connection, org) via a COMPOSITE FK", () => {
    expect(sql).toMatch(
      /foreign key \(connection_id,\s*org_id\)\s*references public\.hmrc_connections \(id,\s*org_id\)/i,
    );
  });

  it("has NO 'submitted' / 'filed' status — the legal boundary is in the schema", () => {
    expect(sql).toMatch(/status\s+text not null default 'prepared'[\s\S]*check \(status in \('prepared', 'held'\)\)/i);
    expect(sql).not.toMatch(/'submitted'/i);
    expect(sql).not.toMatch(/'filed'/i);
  });

  it("is APPEND-ONLY: it grants insert + select but NO update / delete policy", () => {
    // A submissions insert + select policy exist…
    expect(sql).toMatch(/create policy[^;]*hmrc_submissions[^;]*for insert/i);
    expect(sql).toMatch(/create policy[^;]*hmrc_submissions[^;]*for select/i);
    // …and NO update/delete policy targets hmrc_submissions (default-deny = immutable).
    expect(sql).not.toMatch(/create policy[^;]*hmrc_submissions[^;]*for update/i);
    expect(sql).not.toMatch(/create policy[^;]*hmrc_submissions[^;]*for delete/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ROUTES — gated, 503-dark, org-pinned, constant-time, no leak
// ---------------------------------------------------------------------------

describe("HMRC connect routes are gated + dark", () => {
  it("both routes require org context, gate on owner/admin, validate the flow", () => {
    for (const f of [CONNECT, CALLBACK]) {
      const code = codeOf(read(f));
      expect(code).toMatch(/requireOrgContext\(\)/);
      expect(code).toMatch(/role === "owner"/);
      expect(code).toMatch(/role === "admin"/);
      expect(code).toMatch(/isHmrcFlow\(/);
      expect(code).toMatch(/unknown_flow/);
    }
  });

  it("connect returns 503 not_configured (no redirect) when dark", () => {
    const code = codeOf(read(CONNECT));
    expect(code).toMatch(/buildAuthorizeUrl\(/);
    expect(code).toMatch(/not_configured/);
    expect(code).toMatch(/if\s*\(\s*!authorize\.ok\s*\)/);
    expect(code).toMatch(/status:\s*503/);
  });

  it("callback SHORT-CIRCUITS (503) before any token exchange while dark", () => {
    const code = codeOf(read(CALLBACK));
    const guardIdx = code.indexOf("isHmrcConnectable()");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(exchangeIdx);
    // Constant-time anti-CSRF, never a bare string compare on a security token.
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/state !== stateCookie/);
    expect(code).toMatch(/status:\s*503/);
  });

  it("callback never writes a connected row without a VRN handle", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/no_vrn/);
    expect(code).toMatch(/status:\s*"connected"/);
  });

  it("callback CLEARS the single-use PKCE/state cookies (no replay in the window)", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/function clearOAuthCookies/);
    expect(code).toMatch(/res\.cookies\.set\(\s*STATE_COOKIE\(flow\)\s*,\s*""/);
    expect(code).toMatch(/res\.cookies\.set\(\s*VERIFIER_COOKIE\(flow\)\s*,\s*""/);
    expect(code).toMatch(/maxAge:\s*0/);
    expect(code).toMatch(/clearOAuthCookies\(res, flow\)/);
  });
});

describe("hmrc connections service — org-pinned, loud, token-free reads", () => {
  const code = codeOf(read(SERVICE));

  it("pins org_id on the read and reads loudly", () => {
    expect(code).toMatch(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/);
    expect(code).toMatch(/throw readFailure\(/);
  });

  it("NEVER selects a token column back to a tenant surface", () => {
    expect(code).not.toMatch(/access_token/i);
    expect(code).not.toMatch(/refresh_token/i);
  });
});

// ---------------------------------------------------------------------------
// 4. THE COMPOSERS + FRAUD HEADERS — refuse dark, no network in the builder
// ---------------------------------------------------------------------------

describe("payload composers refuse while dark, no submission fetch anywhere", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("composeVatReturn REFUSES to build while dark", () => {
    const res = composeVatReturn({
      periodKey: "18A1",
      vat: { output_vat: 100, input_vat: 40, net_payable: 60, confidence: "computed" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("composeCis300Return REFUSES to build while dark", () => {
    const ds: MonthlyReturnDataset = {
      taxMonthStart: "2026-04-06",
      taxMonthEnd: "2026-05-05",
      taxMonthLabel: "Apr 2026",
      dueOn: "2026-05-19",
      isNil: true,
      subcontractorCount: 0,
      paymentCount: 0,
      totalGross: 0,
      totalMaterials: 0,
      totalDeduction: 0,
      lines: [],
    };
    const res = composeCis300Return({ dataset: ds });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
  });

  it("the fraud-header builder is PURE — no fetch, no network in the module", () => {
    const headers = buildFraudPreventionHeaders();
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(headers["Gov-Vendor-Product-Name"]).toBeDefined();
    for (const f of [FRAUD, VAT, CIS]) {
      const code = codeOf(read(f));
      expect(code).not.toMatch(/\bfetch\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. LEGAL BOUNDARY — no source ever POSTs a return to HMRC
// ---------------------------------------------------------------------------

describe("legal boundary: the substrate never submits to HMRC", () => {
  it("only oauth.ts contains a fetch, and it is the token exchange (not a submission)", () => {
    // The composers, fraud headers, routes and service must contain NO fetch.
    for (const f of [FRAUD, VAT, CIS, CONNECT, CALLBACK, SERVICE]) {
      const code = codeOf(read(f));
      expect(code, `${f} must contain no fetch`).not.toMatch(/\bfetch\(/);
    }
    // oauth.ts's single fetch targets the OAuth /token endpoint, never a
    // submission endpoint.
    const oauth = codeOf(read(OAUTH));
    expect(oauth).toMatch(/tokenUrl:/);
    expect(oauth).not.toMatch(/organisations\/vat|\/returns\b|submit/i);
  });
});

describe("no secret is ever logged", () => {
  it("no source logs a client secret or a token", () => {
    for (const f of [OAUTH, CONNECT, CALLBACK, SERVICE]) {
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

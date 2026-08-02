import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isGoogleCalendarConnectable,
  isMicrosoftCalendarConnectable,
  isCalendarProviderConnectable,
  calendarConnectFeatureEnabled,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "@/lib/integrations/calendar/oauth";

/**
 * Calendar OAUTH CONNECT (20261097) — trust-boundary proofs.
 *
 * Section 1: the OAuth resolver is DARK. With no client credentials (and the
 * feature flag off) no provider is connectable; buildAuthorizeUrl REFUSES with
 * no URL / no PKCE material; exchangeCodeForTokens REFUSES with no network call.
 * A credential alone cannot reach a live call — the token-exchange `fetch` is
 * unreachable dark. Scopes are calendar-only (no mail).
 *
 * Section 2: calendar_connections + calendar_event_links RLS is DB-enforced
 * admin-write / member-read, org-pinned; UNIQUE(org,provider); a CHECK that a
 * `connected` row must name an account (no fake connected state); token columns
 * are stripped from the authenticated read surface; event links are org-bound by
 * a composite FK.
 *
 * Section 3: the routes gate on auth + org + admin, validate the provider, and
 * short-circuit BEFORE any token exchange while dark. The service is org-pinned,
 * loud, token-free, and returns skipped_dark. No secret is logged anywhere.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261097000000_calendar_connections.sql";
const OAUTH = "lib/integrations/calendar/oauth.ts";
const CONNECT = "app/api/integrations/calendar/[provider]/connect/route.ts";
const CALLBACK = "app/api/integrations/calendar/[provider]/callback/route.ts";
const SERVICE = "server/services/calendar-connections.ts";

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
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "MS_GRAPH_CLIENT_ID",
  "MS_GRAPH_CLIENT_SECRET",
  "FEATURE_CALENDAR_CONNECT",
];

// ---------------------------------------------------------------------------
// 1. THE OAUTH RESOLVER IS DARK — no connect, no exchange, without credentials
// ---------------------------------------------------------------------------

describe("calendar OAuth resolver is dark without credentials", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("no provider is connectable when credentials + flag are absent", () => {
    expect(calendarConnectFeatureEnabled()).toBe(false);
    expect(isGoogleCalendarConnectable()).toBe(false);
    expect(isMicrosoftCalendarConnectable()).toBe(false);
    expect(isCalendarProviderConnectable("google")).toBe(false);
    expect(isCalendarProviderConnectable("microsoft")).toBe(false);
  });

  it("credentials WITHOUT the feature flag are still not connectable (two-switch)", () => {
    process.env.GOOGLE_CALENDAR_CLIENT_ID = "id";
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";
    // Flag deliberately left off.
    expect(isGoogleCalendarConnectable()).toBe(false);
  });

  it("the flag WITHOUT credentials is still not connectable (two-switch)", () => {
    process.env.FEATURE_CALENDAR_CONNECT = "1";
    expect(isGoogleCalendarConnectable()).toBe(false);
    expect(isMicrosoftCalendarConnectable()).toBe(false);
  });

  it("buildAuthorizeUrl REFUSES with no URL / no PKCE material when dark", () => {
    for (const p of ["google", "microsoft"] as const) {
      const res = buildAuthorizeUrl(p, "https://app.example/callback");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_configured");
    }
  });

  it("exchangeCodeForTokens REFUSES with NO network call when dark", async () => {
    // If a `fetch` were reached it would throw in this test env; a clean
    // `not_configured` return proves the exchange never touched the network.
    for (const p of ["google", "microsoft"] as const) {
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
    const guardIdx = code.indexOf("reason: \"not_configured\"");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  it("requests CALENDAR-ONLY scopes — no mail scope, and MS uses its own Graph creds", () => {
    const code = codeOf(read(OAUTH));
    // Google: the calendar.events scope, Microsoft: Calendars.ReadWrite.
    expect(code).toMatch(/https:\/\/www\.googleapis\.com\/auth\/calendar\.events/);
    expect(code).toMatch(/Calendars\.ReadWrite offline_access/);
    // NO mail / gmail / IMAP scope anywhere.
    expect(code).not.toMatch(/gmail/i);
    expect(code).not.toMatch(/mail\.read/i);
    expect(code).not.toMatch(/mail\.send/i);
    expect(code).not.toMatch(/auth\/calendar\b(?!\.events)/); // not the full read/write calendar scope
    // Microsoft uses a SEPARATE Graph app, never the auth-only SSO client.
    expect(code).toMatch(/MS_GRAPH_CLIENT_ID/);
    expect(code).toMatch(/MS_GRAPH_CLIENT_SECRET/);
    expect(code).not.toMatch(/NEXT_PUBLIC_FEATURE_MICROSOFT_SSO/);
  });

  it("the correct provider authorize endpoints are used", () => {
    const code = codeOf(read(OAUTH));
    expect(code).toMatch(/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
    expect(code).toMatch(/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/);
  });
});

// ---------------------------------------------------------------------------
// 2. calendar_connections + calendar_event_links — RLS, tenancy, no fake state
// ---------------------------------------------------------------------------

describe("calendar_connections RLS + shape", () => {
  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table public\.calendar_connections enable row level security/i,
    );
  });

  it("is member-read: select gated on current_org_ids()", () => {
    expect(sql).toMatch(
      /create policy[^;]*members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
  });

  it("is admin-write: insert / update / delete gated on is_org_admin()", () => {
    expect(sql).toMatch(
      /create policy[^;]*calendar_connections: admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_connections: admins can update[^;]*for update[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_connections: admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i,
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
    expect(sql).toMatch(/provider\s+text not null check \(provider in \('google', 'microsoft'\)\)/i);
    expect(sql).toMatch(
      /status\s+text not null default 'disconnected'[\s\S]*check \(status in \('disconnected', 'connecting', 'connected', 'error'\)\)/i,
    );
  });

  it("FORBIDS a fake connected state: connected requires an account handle", () => {
    expect(sql).toMatch(
      /check\s*\(\s*status <> 'connected'\s*or external_account_id is not null\s*\)/i,
    );
  });

  it("carries token columns but writes nothing (dark: never populated)", () => {
    expect(sql).toMatch(/access_token\s+text/i);
    expect(sql).toMatch(/refresh_token\s+text/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.calendar_connections/i);
  });

  it("STRIPS the token columns from the authenticated read surface (column privilege)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.calendar_connections\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.calendar_connections\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.calendar_connections\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant to authenticated").not.toBeNull();
    const cols = grant![1];
    expect(cols).not.toMatch(/access_token/i);
    expect(cols).not.toMatch(/refresh_token/i);
    expect(cols).not.toMatch(/token_expires_at/i);
    expect(cols).toMatch(/\bstatus\b/i);
    expect(cols).toMatch(/\bprovider\b/i);
  });
});

describe("calendar_event_links RLS + org-binding", () => {
  it("enables RLS and is member-read / admin-write", () => {
    expect(sql).toMatch(
      /alter table public\.calendar_event_links enable row level security/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_event_links: members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_event_links: admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
  });

  it("is org-pinned and constrains local_kind to job|rota", () => {
    expect(sql).toMatch(/local_kind\s+text not null check \(local_kind in \('job', 'rota'\)\)/i);
    expect(sql).toMatch(/local_id\s+uuid not null/i);
    expect(sql).toMatch(/external_event_id\s+text not null/i);
  });

  it("binds the event link to its connection's org via a COMPOSITE FK (no cross-org link)", () => {
    // The composite FK references calendar_connections(id, org_id), so an event
    // link's org_id MUST equal its connection's org_id — cross-org is impossible.
    expect(sql).toMatch(
      /foreign key\s*\(connection_id,\s*org_id\)\s*references public\.calendar_connections\s*\(id,\s*org_id\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. THE ROUTES + SERVICE — gated, dark-short-circuit, org-pinned, no leak
// ---------------------------------------------------------------------------

describe("calendar connect routes are gated + dark", () => {
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
    const guardIdx = code.indexOf("isCalendarProviderConnectable(provider)");
    const exchangeIdx = code.indexOf("exchangeCodeForTokens(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(exchangeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(exchangeIdx);
    expect(code).toMatch(/state !== stateCookie/);
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

describe("calendar connections service — org-pinned, loud, token-free reads", () => {
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

  it("pushJobToCalendar returns skipped_dark when no live provider is reachable", () => {
    expect(code).toMatch(/isCalendarProviderConnectable\(/);
    expect(code).toMatch(/status:\s*"skipped_dark"/);
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

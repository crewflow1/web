import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Telematics reading SYNC WIRING (20261103) — trust-boundary + structural proofs.
 *
 * The C26 audit found the fetch+map (`syncTelematicsReadings`) had NO caller and
 * there was no token refresh. This suite pins the NEW wiring's invariants against
 * source, so a regression is a visible diff:
 *
 *   1. The cron seam is authorised-first, dark-safe (204 BEFORE telemetry / any
 *      client), and — unlike the weather cron — IS scheduled, so activation is
 *      credentials + flag only (no vercel.json deploy needed to go live).
 *   2. The sync service's DARK readiness gate precedes createAdminClient (zero DB
 *      while dark), writes readings service-role with the idempotent ON CONFLICT
 *      DO NOTHING contract, and pins every row to the CONNECTION's org_id.
 *   3. Token refresh (grant_type=refresh_token) lives strictly AFTER the
 *      connectable guard — no refresh network call is reachable dark.
 *   4. The connection HANDLE is resolved from the token (adapter.resolveAccountHandle
 *      → Samsara /me), NOT a callback query param.
 *   5. No new source logs a secret.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CRON = "app/api/cron/telematics-sync/route.ts";
const SYNC = "server/services/telematics-sync.ts";
const OAUTH = "lib/integrations/telematics/oauth.ts";
const SAMSARA = "lib/integrations/telematics/adapters/samsara.ts";
const CALLBACK = "app/api/integrations/telematics/[provider]/callback/route.ts";

// ---------------------------------------------------------------------------
// 1. THE CRON SEAM — authorised, dark-safe, and SCHEDULED
// ---------------------------------------------------------------------------

describe("telematics-sync cron is authorised, dark-safe, scheduled", () => {
  const code = codeOf(read(CRON));

  it("auth FIRST — a 401 gate precedes everything", () => {
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
    const authIdx = code.indexOf("isCronAuthorised(request)");
    const telemetryIdx = code.indexOf("withCronTelemetry(");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(telemetryIdx);
  });

  it("dark is a 204 no-op BEFORE telemetry / any client access", () => {
    const noopIdx = code.search(/status:\s*204/);
    const telemetryIdx = code.indexOf("withCronTelemetry(");
    expect(noopIdx).toBeGreaterThan(-1);
    // the readiness gate + 204 come before the telemetry-wrapped run.
    expect(noopIdx).toBeLessThan(telemetryIdx);
    expect(code).toMatch(/resolveActiveTelematicsProvider\(\)/);
    expect(code).toMatch(/telematicsProviderReady\(/);
  });

  it("delegates the live pass to runTelematicsSync", () => {
    expect(code).toMatch(/runTelematicsSync\(\)/);
  });

  it("IS scheduled in vercel.json (activation = credentials + flag only)", () => {
    const vercel = read("vercel.json");
    expect(vercel).toContain("/api/cron/telematics-sync");
  });
});

// ---------------------------------------------------------------------------
// 2. THE SYNC SERVICE — dark-gate-first, service-role, idempotent, org-pinned
// ---------------------------------------------------------------------------

describe("runTelematicsSync — dark gate first, idempotent, org-pinned", () => {
  const code = codeOf(read(SYNC));

  it("the readiness gate precedes createAdminClient (zero DB while dark)", () => {
    const gateIdx = code.indexOf("resolveActiveTelematicsProvider()");
    const adminIdx = code.indexOf("createAdminClient(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(adminIdx);
    expect(code).toMatch(/telematicsProviderReady\(provider\)/);
    expect(code).toMatch(/ran:\s*false/);
  });

  it("writes readings with the ON CONFLICT DO NOTHING idempotency contract", () => {
    expect(code).toMatch(/telematics_readings/);
    expect(code).toMatch(/onConflict:\s*READINGS_CONFLICT|onConflict:\s*["']org_id,connection_id,source_event_id["']/);
    expect(code).toMatch(/org_id,connection_id,source_event_id/);
    expect(code).toMatch(/ignoreDuplicates:\s*true/);
  });

  it("pins the mapped rows to the CONNECTION's org_id and connection id", () => {
    // syncTelematicsReadings is called with the connection's own org + id.
    expect(code).toMatch(/orgId:\s*conn\.org_id/);
    expect(code).toMatch(/connectionId:\s*conn\.id/);
  });

  it("builds the vehicle resolver org-pinned (only this org's VINs)", () => {
    expect(code).toMatch(/from\("fleet_vehicles"\)[\s\S]{0,120}\.eq\("org_id",\s*orgId\)/);
  });

  it("proactively refreshes on expiry and retries once after a refresh", () => {
    expect(code).toMatch(/needsRefresh\(/);
    expect(code).toMatch(/refreshAccessToken\(/);
    // the retry is guarded so it happens at most once per pass.
    expect(code).toMatch(/!refreshed/);
  });

  it("persists refreshed tokens ENCRYPTED, never plaintext", () => {
    expect(code).toMatch(/encryptToken\(/);
    // the decrypt-on-use seam is the only place tokens become plaintext.
    expect(code).toMatch(/decryptStoredTokens\(/);
  });

  it("FAIR ORDERING (C71): the connected read orders by last_sync_at nulls-first, NOT id", () => {
    // A pass has a wall-clock budget (below) and clears only a handful of
    // connections; the pre-fix tick-stable `id` order re-serviced the same low-id
    // head every tick while the high-id tail was never reached and silently never
    // synced. Ordering by the success-only cursor (last_sync_at ASC, nulls-first)
    // sinks each just-synced connection to the back so the tail leads the next pass.
    expect(code).toMatch(
      /\.order\(\s*"last_sync_at",\s*\{\s*ascending:\s*true,\s*nullsFirst:\s*true\s*\}\s*\)/,
    );
    // `id` remains only as the deterministic tiebreak, AFTER last_sync_at.
    const primary = code.indexOf('.order("last_sync_at"');
    const idOrder = code.indexOf('.order("id"');
    expect(primary).toBeGreaterThan(-1);
    expect(primary).toBeLessThan(idOrder);
  });

  it("PASS BUDGET (C71): the pass is bounded by a wall-clock budget and breaks", () => {
    // Without a budget the cron's maxDuration=60 kills the loop mid-pass, self-
    // stranding the tail. The loop must stop CLEANLY before starting a connection
    // it cannot finish, leaving the rest for the next (fairly-ordered) pass.
    expect(code).toMatch(/PASS_BUDGET_MS/);
    expect(code).toMatch(/PER_ORG_BUDGET_MS/);
    expect(code).toMatch(/-\s*startedAt\s*\+\s*perOrgBudgetMs\s*>\s*passBudgetMs\)\s*break/);
  });
});

// ---------------------------------------------------------------------------
// 3. TOKEN REFRESH — dark guard precedes the network call
// ---------------------------------------------------------------------------

describe("refreshAccessToken is dark by default", () => {
  const code = codeOf(read(OAUTH));

  it("the refresh grant is refresh_token", () => {
    expect(code).toMatch(/grant_type:\s*["']refresh_token["']/);
  });

  it("REFUSES before any network call when not connectable", () => {
    // isolate the refreshAccessToken body.
    const start = code.indexOf("export async function refreshAccessToken");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    const guardIdx = body.indexOf("isTelematicsProviderConnectable(provider)");
    const notConfiguredIdx = body.indexOf('reason: "not_configured"');
    const fetchIdx = body.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(notConfiguredIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(notConfiguredIdx).toBeLessThan(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. HANDLE RESOLUTION — from the token, not a callback query param
// ---------------------------------------------------------------------------

describe("connection handle is resolved from the token, not a query param", () => {
  it("the callback resolves the handle via adapter.resolveAccountHandle", () => {
    const code = codeOf(read(CALLBACK));
    expect(code).toMatch(/resolveAccountHandle\(/);
    // it no longer trusts a callback query param for the account id.
    expect(code).not.toMatch(/searchParams\.get\("account_id"\)/);
    expect(code).not.toMatch(/searchParams\.get\("org_id"\)/);
    // and still refuses to write a connected row without a real handle.
    expect(code).toMatch(/no_account/);
    expect(code).toMatch(/external_account_id:\s*handle/);
  });

  it("the Samsara adapter's account lookup fetch lives AFTER its availability guard", () => {
    const code = codeOf(read(SAMSARA));
    const start = code.indexOf("async resolveAccountHandle");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    const guardIdx = body.indexOf("if (!this.isAvailable())");
    const fetchIdx = body.indexOf("fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
    expect(body).toMatch(/api\.samsara\.com\/me/);
  });
});

// ---------------------------------------------------------------------------
// 5. NO SECRET IS LOGGED
// ---------------------------------------------------------------------------

describe("no secret is logged in the new sync sources", () => {
  it("no source logs a token or client secret", () => {
    for (const f of [CRON, SYNC]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/client_?secret/i);
        expect(call).not.toMatch(/access_?token/i);
        expect(call).not.toMatch(/refresh_?token/i);
      }
    }
  });
});

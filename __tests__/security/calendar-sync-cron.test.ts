import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CALENDAR SYNC CRON — trust-boundary source proofs for the inbound-sync wiring
 * (watch renewal + bounded periodic pull reconciliation).
 *
 *   - the cron route is CRON_SECRET-gated and dark-no-ops (204) BEFORE telemetry
 *     and before ANY client construction (the bank-sync idiom);
 *   - the watch callback URL is derived from the canonical app origin, never
 *     from the inbound request's host;
 *   - the sync tick's dark guard precedes every store/provider access, and the
 *     per-connection connectable guard precedes provider work;
 *   - the pull composer resolves the live provider through the SERVICE-ROLE,
 *     token-FREE connection-state projection (the webhook + cron run with no
 *     user session, where a tenant read sees zero rows under RLS — the defect
 *     that previously broke the webhook → pull path);
 *   - the new token-store listings select NO token/secret column;
 *   - the route is actually scheduled in vercel.json.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CRON = "app/api/cron/calendar-sync/route.ts";
const SERVICE = "server/services/calendar-pull.ts";
const STORE = "lib/integrations/calendar/token-store.ts";

describe("calendar-sync cron route — gated, dark-204 before telemetry", () => {
  const code = codeOf(read(CRON));

  it("refuses without the CRON bearer secret, FIRST", () => {
    const authIdx = code.indexOf("isCronAuthorised(request)");
    expect(authIdx).toBeGreaterThan(-1);
    const flagIdx = code.indexOf("calendarConnectFeatureEnabled()");
    const telemetryIdx = code.indexOf("withCronTelemetry(");
    expect(authIdx).toBeLessThan(flagIdx);
    expect(authIdx).toBeLessThan(telemetryIdx);
    expect(code).toMatch(/\{ status: 401 \}/);
  });

  it("dark ⇒ 204 BEFORE telemetry (no cron_runs row burnt while dark)", () => {
    const flagIdx = code.indexOf("calendarConnectFeatureEnabled()");
    const telemetryIdx = code.indexOf("withCronTelemetry(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(telemetryIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(telemetryIdx);
    expect(code).toMatch(/new NextResponse\(null, \{ status: 204 \}\)/);
  });

  it("derives the watch callback origin from NEXT_PUBLIC_APP_URL, never the request host", () => {
    expect(code).toMatch(/NEXT_PUBLIC_APP_URL/);
    expect(code).not.toMatch(/request\.headers\.get\(["']host["']\)/i);
    expect(code).not.toMatch(/new URL\(request\.url\)\.origin/);
  });

  it("is scheduled in vercel.json", () => {
    const vercel = JSON.parse(read("vercel.json")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const entry = vercel.crons.find((c) => c.path === "/api/cron/calendar-sync");
    expect(entry, "expected /api/cron/calendar-sync in vercel.json crons").toBeTruthy();
  });
});

describe("runCalendarSyncTick — dark guards precede all work", () => {
  const code = codeOf(read(SERVICE));

  it("the feature-flag guard precedes the connected-connections listing", () => {
    const tickIdx = code.indexOf("export async function runCalendarSyncTick");
    expect(tickIdx).toBeGreaterThan(-1);
    const body = code.slice(tickIdx);
    const flagIdx = body.indexOf("if (!calendarConnectFeatureEnabled())");
    const listIdx = body.indexOf("listConnectedCalendarConnections(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(listIdx);
  });

  it("the per-connection connectable guard precedes watch/pull work", () => {
    const tickIdx = code.indexOf("export async function runCalendarSyncTick");
    const body = code.slice(tickIdx);
    const guardIdx = body.indexOf("if (!isCalendarProviderConnectable(conn.provider))");
    const watchIdx = body.indexOf("registerCalendarWatch(");
    const pullIdx = body.indexOf("pullCalendarEvents(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(watchIdx);
    expect(guardIdx).toBeLessThan(pullIdx);
  });

  it("resolves the live provider via the SERVICE-ROLE token-free projection (no tenant read)", () => {
    expect(code).toMatch(/listOrgCalendarConnectionStates\(orgId\)/);
    // The session-less entry points must not depend on a tenant-JWT read.
    expect(code).not.toMatch(/listCalendarConnections\(/);
  });
});

describe("token-store listings are token-FREE", () => {
  const code = codeOf(read(STORE));

  const selectOf = (fnName: string): string => {
    const idx = code.indexOf(`export async function ${fnName}`);
    expect(idx, `expected ${fnName} in token-store`).toBeGreaterThan(-1);
    const body = code.slice(idx, code.indexOf("export", idx + 10));
    const m = body.match(/\.select\(\s*"([^"]+)"\s*\)/);
    expect(m, `expected a column-listed select in ${fnName}`).not.toBeNull();
    return m![1]!;
  };

  it("listConnectedCalendarConnections selects only id/org/provider", () => {
    const cols = selectOf("listConnectedCalendarConnections");
    expect(cols).not.toMatch(/token/i);
    expect(cols).toBe("id, org_id, provider");
  });

  it("listConnectedCalendarConnections orders by the FAIRNESS cursor (last_sync_at ASC NULLS FIRST)", () => {
    // The cron-fairness guard (cron-fairness-guard.test.ts) proves the tick
    // consumes this lister under a pass budget; THIS pin holds the SQL half of
    // that proof — the recency-cursor primary order, in the token-store where
    // the query actually lives. A successful pull advances last_sync_at
    // (markConnectionSynced), so serviced connections rotate to the back.
    const idx = code.indexOf("export async function listConnectedCalendarConnections");
    const body = code.slice(idx, code.indexOf("export", idx + 10));
    expect(body).toMatch(
      /\.order\(\s*"last_sync_at",\s*\{\s*ascending:\s*true,\s*nullsFirst:\s*true\s*\}\s*\)/,
    );
  });

  it("listOrgCalendarConnectionStates selects only provider/status/handle", () => {
    const cols = selectOf("listOrgCalendarConnectionStates");
    expect(cols).not.toMatch(/token/i);
    expect(cols).toBe("provider, status, external_account_id");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  pullEvents,
  pullFreeBusy,
} from "@/lib/integrations/calendar/pull-adapter";
import {
  registerWatchChannel,
  stopWatchChannel,
} from "@/lib/integrations/calendar/watch-adapter";

/**
 * Calendar two-way PULL (20261138) — trust-boundary proofs.
 *
 * Section 1: the pull + watch adapters are DARK — with no credentials no provider
 * is connectable, and every network function REFUSES before any `fetch`.
 * Section 2: calendar_watch_channels + calendar_pulled_events RLS is DB-enforced
 * admin-write / member-read, org-pinned; verification_token is a secret stripped
 * from the authenticated read surface; both tables are org-bound by a composite FK.
 * Section 3: the webhook receiver validates the provider, short-circuits BEFORE any
 * provider work while dark, echoes the Microsoft validation token, and verifies the
 * echoed secret constant-time. The pull composer is org-pinned, token-free, and
 * dedups against pushed events. No secret is logged anywhere.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261138000000_calendar_pull.sql";
const PULL_ADAPTER = "lib/integrations/calendar/pull-adapter.ts";
const WATCH_ADAPTER = "lib/integrations/calendar/watch-adapter.ts";
const PULL_SERVICE = "server/services/calendar-pull.ts";
const TOKEN_STORE = "lib/integrations/calendar/token-store.ts";
const WEBHOOK = "app/api/integrations/calendar/[provider]/webhook/route.ts";

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
// 1. THE PULL + WATCH ADAPTERS ARE DARK
// ---------------------------------------------------------------------------

describe("pull + watch adapters refuse before any network call while dark", () => {
  const original = { ...process.env };
  beforeEach(() => {
    for (const k of OAUTH_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("pullEvents / pullFreeBusy REFUSE with not_configured when dark", async () => {
    const win = { timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-09-01T00:00:00Z" };
    const tokens = { accessToken: "AT", refreshToken: "RT" };
    for (const p of ["google", "microsoft"] as const) {
      const ev = await pullEvents({ provider: p, tokens, ...win });
      expect(ev.ok).toBe(false);
      if (!ev.ok) expect(ev.reason).toBe("not_configured");
      const fb = await pullFreeBusy({ provider: p, tokens, ...win });
      expect(fb.ok).toBe(false);
      if (!fb.ok) expect(fb.reason).toBe("not_configured");
    }
  });

  it("registerWatchChannel / stopWatchChannel REFUSE with not_configured when dark", async () => {
    const tokens = { accessToken: "AT", refreshToken: "RT" };
    const reg = await registerWatchChannel({
      provider: "google",
      tokens,
      notificationUrl: "https://crewflow.uk/api/integrations/calendar/google/webhook",
      verificationToken: "s",
      channelId: "c",
      ttlMs: 1000,
    });
    expect(reg.ok).toBe(false);
    if (!reg.ok) expect(reg.reason).toBe("not_configured");
    const stop = await stopWatchChannel({ provider: "google", tokens, channelId: "c", resourceId: "r" });
    expect(stop.ok).toBe(false);
    if (!stop.ok) expect(stop.reason).toBe("not_configured");
  });

  it("each network function places its not_configured guard BEFORE it touches the network", () => {
    const pull = codeOf(read(PULL_ADAPTER));
    // pullEvents delegates the fetch to authedGet — the guard must precede that call.
    for (const [fn, marker] of [
      ["pullEvents", "authedGet("],
      ["pullFreeBusy", "fetch("],
    ] as const) {
      const start = pull.indexOf(`export async function ${fn}`);
      expect(start, `${fn} exists`).toBeGreaterThan(-1);
      const body = pull.slice(start, pull.indexOf("export async function", start + 1) === -1 ? undefined : pull.indexOf("export async function", start + 1));
      const guardIdx = body.indexOf('reason: "not_configured"');
      const netIdx = body.indexOf(marker);
      expect(guardIdx, `${fn}: guard present`).toBeGreaterThan(-1);
      expect(netIdx, `${fn}: network marker present`).toBeGreaterThan(-1);
      expect(guardIdx, `${fn}: guard before network`).toBeLessThan(netIdx);
    }
    const watch = codeOf(read(WATCH_ADAPTER));
    for (const fn of ["registerWatchChannel", "stopWatchChannel"]) {
      const start = watch.indexOf(`export async function ${fn}`);
      const body = watch.slice(start);
      const guardIdx = body.indexOf('reason: "not_configured"');
      const fetchIdx = body.indexOf("fetch(");
      expect(guardIdx, `${fn}: guard present`).toBeGreaterThan(-1);
      expect(guardIdx, `${fn}: guard before fetch`).toBeLessThan(fetchIdx);
    }
  });

  it("both adapters gate on isCalendarProviderConnectable (the two-switch dark gate)", () => {
    expect(codeOf(read(PULL_ADAPTER))).toMatch(/isCalendarProviderConnectable\(/);
    expect(codeOf(read(WATCH_ADAPTER))).toMatch(/isCalendarProviderConnectable\(/);
  });

  it("the watch adapter refuses a non-public notification URL (SSRF-to-self / http leak)", () => {
    const code = codeOf(read(WATCH_ADAPTER));
    expect(code).toMatch(/isPrivateHost\(/);
    expect(code).toMatch(/protocol !== "https:"/);
    expect(code).toMatch(/reason: "invalid_url"/);
  });
});

// ---------------------------------------------------------------------------
// 2. THE MIGRATION — RLS, tenancy, org-binding, secret column stripped
// ---------------------------------------------------------------------------

describe("calendar_watch_channels RLS + shape", () => {
  it("enables RLS and is member-read / admin-write", () => {
    expect(sql).toMatch(/alter table public\.calendar_watch_channels enable row level security/i);
    expect(sql).toMatch(
      /create policy[^;]*calendar_watch_channels: members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_watch_channels: admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_watch_channels: admins can update[^;]*for update[\s\S]*is_org_admin\(/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_watch_channels: admins can delete[^;]*for delete[\s\S]*is_org_admin\(/i,
    );
  });

  it("is org-pinned with cascade teardown + a composite FK to its connection's org", () => {
    expect(sql).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(
      /foreign key\s*\(connection_id,\s*org_id\)\s*references public\.calendar_connections\s*\(id,\s*org_id\)/i,
    );
  });

  it("has a globally-unique channel id (the unauthenticated inbound lookup key) and one channel per connection", () => {
    expect(sql).toMatch(/unique\s*\(channel_id\)/i);
    expect(sql).toMatch(/unique\s*\(connection_id\)/i);
  });

  it("constrains provider + status vocabularies", () => {
    expect(sql).toMatch(/provider\s+text not null check \(provider in \('google', 'microsoft'\)\)/i);
    expect(sql).toMatch(/status\s+text not null default 'inactive'[\s\S]*check \(status in \('inactive', 'active', 'expired', 'error'\)\)/i);
  });

  it("STRIPS verification_token from the authenticated read surface (column privilege)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.calendar_watch_channels\s+from\s+anon/i);
    expect(sql).toMatch(
      /revoke\s+select\s+on\s+table\s+public\.calendar_watch_channels\s+from\s+authenticated/i,
    );
    const grant = sql.match(
      /grant\s+select\s*\(([\s\S]*?)\)\s*on\s+public\.calendar_watch_channels\s+to\s+authenticated/i,
    );
    expect(grant, "expected an explicit safe-column SELECT grant").not.toBeNull();
    expect(grant![1]).not.toMatch(/verification_token/i);
    expect(grant![1]).toMatch(/\bchannel_id\b/i);
    expect(grant![1]).toMatch(/\bstatus\b/i);
  });
});

describe("calendar_pulled_events RLS + org-binding + dedup shape", () => {
  it("enables RLS and is member-read / admin-write", () => {
    expect(sql).toMatch(/alter table public\.calendar_pulled_events enable row level security/i);
    expect(sql).toMatch(
      /create policy[^;]*calendar_pulled_events: members can select[^;]*for select[\s\S]*current_org_ids\(\)/i,
    );
    expect(sql).toMatch(
      /create policy[^;]*calendar_pulled_events: admins can insert[^;]*for insert[\s\S]*is_org_admin\(/i,
    );
  });

  it("is org-bound by a composite FK and de-duplicated one row per (connection, external event)", () => {
    expect(sql).toMatch(
      /foreign key\s*\(connection_id,\s*org_id\)\s*references public\.calendar_connections\s*\(id,\s*org_id\)/i,
    );
    expect(sql).toMatch(/unique\s*\(connection_id,\s*external_event_id\)/i);
  });

  it("carries the dedup + busy flags scheduling relies on", () => {
    expect(sql).toMatch(/is_crewflow_origin\s+boolean not null default false/i);
    expect(sql).toMatch(/is_busy\s+boolean not null default true/i);
    expect(sql).toMatch(/external_event_id\s+text not null/i);
  });

  it("revokes anon and writes no rows (dark: never populated)", () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+table\s+public\.calendar_pulled_events\s+from\s+anon/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.calendar_pulled_events/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.calendar_watch_channels/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE WEBHOOK ROUTE + THE PULL COMPOSER
// ---------------------------------------------------------------------------

describe("calendar webhook receiver is validated, dark-safe, and verifies the secret", () => {
  const code = codeOf(read(WEBHOOK));

  it("validates the provider path segment", () => {
    expect(code).toMatch(/unknown_provider/);
    expect(code).toMatch(/CALENDAR_PROVIDERS/);
  });

  it("SHORT-CIRCUITS before delegating any provider work while dark", () => {
    const guardIdx = code.indexOf("isCalendarProviderConnectable(provider)");
    const delegateIdx = code.indexOf("bestEffortHandleInbound(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(delegateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(delegateIdx);
  });

  it("echoes the Microsoft subscription validation token (handshake)", () => {
    expect(code).toMatch(/validationToken/);
    expect(code).toMatch(/text\/plain/);
  });

  it("resolves the channel id from Google headers and Microsoft body clientState", () => {
    expect(code).toMatch(/x-goog-channel-id/);
    expect(code).toMatch(/x-goog-channel-token/);
    expect(code).toMatch(/clientState/);
    expect(code).toMatch(/subscriptionId/);
  });
});

describe("the pull composer is org-pinned, token-free, dedups, and verifies constant-time", () => {
  const code = codeOf(read(PULL_SERVICE));

  it("NEVER selects a token or secret column back through the tenant-facing service", () => {
    expect(code).not.toMatch(/select[\s\S]{0,120}access_token/i);
    expect(code).not.toMatch(/select[\s\S]{0,120}refresh_token/i);
    expect(code).not.toMatch(/select[\s\S]{0,120}verification_token/i);
  });

  it("reads tokens via the service-role store, decrypts on use, and dedups against pushed events", () => {
    expect(code).toMatch(/readConnectionTokens\(/);
    expect(code).toMatch(/decryptStoredTokens\(/);
    expect(code).toMatch(/listPushedExternalEventIds\(/);
    expect(code).toMatch(/hasCrewflowMarker\(/);
    expect(code).toMatch(/is_crewflow_origin|isCrewflowOrigin/);
  });

  it("verifies the inbound token CONSTANT-TIME (never a bare === on a secret)", () => {
    expect(code).toMatch(/timingSafeEqual/);
    expect(code).not.toMatch(/providedToken === expected/);
  });

  it("returns skipped_dark when no live provider is reachable", () => {
    expect(code).toMatch(/isCalendarProviderConnectable\(/);
    expect(code).toMatch(/skipped_dark/);
  });

  it("bestEffortHandleInbound short-circuits on the feature flag BEFORE any work", () => {
    const start = code.indexOf("export async function bestEffortHandleInbound");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start);
    const flagIdx = body.indexOf("calendarConnectFeatureEnabled()");
    const handleIdx = body.indexOf("handleInboundNotification(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(handleIdx);
  });
});

describe("the pull token store — service-role, org-pinned, encrypt-before-write", () => {
  const code = codeOf(read(TOKEN_STORE));

  it("reads/writes under the service-role admin client", () => {
    expect(code).toMatch(/createAdminClient\(/);
  });

  it("encrypts the verification token before persisting it (never plaintext)", () => {
    expect(code).toMatch(/verification_token:\s*encryptToken\(/);
    expect(code).not.toMatch(/verification_token:\s*params\.verificationToken\b/);
  });

  it("upserts pulled events + watch channel with their conflict targets (re-pull updates, not duplicates)", () => {
    expect(code).toMatch(/onConflict:\s*"connection_id,external_event_id"/);
    expect(code).toMatch(/onConflict:\s*"connection_id"/);
  });

  it("pins org_id on the watch/pulled reads and writes", () => {
    expect(code).toMatch(/org_id:\s*orgId/);
    expect((code.match(/\.eq\("org_id"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// 4. NO SECRET IS EVER LOGGED (new pull files)
// ---------------------------------------------------------------------------

describe("no secret is ever logged in the pull surface", () => {
  it("no pull source logs a token or verification secret", () => {
    for (const f of [PULL_ADAPTER, WATCH_ADAPTER, PULL_SERVICE, TOKEN_STORE, WEBHOOK]) {
      const code = codeOf(read(f));
      const logCalls = code.match(/console\.\w+\([^;]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call).not.toMatch(/access_?token/i);
        expect(call).not.toMatch(/refresh_?token/i);
        expect(call).not.toMatch(/verification_?token/i);
        expect(call).not.toMatch(/clientState/i);
        expect(call).not.toMatch(/client_?secret/i);
      }
    }
  });
});

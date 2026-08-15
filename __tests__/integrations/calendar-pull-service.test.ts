import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * calendar-pull service composition — hermetic tests.
 *
 * Executes the REAL pull composer, REAL token-store, REAL pull-adapter and REAL
 * token crypto against a chainable Supabase mock (tenant + admin) and a mocked
 * provider HTTP layer. Proves:
 *   - a pull DEDUPS against events CrewFlow pushed (stored external id) — flagging
 *     is_crewflow_origin so scheduling ignores our own events;
 *   - pullCalendarEvents is skipped_dark (no network) when no live provider;
 *   - handleInboundNotification CONSTANT-TIME verifies the echoed token: a valid
 *     token → synced (triggers a pull), a wrong token → invalid_token (no pull),
 *     an unknown channel → unknown_channel, and it refuses (no provider work)
 *     while dark.
 */

const h = vi.hoisted(() => {
  type ConnRow = {
    provider: string;
    status: string;
    external_account_id: string | null;
    connected_at: string | null;
    last_sync_at: string | null;
    last_error: string | null;
  };
  const state: {
    connections: ConnRow[];
    tokenRow: Record<string, unknown> | null;
    watch: Record<string, unknown> | null;
    pushedLinks: { external_event_id: string }[];
    pulledUpserts: Record<string, unknown>[][];
    watchWrites: Record<string, unknown>[];
  } = {
    connections: [],
    tokenRow: null,
    watch: null,
    pushedLinks: [],
    pulledUpserts: [],
    watchWrites: [],
  };

  type BuilderState = {
    table: string;
    op: string;
    row: Record<string, unknown> | Record<string, unknown>[] | null;
    eqs: Array<[string, unknown]>;
  };
  type Resolver = (st: BuilderState) => { data?: unknown; error: unknown };

  function makeBuilder(table: string, resolver: Resolver) {
    const st: BuilderState = { table, op: "select", row: null, eqs: [] };
    const settle = () => Promise.resolve(resolver(st));
    const b: Record<string, unknown> = {
      select() { st.op = "select"; return b; },
      update(r: Record<string, unknown>) { st.op = "update"; st.row = r; return b; },
      delete() { st.op = "delete"; return b; },
      upsert(r: Record<string, unknown> | Record<string, unknown>[]) { st.op = "upsert"; st.row = r; return settle(); },
      eq(col: string, val: unknown) { st.eqs.push([col, val]); return b; },
      range() { return settle(); },
      maybeSingle() { return settle(); },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { return settle().then(res, rej); },
    };
    return b;
  }
  const eqVal = (st: BuilderState, c: string) => (st.eqs.find(([col]) => col === c) ?? [])[1];

  const serverResolver: Resolver = (st) => {
    // Tenant client: listCalendarConnections (org-only → array).
    if (st.table === "calendar_connections" && st.op === "select") {
      return { data: state.connections, error: null };
    }
    return { data: null, error: null };
  };
  const adminResolver: Resolver = (st) => {
    if (st.table === "calendar_connections" && st.op === "select")
      return { data: state.tokenRow, error: null };
    if (st.table === "calendar_connections" && st.op === "update") return { data: null, error: null };
    if (st.table === "calendar_event_links" && st.op === "select")
      return { data: state.pushedLinks, error: null };
    if (st.table === "calendar_watch_channels" && st.op === "select") {
      // findWatchChannelByChannelId pins channel_id; readWatchChannel pins org_id.
      if (eqVal(st, "channel_id") !== undefined) return { data: state.watch, error: null };
      return { data: state.watch, error: null };
    }
    if (st.table === "calendar_watch_channels") {
      state.watchWrites.push({ op: st.op, row: st.row });
      return { data: null, error: null };
    }
    if (st.table === "calendar_pulled_events" && st.op === "upsert") {
      state.pulledUpserts.push(st.row as Record<string, unknown>[]);
      return { error: null };
    }
    return { data: null, error: null };
  };

  const createClientMock = vi.fn(async () => ({ from: (t: string) => makeBuilder(t, serverResolver) }));
  const createAdminMock = vi.fn(() => ({ from: (t: string) => makeBuilder(t, adminResolver) }));
  return { state, createClientMock, createAdminMock };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClientMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.createAdminMock }));
vi.mock("@/lib/supabase/read-failure", () => ({
  readFailure: (ctx: string, e: { message: string }) => new Error(`${ctx}: ${e.message}`),
}));

import { encryptToken } from "@/lib/integrations/token-crypto";
import {
  pullCalendarEvents,
  handleInboundNotification,
} from "@/server/services/calendar-pull";

// Set the encryption key at module load so the `encryptToken(...)` calls in the
// test fixtures below (evaluated during collection, before beforeEach) succeed.
process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const CREDS = {
  FEATURE_CALENDAR_CONNECT: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "gid",
  GOOGLE_CALENDAR_CLIENT_SECRET: "gsecret",
  MS_GRAPH_CLIENT_ID: "mid",
  MS_GRAPH_CLIENT_SECRET: "msecret",
  INTEGRATION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as const;

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const CONNECTED_GOOGLE = {
  provider: "google",
  status: "connected",
  external_account_id: "boss@acme.co",
  connected_at: "2026-08-01T00:00:00Z",
  last_sync_at: null,
  last_error: null,
};

const original = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
  h.state.connections = [CONNECTED_GOOGLE];
  h.state.tokenRow = {
    id: "conn-1",
    access_token: encryptToken("access-plain"),
    refresh_token: encryptToken("refresh-plain"),
    token_expires_at: null,
  };
  h.state.watch = null;
  h.state.pushedLinks = [];
  h.state.pulledUpserts = [];
  h.state.watchWrites = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

describe("pullCalendarEvents — dedup against pushed events", () => {
  it("flags a pulled event whose id CrewFlow pushed as crewflow-origin (deduped)", async () => {
    h.state.pushedLinks = [{ external_event_id: "evt-pushed" }];
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        items: [
          { id: "evt-pushed", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } },
          { id: "evt-external", start: { dateTime: "2026-09-02T09:00:00Z" }, end: { dateTime: "2026-09-02T10:00:00Z" } },
        ],
        nextSyncToken: "S1",
      }),
    );
    const res = await pullCalendarEvents("org-1");
    expect(res).toMatchObject({ ok: true, status: "pulled", provider: "google", fetched: 2, deduped: 1, imported: 2 });

    const upserted = h.state.pulledUpserts[0]!;
    const byId = Object.fromEntries(upserted.map((r) => [r.external_event_id, r]));
    expect(byId["evt-pushed"]!.is_crewflow_origin).toBe(true);
    expect(byId["evt-external"]!.is_crewflow_origin).toBe(false);
  });

  it("flags a pulled event carrying the CrewFlow marker even when not in the pushed set", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        items: [
          {
            id: "evt-marked",
            description: "CrewFlow job 12345678-1234-1234-1234-123456789abc",
            start: { dateTime: "2026-09-01T09:00:00Z" },
            end: { dateTime: "2026-09-01T10:00:00Z" },
          },
        ],
        nextSyncToken: "S1",
      }),
    );
    const res = await pullCalendarEvents("org-1");
    expect(res.deduped).toBe(1);
    expect(h.state.pulledUpserts[0]![0]!.is_crewflow_origin).toBe(true);
  });

  it("is skipped_dark (no network) when the provider has no live credentials", async () => {
    for (const k of Object.keys(CREDS)) if (k !== "INTEGRATION_TOKEN_ENCRYPTION_KEY") delete process.env[k];
    const res = await pullCalendarEvents("org-1");
    expect(res.status).toBe("skipped_dark");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleInboundNotification — constant-time token verification", () => {
  const WATCH = {
    id: "watch-1",
    org_id: "org-1",
    connection_id: "conn-1",
    provider: "google",
    channel_id: "chan-1",
    resource_id: "res-1",
    verification_token: encryptToken("watch-secret"),
    sync_token: null,
    status: "active",
    expiration: null,
  };

  it("a VALID token verifies and triggers a pull (synced)", async () => {
    h.state.watch = { ...WATCH };
    fetchMock.mockResolvedValueOnce(jsonRes(200, { items: [], nextSyncToken: "S2" }));
    const res = await handleInboundNotification({ provider: "google", channelId: "chan-1", providedToken: "watch-secret" });
    expect(res).toMatchObject({ ok: true, verified: true, status: "synced" });
    // The pull actually ran.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("a WRONG token is rejected (invalid_token) and triggers NO pull", async () => {
    h.state.watch = { ...WATCH };
    const res = await handleInboundNotification({ provider: "google", channelId: "chan-1", providedToken: "not-the-secret" });
    expect(res).toMatchObject({ verified: false, status: "invalid_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown channel is a non-fatal no-op (unknown_channel)", async () => {
    h.state.watch = null;
    const res = await handleInboundNotification({ provider: "google", channelId: "nope", providedToken: "x" });
    expect(res).toMatchObject({ verified: false, status: "unknown_channel" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a provider mismatch on the resolved channel is not verified", async () => {
    h.state.watch = { ...WATCH, provider: "microsoft" };
    const res = await handleInboundNotification({ provider: "google", channelId: "chan-1", providedToken: "watch-secret" });
    expect(res).toMatchObject({ verified: false, status: "unknown_channel" });
  });

  it("refuses (no provider work) while dark", async () => {
    for (const k of Object.keys(CREDS)) if (k !== "INTEGRATION_TOKEN_ENCRYPTION_KEY") delete process.env[k];
    const res = await handleInboundNotification({ provider: "google", channelId: "chan-1", providedToken: "watch-secret" });
    expect(res).toMatchObject({ verified: false, status: "skipped_dark" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

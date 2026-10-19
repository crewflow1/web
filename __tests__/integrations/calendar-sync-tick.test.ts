import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * runCalendarSyncTick — the cron composer for calendar watch RENEWAL + bounded
 * periodic PULL reconciliation (server/services/calendar-pull.ts).
 *
 * Hermetic: the token-store is mocked wholesale (no DB), the provider adapters
 * (pull / watch) are mocked (no network), while the oauth gating + token crypto
 * run FOR REAL against the env. Proves:
 *   - DARK SHORT-CIRCUIT: flag off ⇒ ran:false, ZERO store access (the cron
 *     route's 204 guard has a second, structural line of defence here);
 *   - a connected org with NO watch channel gets one REGISTERED, and its events
 *     PULLED (the activation-day behaviour the audit found unreachable);
 *   - a watch expiring OUTSIDE the renewal window is KEPT (no provider call);
 *   - a watch expiring INSIDE the window is RE-REGISTERED;
 *   - a provider that is no longer connectable is skipped dark, per connection,
 *     with no provider work;
 *   - one org's failure does not starve the rest of the tick (never-throws).
 */

const h = vi.hoisted(() => {
  const state: {
    connected: Array<{ orgId: string; provider: string; connectionId: string }>;
    connStates: Array<{ provider: string; status: string; externalAccountId: string | null }>;
    tokenRow: Record<string, unknown> | null;
    watch: Record<string, unknown> | null;
    pulledUpserts: unknown[];
    watchUpserts: unknown[];
    calls: string[];
  } = {
    connected: [],
    connStates: [],
    tokenRow: null,
    watch: null,
    pulledUpserts: [],
    watchUpserts: [],
    calls: [],
  };

  const store = {
    listConnectedCalendarConnections: vi.fn(async (limit: number) => {
      state.calls.push("listConnected");
      return state.connected.slice(0, limit);
    }),
    listOrgCalendarConnectionStates: vi.fn(async () => state.connStates),
    readConnectionTokens: vi.fn(async () => state.tokenRow),
    persistRefreshedTokens: vi.fn(async () => undefined),
    markConnectionSynced: vi.fn(async () => undefined),
    markConnectionError: vi.fn(async () => undefined),
    listPushedExternalEventIds: vi.fn(async () => new Set<string>()),
    upsertPulledEvents: vi.fn(async (_o: string, _c: string, events: unknown[]) => {
      state.pulledUpserts.push(events);
    }),
    findWatchChannelByChannelId: vi.fn(async () => null),
    readWatchChannel: vi.fn(async () => state.watch),
    upsertWatchChannel: vi.fn(async (row: unknown) => {
      state.watchUpserts.push(row);
    }),
    updateWatchSyncState: vi.fn(async () => undefined),
    markWatchNotified: vi.fn(async () => undefined),
    deleteWatchChannel: vi.fn(async () => undefined),
  };

  const pullEvents = vi.fn(async () => ({
    ok: true as const,
    events: [
      {
        externalEventId: "evt-1",
        icalUid: null,
        summary: "Dentist",
        location: null,
        startsAt: "2026-08-20T10:00:00Z",
        endsAt: "2026-08-20T11:00:00Z",
        isAllDay: false,
        status: "confirmed",
        isBusy: true,
        isCrewflowOrigin: false,
        etag: null,
        providerUpdatedAt: null,
      },
    ],
    nextSyncToken: "cursor-2",
    refreshed: null,
  }));
  const pullFreeBusy = vi.fn(async () => ({ ok: true as const, busy: [], refreshed: null }));
  const registerWatchChannel = vi.fn(async (params: { channelId: string }) => ({
    ok: true as const,
    watch: { channelId: params.channelId, resourceId: "res-1", expiration: "2026-08-25T00:00:00Z" },
    refreshed: null,
  }));
  const stopWatchChannel = vi.fn(async () => ({ ok: true as const, refreshed: null }));

  return { state, store, pullEvents, pullFreeBusy, registerWatchChannel, stopWatchChannel };
});

vi.mock("@/lib/integrations/calendar/token-store", () => h.store);
vi.mock("@/lib/integrations/calendar/pull-adapter", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    pullEvents: h.pullEvents,
    pullFreeBusy: h.pullFreeBusy,
  };
});
vi.mock("@/lib/integrations/calendar/watch-adapter", () => ({
  registerWatchChannel: h.registerWatchChannel,
  stopWatchChannel: h.stopWatchChannel,
}));

import { encryptToken } from "@/lib/integrations/token-crypto";
import { runCalendarSyncTick } from "@/server/services/calendar-pull";

process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const CREDS = {
  FEATURE_CALENDAR_CONNECT: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "gid",
  GOOGLE_CALENDAR_CLIENT_SECRET: "gsecret",
  MS_GRAPH_CLIENT_ID: "mid",
  MS_GRAPH_CLIENT_SECRET: "msecret",
  INTEGRATION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
} as const;

const ORIGIN = "https://crewflow.uk";

const original = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
  h.state.connected = [{ orgId: "org-1", provider: "google", connectionId: "conn-1" }];
  h.state.connStates = [
    { provider: "google", status: "connected", externalAccountId: "boss@acme.co" },
  ];
  h.state.tokenRow = {
    connectionId: "conn-1",
    accessToken: encryptToken("access-plain"),
    refreshToken: encryptToken("refresh-plain"),
    expiresAt: null,
  };
  h.state.watch = null;
  h.state.pulledUpserts = [];
  h.state.watchUpserts = [];
  h.state.calls = [];
});

afterEach(() => {
  process.env = { ...original };
});

describe("runCalendarSyncTick", () => {
  it("DARK: flag off ⇒ skipped_dark with ZERO store access", async () => {
    delete process.env.FEATURE_CALENDAR_CONNECT;
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary).toEqual({ ran: false, status: "skipped_dark", connections: 0, outcomes: [] });
    expect(h.store.listConnectedCalendarConnections).not.toHaveBeenCalled();
    expect(h.pullEvents).not.toHaveBeenCalled();
    expect(h.registerWatchChannel).not.toHaveBeenCalled();
  });

  it("zero connected calendars ⇒ a cheap no-op (one bounded select, no provider call)", async () => {
    h.state.connected = [];
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary.ran).toBe(true);
    expect(summary.connections).toBe(0);
    expect(summary.outcomes).toEqual([]);
    expect(h.pullEvents).not.toHaveBeenCalled();
    expect(h.registerWatchChannel).not.toHaveBeenCalled();
  });

  it("a connected org with NO watch channel gets one registered AND its events pulled", async () => {
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary.outcomes).toHaveLength(1);
    const o = summary.outcomes[0]!;
    expect(o.ok).toBe(true);
    expect(o.watch).toBe("registered");
    expect(o.pull).toBe("pulled");
    // The provider watch targets OUR webhook receiver, derived from the app origin.
    expect(h.registerWatchChannel).toHaveBeenCalledTimes(1);
    const regArgs = h.registerWatchChannel.mock.calls[0]![0] as unknown as {
      notificationUrl: string;
    };
    expect(regArgs.notificationUrl).toBe(
      "https://crewflow.uk/api/integrations/calendar/google/webhook",
    );
    // The channel row is persisted; the pulled event is upserted (idempotent key
    // = connection + external event id, enforced by the DB unique constraint).
    expect(h.store.upsertWatchChannel).toHaveBeenCalledTimes(1);
    expect(h.store.upsertPulledEvents).toHaveBeenCalledTimes(1);
  });

  it("a watch expiring OUTSIDE the 24h renewal window is kept — no provider registration", async () => {
    h.state.watch = {
      id: "w1",
      orgId: "org-1",
      connectionId: "conn-1",
      provider: "google",
      channelId: "chan-1",
      resourceId: "res-1",
      verificationToken: encryptToken("vt"),
      syncToken: "cursor-1",
      status: "active",
      expiration: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary.outcomes[0]!.watch).toBe("kept");
    expect(h.registerWatchChannel).not.toHaveBeenCalled();
    // The pull still runs (reconciliation) and uses the stored cursor.
    expect(h.pullEvents).toHaveBeenCalledTimes(1);
    const pullArgs = (h.pullEvents.mock.calls[0] as unknown[])[0] as {
      syncToken: string | null;
    };
    expect(pullArgs.syncToken).toBe("cursor-1");
  });

  it("a watch expiring INSIDE the window is re-registered", async () => {
    h.state.watch = {
      id: "w1",
      orgId: "org-1",
      connectionId: "conn-1",
      provider: "google",
      channelId: "chan-1",
      resourceId: "res-1",
      verificationToken: encryptToken("vt"),
      syncToken: "cursor-1",
      status: "active",
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h out
    };
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary.outcomes[0]!.watch).toBe("registered");
    expect(h.registerWatchChannel).toHaveBeenCalledTimes(1);
  });

  it("a provider no longer connectable is skipped DARK per connection — no provider work", async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const summary = await runCalendarSyncTick(ORIGIN);
    const o = summary.outcomes[0]!;
    expect(o.watch).toBe("skipped_dark");
    expect(o.pull).toBe("skipped_dark");
    expect(o.ok).toBe(true);
    expect(h.pullEvents).not.toHaveBeenCalled();
    expect(h.registerWatchChannel).not.toHaveBeenCalled();
  });

  it("one org's failure does not starve the rest of the tick", async () => {
    h.state.connected = [
      { orgId: "org-1", provider: "google", connectionId: "conn-1" },
      { orgId: "org-2", provider: "google", connectionId: "conn-2" },
    ];
    // First registration throws; the engine records the error and continues.
    h.registerWatchChannel
      .mockImplementationOnce(async () => {
        throw new Error("provider exploded");
      })
      .mockImplementation(async (params: { channelId: string }) => ({
        ok: true as const,
        watch: { channelId: params.channelId, resourceId: "r", expiration: "2026-08-25T00:00:00Z" },
        refreshed: null,
      }));
    const summary = await runCalendarSyncTick(ORIGIN);
    expect(summary.outcomes).toHaveLength(2);
    expect(summary.outcomes[0]!.watch).toBe("error");
    expect(summary.outcomes[0]!.ok).toBe(false);
    expect(summary.outcomes[1]!.watch).toBe("registered");
    expect(summary.outcomes[1]!.ok).toBe(true);
  });
});

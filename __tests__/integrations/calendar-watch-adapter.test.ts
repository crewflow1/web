import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  registerWatchChannel,
  stopWatchChannel,
} from "@/lib/integrations/calendar/watch-adapter";

/**
 * Calendar WATCH-CHANNEL adapter — unit tests (hermetic; provider HTTP mocked).
 *
 * Proves: Google events.watch + Microsoft subscription registration map to the
 * neutral RegisteredWatch; a non-public notification URL is refused before any
 * network call; stop tolerates already-gone; a 401 refreshes + retries once; and
 * every function REFUSES before any `fetch` while dark.
 */

const CREDS = {
  FEATURE_CALENDAR_CONNECT: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "gid",
  GOOGLE_CALENDAR_CLIENT_SECRET: "gsecret",
  MS_GRAPH_CLIENT_ID: "mid",
  MS_GRAPH_CLIENT_SECRET: "msecret",
} as const;

function enableProviders() {
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
}
function disableProviders() {
  for (const k of Object.keys(CREDS)) delete process.env[k];
}
function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const TOKENS = { accessToken: "AT", refreshToken: "RT" };
const NOTIFY = "https://crewflow.uk/api/integrations/calendar/google/webhook";

const original = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  enableProviders();
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

describe("registerWatchChannel", () => {
  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await registerWatchChannel({
      provider: "google",
      tokens: TOKENS,
      notificationUrl: NOTIFY,
      verificationToken: "secret",
      channelId: "chan-1",
      ttlMs: 3600_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REFUSES a non-https / private notification URL before any network call", async () => {
    for (const bad of ["http://crewflow.uk/webhook", "https://localhost/webhook", "https://127.0.0.1/webhook"]) {
      const res = await registerWatchChannel({
        provider: "google",
        tokens: TOKENS,
        notificationUrl: bad,
        verificationToken: "secret",
        channelId: "chan-1",
        ttlMs: 3600_000,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid_url");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google: POSTs events.watch and returns channel id + resourceId + expiration", async () => {
    const exp = Date.now() + 3600_000;
    fetchMock.mockResolvedValueOnce(jsonRes(200, { id: "chan-1", resourceId: "res-1", expiration: String(exp) }));
    const res = await registerWatchChannel({
      provider: "google",
      tokens: TOKENS,
      notificationUrl: NOTIFY,
      verificationToken: "secret",
      channelId: "chan-1",
      ttlMs: 3600_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.watch.channelId).toBe("chan-1");
      expect(res.watch.resourceId).toBe("res-1");
      expect(res.watch.expiration).toBe(new Date(exp).toISOString());
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/watch");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ id: "chan-1", type: "web_hook", address: NOTIFY, token: "secret" });
  });

  it("Microsoft: POSTs a subscription and reads the assigned subscription id", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(201, { id: "sub-1", expirationDateTime: "2026-09-04T00:00:00Z" }));
    const res = await registerWatchChannel({
      provider: "microsoft",
      tokens: TOKENS,
      notificationUrl: "https://crewflow.uk/api/integrations/calendar/microsoft/webhook",
      verificationToken: "secret",
      channelId: "ignored",
      ttlMs: 3600_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.watch.channelId).toBe("sub-1"); // provider-assigned, not our minted id
      expect(res.watch.resourceId).toBeNull();
    }
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ resource: "me/events", clientState: "secret" });
    expect(body.changeType).toContain("updated");
  });

  it("on a 401 refreshes then retries once", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" }))
      .mockResolvedValueOnce(jsonRes(200, { access_token: "AT2", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonRes(200, { id: "chan-1", resourceId: "res-1" }));
    const res = await registerWatchChannel({
      provider: "google",
      tokens: TOKENS,
      notificationUrl: NOTIFY,
      verificationToken: "secret",
      channelId: "chan-1",
      ttlMs: 3600_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.refreshed?.accessToken).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("stopWatchChannel", () => {
  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await stopWatchChannel({ provider: "google", tokens: TOKENS, channelId: "chan-1", resourceId: "res-1" });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google: POSTs channels/stop with id + resourceId", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(204, null));
    const res = await stopWatchChannel({ provider: "google", tokens: TOKENS, channelId: "chan-1", resourceId: "res-1" });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/channels/stop");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: "chan-1", resourceId: "res-1" });
  });

  it("Microsoft: DELETEs the subscription", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(204, null));
    const res = await stopWatchChannel({ provider: "microsoft", tokens: TOKENS, channelId: "sub-1", resourceId: null });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions/sub-1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("TOLERATES a 404 (already gone) as success", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "gone" }));
    const res = await stopWatchChannel({ provider: "microsoft", tokens: TOKENS, channelId: "sub-1", resourceId: null });
    expect(res.ok).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  pullEvents,
  pullFreeBusy,
  normalizeGoogleEvent,
  normalizeMicrosoftEvent,
  hasCrewflowMarker,
  MAX_PULL_PAGES,
  type PulledEvent,
} from "@/lib/integrations/calendar/pull-adapter";

/**
 * Calendar event-PULL adapter — unit tests (hermetic; provider HTTP mocked).
 *
 * Proves: provider events normalise deterministically into the internal shape;
 * a multi-page result is followed to completion (F-1); a 401 refreshes + retries
 * once and threads the renewed token; free-busy maps busy intervals; the CrewFlow
 * marker is detected in a pulled event body; and every network function REFUSES
 * before any `fetch` while dark.
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

const WINDOW = { timeMin: "2026-08-01T00:00:00.000Z", timeMax: "2026-12-01T00:00:00.000Z" };
const TOKENS = { accessToken: "AT", refreshToken: "RT" };

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

// ── NORMALISATION (pure) ────────────────────────────────────────────────────

describe("normalizeGoogleEvent", () => {
  it("maps a timed event to absolute UTC instants + busy/status", () => {
    const ev = normalizeGoogleEvent({
      id: "g1",
      etag: "e1",
      iCalUID: "uid-1",
      summary: "Site visit",
      location: "Leeds",
      description: "notes",
      status: "confirmed",
      start: { dateTime: "2026-09-01T09:00:00+01:00" },
      end: { dateTime: "2026-09-01T10:00:00+01:00" },
      updated: "2026-08-15T00:00:00Z",
    });
    expect(ev).toMatchObject<Partial<PulledEvent>>({
      externalEventId: "g1",
      icalUid: "uid-1",
      summary: "Site visit",
      location: "Leeds",
      startsAt: "2026-09-01T08:00:00.000Z", // +01:00 normalised to UTC
      endsAt: "2026-09-01T09:00:00.000Z",
      isAllDay: false,
      isBusy: true,
      isCrewflowOrigin: false,
      status: "confirmed",
    });
  });

  it("treats an all-day (date-only) event and a 'transparent' event correctly", () => {
    const allDay = normalizeGoogleEvent({ id: "g2", start: { date: "2026-09-01" }, end: { date: "2026-09-02" } });
    expect(allDay!.isAllDay).toBe(true);
    expect(allDay!.startsAt).toBe("2026-09-01T00:00:00.000Z");
    const free = normalizeGoogleEvent({ id: "g3", transparency: "transparent", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } });
    expect(free!.isBusy).toBe(false);
    const cancelled = normalizeGoogleEvent({ id: "g4", status: "cancelled", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } });
    expect(cancelled!.isBusy).toBe(false);
  });

  it("flags a CrewFlow-origin event by the marker in its description", () => {
    const ev = normalizeGoogleEvent({
      id: "g5",
      description: "CrewFlow job 12345678-1234-1234-1234-123456789abc\nStatus: scheduled",
      start: { dateTime: "2026-09-01T09:00:00Z" },
      end: { dateTime: "2026-09-01T10:00:00Z" },
    });
    expect(ev!.isCrewflowOrigin).toBe(true);
  });

  it("returns null for an item with no id", () => {
    expect(normalizeGoogleEvent({ summary: "no id" })).toBeNull();
  });
});

describe("normalizeMicrosoftEvent", () => {
  it("maps a UTC wall-clock event + showAs to the internal shape", () => {
    const ev = normalizeMicrosoftEvent({
      id: "m1",
      "@odata.etag": 'W/"1"',
      iCalUId: "uid-m",
      subject: "Client call",
      location: { displayName: "Teams" },
      body: { content: "agenda" },
      showAs: "busy",
      isAllDay: false,
      isCancelled: false,
      start: { dateTime: "2026-09-01T08:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-09-01T09:00:00.0000000", timeZone: "UTC" },
      lastModifiedDateTime: "2026-08-15T00:00:00Z",
    });
    expect(ev).toMatchObject<Partial<PulledEvent>>({
      externalEventId: "m1",
      summary: "Client call",
      location: "Teams",
      startsAt: "2026-09-01T08:00:00.000Z",
      endsAt: "2026-09-01T09:00:00.000Z",
      isBusy: true,
      status: "confirmed",
      etag: 'W/"1"',
    });
  });

  it("marks a free showAs as not busy and a cancelled event as cancelled", () => {
    const free = normalizeMicrosoftEvent({ id: "m2", showAs: "free", start: { dateTime: "2026-09-01T08:00:00" }, end: { dateTime: "2026-09-01T09:00:00" } });
    expect(free!.isBusy).toBe(false);
    const cancelled = normalizeMicrosoftEvent({ id: "m3", isCancelled: true, start: { dateTime: "2026-09-01T08:00:00" }, end: { dateTime: "2026-09-01T09:00:00" } });
    expect(cancelled!.isBusy).toBe(false);
    expect(cancelled!.status).toBe("cancelled");
  });

  it("flags a CrewFlow-origin event by the marker in its body", () => {
    const ev = normalizeMicrosoftEvent({
      id: "m4",
      body: { content: "CrewFlow rota shift 12345678-1234-1234-1234-123456789abc" },
      start: { dateTime: "2026-09-01T08:00:00" },
      end: { dateTime: "2026-09-01T09:00:00" },
    });
    expect(ev!.isCrewflowOrigin).toBe(true);
  });
});

describe("hasCrewflowMarker", () => {
  it("matches the pushed-event marker and ignores unrelated text", () => {
    expect(hasCrewflowMarker("CrewFlow job 12345678-1234-1234-1234-123456789abc")).toBe(true);
    expect(hasCrewflowMarker("just a normal meeting")).toBe(false);
    expect(hasCrewflowMarker(null)).toBe(false);
  });
});

// ── PULL (network) ──────────────────────────────────────────────────────────

describe("pullEvents", () => {
  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google: follows nextPageToken to completion and returns the nextSyncToken (F-1)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          items: [{ id: "a", start: { dateTime: "2026-09-02T09:00:00Z" }, end: { dateTime: "2026-09-02T10:00:00Z" } }],
          nextPageToken: "PAGE2",
        }),
      )
      .mockResolvedValueOnce(
        jsonRes(200, {
          items: [{ id: "b", start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } }],
          nextSyncToken: "SYNC-NEXT",
        }),
      );
    const res = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.events.map((e) => e.externalEventId)).toEqual(["b", "a"]); // sorted by start
      expect(res.nextSyncToken).toBe("SYNC-NEXT");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second call carried the pageToken cursor.
    expect(String(fetchMock.mock.calls[1]![0])).toContain("pageToken=PAGE2");
  });

  it("Google: an incremental pull sends syncToken and omits the time window", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { items: [], nextSyncToken: "S2" }));
    await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW, syncToken: "S1" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("syncToken=S1");
    expect(url).not.toContain("timeMin");
  });

  it("Microsoft: follows @odata.nextLink to completion", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes(200, {
          value: [{ id: "x", start: { dateTime: "2026-09-01T08:00:00" }, end: { dateTime: "2026-09-01T09:00:00" } }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=abc",
        }),
      )
      .mockResolvedValueOnce(
        jsonRes(200, {
          value: [{ id: "y", start: { dateTime: "2026-09-02T08:00:00" }, end: { dateTime: "2026-09-02T09:00:00" } }],
        }),
      );
    const res = await pullEvents({ provider: "microsoft", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events.map((e) => e.externalEventId)).toEqual(["x", "y"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("$skiptoken=abc");
    // Microsoft requests UTC wall-clock times.
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Prefer: 'outlook.timezone="UTC"',
    });
  });

  it("on a 401 refreshes the token, retries ONCE, and threads the renewed token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // first list
      .mockResolvedValueOnce(jsonRes(200, { access_token: "AT2", expires_in: 3600 })) // refresh
      .mockResolvedValueOnce(jsonRes(200, { items: [], nextSyncToken: "S" })); // retried list
    const res = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.refreshed?.accessToken).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer AT2",
    });
  });

  it("a rate-limit 403 is TRANSIENT; an authz 403 is TERMINAL", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }));
    const t1 = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(t1.ok).toBe(false);
    if (!t1.ok) expect(t1.terminal).toBeFalsy();

    fetchMock.mockResolvedValueOnce(jsonRes(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }));
    const t2 = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(t2.ok).toBe(false);
    if (!t2.ok) expect(t2.terminal).toBe(true);
  });

  it("stops at MAX_PULL_PAGES even if the provider keeps returning a cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonRes(200, { items: [{ id: `e`, start: { dateTime: "2026-09-01T09:00:00Z" }, end: { dateTime: "2026-09-01T10:00:00Z" } }], nextPageToken: "LOOP" }),
    );
    const res = await pullEvents({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_PULL_PAGES);
  });
});

describe("pullFreeBusy", () => {
  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await pullFreeBusy({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google: maps busy intervals from the freeBusy response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        calendars: { primary: { busy: [{ start: "2026-09-01T09:00:00Z", end: "2026-09-01T10:00:00Z" }] } },
      }),
    );
    const res = await pullFreeBusy({ provider: "google", tokens: TOKENS, ...WINDOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.busy).toEqual([{ start: "2026-09-01T09:00:00.000Z", end: "2026-09-01T10:00:00.000Z" }]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/freeBusy");
  });

  it("Microsoft: maps busy scheduleItems and skips 'free' ones", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        value: [
          {
            scheduleItems: [
              { status: "busy", start: { dateTime: "2026-09-01T08:00:00.0000000" }, end: { dateTime: "2026-09-01T09:00:00.0000000" } },
              { status: "free", start: { dateTime: "2026-09-01T10:00:00.0000000" }, end: { dateTime: "2026-09-01T11:00:00.0000000" } },
            ],
          },
        ],
      }),
    );
    const res = await pullFreeBusy({ provider: "microsoft", tokens: TOKENS, ...WINDOW, account: "boss@acme.co" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.busy).toEqual([{ start: "2026-09-01T08:00:00.000Z", end: "2026-09-01T09:00:00.000Z" }]);
  });

  it("Microsoft: errors cleanly when no account handle is available (no getSchedule target)", async () => {
    const res = await pullFreeBusy({ provider: "microsoft", tokens: TOKENS, ...WINDOW, account: null });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

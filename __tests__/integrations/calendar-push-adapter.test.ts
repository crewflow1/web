import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildEventPayload,
  buildRotaEventPayload,
  pushEventToProvider,
  deleteEventFromProvider,
  type JobForEvent,
  type RotaForEvent,
} from "@/lib/integrations/calendar/push-adapter";

/**
 * Calendar event-push adapter — unit tests (hermetic; provider HTTP mocked).
 *
 * Proves: a job maps to an event correctly (title/times/location/description);
 * a first push INSERTs (POST), a re-push with a known event id UPDATEs (PATCH the
 * same event — no duplicate); a 401 triggers a refresh + single retry and returns
 * the renewed tokens; and the adapter REFUSES before any network call while dark.
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

const JOB: JobForEvent = {
  id: "job-1",
  status: "scheduled",
  scheduled_date: "2026-09-01",
  notes: "Fix the boiler\nBring parts",
  site_address_line1: "1 High St",
  site_address_line2: null,
  site_city: "Leeds",
  site_county: null,
  site_postcode: "LS1 1AA",
  site_country: "UK",
};

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

describe("buildEventPayload", () => {
  it("maps title, 08:00–17:00 times, location and description from a job", () => {
    const p = buildEventPayload(JOB);
    expect(p).not.toBeNull();
    expect(p!.summary).toBe("Fix the boiler");
    expect(p!.startDateTime).toBe("2026-09-01T08:00:00");
    expect(p!.endDateTime).toBe("2026-09-01T17:00:00");
    expect(p!.timeZone).toBe("Europe/London");
    expect(p!.location).toBe("1 High St, Leeds, LS1 1AA, UK");
    expect(p!.description).toContain("job-1");
    expect(p!.description).toContain("scheduled");
  });

  it("falls back to a generic title when there are no notes", () => {
    const p = buildEventPayload({ ...JOB, notes: null });
    expect(p!.summary).toBe("Scheduled job (scheduled)");
  });

  it("returns null for an unscheduled job (nothing to place on a calendar)", () => {
    expect(buildEventPayload({ ...JOB, scheduled_date: null })).toBeNull();
  });
});

describe("buildRotaEventPayload", () => {
  const ROTA: RotaForEvent = {
    id: "rota-1",
    starts_at: "2026-09-01T07:30:00+00:00",
    ends_at: "2026-09-01T15:45:00+00:00",
    notes: "Cover the yard",
    staffName: "Jane Doe",
  };

  it("spans the shift's OWN start/end (not a fixed 08:00–17:00) as UTC wall-clock", () => {
    const p = buildRotaEventPayload(ROTA);
    expect(p).not.toBeNull();
    expect(p!.startDateTime).toBe("2026-09-01T07:30:00");
    expect(p!.endDateTime).toBe("2026-09-01T15:45:00");
    expect(p!.timeZone).toBe("UTC");
    expect(p!.summary).toBe("Shift — Jane Doe");
    expect(p!.description).toContain("rota-1");
    expect(p!.description).toContain("Cover the yard");
    expect(p!.location).toBeNull();
  });

  it("falls back to a generic title when the staff name is unknown", () => {
    expect(buildRotaEventPayload({ ...ROTA, staffName: null })!.summary).toBe("Rota shift");
  });

  it("returns null when a bound is unparseable (nothing to place on a calendar)", () => {
    expect(buildRotaEventPayload({ ...ROTA, starts_at: "not-a-date" })).toBeNull();
  });
});

describe("pushEventToProvider", () => {
  it("INSERTs (POST) a new Google event and returns its id + etag", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { id: "evt-g1", etag: "etag-1" }));
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res).toMatchObject({ ok: true, externalEventId: "evt-g1", etag: "etag-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.summary).toBe("Fix the boiler");
    expect(body.start).toEqual({ dateTime: "2026-09-01T08:00:00", timeZone: "Europe/London" });
  });

  it("UPDATEs (PATCH) the SAME event when given an external event id (no duplicate)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { id: "evt-g1", etag: "etag-2" }));
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: "evt-g1",
    });
    expect(res).toMatchObject({ ok: true, externalEventId: "evt-g1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-g1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("serialises a Microsoft Graph event body (subject/body/location)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(201, { id: "evt-m1", "@odata.etag": 'W/"1"' }));
    const res = await pushEventToProvider({
      provider: "microsoft",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res).toMatchObject({ ok: true, externalEventId: "evt-m1", etag: 'W/"1"' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.subject).toBe("Fix the boiler");
    expect(body.body).toEqual({ contentType: "text", content: expect.stringContaining("job-1") });
    expect(body.location).toEqual({ displayName: "1 High St, Leeds, LS1 1AA, UK" });
  });

  it("on 401 refreshes the token, retries ONCE, and returns the renewed tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // first event call
      .mockResolvedValueOnce(jsonRes(200, { access_token: "AT2", expires_in: 3600 })) // refresh
      .mockResolvedValueOnce(jsonRes(200, { id: "evt-g1" })); // retried event call

    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.externalEventId).toBe("evt-g1");
      expect(res.refreshed?.accessToken).toBe("AT2");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The retry used the refreshed token.
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer AT2",
    });
  });

  it("REFUSES with NO network call while dark", async () => {
    disableProviders();
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deleteEventFromProvider", () => {
  it("issues a DELETE to the provider event and succeeds (Google)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(204, null));
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-g1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("issues a DELETE to the Microsoft Graph event and succeeds", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(204, null));
    const res = await deleteEventFromProvider({
      provider: "microsoft",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-m1",
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/events/evt-m1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("TOLERATES a 404 (already-gone) as success", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "not found" }));
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-gone",
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TOLERATES a 410 Gone (Google already-deleted) as success", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(410, { error: "gone" }));
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-gone",
    });
    expect(res.ok).toBe(true);
  });

  it("surfaces a non-404 error status", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(500, { error: "boom" }));
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("500");
  });

  it("on 401 refreshes the token, retries the DELETE ONCE, and returns renewed tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // first delete
      .mockResolvedValueOnce(jsonRes(200, { access_token: "AT2", expires_in: 3600 })) // refresh
      .mockResolvedValueOnce(jsonRes(204, null)); // retried delete
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.refreshed?.accessToken).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]![1] as RequestInit).headers).toMatchObject({
      authorization: "Bearer AT2",
    });
  });

  it("REFUSES with NO network call while dark (no-op)", async () => {
    disableProviders();
    const res = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildEventPayload,
  buildEventRecurrence,
  buildRotaEventPayload,
  pushEventToProvider,
  deleteEventFromProvider,
  type JobForEvent,
  type RotaForEvent,
} from "@/lib/integrations/calendar/push-adapter";
import { MAX_OCCURRENCES } from "@/lib/schedule/recurring";

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
  recurring: null,
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

// ── RECURRENCE (C73-B: a recurring parent must push provider-native recurrence,
// not a single anchor-only event) ──────────────────────────────────────────────
//
// A recurring job is ONE jobs row + one anchor; occurrences exist internally only
// via expandRecurring. The push path was recurrence-BLIND, so on activation a
// weekly parent pushed exactly one event and silently omitted every later
// occurrence. These pin the fix: buildEventPayload derives a provider-neutral
// recurrence for each supported pattern, and BOTH serialisers emit it (Google
// RRULE / Microsoft recurrence object) with the right bounded/open-ended cap.
//
// DELETE-THE-FIX PROOF: remove the recurrence branch in buildEventPayload (so the
// payload carries no `recurrence`) and every "emits recurrence" assertion below
// fails — the serialised body would carry no `recurrence`/RRULE at all. The
// non-recurring test still passes, proving the assertions are non-vacuous.
describe("buildEventPayload — recurrence (provider-native)", () => {
  // 2026-09-01 is a Tuesday (drives the Microsoft weekly daysOfWeek assertion).
  const recurringJob = (recurring: unknown): JobForEvent => ({ ...JOB, recurring });

  async function googleBody(job: JobForEvent): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { id: "evt-g", etag: "e" }));
    await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(job)!,
      externalEventId: null,
    });
    return JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body));
  }
  async function microsoftBody(job: JobForEvent): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValueOnce(jsonRes(201, { id: "evt-m", "@odata.etag": 'W/"1"' }));
    await pushEventToProvider({
      provider: "microsoft",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(job)!,
      externalEventId: null,
    });
    return JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body));
  }

  // pattern → the RRULE FREQ/INTERVAL the code derives from lib/schedule/recurring.ts.
  const cases = [
    { pattern: "weekly", freq: "WEEKLY", interval: 1 },
    { pattern: "biweekly", freq: "WEEKLY", interval: 2 },
    { pattern: "monthly", freq: "MONTHLY", interval: 1 },
    { pattern: "quarterly", freq: "MONTHLY", interval: 3 },
  ] as const;

  for (const { pattern, freq, interval } of cases) {
    it(`open-ended ${pattern} → Google RRULE FREQ=${freq};INTERVAL=${interval};COUNT=${MAX_OCCURRENCES}`, async () => {
      const body = await googleBody(recurringJob({ pattern }));
      expect(body.recurrence).toEqual([`RRULE:FREQ=${freq};INTERVAL=${interval};COUNT=${MAX_OCCURRENCES}`]);
    });

    it(`bounded ${pattern} (end_date) → Google RRULE …;UNTIL=<end>Z (no COUNT)`, async () => {
      const body = await googleBody(recurringJob({ pattern, end_date: "2027-03-31" }));
      expect(body.recurrence).toEqual([
        `RRULE:FREQ=${freq};INTERVAL=${interval};UNTIL=20270331T235959Z`,
      ]);
    });
  }

  it("weekly → Microsoft weekly recurrence anchored on the anchor's weekday, numbered when open-ended", async () => {
    const body = await microsoftBody(recurringJob({ pattern: "weekly" }));
    expect(body.recurrence).toEqual({
      pattern: { type: "weekly", interval: 1, daysOfWeek: ["tuesday"] },
      range: { type: "numbered", startDate: "2026-09-01", numberOfOccurrences: MAX_OCCURRENCES },
    });
  });

  it("biweekly → Microsoft weekly interval 2", async () => {
    const body = await microsoftBody(recurringJob({ pattern: "biweekly" }));
    expect((body.recurrence as { pattern: { interval: number } }).pattern.interval).toBe(2);
  });

  it("monthly (day ≤28) → Microsoft absoluteMonthly with the anchor day-of-month; bounded uses endDate range", async () => {
    const body = await microsoftBody(recurringJob({ pattern: "monthly", end_date: "2027-03-31" }));
    expect(body.recurrence).toEqual({
      pattern: { type: "absoluteMonthly", interval: 1, dayOfMonth: 1 },
      range: { type: "endDate", startDate: "2026-09-01", endDate: "2027-03-31" },
    });
  });

  it("quarterly → Microsoft absoluteMonthly interval 3", async () => {
    const body = await microsoftBody(recurringJob({ pattern: "quarterly" }));
    expect((body.recurrence as { pattern: { type: string; interval: number } }).pattern).toMatchObject({
      type: "absoluteMonthly",
      interval: 3,
    });
  });

  it("a NON-recurring job emits NO recurrence on either provider (unchanged behaviour)", async () => {
    expect((await googleBody(JOB)).recurrence).toBeUndefined();
    expect((await microsoftBody(JOB)).recurrence).toBeUndefined();
    // An invalid/foreign payload is treated as non-recurring, not an error.
    expect((await googleBody(recurringJob({ pattern: "nonsense" }))).recurrence).toBeUndefined();
    expect((await googleBody(recurringJob({ notAPattern: true }))).recurrence).toBeUndefined();
  });

  // Faithfulness guard: expandRecurring steps monthly/quarterly with JS-Date month
  // arithmetic that ROLLS overflow forward (Jan-31 → Mar-3 → Apr-3…), which no
  // single RRULE / MS rule reproduces. Rather than silently approximate, a
  // monthly/quarterly anchor on day 29–31 is flagged INEXPRESSIBLE so the caller
  // surfaces it (see the service test) instead of pushing a misleading event.
  for (const pattern of ["monthly", "quarterly"] as const) {
    for (const day of ["29", "30", "31"] as const) {
      it(`${pattern} anchored on the ${day}th is flagged inexpressible (not approximated)`, () => {
        const r = buildEventRecurrence({ pattern }, `2026-01-${day}`);
        expect(r).not.toBeNull();
        expect(r && "inexpressible" in r && r.inexpressible).toBe(true);
        // buildEventPayload surfaces it as recurrenceUnsupported and emits NO recurrence.
        const p = buildEventPayload({ ...JOB, recurring: { pattern }, scheduled_date: `2026-01-${day}` });
        expect(p!.recurrence).toBeUndefined();
        expect(p!.recurrenceUnsupported).toBeTruthy();
      });
    }
  }

  it("weekly/biweekly are ALWAYS expressible regardless of day-of-month (pure day arithmetic)", () => {
    for (const pattern of ["weekly", "biweekly"] as const) {
      const r = buildEventRecurrence({ pattern }, "2026-01-31");
      expect(r && "freq" in r && r.freq).toBe("WEEKLY");
    }
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

  // ── 403 classification (GAP 2 — the C48 regression) ─────────────────────────
  // Google Calendar events.insert/patch returns HTTP 403 for BOTH transient
  // rate-limit / quota errors AND genuine authz denials. A bare 403 must NOT be
  // treated as terminal, or one bulk-import throttle strands a live calendar
  // forever (a 403 never enters the 401-only refresh path, so the only self-heal —
  // a later successful push — is now unreachable).
  for (const reason of [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "dailyLimitExceeded",
    "quotaExceeded",
  ] as const) {
    it(`treats an event-API 403 '${reason}' as TRANSIENT (terminal:false → self-heal)`, async () => {
      fetchMock.mockResolvedValueOnce(
        jsonRes(403, {
          error: { code: 403, errors: [{ reason, domain: "usageLimits" }] },
        }),
      );
      const res = await pushEventToProvider({
        provider: "google",
        tokens: { accessToken: "AT", refreshToken: "RT" },
        payload: buildEventPayload(JOB)!,
        externalEventId: null,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.terminal).toBeFalsy();
      // A 403 never triggers a refresh — exactly one provider call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("treats an event-API 403 with canonical status RESOURCE_EXHAUSTED as TRANSIENT", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, { error: { code: 403, status: "RESOURCE_EXHAUSTED" } }),
    );
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBeFalsy();
  });

  it("treats a genuine authz 403 (insufficientPermissions) as TERMINAL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          errors: [{ reason: "insufficientPermissions", domain: "global" }],
        },
      }),
    );
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });

  it("treats a Microsoft Graph 403 (ErrorAccessDenied — no rate-limit reason) as TERMINAL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } }),
    );
    const res = await pushEventToProvider({
      provider: "microsoft",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
  });

  it("a 401 STILL rejected after the refresh+retry is TERMINAL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // first event call
      .mockResolvedValueOnce(jsonRes(200, { access_token: "AT2", expires_in: 3600 })) // refresh ok
      .mockResolvedValueOnce(jsonRes(401, { error: "still bad" })); // retried event call — still 401
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a 5xx blip stays TRANSIENT (terminal:false)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "unavailable" }));
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.terminal).toBeFalsy();
  });

  // ── STALE-MAPPING classification (the disconnect/reconnect 404-loop fix) ──────
  // A PATCH of an existing external event that 404/410s means the mapped provider
  // event is GONE (a disconnect/reconnect reused the connection id, or a user
  // manually deleted the CrewFlow event). Before the fix this was mis-scored as a
  // generic transient (classifyEventApiFailure treats 404/410 — neither 401 nor 403
  // — as terminal:false), so the caller kept PATCHing the DEAD id forever and the
  // job silently never landed. It must now surface a DISTINCT `stale` outcome.
  for (const status of [404, 410] as const) {
    it(`a PATCH that ${status}s is STALE (not a generic transient) so the caller re-INSERTs`, async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(status, { error: "gone" }));
      const res = await pushEventToProvider({
        provider: "google",
        tokens: { accessToken: "AT", refreshToken: "RT" },
        payload: buildEventPayload(JOB)!,
        externalEventId: "evt-dead",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.stale).toBe(true);
        // Stale is NOT terminal (the grant is fine — re-consent would be wrong).
        expect(res.terminal).toBeFalsy();
      }
      // A 404/410 never enters the 401-only refresh path — exactly one call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-dead");
      expect((init as RequestInit).method).toBe("PATCH");
    });
  }

  it("a 410 PATCH on Microsoft Graph is also STALE", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(410, { error: "gone" }));
    const res = await pushEventToProvider({
      provider: "microsoft",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: "evt-dead",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stale).toBe(true);
  });

  it("a POST (INSERT) that 404s is NOT stale — there is no mapping to reclaim", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "not found" }));
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.stale).toBeFalsy();
  });

  it("a PATCH 5xx blip is TRANSIENT, NOT stale (retries the SAME id, self-heals)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "unavailable" }));
    const res = await pushEventToProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      payload: buildEventPayload(JOB)!,
      externalEventId: "evt-live",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.stale).toBeFalsy();
      expect(res.terminal).toBeFalsy();
    }
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

  it("a rate-limit 403 on DELETE is TRANSIENT (terminal:false); an authz 403 is TERMINAL", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }),
    );
    const transient = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(transient.ok).toBe(false);
    if (!transient.ok) expect(transient.terminal).toBeFalsy();

    fetchMock.mockResolvedValueOnce(
      jsonRes(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }),
    );
    const terminal = await deleteEventFromProvider({
      provider: "google",
      tokens: { accessToken: "AT", refreshToken: "RT" },
      externalEventId: "evt-g1",
    });
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.terminal).toBe(true);
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

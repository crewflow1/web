import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * pushJobToCalendar / bestEffortPushJob — service composition tests (hermetic).
 *
 * Executes the REAL service, REAL token-store, REAL push-adapter and REAL token
 * crypto against a chainable Supabase mock (tenant + admin) and a mocked provider
 * HTTP layer. Proves:
 *   - a first push INSERTs an event and WRITES a calendar_event_links row;
 *   - a re-push finds that link and PATCHes the SAME event (no duplicate link);
 *   - a missing job → not_found; no connected provider → skipped_dark (no DB
 *     token read, no network);
 *   - bestEffortPushJob is a pure no-op while dark — no client, no network.
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
    job: Record<string, unknown> | null;
    rota: Record<string, unknown> | null;
    connections: ConnRow[];
    tokenRow: Record<string, unknown> | null;
    eventLinks: Map<string, { external_event_id: string }>;
    /** Every UPDATE row written to calendar_connections via the admin client (status writes, sync/error stamps). */
    connectionUpdates: Record<string, unknown>[];
  } = {
    job: null,
    rota: null,
    connections: [],
    tokenRow: null,
    eventLinks: new Map(),
    connectionUpdates: [],
  };

  type BuilderState = {
    table: string;
    op: string;
    row: Record<string, unknown> | null;
    eqs: Array<[string, unknown]>;
  };
  type Resolver = (st: BuilderState) => { data?: unknown; error: unknown };

  function makeBuilder(table: string, resolver: Resolver) {
    const st: BuilderState = { table, op: "select", row: null, eqs: [] };
    const settle = () => Promise.resolve(resolver(st));
    const b: Record<string, unknown> = {
      select() {
        st.op = "select";
        return b;
      },
      update(r: Record<string, unknown>) {
        st.op = "update";
        st.row = r;
        return b;
      },
      delete() {
        st.op = "delete";
        return b;
      },
      upsert(r: Record<string, unknown>) {
        st.op = "upsert";
        st.row = r;
        return settle();
      },
      eq(col: string, val: unknown) {
        st.eqs.push([col, val]);
        return b;
      },
      maybeSingle() {
        return settle();
      },
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        return settle().then(res, rej);
      },
    };
    return b;
  }
  const eqVal = (st: BuilderState, c: string) =>
    (st.eqs.find(([col]) => col === c) ?? [])[1];

  const serverResolver: Resolver = (st) => {
    if (st.table === "jobs" && st.op === "select") return { data: state.job, error: null };
    if (st.table === "rota_entries" && st.op === "select") return { data: state.rota, error: null };
    if (st.table === "calendar_connections" && st.op === "select") {
      // A provider-pinned select (disconnect's id read / getCalendarConnection)
      // resolves to a SINGLE row carrying the connection id; an org-only select
      // (listCalendarConnections) resolves to the array of provider rows.
      const prov = eqVal(st, "provider");
      if (prov !== undefined) {
        const row = state.connections.find((c) => c.provider === prov) ?? null;
        return { data: row ? { id: "conn-1", ...row } : null, error: null };
      }
      return { data: state.connections, error: null };
    }
    return { data: null, error: null };
  };
  const adminResolver: Resolver = (st) => {
    if (st.table === "calendar_connections" && st.op === "select")
      return { data: state.tokenRow, error: null };
    if (st.table === "calendar_connections" && st.op === "update") {
      if (st.row) state.connectionUpdates.push(st.row);
      return { data: null, error: null };
    }
    if (st.table === "calendar_event_links" && st.op === "select") {
      const key = `${eqVal(st, "connection_id")}|${eqVal(st, "local_kind")}|${eqVal(st, "local_id")}`;
      return { data: state.eventLinks.get(key) ?? null, error: null };
    }
    if (st.table === "calendar_event_links" && st.op === "upsert") {
      const r = st.row as Record<string, string>;
      state.eventLinks.set(`${r.connection_id}|${r.local_kind}|${r.local_id}`, {
        external_event_id: String(r.external_event_id),
      });
      return { error: null };
    }
    if (st.table === "calendar_event_links" && st.op === "delete") {
      const conn = String(eqVal(st, "connection_id"));
      const lk = eqVal(st, "local_kind");
      if (lk === undefined) {
        // Connection-wide reclaim (deleteEventLinksForConnection): drop EVERY link
        // for this connection, regardless of local kind/id.
        for (const key of [...state.eventLinks.keys()]) {
          if (key.startsWith(`${conn}|`)) state.eventLinks.delete(key);
        }
        return { error: null };
      }
      state.eventLinks.delete(`${conn}|${lk}|${eqVal(st, "local_id")}`);
      return { error: null };
    }
    return { data: null, error: null };
  };

  const createClientMock = vi.fn(async () => ({
    from: (t: string) => makeBuilder(t, serverResolver),
  }));
  const createAdminMock = vi.fn(() => ({
    from: (t: string) => makeBuilder(t, adminResolver),
  }));

  return { state, createClientMock, createAdminMock };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: h.createClientMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.createAdminMock }));
vi.mock("@/lib/supabase/read-failure", () => ({
  readFailure: (ctx: string, e: { message: string }) => new Error(`${ctx}: ${e.message}`),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { encryptToken } from "@/lib/integrations/token-crypto";
import {
  pushJobToCalendar,
  bestEffortPushJob,
  pushRotaToCalendar,
  bestEffortPushRota,
  bestEffortDeleteJobEvent,
  bestEffortDeleteRotaEvent,
  disconnectCalendarProvider,
} from "@/server/services/calendar-connections";

const CREDS = {
  FEATURE_CALENDAR_CONNECT: "1",
  GOOGLE_CALENDAR_CLIENT_ID: "gid",
  GOOGLE_CALENDAR_CLIENT_SECRET: "gsecret",
  MS_GRAPH_CLIENT_ID: "mid",
  MS_GRAPH_CLIENT_SECRET: "msecret",
  // A valid base64 32-byte AES-256 key so token encrypt/decrypt run for real.
  INTEGRATION_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as const;

function jsonRes(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const original = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

const JOB = {
  id: "job-1",
  org_id: "org-1",
  status: "scheduled",
  scheduled_date: "2026-09-01",
  notes: "Fix the boiler",
  assigned_to: null,
  site_address_line1: "1 High St",
  site_address_line2: null,
  site_city: "Leeds",
  site_county: null,
  site_postcode: "LS1 1AA",
  site_country: "UK",
};

const ROTA = {
  id: "rota-1",
  org_id: "org-1",
  starts_at: "2026-09-01T07:30:00+00:00",
  ends_at: "2026-09-01T15:45:00+00:00",
  notes: "Cover the yard",
  user: { full_name: "Jane Doe", email: "jane@acme.co" },
};

const CONNECTED_GOOGLE = {
  provider: "google",
  status: "connected",
  external_account_id: "boss@acme.co",
  connected_at: "2026-08-01T00:00:00Z",
  last_sync_at: null,
  last_error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(CREDS)) process.env[k] = v;
  h.state.job = { ...JOB };
  h.state.rota = { ...ROTA };
  h.state.connections = [CONNECTED_GOOGLE];
  h.state.tokenRow = {
    id: "conn-1",
    access_token: encryptToken("access-plain"),
    refresh_token: encryptToken("refresh-plain"),
    token_expires_at: null,
  };
  h.state.eventLinks = new Map();
  h.state.connectionUpdates = [];
  fetchMock = vi.fn().mockResolvedValue(jsonRes(200, { id: "evt-1", etag: "etag-1" }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...original };
});

describe("pushJobToCalendar — live path", () => {
  it("INSERTs an event and writes a calendar_event_links row on first push", async () => {
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", provider: "google", externalEventId: "evt-1" });
    expect(h.state.eventLinks.size).toBe(1);
    expect(h.state.eventLinks.get("conn-1|job|job-1")).toEqual({ external_event_id: "evt-1" });
    // First push is a POST (insert).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("re-push UPDATEs the SAME event (PATCH) and does not duplicate the link", async () => {
    await pushJobToCalendar("org-1", "job-1"); // seeds the link
    fetchMock.mockClear();
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", externalEventId: "evt-1" });
    // Still exactly one link — no duplicate.
    expect(h.state.eventLinks.size).toBe(1);
    // The second push PATCHes the known event id.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("returns not_found for a missing job", async () => {
    h.state.job = null;
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns skipped_dark with NO token read / NO network when nothing is connected", async () => {
    h.state.connections = [{ ...CONNECTED_GOOGLE, status: "disconnected", external_account_id: null }];
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "skipped_dark" });
    // No admin (token) client was ever created, and no provider call happened.
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // C73-B: a recurring parent must push provider-native recurrence, not a single
  // anchor event that silently omits every later occurrence. The service reads the
  // `recurring` column (JOB_PUSH_COLUMNS) and buildEventPayload attaches it.
  it("pushes a recurring job WITH provider recurrence in the serialised body", async () => {
    h.state.job = { ...JOB, recurring: { pattern: "weekly" } };
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    // Google RRULE, open-ended → COUNT-bounded (matches expandRecurring's cap).
    expect(body.recurrence).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=60"]);
  });

  it("SURFACES an inexpressible recurrence as a loud error (no misleading anchor-only push)", async () => {
    // monthly anchored on the 31st: expandRecurring's month rollover has no RRULE
    // equivalent, so we refuse rather than silently drop occurrences.
    h.state.job = { ...JOB, scheduled_date: "2026-01-31", recurring: { pattern: "monthly" } };
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    expect(res.message).toContain("recurrence is not pushable");
    // Nothing was pushed and no link was written — surfaced, not hidden.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.eventLinks.size).toBe(0);
  });

  it("a non-recurring job still emits NO recurrence (unchanged)", async () => {
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res.ok).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.recurrence).toBeUndefined();
  });
});

describe("JOB_PUSH_COLUMNS wiring (source) — the push read selects `recurring`", () => {
  const src = readFileSync(
    join(process.cwd(), "server/services/calendar-connections.ts"),
    "utf8",
  );
  it("the job push read selects the recurring column", () => {
    // Non-vacuous: without this column the row's `recurring` is undefined, so a
    // recurring parent would push as a single anchor event. The list must include it.
    const cols = src.match(/const JOB_PUSH_COLUMNS =\s*([^;]+);/)![1]!;
    expect(cols).toContain("recurring");
  });
});

describe("bestEffortPushJob — caller seam", () => {
  it("is a pure no-op while dark: no client, no network", async () => {
    delete process.env.FEATURE_CALENDAR_CONNECT;
    const res = await bestEffortPushJob("org-1", "job-1");
    expect(res).toEqual({ status: "skipped_dark" });
    expect(h.createClientMock).not.toHaveBeenCalled();
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates to the push once live and never throws", async () => {
    const res = await bestEffortPushJob("org-1", "job-1");
    expect(res).toEqual({ status: "pushed" });
  });
});

describe("pushRotaToCalendar — live path", () => {
  it("INSERTs an event with the shift's own start/end and writes a 'rota' event link", async () => {
    const res = await pushRotaToCalendar("org-1", "rota-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", provider: "google", externalEventId: "evt-1" });
    // The link is keyed by local_kind 'rota' (distinct from a 'job' link).
    expect(h.state.eventLinks.size).toBe(1);
    expect(h.state.eventLinks.get("conn-1|rota|rota-1")).toEqual({ external_event_id: "evt-1" });
    // First push is a POST carrying the shift's real bounds (not 08:00–17:00).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.summary).toBe("Shift — Jane Doe");
    expect(body.start).toEqual({ dateTime: "2026-09-01T07:30:00", timeZone: "UTC" });
    expect(body.end).toEqual({ dateTime: "2026-09-01T15:45:00", timeZone: "UTC" });
  });

  it("re-push UPDATEs the SAME event (PATCH) and does not duplicate the link", async () => {
    await pushRotaToCalendar("org-1", "rota-1");
    fetchMock.mockClear();
    const res = await pushRotaToCalendar("org-1", "rota-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", externalEventId: "evt-1" });
    expect(h.state.eventLinks.size).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1");
    expect((init as RequestInit).method).toBe("PATCH");
  });

  it("returns not_found for a missing rota entry", async () => {
    h.state.rota = null;
    const res = await pushRotaToCalendar("org-1", "rota-1");
    expect(res).toMatchObject({ ok: false, status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns skipped_dark with NO token read / NO network when nothing is connected", async () => {
    h.state.connections = [{ ...CONNECTED_GOOGLE, status: "disconnected", external_account_id: null }];
    const res = await pushRotaToCalendar("org-1", "rota-1");
    expect(res).toMatchObject({ ok: false, status: "skipped_dark" });
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bestEffortPushRota — caller seam", () => {
  it("is a pure no-op while dark: no client, no network", async () => {
    delete process.env.FEATURE_CALENDAR_CONNECT;
    const res = await bestEffortPushRota("org-1", "rota-1");
    expect(res).toEqual({ status: "skipped_dark" });
    expect(h.createClientMock).not.toHaveBeenCalled();
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates to the push once live and never throws", async () => {
    const res = await bestEffortPushRota("org-1", "rota-1");
    expect(res).toEqual({ status: "pushed" });
  });
});

describe("bestEffortDeleteJobEvent — removes the provider event + link row", () => {
  it("DELETEs the mapped provider event and drops the calendar_event_links row", async () => {
    await pushJobToCalendar("org-1", "job-1"); // seed the link
    expect(h.state.eventLinks.size).toBe(1);
    fetchMock.mockClear();

    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "deleted" });
    // The link row is gone (no orphan mapping left behind).
    expect(h.state.eventLinks.size).toBe(0);
    // A provider DELETE was issued to the mapped event.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("is a no_link no-op (no provider call) when the job was never pushed", async () => {
    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "no_link" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates a 404 from the provider and still removes the link", async () => {
    await pushJobToCalendar("org-1", "job-1");
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "not found" }));
    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "deleted" });
    expect(h.state.eventLinks.size).toBe(0);
  });

  it("is a pure no-op while dark: no client, no network", async () => {
    delete process.env.FEATURE_CALENDAR_CONNECT;
    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "skipped_dark" });
    expect(h.createClientMock).not.toHaveBeenCalled();
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skipped_dark with NO token read / NO network when nothing is connected", async () => {
    h.state.connections = [{ ...CONNECTED_GOOGLE, status: "disconnected", external_account_id: null }];
    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "skipped_dark" });
    expect(h.createAdminMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bestEffortDeleteRotaEvent — removes the provider event + 'rota' link", () => {
  it("DELETEs the mapped provider event and drops the 'rota' link row", async () => {
    await pushRotaToCalendar("org-1", "rota-1");
    expect(h.state.eventLinks.get("conn-1|rota|rota-1")).toBeTruthy();
    fetchMock.mockClear();

    const res = await bestEffortDeleteRotaEvent("org-1", "rota-1");
    expect(res).toEqual({ status: "deleted" });
    expect(h.state.eventLinks.size).toBe(0);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("is a pure no-op while dark: no client, no network", async () => {
    delete process.env.FEATURE_CALENDAR_CONNECT;
    const res = await bestEffortDeleteRotaEvent("org-1", "rota-1");
    expect(res).toEqual({ status: "skipped_dark" });
    expect(h.createClientMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("terminal vs transient refresh failure — status='error' persistence + self-heal", () => {
  // Helper: assert whether a status='error' connection UPDATE was written.
  const errorWrites = () =>
    h.state.connectionUpdates.filter((u) => u.status === "error");
  const connectedWrites = () =>
    h.state.connectionUpdates.filter((u) => u.status === "connected");

  it("TERMINAL refresh failure during a push persists status='error' + last_error", async () => {
    // First push → 401 (access token rejected); the refresh then returns 400
    // invalid_grant ⇒ the grant is DEAD (terminal), no retry can recover it.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "invalid" })) // event push
      .mockResolvedValueOnce(jsonRes(400, { error: "invalid_grant" })); // refresh — terminal

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });

    // The launch-blocking fix: the row is flipped to 'error' so the panel shows
    // "reconnect required" and pushes stop silently failing forever.
    const errs = errorWrites();
    expect(errs.length).toBe(1);
    expect(typeof errs[0]!.last_error).toBe("string");
    expect(String(errs[0]!.last_error).length).toBeGreaterThan(0);
    // No spurious success/self-heal write happened.
    expect(connectedWrites().length).toBe(0);
  });

  it("TERMINAL failure (401 with NO refresh token) also persists status='error'", async () => {
    // No refresh token stored ⇒ a 401 can never be refreshed ⇒ terminal.
    h.state.tokenRow = { ...(h.state.tokenRow as object), refresh_token: null };
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonRes(401, { error: "invalid" }));

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    expect(errorWrites().length).toBe(1);
    // Exactly one provider call — no refresh was attempted (no refresh token).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TRANSIENT failure (5xx) keeps status='connected' — never writes 'error'", async () => {
    // A 500 is a provider blip, not a dead grant; no refresh is triggered and the
    // connection must stay live so the next job save self-heals.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonRes(500, { error: "boom" }));

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" }); // push result is an error…
    expect(errorWrites().length).toBe(0); // …but the CONNECTION is NOT marked error.
  });

  it("TRANSIENT failure (network throw) keeps status='connected'", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    expect(errorWrites().length).toBe(0);
  });

  it("TRANSIENT refresh failure (refresh 5xx) keeps status='connected'", async () => {
    // 401 on the push, but the refresh itself 503s — a blip, not invalid_grant.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "expired" })) // event push
      .mockResolvedValueOnce(jsonRes(503, { error: "unavailable" })); // refresh — transient

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    expect(errorWrites().length).toBe(0);
  });

  it("a SUCCESSFUL push restores/re-asserts status='connected' and clears last_error (self-heal)", async () => {
    // A healthy push (default mock returns 200) must stamp status='connected'
    // with last_error null, so a connection recovering from a prior error heals.
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed" });
    const heal = connectedWrites();
    expect(heal.length).toBe(1);
    expect(heal[0]!.last_error).toBeNull();
    expect(errorWrites().length).toBe(0);
  });

  it("TERMINAL failure during a DELETE persists status='error'", async () => {
    // Seed a link with a successful push, then reset and drive a terminal delete.
    await pushJobToCalendar("org-1", "job-1");
    h.state.connectionUpdates = [];
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonRes(401, { error: "invalid" })) // delete
      .mockResolvedValueOnce(jsonRes(403, { error: "forbidden" })); // refresh — terminal

    const res = await bestEffortDeleteJobEvent("org-1", "job-1");
    expect(res).toEqual({ status: "error" });
    expect(errorWrites().length).toBe(1);
  });

  it("an events-API 403 rate-limit (rateLimitExceeded) KEEPS status='connected' — the C48 regression fix", async () => {
    // A bulk import / multi-shift rota save can trip Google's per-user rate limit,
    // which surfaces as a 403 on events.insert/patch. Before the fix this bare 403
    // was terminal ⇒ the calendar was stranded forever on ONE throttle. It must now
    // stay 'connected' so the next event self-heals.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, {
        error: { code: 403, errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }] },
      }),
    );
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" }); // push failed…
    expect(errorWrites().length).toBe(0); // …but the CONNECTION is NOT marked error.
    // A 403 never triggers a refresh — exactly one provider call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a genuine authz 403 (insufficientPermissions) still persists status='error'", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          errors: [{ reason: "insufficientPermissions" }],
        },
      }),
    );
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    expect(errorWrites().length).toBe(1);
  });

  it("a status='error' connection is not 'connected', so a later push is a skipped_dark no-op until re-consent", async () => {
    // Once the row is 'error', the connected-provider lookup finds nothing, so the
    // push neither contacts the provider nor re-writes status — it stays 'error'
    // until the callback re-consent path restores 'connected'.
    h.state.connections = [{ ...CONNECTED_GOOGLE, status: "error" }];
    fetchMock.mockReset();
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "skipped_dark" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorWrites().length).toBe(0);
    expect(connectedWrites().length).toBe(0);
  });
});

describe("stale event link — PATCH 404/410 drops the mapping + re-INSERTs (disconnect/reconnect fix)", () => {
  const errorWrites = () => h.state.connectionUpdates.filter((u) => u.status === "error");
  const connectedWrites = () => h.state.connectionUpdates.filter((u) => u.status === "connected");

  it("a PATCH 404 drops the stale link, re-INSERTs, and upserts the NEW mapping (job)", async () => {
    await pushJobToCalendar("org-1", "job-1"); // seed the link → evt-1
    expect(h.state.eventLinks.get("conn-1|job|job-1")).toEqual({ external_event_id: "evt-1" });
    h.state.connectionUpdates = [];
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonRes(404, { error: "gone" })) // PATCH the dead evt-1
      .mockResolvedValueOnce(jsonRes(200, { id: "evt-2", etag: "etag-2" })); // re-INSERT

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", externalEventId: "evt-2" });
    // The mapping now points at the NEW event — no duplicate, no dead id retained.
    expect(h.state.eventLinks.size).toBe(1);
    expect(h.state.eventLinks.get("conn-1|job|job-1")).toEqual({ external_event_id: "evt-2" });
    // Call 0 PATCHed the dead id; call 1 POSTed a fresh event.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("PATCH");
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("POST");
    // A stale link is NOT a connection error — the connection stays healthy.
    expect(errorWrites().length).toBe(0);
    expect(connectedWrites().length).toBe(1);
  });

  it("a PATCH 410 drops the stale link and re-INSERTs for a rota shift too", async () => {
    await pushRotaToCalendar("org-1", "rota-1"); // seed → evt-1
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonRes(410, { error: "gone" })) // PATCH the dead evt-1
      .mockResolvedValueOnce(jsonRes(200, { id: "evt-2r" })); // re-INSERT
    const res = await pushRotaToCalendar("org-1", "rota-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", externalEventId: "evt-2r" });
    expect(h.state.eventLinks.get("conn-1|rota|rota-1")).toEqual({ external_event_id: "evt-2r" });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe("POST");
  });

  it("a PATCH 5xx TRANSIENT does NOT drop the link (the SAME id self-heals next save)", async () => {
    await pushJobToCalendar("org-1", "job-1"); // seed → evt-1
    h.state.connectionUpdates = [];
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "unavailable" }));
    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: false, status: "error" });
    // The link is UNTOUCHED — no drop, no re-INSERT (exactly one provider call).
    expect(h.state.eventLinks.get("conn-1|job|job-1")).toEqual({ external_event_id: "evt-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The connection stays 'connected' (never marked error) so it self-heals.
    expect(errorWrites().length).toBe(0);
  });

  it("disconnectCalendarProvider deletes ALL event links for the connection", async () => {
    // Seed two links (a job + a rota) on the same connection.
    await pushJobToCalendar("org-1", "job-1");
    await pushRotaToCalendar("org-1", "rota-1");
    expect(h.state.eventLinks.size).toBe(2);

    const res = await disconnectCalendarProvider("org-1", "google");
    expect(res).toEqual({ ok: true });
    // Every mapping for this connection is reclaimed — none survives to go stale.
    expect(h.state.eventLinks.size).toBe(0);
  });

  it("after a disconnect the first save INSERTs — no dead id reused (reconnect to a different account)", async () => {
    await pushJobToCalendar("org-1", "job-1"); // account A → link evt-1
    await disconnectCalendarProvider("org-1", "google"); // reclaims the link
    expect(h.state.eventLinks.size).toBe(0);

    // Reconnect reuses the SAME connection row id (conn-1) and the row is connected
    // again. Because the stale link was reclaimed, the first save is a fresh INSERT
    // (POST) — never a PATCH of account A's dead event id.
    h.state.connectionUpdates = [];
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonRes(200, { id: "evt-new", etag: "etag-new" }));

    const res = await pushJobToCalendar("org-1", "job-1");
    expect(res).toMatchObject({ ok: true, status: "pushed", externalEventId: "evt-new" });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(h.state.eventLinks.get("conn-1|job|job-1")).toEqual({ external_event_id: "evt-new" });
  });
});

describe("re-consent + panel wiring (source) — the error state clears and is rendered", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the OAuth callback upsert restores status='connected' AND clears last_error (re-consent heals a terminal error)", () => {
    const src = read("app/api/integrations/calendar/[provider]/callback/route.ts");
    // A single upsert that both sets connected and nulls last_error.
    expect(src).toMatch(
      /upsert\([\s\S]*?status:\s*"connected"[\s\S]*?last_error:\s*null[\s\S]*?\}/,
    );
  });

  it("the connections panel renders a live 'reconnect required' branch for status==='error'", () => {
    const src = read("app/(app)/settings/integrations/CalendarConnectionsPanel.tsx");
    expect(src).toMatch(/conn\.status === "error"/);
    expect(src).toMatch(/reconnect required/i);
  });
});

describe("delete/clear wiring (source) — the composer is invoked at the call sites", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("updateJob deletes the external event when scheduled_date is cleared", () => {
    const src = read("app/(app)/jobs/actions.ts");
    // The clear branch (else of the scheduled_date guard) calls the delete composer.
    expect(src).toMatch(
      /if \(result\.data\.scheduled_date\)[\s\S]*?bestEffortPushJob[\s\S]*?\} else \{[\s\S]*?bestEffortDeleteJobEvent\(ctx\.org\.id, id\)/,
    );
  });

  it("deleteJob deletes the external event before the row is removed", () => {
    const src = read("app/(app)/jobs/actions.ts");
    expect(src).toMatch(
      /bestEffortDeleteJobEvent\(ctx\.org\.id, id\)[\s\S]*?\.from\("jobs"\)[\s\S]*?\.delete\(/,
    );
  });

  it("deleteRotaEntry deletes the external event before the row is removed", () => {
    const src = read("app/(app)/staff/actions.ts");
    expect(src).toMatch(
      /bestEffortDeleteRotaEvent\(ctx\.org\.id, entryId\)[\s\S]*?\.from\("rota_entries"\)[\s\S]*?\.delete\(/,
    );
  });

  // ── The calendar drag-drop reschedule endpoint (GAP 2) ────────────────────
  // app/(app)/jobs/calendar/_calendar.tsx PUTs to this endpoint on every grid
  // drag. Before the fix it did a bare jobs.update() and called NEITHER composer,
  // so once calendar OAuth activates a grid-drag reschedule would strand the
  // external event on the old day. It must now mirror updateJob.
  it("the reschedule endpoint imports both calendar composers", () => {
    const src = read("app/api/schedule/[id]/route.ts");
    expect(src).toMatch(
      /import \{[\s\S]*?bestEffortPushJob[\s\S]*?bestEffortDeleteJobEvent[\s\S]*?\} from "@\/server\/services\/calendar-connections"/,
    );
  });

  it("the reschedule endpoint PUSHes on a non-null scheduled_date and DELETEs when cleared", () => {
    const src = read("app/api/schedule/[id]/route.ts");
    // Only when the patch actually carries a scheduled_date (a reassign-only
    // patch touches no date), branch: null → delete the event, else → push.
    expect(src).toMatch(
      /scheduled_date !== undefined[\s\S]*?scheduled_date === null[\s\S]*?bestEffortDeleteJobEvent\(ctx\.org\.id, id\)[\s\S]*?\} else \{[\s\S]*?bestEffortPushJob\(ctx\.org\.id, id\)/,
    );
  });

  it("the reschedule endpoint syncs the calendar only AFTER a successful update (count>0)", () => {
    const src = read("app/api/schedule/[id]/route.ts");
    // The calendar calls must sit after the count===0 (403) guard, so a denied
    // or failed update never touches the external calendar.
    expect(src).toMatch(
      /if \(count === 0\)[\s\S]*?403[\s\S]*?\}[\s\S]*?bestEffortPushJob\(ctx\.org\.id, id\)/,
    );
  });
});

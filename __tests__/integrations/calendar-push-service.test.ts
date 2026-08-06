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
  } = { job: null, rota: null, connections: [], tokenRow: null, eventLinks: new Map() };

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
    if (st.table === "calendar_connections" && st.op === "select")
      return { data: state.connections, error: null };
    return { data: null, error: null };
  };
  const adminResolver: Resolver = (st) => {
    if (st.table === "calendar_connections" && st.op === "select")
      return { data: state.tokenRow, error: null };
    if (st.table === "calendar_connections" && st.op === "update")
      return { data: null, error: null };
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
      const key = `${eqVal(st, "connection_id")}|${eqVal(st, "local_kind")}|${eqVal(st, "local_id")}`;
      state.eventLinks.delete(key);
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

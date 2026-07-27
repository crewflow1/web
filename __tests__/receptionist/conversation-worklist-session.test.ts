import { describe, it, expect } from "vitest";
import {
  initWorklistSession,
  beginWorklistLoad,
  applyWorklistPage,
  applyWorklistError,
  selectWorklistView,
  applyWorklistFilter,
  clearWorklistFilter,
  setWorklistPageSize,
  toFirstWorklistPage,
  toNextWorklistPage,
  toPreviousWorklistPage,
  hasNextWorklistPage,
  hasPreviousWorklistPage,
  type WorklistSessionState,
  type WorklistPage,
  type WorklistView,
} from "@/lib/receptionist/conversation-worklist-session";
import {
  createWorklistSession,
  WorklistSession,
} from "@/server/services/receptionist-worklist-session";

// =====================================================================
// R42 — CONVERSATION WORKLIST SESSION: unit behaviour.
//
// Two subjects: the PURE CORE (the immutable state model + transitions) and the RUNTIME (the stateful
// WorklistSession, driven with an injected transport so the one HTTP boundary — inside the R41 client the
// session reads through — is exercised without a network). The session inspects only a page's METADATA
// (view / total / limit / offset / has_more), so pages carry no items here.
// =====================================================================

const BASE = "http://session.test";
const WORKLIST_PATH = "/api/receptionist/worklists";

/** A worklist page with sensible defaults — override only the metadata a test cares about. */
function pageOf(view: WorklistView, overrides: Partial<WorklistPage> = {}): WorklistPage {
  return { view, items: [], total: 0, limit: 10, offset: 0, has_more: false, ...overrides };
}

/** The API's success envelope for a page — `{ ok: true }` + the page (what the R41 client parses). */
function successBody(page: WorklistPage): Record<string, unknown> {
  return { ok: true, ...page };
}

/** The API's failure envelope. */
function failureBody(error: string): Record<string, unknown> {
  return { ok: false, error };
}

/** A minimal Response whose `.json()` yields `body` and whose `.status` is `status`. */
function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

type CannedResponse = { status: number; body: unknown };

const okResponse = (view: WorklistView, overrides: Partial<WorklistPage> = {}): CannedResponse => ({
  status: 200,
  body: successBody(pageOf(view, overrides)),
});

/** A transport that returns canned responses in order (clamping to the last), recording url + init. */
function recordingTransport(responses: CannedResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return fakeResponse(r.status, r.body);
  }) as unknown as typeof fetch;
  return { transport, calls };
}

/** A transport whose calls are settled MANUALLY, so overlapping loads can be interleaved deterministically. */
function manualTransport() {
  const settlers: Array<(r: Response) => void> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Promise<Response>((resolve) => settlers.push(resolve));
  }) as unknown as typeof fetch;
  return {
    transport,
    calls,
    settle(index: number, status: number, body: unknown) {
      settlers[index]!(fakeResponse(status, body));
    },
  };
}

// ---------------------------------------------------------------------
// PURE CORE — initialisation.
// ---------------------------------------------------------------------

describe("worklist session core — initialisation", () => {
  it("starts idle over the given request, with no page and revision 0", () => {
    const state = initWorklistSession({ view: "recovery" });
    expect(state.status).toBe("idle");
    expect(state.page).toBeNull();
    expect(state.error).toBeNull();
    expect(state.revision).toBe(0);
    expect(state.request).toEqual({ view: "recovery" });
  });

  it("defaults to the empty request (the API's default view + page)", () => {
    expect(initWorklistSession().request).toEqual({});
  });
});

// ---------------------------------------------------------------------
// PURE CORE — load lifecycle + the revision freshness rule.
// ---------------------------------------------------------------------

describe("worklist session core — load lifecycle", () => {
  it("beginWorklistLoad marks loading, clears error and advances the revision", () => {
    const errored: WorklistSessionState = {
      request: {},
      status: "error",
      page: pageOf("prioritised"),
      error: "boom",
      revision: 4,
    };
    const loading = beginWorklistLoad(errored);
    expect(loading.status).toBe("loading");
    expect(loading.error).toBeNull();
    expect(loading.revision).toBe(5);
    // the last page is retained while a refresh is in flight
    expect(loading.page).toEqual(pageOf("prioritised"));
  });

  it("applyWorklistPage folds the page when the revision matches", () => {
    const loading = beginWorklistLoad(initWorklistSession()); // revision 1
    const page = pageOf("prioritised", { total: 3 });
    const ready = applyWorklistPage(loading, page, 1);
    expect(ready.status).toBe("ready");
    expect(ready.page).toBe(page);
    expect(ready.error).toBeNull();
  });

  it("applyWorklistPage DISCARDS a stale page (revision has since advanced)", () => {
    const loading = beginWorklistLoad(initWorklistSession()); // revision 1
    const superseded = beginWorklistLoad(loading); // revision 2 — a newer load began
    const stale = applyWorklistPage(superseded, pageOf("recovery", { total: 99 }), 1);
    expect(stale).toBe(superseded); // unchanged: the older result is dropped
    expect(stale.status).toBe("loading");
    expect(stale.page).toBeNull();
  });

  it("applyWorklistError records the message and retains the last good page", () => {
    const ready = applyWorklistPage(beginWorklistLoad(initWorklistSession()), pageOf("prioritised"), 1);
    const refreshing = beginWorklistLoad(ready); // revision 2
    const errored = applyWorklistError(refreshing, "the worklist API request failed (status 500)", 2);
    expect(errored.status).toBe("error");
    expect(errored.error).toContain("500");
    expect(errored.page).toEqual(pageOf("prioritised")); // retained
  });

  it("applyWorklistError DISCARDS a stale failure", () => {
    const loading = beginWorklistLoad(initWorklistSession()); // revision 1
    const superseded = beginWorklistLoad(loading); // revision 2
    const stale = applyWorklistError(superseded, "old failure", 1);
    expect(stale).toBe(superseded);
    expect(stale.status).toBe("loading");
  });
});

// ---------------------------------------------------------------------
// PURE CORE — request shaping (view / filter / page size).
// ---------------------------------------------------------------------

describe("worklist session core — request shaping", () => {
  it("selectWorklistView sets the view and resets to the first page", () => {
    const state: WorklistSessionState = {
      request: { view: "prioritised", page: { limit: 5, offset: 15 } },
      status: "ready",
      page: pageOf("prioritised", { limit: 5, offset: 15 }),
      error: null,
      revision: 3,
    };
    const next = selectWorklistView(state, "escalation");
    expect(next.request.view).toBe("escalation");
    expect(next.request.page).toEqual({ limit: 5, offset: 0 }); // page size kept, offset reset
    expect(next.status).toBe("ready"); // shaping does not itself load
  });

  it("applyWorklistFilter merges the filter and resets the offset", () => {
    const state = {
      ...initWorklistSession({ filter: { priorities: ["critical"] }, page: { limit: 10, offset: 20 } }),
    };
    const next = applyWorklistFilter(state, { requires_human: true });
    expect(next.request.filter).toEqual({ priorities: ["critical"], requires_human: true });
    expect(next.request.page).toEqual({ limit: 10, offset: 0 });
  });

  it("clearWorklistFilter drops the filter, keeping the view and page size, resetting the offset", () => {
    const state = initWorklistSession({
      view: "human_review",
      filter: { priorities: ["critical"], conversation_id: "c-1" },
      page: { limit: 8, offset: 24 },
    });
    const next = clearWorklistFilter(state);
    expect(next.request.filter).toBeUndefined();
    expect(next.request.view).toBe("human_review");
    expect(next.request.page).toEqual({ limit: 8, offset: 0 });
  });

  it("setWorklistPageSize sets the size and jumps to the first page", () => {
    const state = initWorklistSession({ view: "recovery" });
    const next = setWorklistPageSize(state, 25);
    expect(next.request.page).toEqual({ limit: 25, offset: 0 });
    expect(next.request.view).toBe("recovery");
  });
});

// ---------------------------------------------------------------------
// PURE CORE — page navigation.
// ---------------------------------------------------------------------

describe("worklist session core — page navigation", () => {
  it("toNextWorklistPage advances the offset by the page size when more remain", () => {
    const state = applyWorklistPage(
      beginWorklistLoad(initWorklistSession({ view: "prioritised", page: { limit: 10, offset: 0 } })),
      pageOf("prioritised", { limit: 10, offset: 0, total: 25, has_more: true }),
      1,
    );
    const next = toNextWorklistPage(state);
    expect(next).not.toBeNull();
    expect(next!.request.page).toEqual({ limit: 10, offset: 10 });
  });

  it("toNextWorklistPage returns null when the last page reported no more entries", () => {
    const state = applyWorklistPage(
      beginWorklistLoad(initWorklistSession({ page: { limit: 10 } })),
      pageOf("prioritised", { limit: 10, has_more: false }),
      1,
    );
    expect(toNextWorklistPage(state)).toBeNull();
  });

  it("toNextWorklistPage returns null when nothing has been read yet", () => {
    expect(toNextWorklistPage(initWorklistSession({ page: { limit: 10 } }))).toBeNull();
  });

  it("toPreviousWorklistPage steps the offset back by the page size", () => {
    const state = initWorklistSession({ view: "prioritised", page: { limit: 10, offset: 30 } });
    const prev = toPreviousWorklistPage(state);
    expect(prev!.request.page).toEqual({ limit: 10, offset: 20 });
  });

  it("toPreviousWorklistPage clamps at offset 0 and returns null at the first page", () => {
    const atStart = initWorklistSession({ page: { limit: 10, offset: 0 } });
    expect(toPreviousWorklistPage(atStart)).toBeNull();
    const nearStart = initWorklistSession({ page: { limit: 10, offset: 4 } });
    expect(toPreviousWorklistPage(nearStart)!.request.page).toEqual({ limit: 10, offset: 0 });
  });

  it("toFirstWorklistPage resets the offset to 0", () => {
    const state = initWorklistSession({ view: "recovery", page: { limit: 10, offset: 50 } });
    expect(toFirstWorklistPage(state).request.page).toEqual({ limit: 10, offset: 0 });
  });
});

// ---------------------------------------------------------------------
// PURE CORE — selectors + immutability.
// ---------------------------------------------------------------------

describe("worklist session core — selectors", () => {
  it("hasNextWorklistPage reflects the last page's has_more", () => {
    expect(hasNextWorklistPage(initWorklistSession())).toBe(false);
    const withMore = applyWorklistPage(
      beginWorklistLoad(initWorklistSession()),
      pageOf("prioritised", { has_more: true }),
      1,
    );
    expect(hasNextWorklistPage(withMore)).toBe(true);
  });

  it("hasPreviousWorklistPage reflects the current offset", () => {
    expect(hasPreviousWorklistPage(initWorklistSession({ page: { limit: 10, offset: 0 } }))).toBe(false);
    expect(hasPreviousWorklistPage(initWorklistSession({ page: { limit: 10, offset: 10 } }))).toBe(true);
  });
});

describe("worklist session core — immutability", () => {
  it("no transition mutates the input state", () => {
    const original = initWorklistSession({ view: "prioritised", page: { limit: 10, offset: 10 } });
    const snapshot = JSON.parse(JSON.stringify(original));
    beginWorklistLoad(original);
    selectWorklistView(original, "recovery");
    applyWorklistFilter(original, { requires_human: true });
    clearWorklistFilter(original);
    setWorklistPageSize(original, 5);
    toFirstWorklistPage(original);
    toPreviousWorklistPage(original);
    expect(original).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------
// RUNTIME — reads flow through the R41 client to the worklist endpoint.
// ---------------------------------------------------------------------

describe("WorklistSession runtime — reads through the client", () => {
  it("is idle before the first read", () => {
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: recordingTransport([]).transport });
    expect(session.getState().status).toBe("idle");
    expect(session).toBeInstanceOf(WorklistSession);
  });

  it("refresh reads the current request through the client and becomes ready", async () => {
    const t = recordingTransport([okResponse("prioritised", { total: 3 })]);
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: t.transport, request: { view: "prioritised" } });
    const state = await session.refresh();
    expect(state.status).toBe("ready");
    expect(state.page?.view).toBe("prioritised");
    expect(state.page?.total).toBe(3);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toContain(`${BASE}${WORKLIST_PATH}`);
    expect(t.calls[0]!.url).toContain("view=prioritised");
  });

  it("setView selects a different view and reads it", async () => {
    const t = recordingTransport([okResponse("prioritised"), okResponse("recovery")]);
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: t.transport });
    await session.refresh();
    await session.setView("recovery");
    expect(session.getState().request.view).toBe("recovery");
    expect(t.calls[1]!.url).toContain("view=recovery");
  });

  it("setFilter narrows the read the client sends", async () => {
    const t = recordingTransport([okResponse("prioritised"), okResponse("prioritised")]);
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: t.transport, request: { view: "prioritised" } });
    await session.refresh();
    await session.setFilter({ priorities: ["critical"], requires_human: true });
    const url = t.calls[1]!.url;
    expect(url).toContain("priority=critical");
    expect(url).toContain("requires_human=true");
  });

  it("clearFilter drops the narrowing on the next read", async () => {
    const t = recordingTransport([okResponse("prioritised"), okResponse("prioritised")]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { view: "prioritised", filter: { priorities: ["critical"] } },
    });
    await session.refresh();
    expect(t.calls[0]!.url).toContain("priority=critical");
    await session.clearFilter();
    expect(t.calls[1]!.url).not.toContain("priority=");
  });

  it("nextPage advances the offset and reads the next window", async () => {
    const t = recordingTransport([
      okResponse("prioritised", { total: 25, limit: 10, offset: 0, has_more: true }),
      okResponse("prioritised", { total: 25, limit: 10, offset: 10, has_more: true }),
    ]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { view: "prioritised", page: { limit: 10 } },
    });
    await session.refresh();
    await session.nextPage();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.url).toContain("offset=10");
    expect(t.calls[1]!.url).toContain("limit=10");
    expect(session.getState().page?.offset).toBe(10);
  });

  it("nextPage at the end is a no-op — it issues no read", async () => {
    const t = recordingTransport([okResponse("prioritised", { limit: 10, has_more: false })]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { page: { limit: 10 } },
    });
    await session.refresh();
    const before = session.getState();
    const after = await session.nextPage();
    expect(t.calls).toHaveLength(1); // no second read
    expect(after).toBe(before); // state object unchanged
  });

  it("previousPage at the first page is a no-op — it issues no read", async () => {
    const t = recordingTransport([okResponse("prioritised", { limit: 10, offset: 0 })]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { page: { limit: 10, offset: 0 } },
    });
    await session.refresh();
    await session.previousPage();
    expect(t.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// RUNTIME — refresh state + the staleness guarantee.
// ---------------------------------------------------------------------

describe("WorklistSession runtime — refresh state", () => {
  it("goes loading → ready across a read", async () => {
    const m = manualTransport();
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: m.transport, request: { view: "prioritised" } });
    const pending = session.refresh();
    expect(session.getState().status).toBe("loading");
    m.settle(0, 200, successBody(pageOf("prioritised", { total: 1 })));
    await pending;
    expect(session.getState().status).toBe("ready");
  });

  it("discards a superseded load — the newer read wins even if the older resolves last", async () => {
    const m = manualTransport();
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: m.transport, request: { view: "prioritised" } });
    const first = session.refresh(); // revision 1
    const second = session.refresh(); // revision 2
    // resolve the NEWER load first — it applies…
    m.settle(1, 200, successBody(pageOf("prioritised", { total: 2 })));
    // …then the OLDER load resolves last, but is stale and dropped
    m.settle(0, 200, successBody(pageOf("prioritised", { total: 999 })));
    await Promise.all([first, second]);
    const state = session.getState();
    expect(state.status).toBe("ready");
    expect(state.page?.total).toBe(2); // the winner, not the late straggler
    expect(state.revision).toBe(2);
  });

  it("a client error becomes error status with the API's message, keeping the last good page", async () => {
    const t = recordingTransport([
      okResponse("prioritised", { total: 3 }),
      { status: 400, body: failureBody("worklist page limit must be a positive integer") },
    ]);
    const session = createWorklistSession({ baseUrl: BASE, fetchImpl: t.transport });
    await session.refresh();
    const good = session.getState().page;
    await session.refresh();
    const state = session.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("positive integer");
    expect(state.page).toEqual(good); // retained across the failed refresh
  });
});

// ---------------------------------------------------------------------
// RUNTIME — organisation isolation: forwarded from the session, never a client value.
// ---------------------------------------------------------------------

describe("WorklistSession runtime — organisation isolation", () => {
  it("forwards the caller's session headers to the client, and names no organisation in the URL", async () => {
    const t = recordingTransport([okResponse("prioritised")]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      headers: { cookie: "sb-session=abc123" },
    });
    await session.refresh();
    const headers = t.calls[0]!.init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("sb-session=abc123");
    expect(t.calls[0]!.url).not.toMatch(/org|organisation|organization/i);
  });

  it("forwards the same session headers on EVERY read, across view + page changes", async () => {
    const t = recordingTransport([
      okResponse("prioritised", { total: 25, limit: 10, has_more: true }),
      okResponse("recovery", { total: 25, limit: 10, has_more: true }),
      okResponse("recovery", { total: 25, limit: 10, offset: 10, has_more: true }),
    ]);
    const session = createWorklistSession({
      baseUrl: BASE,
      fetchImpl: t.transport,
      headers: { cookie: "sb-session=xyz" },
      request: { page: { limit: 10 } },
    });
    await session.refresh();
    await session.setView("recovery");
    await session.nextPage();
    for (const call of t.calls) {
      expect((call.init?.headers as Record<string, string>).cookie).toBe("sb-session=xyz");
      expect(call.url).not.toMatch(/org|organisation|organization/i);
    }
  });
});

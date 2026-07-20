import { describe, it, expect } from "vitest";
import {
  deriveWorklistPresentation,
  deriveWorklistSummary,
  deriveWorklistPagination,
  deriveWorklistEmptyState,
  deriveWorklistLoadingState,
  deriveWorklistErrorState,
  deriveWorklistViewModel,
  type WorklistSessionState,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-view-model";
import {
  createWorklistViewModel,
  WorklistViewModelRuntime,
} from "@/server/services/receptionist-worklist-view-model";

// =====================================================================
// R43 — CONVERSATION WORKLIST VIEW MODEL: unit behaviour.
//
// Two subjects: the PURE CORE (the total, deterministic derivations that project a WorklistSessionState into a
// presentation-ready view model) and the RUNTIME (the WorklistViewModelRuntime, driven with an injected
// transport so the whole session → client → HTTP boundary is exercised without a network, and its state is
// projected through the pure core). The core is fed hand-built session states; the runtime is fed canned API
// responses whose items are synthetic entries (the client passes items through verbatim).
// =====================================================================

const BASE = "http://view-model.test";
const WORKLIST_PATH = "/api/receptionist/worklists";

// The two non-ASCII glyphs the display copy uses — reconstructed here so an assertion cannot silently drift on
// an invisible character.
const ELLIPSIS = String.fromCharCode(0x2026); // …
const ENDASH = String.fromCharCode(0x2013); // –

const SUMMARY_EMPTY = "No conversations";
const EMPTY_FILTERED = "No conversations match the current filter.";
const EMPTY_VIEW = "This worklist is empty.";
const LOADING_INITIAL = `Loading conversations${ELLIPSIS}`;
const LOADING_REFRESH = `Refreshing${ELLIPSIS}`;

// The already-derived entry the session holds — typed THROUGH the page, exactly as the view model types it.
type WorklistEntry = WorklistPage["items"][number];

/**
 * A worklist ENTRY with sensible defaults — override only the display fields a test cares about. The heavy
 * `lead_participant` / `record` fields the view model never reads are stubbed (the client passes items through
 * verbatim, so these need only be present, not real).
 */
function entryOf(overrides: Partial<WorklistEntry> = {}): WorklistEntry {
  return {
    coordination_id: "co-1",
    org_id: "org-1",
    conversation_id: "cv-1",
    categories: ["human_review"],
    priority: "critical",
    priority_rank: 0,
    lead_participant: "receptionist" as WorklistEntry["lead_participant"],
    requires_human: true,
    mode: "escalating",
    at: "2026-01-01T00:00:00.000Z",
    record: {} as WorklistEntry["record"],
    ...overrides,
  };
}

/** A worklist PAGE with sensible defaults — override only the metadata / items a test cares about. */
function pageOf(overrides: Partial<WorklistPage> = {}): WorklistPage {
  return {
    view: "prioritised",
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
    has_more: false,
    ...overrides,
  };
}

/** A session STATE with sensible (idle) defaults — override only the fields a test cares about. */
function stateOf(overrides: Partial<WorklistSessionState> = {}): WorklistSessionState {
  return { request: {}, status: "idle", page: null, error: null, revision: 0, ...overrides };
}

/** Ten distinct entries — for range / summary tests that need a full page. */
function entries(count: number): WorklistEntry[] {
  return Array.from({ length: count }, (_, i) => entryOf({ coordination_id: `co-${i}` }));
}

// ---------------------------------------------------------------------
// RUNTIME transport doubles — the same shape R42's session test uses.
// ---------------------------------------------------------------------

function successBody(page: WorklistPage): Record<string, unknown> {
  return { ok: true, ...page };
}

function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

type CannedResponse = { status: number; body: unknown };

const okResponse = (overrides: Partial<WorklistPage> = {}): CannedResponse => ({
  status: 200,
  body: successBody(pageOf(overrides)),
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

// ---------------------------------------------------------------------
// PURE CORE — presentation derivation (the display rows).
// ---------------------------------------------------------------------

describe("worklist view model — presentation", () => {
  it("maps the page's entries to display rows, in the same order, with humanised labels", () => {
    const state = stateOf({
      status: "ready",
      page: pageOf({
        view: "prioritised",
        total: 2,
        items: [
          entryOf({
            coordination_id: "co-a",
            conversation_id: "cv-a",
            priority: "critical",
            priority_rank: 0,
            categories: ["human_review", "escalation"],
            mode: "escalating",
            requires_human: true,
            at: "2026-02-01T00:00:00.000Z",
          }),
          entryOf({
            coordination_id: "co-b",
            conversation_id: null,
            priority: "elevated",
            priority_rank: 1,
            categories: ["recovery"],
            mode: "remediating",
            requires_human: false,
            at: "2026-01-01T00:00:00.000Z",
          }),
        ],
      }),
    });
    const rows = deriveWorklistPresentation(state);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.coordinationId).toBe("co-a");
    expect(rows[0]!.conversationId).toBe("cv-a");
    expect(rows[0]!.priority).toBe("critical");
    expect(rows[0]!.priorityLabel).toBe("Critical");
    expect(rows[0]!.priorityRank).toBe(0);
    expect(rows[0]!.categories).toEqual(["human_review", "escalation"]);
    expect(rows[0]!.categoryLabels).toEqual(["Human review", "Escalation"]);
    expect(rows[0]!.mode).toBe("escalating");
    expect(rows[0]!.modeLabel).toBe("Escalating");
    expect(rows[0]!.requiresHuman).toBe(true);
    expect(rows[0]!.at).toBe("2026-02-01T00:00:00.000Z");
    // order preserved — co-b second, with its own labels
    expect(rows[1]!.coordinationId).toBe("co-b");
    expect(rows[1]!.conversationId).toBeNull();
    expect(rows[1]!.modeLabel).toBe("Remediating");
    expect(rows[1]!.categoryLabels).toEqual(["Recovery"]);
  });

  it("is the empty list when no page is loaded", () => {
    expect(deriveWorklistPresentation(stateOf())).toEqual([]);
  });

  it("surfaces NO organisation or ledger dimension on a row — only display fields", () => {
    const state = stateOf({ status: "ready", page: pageOf({ total: 1, items: [entryOf()] }) });
    const row = deriveWorklistPresentation(state)[0]!;
    const keys = Object.keys(row);
    expect(keys).not.toContain("org_id");
    expect(keys).not.toContain("record");
    expect(keys).not.toContain("lead_participant");
    expect(new Set(keys)).toEqual(
      new Set([
        "coordinationId",
        "conversationId",
        "priority",
        "priorityLabel",
        "priorityRank",
        "categories",
        "categoryLabels",
        "mode",
        "modeLabel",
        "requiresHuman",
        "at",
      ]),
    );
  });
});

// ---------------------------------------------------------------------
// PURE CORE — summary derivation (the count / range header).
// ---------------------------------------------------------------------

describe("worklist view model — summary", () => {
  it("is the empty summary when no page is loaded", () => {
    const summary = deriveWorklistSummary(stateOf({ request: { view: "recovery" } }));
    expect(summary).toEqual({
      view: "recovery",
      total: 0,
      shown: 0,
      rangeStart: 0,
      rangeEnd: 0,
      filtered: false,
      label: SUMMARY_EMPTY,
    });
  });

  it("is the empty summary when the page reports a zero total", () => {
    const summary = deriveWorklistSummary(stateOf({ status: "ready", page: pageOf({ total: 0 }) }));
    expect(summary.total).toBe(0);
    expect(summary.label).toBe(SUMMARY_EMPTY);
  });

  it("computes a 1-based range and a ready-to-render label for the first page", () => {
    const state = stateOf({
      status: "ready",
      page: pageOf({ total: 25, limit: 10, offset: 0, items: entries(10) }),
    });
    const summary = deriveWorklistSummary(state);
    expect(summary.total).toBe(25);
    expect(summary.shown).toBe(10);
    expect(summary.rangeStart).toBe(1);
    expect(summary.rangeEnd).toBe(10);
    expect(summary.label).toBe(`Showing 1${ENDASH}10 of 25`);
  });

  it("offsets the range by the page's offset", () => {
    const state = stateOf({
      status: "ready",
      request: { page: { limit: 10, offset: 10 } },
      page: pageOf({ total: 25, limit: 10, offset: 10, items: entries(5) }),
    });
    const summary = deriveWorklistSummary(state);
    expect(summary.rangeStart).toBe(11);
    expect(summary.rangeEnd).toBe(15);
    expect(summary.label).toBe(`Showing 11${ENDASH}15 of 25`);
  });

  it("flags a filtered read", () => {
    const state = stateOf({
      status: "ready",
      request: { filter: { requires_human: true } },
      page: pageOf({ total: 3, items: entries(3) }),
    });
    expect(deriveWorklistSummary(state).filtered).toBe(true);
  });

  it("is not flagged filtered when the filter object is empty", () => {
    const state = stateOf({ status: "ready", request: { filter: {} }, page: pageOf({ total: 1, items: entries(1) }) });
    expect(deriveWorklistSummary(state).filtered).toBe(false);
  });
});

// ---------------------------------------------------------------------
// PURE CORE — pagination derivation (the navigation affordances).
// ---------------------------------------------------------------------

describe("worklist view model — pagination", () => {
  it("reflects the session's next / previous selectors and echoes the window", () => {
    const state = stateOf({
      status: "ready",
      request: { page: { limit: 10, offset: 10 } },
      page: pageOf({ limit: 10, offset: 10, has_more: true }),
    });
    const pagination = deriveWorklistPagination(state);
    expect(pagination.hasNext).toBe(true);
    expect(pagination.hasPrevious).toBe(true);
    expect(pagination.pageSize).toBe(10);
    expect(pagination.offset).toBe(10);
  });

  it("has no next / previous and a null page size before any read", () => {
    const pagination = deriveWorklistPagination(stateOf());
    expect(pagination.hasNext).toBe(false);
    expect(pagination.hasPrevious).toBe(false);
    expect(pagination.pageSize).toBeNull();
    expect(pagination.offset).toBe(0);
  });

  it("reports a previous page from the request offset even before a page is held", () => {
    const pagination = deriveWorklistPagination(stateOf({ request: { page: { limit: 10, offset: 20 } } }));
    expect(pagination.hasPrevious).toBe(true);
    expect(pagination.hasNext).toBe(false);
    expect(pagination.offset).toBe(20);
  });
});

// ---------------------------------------------------------------------
// PURE CORE — the three lifecycle verdicts.
// ---------------------------------------------------------------------

describe("worklist view model — empty state", () => {
  it("is empty only when a read succeeded and returned nothing", () => {
    const state = stateOf({ status: "ready", page: pageOf({ total: 0, items: [] }) });
    const empty = deriveWorklistEmptyState(state);
    expect(empty.isEmpty).toBe(true);
    expect(empty.message).toBe(EMPTY_VIEW);
  });

  it("distinguishes an empty filtered result", () => {
    const state = stateOf({
      status: "ready",
      request: { filter: { priorities: ["critical"] } },
      page: pageOf({ total: 0, items: [] }),
    });
    expect(deriveWorklistEmptyState(state).message).toBe(EMPTY_FILTERED);
  });

  it("is not empty when the ready page has entries", () => {
    const state = stateOf({ status: "ready", page: pageOf({ total: 1, items: entries(1) }) });
    expect(deriveWorklistEmptyState(state).isEmpty).toBe(false);
  });

  it("is not empty while loading, idle or errored", () => {
    expect(deriveWorklistEmptyState(stateOf({ status: "loading" })).isEmpty).toBe(false);
    expect(deriveWorklistEmptyState(stateOf({ status: "idle" })).isEmpty).toBe(false);
    expect(deriveWorklistEmptyState(stateOf({ status: "error", error: "boom" })).isEmpty).toBe(false);
  });
});

describe("worklist view model — loading state", () => {
  it("is an INITIAL load when loading with no page yet", () => {
    const loading = deriveWorklistLoadingState(stateOf({ status: "loading", page: null }));
    expect(loading.isLoading).toBe(true);
    expect(loading.isInitialLoad).toBe(true);
    expect(loading.message).toBe(LOADING_INITIAL);
  });

  it("is a REFRESH when loading over an existing page", () => {
    const loading = deriveWorklistLoadingState(
      stateOf({ status: "loading", page: pageOf({ total: 1, items: entries(1) }) }),
    );
    expect(loading.isLoading).toBe(true);
    expect(loading.isInitialLoad).toBe(false);
    expect(loading.message).toBe(LOADING_REFRESH);
  });

  it("is not loading when ready or idle", () => {
    expect(deriveWorklistLoadingState(stateOf({ status: "ready" })).isLoading).toBe(false);
    expect(deriveWorklistLoadingState(stateOf({ status: "idle" })).message).toBe("");
  });
});

describe("worklist view model — error state", () => {
  it("surfaces the message and a retained stale page", () => {
    const state = stateOf({
      status: "error",
      error: "the worklist API request failed (status 500)",
      page: pageOf({ total: 3, items: entries(3) }),
    });
    const error = deriveWorklistErrorState(state);
    expect(error.isError).toBe(true);
    expect(error.message).toContain("500");
    expect(error.hasStalePage).toBe(true);
  });

  it("reports no stale page when the failure had nothing loaded before it", () => {
    const error = deriveWorklistErrorState(stateOf({ status: "error", error: "boom", page: null }));
    expect(error.isError).toBe(true);
    expect(error.hasStalePage).toBe(false);
  });

  it("is not an error when ready", () => {
    const error = deriveWorklistErrorState(stateOf({ status: "ready" }));
    expect(error.isError).toBe(false);
    expect(error.message).toBeNull();
    expect(error.hasStalePage).toBe(false);
  });
});

// ---------------------------------------------------------------------
// PURE CORE — the composed view model + determinism.
// ---------------------------------------------------------------------

describe("worklist view model — composition", () => {
  it("composes every projection for a ready state", () => {
    const state = stateOf({
      status: "ready",
      request: { view: "prioritised", page: { limit: 10, offset: 0 } },
      page: pageOf({ view: "prioritised", total: 12, limit: 10, offset: 0, has_more: true, items: entries(10) }),
    });
    const vm = deriveWorklistViewModel(state);
    expect(vm.status).toBe("ready");
    expect(vm.rows).toHaveLength(10);
    expect(vm.summary.total).toBe(12);
    expect(vm.summary.label).toBe(`Showing 1${ENDASH}10 of 12`);
    expect(vm.pagination.hasNext).toBe(true);
    expect(vm.pagination.hasPrevious).toBe(false);
    expect(vm.empty.isEmpty).toBe(false);
    expect(vm.loading.isLoading).toBe(false);
    expect(vm.error.isError).toBe(false);
  });

  it("is deterministic — the same state always yields a deeply-equal view model", () => {
    const state = stateOf({
      status: "ready",
      page: pageOf({ total: 2, items: entries(2) }),
    });
    expect(deriveWorklistViewModel(state)).toEqual(deriveWorklistViewModel(state));
  });

  it("projects the idle state to an empty, non-loading, non-error view model", () => {
    const vm = deriveWorklistViewModel(stateOf());
    expect(vm.status).toBe("idle");
    expect(vm.rows).toEqual([]);
    expect(vm.summary.label).toBe(SUMMARY_EMPTY);
    expect(vm.empty.isEmpty).toBe(false);
    expect(vm.loading.isLoading).toBe(false);
    expect(vm.error.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------
// RUNTIME — projects a live session through the pure core.
// ---------------------------------------------------------------------

describe("WorklistViewModelRuntime — projects the live session", () => {
  it("projects the idle session before the first read", () => {
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: recordingTransport([]).transport });
    expect(vm).toBeInstanceOf(WorklistViewModelRuntime);
    const model = vm.getViewModel();
    expect(model.status).toBe("idle");
    expect(model.rows).toEqual([]);
    expect(model.summary.label).toBe(SUMMARY_EMPTY);
    expect(model.loading.isLoading).toBe(false);
    expect(model.empty.isEmpty).toBe(false);
    expect(model.error.isError).toBe(false);
  });

  it("refresh reads through the session and projects the page's rows", async () => {
    const t = recordingTransport([
      okResponse({ view: "prioritised", total: 2, items: [entryOf({ coordination_id: "co-1" }), entryOf({ coordination_id: "co-2" })] }),
    ]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport, request: { view: "prioritised" } });
    const model = await vm.refresh();
    expect(model.status).toBe("ready");
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]!.coordinationId).toBe("co-1");
    expect(model.summary.total).toBe(2);
    expect(t.calls[0]!.url).toContain(`${BASE}${WORKLIST_PATH}`);
    expect(t.calls[0]!.url).toContain("view=prioritised");
  });

  it("setView re-reads and re-projects the new view", async () => {
    const t = recordingTransport([okResponse({ view: "prioritised" }), okResponse({ view: "recovery" })]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport });
    await vm.refresh();
    const model = await vm.setView("recovery");
    expect(model.summary.view).toBe("recovery");
    expect(t.calls[1]!.url).toContain("view=recovery");
  });

  it("setFilter re-projects a filtered summary and narrows the read", async () => {
    const t = recordingTransport([okResponse(), okResponse()]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport });
    await vm.refresh();
    const model = await vm.setFilter({ priorities: ["critical"], requires_human: true });
    expect(model.summary.filtered).toBe(true);
    expect(t.calls[1]!.url).toContain("priority=critical");
    expect(t.calls[1]!.url).toContain("requires_human=true");
  });

  it("clearFilter re-projects an unfiltered summary", async () => {
    const t = recordingTransport([okResponse(), okResponse()]);
    const vm = createWorklistViewModel({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { filter: { priorities: ["critical"] } },
    });
    await vm.refresh();
    const model = await vm.clearFilter();
    expect(model.summary.filtered).toBe(false);
    expect(t.calls[1]!.url).not.toContain("priority=");
  });

  it("nextPage advances the window and re-projects the offset", async () => {
    const t = recordingTransport([
      okResponse({ total: 25, limit: 10, offset: 0, has_more: true, items: entries(10) }),
      okResponse({ total: 25, limit: 10, offset: 10, has_more: true, items: entries(10) }),
    ]);
    const vm = createWorklistViewModel({
      baseUrl: BASE,
      fetchImpl: t.transport,
      request: { view: "prioritised", page: { limit: 10 } },
    });
    await vm.refresh();
    const model = await vm.nextPage();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.url).toContain("offset=10");
    expect(model.pagination.offset).toBe(10);
    expect(model.summary.rangeStart).toBe(11);
  });

  it("nextPage at the end is a no-op — it issues no read and re-projects the same model", async () => {
    const t = recordingTransport([okResponse({ limit: 10, has_more: false, total: 3, items: entries(3) })]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport, request: { page: { limit: 10 } } });
    const before = await vm.refresh();
    const after = await vm.nextPage();
    expect(t.calls).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it("a failed read projects an error verdict that keeps the last good page", async () => {
    const t = recordingTransport([
      okResponse({ total: 3, items: entries(3) }),
      { status: 400, body: { ok: false, error: "worklist page limit must be a positive integer" } },
    ]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport });
    await vm.refresh();
    const model = await vm.refresh();
    expect(model.status).toBe("error");
    expect(model.error.isError).toBe(true);
    expect(model.error.message).toContain("positive integer");
    expect(model.error.hasStalePage).toBe(true);
    expect(model.rows).toHaveLength(3); // the retained page still projects rows
  });
});

// ---------------------------------------------------------------------
// RUNTIME — organisation isolation: inherited from the session, never a view-model value.
// ---------------------------------------------------------------------

describe("WorklistViewModelRuntime — organisation isolation", () => {
  it("forwards the caller's session headers on every read and names no organisation", async () => {
    const t = recordingTransport([
      okResponse({ view: "prioritised", total: 25, limit: 10, has_more: true, items: entries(10) }),
      okResponse({ view: "recovery", total: 25, limit: 10, has_more: true, items: entries(10) }),
      okResponse({ view: "recovery", total: 25, limit: 10, offset: 10, has_more: true, items: entries(10) }),
    ]);
    const vm = createWorklistViewModel({
      baseUrl: BASE,
      fetchImpl: t.transport,
      headers: { cookie: "sb-session=xyz" },
      request: { page: { limit: 10 } },
    });
    await vm.refresh();
    await vm.setView("recovery");
    await vm.nextPage();
    for (const call of t.calls) {
      expect((call.init?.headers as Record<string, string>).cookie).toBe("sb-session=xyz");
      expect(call.url).not.toMatch(/org|organisation|organization/i);
    }
  });

  it("the projected view model exposes only presentation fields — no organisation dimension", async () => {
    const t = recordingTransport([okResponse({ total: 1, items: [entryOf()] })]);
    const vm = createWorklistViewModel({ baseUrl: BASE, fetchImpl: t.transport });
    const model = await vm.refresh();
    expect(new Set(Object.keys(model))).toEqual(
      new Set(["status", "rows", "summary", "pagination", "empty", "loading", "error"]),
    );
    const summaryKeys = Object.keys(model.summary);
    expect(summaryKeys).not.toContain("org_id");
    expect(summaryKeys).not.toContain("organisation");
  });
});

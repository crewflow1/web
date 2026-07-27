import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit proof for the Pulse reader service (Module 1, PR5 / CEO Directive #005,
 * STEP 3). Mocks the admin client's RPC so we assert the EXACT argument mapping
 * the three timeline RPCs receive — the category→namespace flattening, the
 * "empty filter = no constraint" (NULL) contract, the search trim, the keyset
 * cursor wiring, the limit default — and the never-throw degradation (a failed
 * read becomes an empty page / null, never a throw) WITHOUT a database. The real
 * projection / replay / keyset behaviour is proven against live Postgres in the
 * integration tier (timeline-projection.test.ts).
 */

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

import {
  getTimelinePage,
  getTimelineEvent,
  getTimelineFacets,
} from "@/server/services/spine-timeline";

const OK_PAGE = { data: { items: [], next_cursor: null }, error: null } as const;

/** The args the (single) call to a given rpc fn received. */
function argsFor(fn: string): Record<string, unknown> {
  const call = rpcMock.mock.calls.find((c) => c[0] === fn);
  expect(call, `${fn} was not called`).toBeDefined();
  return call?.[1] as Record<string, unknown>;
}

describe("spine-timeline reader service", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  // --- getTimelinePage -------------------------------------------------------

  it("getTimelinePage: a first page with no filters sends every constraint as NULL", async () => {
    rpcMock.mockResolvedValue(OK_PAGE);
    await getTimelinePage();

    expect(argsFor("hq_timeline_page")).toEqual({
      p_limit: 50,
      p_before_ts: null,
      p_before_id: null,
      p_namespaces: null,
      p_severities: null,
      p_actor_types: null,
      p_search: null,
    });
  });

  it("getTimelinePage: flattens category chips to the projection's namespace vocabulary", async () => {
    rpcMock.mockResolvedValue(OK_PAGE);
    await getTimelinePage({ filters: { categories: ["sales", "finance"] } });
    // sales → quote,lead ; finance → invoice,billing (order preserved, deduped).
    expect(argsFor("hq_timeline_page").p_namespaces).toEqual([
      "quote",
      "lead",
      "invoice",
      "billing",
    ]);
  });

  it("getTimelinePage: a refine filter passes its members; an EMPTY one is NULL (no constraint)", async () => {
    rpcMock.mockResolvedValue(OK_PAGE);
    await getTimelinePage({
      filters: { severities: ["critical", "warn"], actorTypes: [], search: "  invoice 7  " },
    });
    const a = argsFor("hq_timeline_page");
    expect(a.p_severities).toEqual(["critical", "warn"]);
    expect(a.p_actor_types).toBeNull(); // empty array → no constraint, not "match nothing"
    expect(a.p_search).toBe("invoice 7"); // trimmed
  });

  it("getTimelinePage: a blank / whitespace search collapses to NULL", async () => {
    rpcMock.mockResolvedValue(OK_PAGE);
    await getTimelinePage({ filters: { search: "   " } });
    expect(argsFor("hq_timeline_page").p_search).toBeNull();
  });

  it("getTimelinePage: threads the keyset cursor + a custom limit", async () => {
    rpcMock.mockResolvedValue(OK_PAGE);
    await getTimelinePage({
      cursor: { ts: "2026-06-20T10:00:00.000Z", event_id: 4242 },
      limit: 25,
    });
    const a = argsFor("hq_timeline_page");
    expect(a.p_before_ts).toBe("2026-06-20T10:00:00.000Z");
    expect(a.p_before_id).toBe(4242);
    expect(a.p_limit).toBe(25);
  });

  it("getTimelinePage: returns the projection page verbatim on success", async () => {
    const page = {
      items: [{ event_id: 9, ts: "t", verb: "customer.created" }],
      next_cursor: { ts: "t", event_id: 9 },
    };
    rpcMock.mockResolvedValue({ data: page, error: null });
    expect(await getTimelinePage()).toEqual(page);
  });

  it("getTimelinePage: NEVER throws — an RPC error or rejection degrades to an empty page", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "rls denied" } });
    expect(await getTimelinePage()).toEqual({ items: [], next_cursor: null });

    rpcMock.mockRejectedValue(new Error("network down"));
    expect(await getTimelinePage()).toEqual({ items: [], next_cursor: null });
  });

  it("getTimelinePage: defends a malformed body — non-array items → [], missing cursor → null", async () => {
    rpcMock.mockResolvedValue({ data: { items: "nope" }, error: null });
    expect(await getTimelinePage()).toEqual({ items: [], next_cursor: null });
  });

  // --- getTimelineEvent ------------------------------------------------------

  it("getTimelineEvent: maps the id and returns the event + its correlation chain", async () => {
    const detail = {
      event: { event_id: 7, verb: "quote.sent" },
      correlation: [{ event_id: 6 }, { event_id: 7 }],
    };
    rpcMock.mockResolvedValue({ data: detail, error: null });
    expect(await getTimelineEvent(7)).toEqual(detail);
    expect(argsFor("hq_timeline_event")).toEqual({ p_event_id: 7 });
  });

  it("getTimelineEvent: a non-finite id short-circuits to null WITHOUT touching the RPC", async () => {
    expect(await getTimelineEvent(Number.NaN)).toBeNull();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("getTimelineEvent: unknown id / error / no-event body all degrade to null", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    expect(await getTimelineEvent(1)).toBeNull();

    rpcMock.mockResolvedValue({ data: { correlation: [] }, error: null }); // no .event
    expect(await getTimelineEvent(1)).toBeNull();

    rpcMock.mockRejectedValue(new Error("boom"));
    expect(await getTimelineEvent(1)).toBeNull();
  });

  it("getTimelineEvent: coerces a missing correlation array to []", async () => {
    rpcMock.mockResolvedValue({ data: { event: { event_id: 3 } }, error: null });
    expect(await getTimelineEvent(3)).toEqual({ event: { event_id: 3 }, correlation: [] });
  });

  // --- getTimelineFacets -----------------------------------------------------

  it("getTimelineFacets: returns the facet blob on success, null on any failure", async () => {
    const facets = {
      generated_at: "t",
      total: 3,
      namespaces: {},
      severities: {},
      actor_types: {},
    };
    rpcMock.mockResolvedValue({ data: facets, error: null });
    expect(await getTimelineFacets()).toEqual(facets);

    rpcMock.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await getTimelineFacets()).toBeNull();

    rpcMock.mockRejectedValue(new Error("down"));
    expect(await getTimelineFacets()).toBeNull();
  });
});

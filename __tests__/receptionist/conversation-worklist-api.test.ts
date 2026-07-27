import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  parseWorklistQuery,
  WorklistQueryError,
  DEFAULT_WORKLIST_VIEW,
  DEFAULT_WORKLIST_LIMIT,
  MAX_WORKLIST_LIMIT,
} from "@/lib/receptionist/conversation-worklist-api";
import type {
  WorklistPage,
  WorklistView,
} from "@/lib/receptionist/conversation-worklist-read-surface";
import { requireOrgContext } from "@/server/auth/session";
import { queryOrgWorklist } from "@/server/services/receptionist-worklist-read-surface";
import type { NextRequest } from "next/server";

/**
 * The Conversation Worklist API — request contract + route wiring, unit tier (the AI Receptionist
 * Programme, R40 — CONVERSATION WORKLIST API).
 *
 * Two layers are pinned here:
 *   1. `parseWorklistQuery` — the PURE request contract. A query string in, a validated
 *      {@link WorklistQuery} out: every parameter defaults when absent, a present-but-invalid one is a
 *      typed {@link WorklistQueryError} (a 400), a page is ALWAYS returned (never unbounded), and it
 *      parses NO organisation — the vocabulary to name another org simply does not exist.
 *   2. `GET /api/receptionist/worklists` — the route wiring, with BOTH seams mocked
 *      (`requireOrgContext`, `queryOrgWorklist`). These prove the handler scopes the read to the
 *      SESSION's organisation (never a client-supplied `org_id`), forwards the parsed query verbatim,
 *      maps a malformed query to 400 without reading, and maps an unexpected read failure to 500.
 *
 * The live read path (R39 → R38 → R37 → Postgres) is exercised in the integration tier; here the read
 * surface is mocked so the CONTRACT and the WIRING are isolated.
 */

vi.mock("@/server/auth/session", () => ({ requireOrgContext: vi.fn() }));
vi.mock("@/server/services/receptionist-worklist-read-surface", () => ({
  queryOrgWorklist: vi.fn(),
}));

// Late import so the module mocks are bound before the route module resolves its imports.
async function loadRoute() {
  return import("@/app/api/receptionist/worklists/route");
}

/** The handler only reads `request.nextUrl.searchParams`, so a URL-bearing stand-in is sufficient. */
function req(queryString: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost/api/receptionist/worklists${queryString}`),
  } as unknown as NextRequest;
}

/** A minimal authenticated org context, as `requireOrgContext` would resolve it. */
function sessionContext(orgId: string): Awaited<ReturnType<typeof requireOrgContext>> {
  return {
    user: { id: "user-1" },
    ctx: {
      membership: { org_id: orgId, role: "owner" },
      org: { id: orgId, name: "Org", slug: "org", status: "active" },
    },
  } as unknown as Awaited<ReturnType<typeof requireOrgContext>>;
}

/** A minimal page, as the R39 read surface would return it. */
function pageFixture(view: WorklistView): WorklistPage {
  return { view, items: [], total: 0, limit: 50, offset: 0, has_more: false };
}

/** Parse a raw query string through the request contract. */
function parse(queryString: string) {
  return parseWorklistQuery(new URLSearchParams(queryString));
}

describe("parseWorklistQuery — the pure request contract", () => {
  describe("view", () => {
    it("defaults to the prioritised backlog when absent", () => {
      expect(parse("").view).toBe(DEFAULT_WORKLIST_VIEW);
      expect(parse("").view).toBe("prioritised");
    });

    it.each(["prioritised", "human_review", "recovery", "escalation"] as const)(
      "accepts the known view %s",
      (view) => {
        expect(parse(`view=${view}`).view).toBe(view);
      },
    );

    it("rejects an unknown view as a WorklistQueryError", () => {
      expect(() => parse("view=not-a-view")).toThrow(WorklistQueryError);
    });

    it("treats a blank view as absent (defaults)", () => {
      expect(parse("view=").view).toBe(DEFAULT_WORKLIST_VIEW);
    });
  });

  describe("priority filter", () => {
    it("accepts a single known priority", () => {
      expect(parse("priority=critical").filter).toEqual({ priorities: ["critical"] });
    });

    it("accepts a comma-separated list of known priorities", () => {
      expect(parse("priority=critical,routine").filter).toEqual({
        priorities: ["critical", "routine"],
      });
    });

    it("rejects an unknown priority", () => {
      expect(() => parse("priority=urgent")).toThrow(WorklistQueryError);
    });

    it("rejects a list containing any unknown priority", () => {
      expect(() => parse("priority=critical,urgent")).toThrow(WorklistQueryError);
    });
  });

  describe("mode filter (no runtime vocabulary — passed through unchanged)", () => {
    it("accepts a single mode", () => {
      expect(parse("mode=finalising").filter).toEqual({ modes: ["finalising"] });
    });

    it("accepts a comma-separated list of modes", () => {
      expect(parse("mode=finalising,remediating").filter).toEqual({
        modes: ["finalising", "remediating"],
      });
    });

    it("passes an unrecognised mode through rather than rejecting it", () => {
      expect(() => parse("mode=teleport")).not.toThrow();
      expect(parse("mode=teleport").filter).toEqual({ modes: ["teleport"] });
    });
  });

  describe("category filter", () => {
    it("accepts a single known category", () => {
      expect(parse("category=recovery").filter).toEqual({ categories: ["recovery"] });
    });

    it("accepts a comma-separated list of known categories", () => {
      expect(parse("category=human_review,escalation").filter).toEqual({
        categories: ["human_review", "escalation"],
      });
    });

    it("rejects an unknown category", () => {
      expect(() => parse("category=urgent")).toThrow(WorklistQueryError);
    });
  });

  describe("requires_human flag", () => {
    it('parses "true"', () => {
      expect(parse("requires_human=true").filter).toEqual({ requires_human: true });
    });

    it('parses "false"', () => {
      expect(parse("requires_human=false").filter).toEqual({ requires_human: false });
    });

    it("rejects a non-boolean value", () => {
      expect(() => parse("requires_human=yes")).toThrow(WorklistQueryError);
    });
  });

  describe("conversation_id", () => {
    it("keeps a present identifier", () => {
      expect(parse("conversation_id=conv-1").filter).toEqual({ conversation_id: "conv-1" });
    });

    it("trims surrounding whitespace", () => {
      expect(parse("conversation_id=%20conv-2%20").filter).toEqual({
        conversation_id: "conv-2",
      });
    });

    it("treats an empty identifier as absent (no filter)", () => {
      expect(parse("conversation_id=").filter).toBeUndefined();
    });
  });

  describe("page bounds", () => {
    it("defaults limit and offset when absent", () => {
      expect(parse("").page).toEqual({ limit: DEFAULT_WORKLIST_LIMIT, offset: 0 });
    });

    it("accepts an in-range limit and offset", () => {
      expect(parse("limit=10&offset=20").page).toEqual({ limit: 10, offset: 20 });
    });

    it("accepts the min and max limit boundaries", () => {
      expect(parse("limit=1").page?.limit).toBe(1);
      expect(parse(`limit=${MAX_WORKLIST_LIMIT}`).page?.limit).toBe(MAX_WORKLIST_LIMIT);
    });

    it("rejects a limit below the minimum", () => {
      expect(() => parse("limit=0")).toThrow(WorklistQueryError);
    });

    it("rejects a limit above the maximum", () => {
      expect(() => parse(`limit=${MAX_WORKLIST_LIMIT + 1}`)).toThrow(WorklistQueryError);
    });

    it("rejects a non-integer limit", () => {
      expect(() => parse("limit=5.5")).toThrow(WorklistQueryError);
      expect(() => parse("limit=abc")).toThrow(WorklistQueryError);
    });

    it("rejects a negative offset", () => {
      expect(() => parse("offset=-1")).toThrow(WorklistQueryError);
    });

    it("rejects a non-integer offset", () => {
      expect(() => parse("offset=1.5")).toThrow(WorklistQueryError);
    });

    it("always returns a bounded page, even with no parameters", () => {
      const page = parse("view=escalation").page;
      expect(page).toBeDefined();
      expect(page?.limit).toBeGreaterThanOrEqual(1);
      expect(page?.limit).toBeLessThanOrEqual(MAX_WORKLIST_LIMIT);
    });
  });

  describe("query shape", () => {
    it("omits the filter entirely when no filter dimension is present", () => {
      expect(parse("view=recovery&limit=10")).not.toHaveProperty("filter");
    });

    it("composes every dimension into one query", () => {
      expect(
        parse(
          "view=recovery&priority=critical&mode=escalating&category=escalation&requires_human=true&conversation_id=c1&limit=5&offset=10",
        ),
      ).toEqual({
        view: "recovery",
        filter: {
          priorities: ["critical"],
          modes: ["escalating"],
          categories: ["escalation"],
          requires_human: true,
          conversation_id: "c1",
        },
        page: { limit: 5, offset: 10 },
      });
    });

    it("is deterministic — the same query string yields an equal query", () => {
      const qs = "view=recovery&priority=critical&limit=7&offset=3";
      expect(parse(qs)).toEqual(parse(qs));
    });

    it("parses NO organisation — an org_id in the query is simply ignored", () => {
      const query = parse("view=recovery&org_id=org-EVIL");
      expect(JSON.stringify(query)).not.toContain("org-EVIL");
      expect(query.filter).toBeUndefined();
    });
  });
});

describe("GET /api/receptionist/worklists — the route wiring", () => {
  beforeEach(() => {
    vi.mocked(requireOrgContext).mockReset();
    vi.mocked(queryOrgWorklist).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 { ok: true, ...page } on success", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext("org-A"));
    vi.mocked(queryOrgWorklist).mockResolvedValue(pageFixture("prioritised"));

    const { GET } = await loadRoute();
    const res = await GET(req("?view=prioritised"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      view: "prioritised",
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      has_more: false,
    });
  });

  it("scopes the read to the SESSION org, ignoring a client-supplied org_id", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext("org-A"));
    vi.mocked(queryOrgWorklist).mockResolvedValue(pageFixture("prioritised"));

    const { GET } = await loadRoute();
    await GET(req("?view=prioritised&org_id=org-EVIL"));

    expect(queryOrgWorklist).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(queryOrgWorklist).mock.calls[0]![0];
    expect(arg.org_id).toBe("org-A");
    // The attacker-supplied org never reaches the read surface, in any field.
    expect(JSON.stringify(arg)).not.toContain("org-EVIL");
  });

  it("forwards the parsed query verbatim alongside the session org", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext("org-A"));
    vi.mocked(queryOrgWorklist).mockResolvedValue(pageFixture("recovery"));

    const { GET } = await loadRoute();
    await GET(req("?view=recovery&priority=critical&limit=10&offset=5"));

    expect(queryOrgWorklist).toHaveBeenCalledWith({
      org_id: "org-A",
      view: "recovery",
      filter: { priorities: ["critical"] },
      page: { limit: 10, offset: 5 },
    });
  });

  it("returns 400 { ok: false } for a malformed query and never reads", async () => {
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext("org-A"));

    const { GET } = await loadRoute();
    const res = await GET(req("?view=not-a-view"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(queryOrgWorklist).not.toHaveBeenCalled();
  });

  it("returns 500 { ok: false } when the read surface throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireOrgContext).mockResolvedValue(sessionContext("org-A"));
    vi.mocked(queryOrgWorklist).mockRejectedValue(new Error("read model unavailable"));

    const { GET } = await loadRoute();
    const res = await GET(req("?view=prioritised"));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });

  it("lets a requireOrgContext redirect propagate (never swallowed into 500)", async () => {
    // requireOrgContext throws NEXT_REDIRECT for an unauthenticated / org-less caller. The handler
    // runs it OUTSIDE the try/catch, so the redirect must escape rather than becoming a 500.
    const redirectError = new Error("NEXT_REDIRECT");
    vi.mocked(requireOrgContext).mockRejectedValue(redirectError);

    const { GET } = await loadRoute();
    await expect(GET(req("?view=prioritised"))).rejects.toThrow("NEXT_REDIRECT");
    expect(queryOrgWorklist).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  WORKLIST_API_PATH,
  worklistRequestToSearchParams,
  buildWorklistRequestPath,
  parseWorklistApiResponse,
  WorklistClientError,
  withWorklistView,
  withWorklistFilter,
  withWorklistPage,
  nextWorklistPageRequest,
  type WorklistClientRequest,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-client";
import { parseWorklistQuery } from "@/lib/receptionist/conversation-worklist-api";
import { fetchOrgWorklist } from "@/server/services/receptionist-worklist-client";

/**
 * The Conversation Worklist Client — pure contract + runtime consumption, unit tier (the AI Receptionist
 * Programme, R41 — CONVERSATION WORKLIST CLIENT).
 *
 * Two layers are pinned here:
 *   1. The PURE CONTRACT (`lib/receptionist/conversation-worklist-client.ts`) — request serialisation,
 *      response parsing, the typed error, and the immutable filter/pagination helpers. The load-bearing
 *      proof is a ROUND-TRIP: what the client serialises is EXACTLY what the R40 API's own
 *      `parseWorklistQuery` parses back — the client forks no contract. It names no organisation, and it
 *      re-derives / re-orders / re-paginates no entries.
 *   2. The RUNTIME (`server/services/receptionist-worklist-client.ts`) — with the transport injected, it
 *      GETs the ONE endpoint, forwards the caller's session headers (never an org), returns the API's page
 *      verbatim on success, and raises a typed {@link WorklistClientError} (carrying the API's own message)
 *      on a 400 / 500 / non-JSON / transport failure — and never retries.
 *
 * The live read path (API → R39 → R38 → R37 → Postgres) is exercised in the integration tier; here the
 * transport is a stub so the CONTRACT and the CONSUMPTION are isolated.
 */

// ---------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------

/** A structurally-complete worklist page, as the R39 read surface would return it. */
function page(view: WorklistPage["view"], overrides: Partial<WorklistPage> = {}): WorklistPage {
  return { view, items: [], total: 0, limit: 50, offset: 0, has_more: false, ...overrides };
}

/** A minimal `Response` stand-in — the runtime only reads `.status` and `.json()`. */
function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

/** A `Response` whose body is not JSON — `.json()` rejects, as a login-page HTML redirect would. */
function nonJsonResponse(status: number): Response {
  return {
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  } as unknown as Response;
}

/** Capture the URL string the transport was called with. */
function calledUrl(fetchImpl: ReturnType<typeof vi.fn>): string {
  return fetchImpl.mock.calls[0]![0] as string;
}

/** Capture the `RequestInit` the transport was called with. */
function calledInit(fetchImpl: ReturnType<typeof vi.fn>): RequestInit {
  return fetchImpl.mock.calls[0]![1] as RequestInit;
}

// =====================================================================
// 1. worklistRequestToSearchParams — serialise a typed request into the API's query.
// =====================================================================

describe("worklistRequestToSearchParams — request serialisation", () => {
  it("serialises an empty request to no parameters", () => {
    expect(worklistRequestToSearchParams({}).toString()).toBe("");
    expect(worklistRequestToSearchParams().toString()).toBe("");
  });

  it("serialises the view", () => {
    expect(worklistRequestToSearchParams({ view: "recovery" }).get("view")).toBe("recovery");
  });

  it("serialises each filter dimension as the API reads it", () => {
    const params = worklistRequestToSearchParams({
      filter: {
        priorities: ["critical", "elevated"],
        modes: ["finalising", "escalating"],
        categories: ["recovery", "escalation"],
        requires_human: true,
        conversation_id: "conv-1",
      },
    });
    expect(params.get("priority")).toBe("critical,elevated");
    expect(params.get("mode")).toBe("finalising,escalating");
    expect(params.get("category")).toBe("recovery,escalation");
    expect(params.get("requires_human")).toBe("true");
    expect(params.get("conversation_id")).toBe("conv-1");
  });

  it("serialises requires_human=false explicitly", () => {
    expect(worklistRequestToSearchParams({ filter: { requires_human: false } }).get("requires_human")).toBe(
      "false",
    );
  });

  it("serialises the page bounds", () => {
    const params = worklistRequestToSearchParams({ page: { limit: 10, offset: 20 } });
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("20");
  });

  it("omits the offset when absent (the API defaults it)", () => {
    const params = worklistRequestToSearchParams({ page: { limit: 10 } });
    expect(params.get("limit")).toBe("10");
    expect(params.has("offset")).toBe(false);
  });

  it("writes NO organisation parameter, whatever the request", () => {
    const params = worklistRequestToSearchParams({
      view: "escalation",
      filter: { conversation_id: "conv-9", requires_human: true },
      page: { limit: 5, offset: 5 },
    });
    for (const key of params.keys()) {
      expect(key, `serialised param "${key}" must not name an organisation`).not.toMatch(/org/i);
    }
  });

  it("ROUND-TRIPS through the R40 API's own parser — the client forks no contract", () => {
    const request = {
      view: "recovery",
      filter: {
        priorities: ["critical"],
        modes: ["escalating"],
        categories: ["escalation"],
        requires_human: true,
        conversation_id: "c1",
      },
      page: { limit: 5, offset: 10 },
    } satisfies WorklistClientRequest;

    // What the client SERIALISES is exactly what the API PARSES back — no drift between the two contracts.
    expect(parseWorklistQuery(worklistRequestToSearchParams(request))).toEqual({
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

  it("ROUND-TRIPS a view-only request to the API's defaulted query", () => {
    expect(parseWorklistQuery(worklistRequestToSearchParams({ view: "human_review" }))).toEqual({
      view: "human_review",
      page: { limit: 50, offset: 0 },
    });
  });
});

// =====================================================================
// 2. buildWorklistRequestPath — the endpoint + query.
// =====================================================================

describe("buildWorklistRequestPath — the request path", () => {
  it("is the bare API path when the request is empty", () => {
    expect(buildWorklistRequestPath({})).toBe(WORKLIST_API_PATH);
    expect(buildWorklistRequestPath({})).toBe("/api/receptionist/worklists");
  });

  it("appends the serialised query when present", () => {
    expect(buildWorklistRequestPath({ view: "recovery" })).toBe(
      "/api/receptionist/worklists?view=recovery",
    );
  });

  it("targets only the worklist API path", () => {
    const path = buildWorklistRequestPath({ view: "escalation", page: { limit: 3 } });
    expect(path.startsWith(WORKLIST_API_PATH)).toBe(true);
  });
});

// =====================================================================
// 3. parseWorklistApiResponse — read the API envelope into a page or a typed error.
// =====================================================================

describe("parseWorklistApiResponse — response parsing", () => {
  it("returns the page verbatim on a { ok: true } envelope", () => {
    const p = page("prioritised", {
      items: [{ coordination_id: "co-1" }] as unknown as WorklistPage["items"],
      total: 1,
      limit: 50,
      has_more: false,
    });
    expect(parseWorklistApiResponse(200, { ok: true, ...p })).toEqual(p);
  });

  it("throws the API's own message on a { ok: false } envelope", () => {
    const error = parseFailure(400, { ok: false, error: 'unknown worklist view "nope"' });
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.message).toBe('unknown worklist view "nope"');
    expect(error.status).toBe(400);
  });

  it("throws a generic message on a { ok: false } envelope with no error string", () => {
    const error = parseFailure(500, { ok: false });
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.status).toBe(500);
    expect(error.message).toMatch(/failed/i);
  });

  it("throws on a non-object body (null, string, number)", () => {
    expect(() => parseWorklistApiResponse(200, null)).toThrow(WorklistClientError);
    expect(() => parseWorklistApiResponse(200, "<html>login</html>")).toThrow(WorklistClientError);
    expect(() => parseWorklistApiResponse(200, 42)).toThrow(WorklistClientError);
  });

  it("throws on a { ok: true } envelope that is missing page fields (malformed)", () => {
    const error = parseFailure(200, { ok: true, view: "prioritised" });
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.message).toMatch(/malformed/i);
  });

  it("throws on an object with no ok discriminant", () => {
    expect(() => parseWorklistApiResponse(200, { view: "prioritised", items: [] })).toThrow(
      WorklistClientError,
    );
  });

  /** Run the parser and return the error it threw (fails the test if it does not throw). */
  function parseFailure(status: number, body: unknown): WorklistClientError {
    try {
      parseWorklistApiResponse(status, body);
    } catch (e) {
      return e as WorklistClientError;
    }
    throw new Error("expected parseWorklistApiResponse to throw");
  }
});

// =====================================================================
// 4. Request builders — immutable filter/view/page shaping.
// =====================================================================

describe("request builders — immutable shaping", () => {
  const base: WorklistClientRequest = { view: "prioritised" };

  it("withWorklistView replaces the view without mutating the input", () => {
    expect(withWorklistView(base, "recovery")).toEqual({ view: "recovery" });
    expect(base).toEqual({ view: "prioritised" });
  });

  it("withWorklistFilter merges filter dimensions without mutating the input", () => {
    const one = withWorklistFilter(base, { priorities: ["critical"] });
    expect(one).toEqual({ view: "prioritised", filter: { priorities: ["critical"] } });

    const two = withWorklistFilter(one, { requires_human: true });
    expect(two.filter).toEqual({ priorities: ["critical"], requires_human: true });
    // The earlier request is untouched — the helper is immutable.
    expect(one.filter).toEqual({ priorities: ["critical"] });
  });

  it("withWorklistPage bounds the request without mutating the input", () => {
    expect(withWorklistPage(base, { limit: 10, offset: 20 })).toEqual({
      view: "prioritised",
      page: { limit: 10, offset: 20 },
    });
    expect(base).toEqual({ view: "prioritised" });
  });
});

// =====================================================================
// 5. nextWorklistPageRequest — derive the next page from the API's paging metadata.
// =====================================================================

describe("nextWorklistPageRequest — pagination", () => {
  const request: WorklistClientRequest = { view: "prioritised", filter: { priorities: ["critical"] } };

  it("advances the offset by the applied page size when more remain", () => {
    expect(nextWorklistPageRequest(request, page("prioritised", { total: 10, limit: 3, offset: 0, has_more: true }))).toEqual(
      { view: "prioritised", filter: { priorities: ["critical"] }, page: { limit: 3, offset: 3 } },
    );
  });

  it("advances from a non-zero offset", () => {
    expect(
      nextWorklistPageRequest(request, page("prioritised", { total: 10, limit: 3, offset: 3, has_more: true }))?.page,
    ).toEqual({ limit: 3, offset: 6 });
  });

  it("returns null when the API reports no more entries", () => {
    expect(
      nextWorklistPageRequest(request, page("prioritised", { total: 3, limit: 3, offset: 0, has_more: false })),
    ).toBeNull();
  });
});

// =====================================================================
// 6. WorklistClientError.
// =====================================================================

describe("WorklistClientError", () => {
  it("is an Error carrying a name, message, status and cause", () => {
    const cause = new Error("root");
    const error = new WorklistClientError("boom", { status: 503, cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WorklistClientError");
    expect(error.message).toBe("boom");
    expect(error.status).toBe(503);
    expect(error.cause).toBe(cause);
  });

  it("has an undefined status when none was given", () => {
    expect(new WorklistClientError("boom").status).toBeUndefined();
  });
});

// =====================================================================
// 7. fetchOrgWorklist — the runtime consumption (transport injected).
// =====================================================================

describe("fetchOrgWorklist — consuming the API", () => {
  it("GETs the endpoint and returns the API page verbatim on success", async () => {
    const expected = page("prioritised", { total: 0 });
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true, ...expected }));

    const result = await fetchOrgWorklist(
      { view: "prioritised" },
      { baseUrl: "https://app.test", fetchImpl },
    );

    expect(result).toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calledUrl(fetchImpl)).toBe("https://app.test/api/receptionist/worklists?view=prioritised");
    expect(calledInit(fetchImpl).method).toBe("GET");
  });

  it("defaults the base URL to NEXT_PUBLIC_APP_URL", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true, ...page("prioritised") }));
    await fetchOrgWorklist({}, { fetchImpl });
    expect(calledUrl(fetchImpl)).toBe("http://localhost:3000/api/receptionist/worklists");
  });

  it("forwards the caller's session headers (e.g. the cookie) and asks for JSON", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true, ...page("prioritised") }));
    await fetchOrgWorklist({}, { baseUrl: "https://app.test", headers: { cookie: "sb=session" }, fetchImpl });

    const headers = calledInit(fetchImpl).headers as Record<string, string>;
    expect(headers.cookie).toBe("sb=session");
    expect(headers.accept).toBe("application/json");
  });

  it("serialises the filter and page into the request URL", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true, ...page("recovery") }));
    await fetchOrgWorklist(
      { view: "recovery", filter: { priorities: ["critical", "elevated"], requires_human: true }, page: { limit: 10, offset: 5 } },
      { baseUrl: "https://app.test", fetchImpl },
    );

    const url = new URL(calledUrl(fetchImpl));
    expect(url.pathname).toBe("/api/receptionist/worklists");
    expect(url.searchParams.get("view")).toBe("recovery");
    expect(url.searchParams.get("priority")).toBe("critical,elevated");
    expect(url.searchParams.get("requires_human")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
  });

  it("never puts an organisation in the request URL", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true, ...page("recovery") }));
    await fetchOrgWorklist(
      { view: "recovery", filter: { conversation_id: "c1" } },
      { baseUrl: "https://app.test", headers: { cookie: "sb=session" }, fetchImpl },
    );
    expect(calledUrl(fetchImpl)).not.toMatch(/org[_-]?id/i);
  });

  it("raises a typed error carrying the API's message on a 400", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(400, { ok: false, error: 'unknown worklist view "nope"' }));
    const error = await fetchOrgWorklist({}, { baseUrl: "https://app.test", fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('unknown worklist view "nope"');
  });

  it("raises a typed error on a 500", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, { ok: false, error: "Worklist temporarily unavailable" }));
    const error = await fetchOrgWorklist({}, { baseUrl: "https://app.test", fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.status).toBe(500);
  });

  it("raises a typed error (carrying the cause) when the transport fails", async () => {
    const boom = new Error("network down");
    const fetchImpl = vi.fn(async () => {
      throw boom;
    });
    const error = await fetchOrgWorklist({}, { baseUrl: "https://app.test", fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.message).toMatch(/transport/i);
    expect(error.cause).toBe(boom);
  });

  it("raises a typed error when the response is not JSON", async () => {
    const fetchImpl = vi.fn(async () => nonJsonResponse(200));
    const error = await fetchOrgWorklist({}, { baseUrl: "https://app.test", fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(WorklistClientError);
    expect(error.status).toBe(200);
    expect(error.message).toMatch(/not valid JSON/i);
  });

  it("makes exactly one request — it does not retry", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, { ok: false, error: "boom" }));
    await fetchOrgWorklist({}, { baseUrl: "https://app.test", fetchImpl }).catch(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

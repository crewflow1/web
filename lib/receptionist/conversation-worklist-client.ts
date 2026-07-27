// =====================================================================
// THE CONVERSATION WORKLIST CLIENT — PURE CONTRACT CORE (CEO Directive #018, R41: CONVERSATION WORKLIST
// CLIENT).
//
// R40 shipped the Conversation Worklist API — the single authorised APPLICATION INTERFACE for querying
// Conversation Worklists over HTTP (`GET /api/receptionist/worklists`): it authenticates the caller,
// resolves the organisation from the SESSION, parses an untrusted query string into a validated
// {@link WorklistQuery}, and answers it a bounded page at a time through the R39 read surface. Nothing yet
// gave a caller a TYPED, REUSABLE way to CONSUME that API — every consumer would otherwise hand-assemble a
// query string and hand-parse the response envelope, forking the contract at each call site. R41 is the
// NEXT — the canonical Conversation Worklist Client: the single authorised CONSUMER of the Worklist API.
// This module is its PURE CONTRACT: it translates a typed {@link WorklistClientRequest} into the exact
// query string the R40 API parses, and a raw HTTP response envelope back into a typed {@link WorklistPage}
// — nothing more.
//
// IT SHAPES A REQUEST AND READS A RESPONSE — IT NEVER FETCHES, DERIVES OR EXECUTES. The client's server
// runtime (`server/services/receptionist-worklist-client.ts`) performs the single HTTP GET against the
// API; this core does the pure work either side of that call: it SERIALISES a typed request into
// {@link URLSearchParams} ({@link worklistRequestToSearchParams}) and a request PATH
// ({@link buildWorklistRequestPath}), and it PARSES the API's response envelope into a page or a typed
// error ({@link parseWorklistApiResponse}). It opens no socket, creates no client, reads no worklist,
// derives no worklist and touches no database — it is a total, deterministic transform from a typed
// request to a query string, and from a response body to a typed page.
//
// IT CONSUMES ONLY THE WORKLIST API — IT REACHES AROUND NOTHING. The client's ONLY endpoint is
// {@link WORKLIST_API_PATH} (`GET /api/receptionist/worklists`); it names no other route, no read surface
// function, no engine, no ledger and no database. The API stays AUTHORITATIVE for everything behind it:
// this core validates NO filter vocabulary of its own (an unknown priority/category is the API's 400 to
// raise, not the client's) and re-derives, re-orders and re-paginates NOTHING — it forwards the typed
// values the caller chose and returns the page the API computed, verbatim. Filtering and pagination are
// supported as REQUEST SHAPING (which query params to send) and RESPONSE NAVIGATION (which page to ask for
// next) — never as a second implementation of the read surface's own filtering or paging of entries.
//
// IT HAS NO CONCEPT OF ORGANISATION — SO ORGANISATION ISOLATION IS PRESERVED STRUCTURALLY. The request
// contract deliberately carries ONLY the read-surface query dimensions the API accepts: the worklist VIEW,
// the FILTER (priority / mode / category / requires-human / conversation) and the PAGE (limit / offset).
// It carries NO organisation identifier of any kind and serialises none. The organisation a read is scoped
// to is resolved by the API's route handler from the AUTHENTICATED SESSION — never from anything the
// client sends. A caller cannot ask this client for another organisation's worklist because the vocabulary
// to express that request does not exist; organisation isolation is inherited from the API as a STRUCTURAL
// property, not a runtime check the client could forget.
//
// IT REUSES THE R39 VOCABULARY — IT FORKS NONE. The request's view / filter / page shapes and the response
// {@link WorklistPage} are the R39 read-surface TYPES, REUSED verbatim (re-exported here so a consumer
// types its requests and responses from ONE module); this core declares no worklist vocabulary of its own
// and re-implements no read-surface operation. It is READ-ONLY: it assigns nobody, dispatches nothing,
// notifies no one, schedules nothing, enqueues into nothing and retries nothing — it reads a worklist page
// through the API, and it acts on none.
// =====================================================================

import type {
  WorklistView,
  WorklistFilter,
  WorklistPageRequest,
  WorklistPage,
} from "@/lib/receptionist/conversation-worklist-read-surface";

// The worklist VIEW / FILTER / PAGE request shapes and the WORKLIST PAGE response are the R39 read-surface
// vocabulary REUSED — re-exported so a consumer types its requests and responses from the client alone,
// without importing the read surface (which it must never call) directly.
export type {
  WorklistView,
  WorklistFilter,
  WorklistPageRequest,
  WorklistPage,
} from "@/lib/receptionist/conversation-worklist-read-surface";

// ---------------------------------------------------------------------
// The endpoint — the ONLY door this client consumes.
// ---------------------------------------------------------------------

/**
 * The single endpoint the Worklist Client consumes — the R40 Conversation Worklist API. The client names
 * NO other route: its entire data path is a GET against this path. Defined in exactly one place so the
 * runtime and every test agree on the one door.
 */
export const WORKLIST_API_PATH = "/api/receptionist/worklists" as const;

// ---------------------------------------------------------------------
// The typed request — the read-surface query dimensions, and NOTHING that names an organisation.
// ---------------------------------------------------------------------

/**
 * A typed WORKLIST CLIENT REQUEST — everything a caller may ask the Worklist API for, and nothing more.
 * Every field is OPTIONAL: an absent `view` lets the API default to the prioritised backlog, an absent
 * `filter` reads the whole view, and an absent `page` takes the API's default bounded page. It carries NO
 * organisation identifier — the organisation is resolved by the API from the authenticated session, never
 * from the request — so this type cannot express a cross-organisation read.
 */
export type WorklistClientRequest = {
  /** Which worklist to read; omitted ⇒ the API's default (the prioritised backlog). */
  view?: WorklistView;
  /** Optional narrowing predicate over already-derived attributes; omitted ⇒ the whole view. */
  filter?: WorklistFilter;
  /** Optional bounded window; omitted ⇒ the API's default page. */
  page?: WorklistPageRequest;
};

// ---------------------------------------------------------------------
// The response envelope — the exact shape the R40 route returns.
// ---------------------------------------------------------------------

/** The API's SUCCESS body — the `{ ok: true }` envelope carrying a {@link WorklistPage}. */
export type WorklistApiSuccess = { ok: true } & WorklistPage;

/** The API's FAILURE body — the `{ ok: false, error }` envelope a 400/500 carries. */
export type WorklistApiFailure = { ok: false; error: string };

/** Either response body the Worklist API may return. */
export type WorklistApiResponseBody = WorklistApiSuccess | WorklistApiFailure;

/**
 * A WORKLIST CLIENT ERROR — the API could not be consumed into a {@link WorklistPage}. It is raised for a
 * transport failure (the request never completed), a non-JSON or unrecognised body, or an API `{ ok: false }`
 * envelope (a 400 malformed query or a 500). When the API returned a status it is carried on `status`, and
 * for an API failure the message is the API's OWN error message — the API stays authoritative for what is
 * and is not a valid query; the client never silently coerces a failed read into an empty page.
 */
export class WorklistClientError extends Error {
  /** The HTTP status the API returned, when the failure carried one. */
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorklistClientError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

// ---------------------------------------------------------------------
// REQUEST SHAPING — serialise a typed request into the exact query the R40 API parses.
// ---------------------------------------------------------------------

/**
 * Serialise a {@link WorklistClientRequest} into the {@link URLSearchParams} the R40 API parses — the exact
 * inverse of the API's request contract, so a request round-trips through the API's `parseWorklistQuery`
 * unchanged. Only PRESENT dimensions are written (an absent field is omitted so the API applies its own
 * default); the array filters are comma-joined exactly as the API splits them. It writes NO organisation
 * parameter of any kind — the vocabulary does not exist. Pure and deterministic.
 */
export function worklistRequestToSearchParams(
  request: WorklistClientRequest = {},
): URLSearchParams {
  const params = new URLSearchParams();

  if (request.view !== undefined) params.set("view", request.view);

  const filter = request.filter;
  if (filter) {
    if (filter.priorities !== undefined) params.set("priority", filter.priorities.join(","));
    if (filter.modes !== undefined) params.set("mode", filter.modes.join(","));
    if (filter.categories !== undefined) params.set("category", filter.categories.join(","));
    if (filter.requires_human !== undefined) {
      params.set("requires_human", String(filter.requires_human));
    }
    if (filter.conversation_id !== undefined) params.set("conversation_id", filter.conversation_id);
  }

  const page = request.page;
  if (page) {
    params.set("limit", String(page.limit));
    if (page.offset !== undefined) params.set("offset", String(page.offset));
  }

  return params;
}

/**
 * Build the request PATH the client GETs — {@link WORKLIST_API_PATH} with the serialised query appended
 * (omitted when the request is empty). A relative path; the runtime prefixes the API origin. Pure.
 */
export function buildWorklistRequestPath(request: WorklistClientRequest = {}): string {
  const query = worklistRequestToSearchParams(request).toString();
  return query.length > 0 ? `${WORKLIST_API_PATH}?${query}` : WORKLIST_API_PATH;
}

// ---------------------------------------------------------------------
// RESPONSE READING — parse the API's envelope into a typed page or a typed error.
// ---------------------------------------------------------------------

/** Whether a response body is a structurally-complete {@link WorklistApiSuccess} page. */
function isWorklistApiSuccess(body: Record<string, unknown>): body is WorklistApiSuccess {
  return (
    body.ok === true &&
    typeof body.view === "string" &&
    Array.isArray(body.items) &&
    typeof body.total === "number" &&
    typeof body.limit === "number" &&
    typeof body.offset === "number" &&
    typeof body.has_more === "boolean"
  );
}

/**
 * Parse the API's response — an HTTP status and a decoded body — into a {@link WorklistPage}, or throw a
 * typed {@link WorklistClientError}. A `{ ok: false }` envelope is surfaced with the API's OWN error
 * message (the API stays authoritative for query validity); a body that is not the recognised success
 * envelope is a malformed response. On success the page is returned verbatim — the client re-derives,
 * re-orders and re-paginates NOTHING; it returns exactly what the API computed. Pure and total.
 */
export function parseWorklistApiResponse(status: number, body: unknown): WorklistPage {
  if (typeof body !== "object" || body === null) {
    throw new WorklistClientError(
      `the worklist API returned an unrecognised response (status ${status})`,
      { status },
    );
  }

  const envelope = body as Record<string, unknown>;

  if (envelope.ok === false) {
    const message =
      typeof envelope.error === "string" && envelope.error.length > 0
        ? envelope.error
        : `the worklist API request failed (status ${status})`;
    throw new WorklistClientError(message, { status });
  }

  if (!isWorklistApiSuccess(envelope)) {
    throw new WorklistClientError(
      `the worklist API returned a malformed page (status ${status})`,
      { status },
    );
  }

  // Return the page verbatim — strip only the transport envelope's `ok`, keep the read surface's page.
  return {
    view: envelope.view,
    items: envelope.items,
    total: envelope.total,
    limit: envelope.limit,
    offset: envelope.offset,
    has_more: envelope.has_more,
  };
}

// ---------------------------------------------------------------------
// REQUEST BUILDERS — typed, immutable helpers for FILTERING and paging a request.
// ---------------------------------------------------------------------

/** Return a new request that reads {@link WorklistView} `view` — the other dimensions unchanged. Immutable. */
export function withWorklistView(
  request: WorklistClientRequest,
  view: WorklistView,
): WorklistClientRequest {
  return { ...request, view };
}

/**
 * Return a new request whose {@link WorklistFilter} is `request`'s filter MERGED with `filter` (the new
 * fields win) — so a caller can compose a narrowing predicate a dimension at a time. It shapes the request
 * the API will filter by; it filters NO worklist entries itself. Immutable.
 */
export function withWorklistFilter(
  request: WorklistClientRequest,
  filter: WorklistFilter,
): WorklistClientRequest {
  return { ...request, filter: { ...request.filter, ...filter } };
}

/** Return a new request bounded by {@link WorklistPageRequest} `page` — the other dimensions unchanged. Immutable. */
export function withWorklistPage(
  request: WorklistClientRequest,
  page: WorklistPageRequest,
): WorklistClientRequest {
  return { ...request, page };
}

// ---------------------------------------------------------------------
// PAGINATION — derive the NEXT page request from a page the API returned.
// ---------------------------------------------------------------------

/**
 * Given the request that produced a {@link WorklistPage} and that page, return the request for the NEXT
 * page — the same view and filter, the offset advanced by the applied page size — or `null` when the API
 * reported no more entries (`has_more === false`). It reads the API's OWN paging metadata (`limit`,
 * `offset`, `has_more`) to compute which page to ask for next; it paginates NO entries itself. A caller
 * drains a worklist by fetching, then following this until it returns `null`. Pure.
 */
export function nextWorklistPageRequest(
  request: WorklistClientRequest,
  page: WorklistPage,
): WorklistClientRequest | null {
  if (!page.has_more) return null;
  return {
    ...request,
    page: { limit: page.limit, offset: page.offset + page.limit },
  };
}

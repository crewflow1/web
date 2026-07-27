import "server-only";
import {
  WORKLIST_API_PATH,
  worklistRequestToSearchParams,
  parseWorklistApiResponse,
  WorklistClientError,
  type WorklistClientRequest,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-client";

// =====================================================================
// THE CONVERSATION WORKLIST CLIENT — SERVER RUNTIME (CEO Directive #018, R41: CONVERSATION WORKLIST
// CLIENT).
//
// R40 shipped the Conversation Worklist API — the authenticated HTTP interface `GET
// /api/receptionist/worklists` that reads a bounded worklist page through the R39 read surface, scoped to
// the caller's organisation resolved from the SESSION. R41's pure core
// (`lib/receptionist/conversation-worklist-client.ts`) is the typed CONTRACT that serialises a request and
// parses a response. This module is the RUNTIME that JOINS them: the single authorised place a server-side
// caller CONSUMES the Worklist API — it performs the one HTTP GET, using the pure core to shape the query
// and read the envelope.
//
// IT CONSUMES ONLY THE WORKLIST API — IT REACHES AROUND NOTHING. Its ONLY data path is a single `fetch` of
// {@link WORKLIST_API_PATH}. It imports the pure client contract and NOTHING else operational: it does not
// import the R39 read surface, the R38 engine, the R37 reader or any database client; it calls no
// read-surface function, derives no worklist, names no ledger and runs no query. The API stays AUTHORITATIVE
// — every worklist this client returns was computed by the API behind the HTTP boundary; the client adds a
// transport, not a second read path.
//
// ORGANISATION ISOLATION IS INHERITED FROM THE API — THE CLIENT NAMES NO ORGANISATION. The request carries
// no organisation and this runtime sends none: the API resolves the organisation from the AUTHENTICATED
// SESSION carried by the request's own credentials (a caller forwards its session via `headers`, e.g. the
// inbound `cookie`). The client cannot select an organisation — it forwards a session and reads back
// whatever worklist the API scopes to it — so one organisation can never read another's worklist through
// this client.
//
// IT IS READ-ONLY — IT EXECUTES NOTHING. It issues a GET and returns a page. It assigns nobody, dispatches
// nothing, notifies no one, enqueues into no operational system, schedules nothing and — a deliberate R41
// non-goal — retries nothing: a failed read raises a typed {@link WorklistClientError}, it is never
// re-driven. It opens no outbound path other than the read of the API itself.
// =====================================================================

/**
 * Options for consuming the Worklist API. `baseUrl` is the API origin (default: `NEXT_PUBLIC_APP_URL`);
 * `headers` are forwarded on the GET so the API can resolve the organisation from the caller's SESSION
 * (typically the inbound `cookie`) — the client sends NO organisation of its own; `fetchImpl` injects the
 * transport (default: the global `fetch`), so the one HTTP boundary can be exercised in tests.
 */
export interface WorklistClientOptions {
  /** The API origin the request is sent to; defaults to `process.env.NEXT_PUBLIC_APP_URL`. */
  baseUrl?: string;
  /** Headers forwarded on the GET so the API resolves the org from the session (e.g. the inbound cookie). */
  headers?: HeadersInit;
  /** The transport, injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Read a bounded page of the caller's organisation's Conversation Worklists — the single authorised
 * consumption of the R40 Worklist API. It serialises the typed {@link WorklistClientRequest} into the
 * API's query (through the pure contract), GETs {@link WORKLIST_API_PATH} once (forwarding the caller's
 * session via `headers` so the API scopes the read to the session's organisation — never a client value),
 * and parses the envelope into a {@link WorklistPage}. It is READ-ONLY and does not retry: a transport
 * failure, a non-JSON body or an API `{ ok: false }` envelope raises a typed {@link WorklistClientError}
 * carrying the API's own message. The organisation is never named by the client — isolation is the API's,
 * inherited structurally.
 */
export async function fetchOrgWorklist(
  request: WorklistClientRequest = {},
  options: WorklistClientOptions = {},
): Promise<WorklistPage> {
  const transport = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  const query = worklistRequestToSearchParams(request).toString();
  const url = `${base}${WORKLIST_API_PATH}${query.length > 0 ? `?${query}` : ""}`;

  let response: Response;
  try {
    response = await transport(url, {
      method: "GET",
      headers: { accept: "application/json", ...(options.headers ?? {}) },
      // Read-only, and do not chase an auth redirect to a login page: an unauthenticated call surfaces as
      // a typed error, never a followed redirect that could be mistaken for a worklist.
      redirect: "manual",
    });
  } catch (cause) {
    throw new WorklistClientError("the worklist API request failed in transport", { cause });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new WorklistClientError(
      `the worklist API response was not valid JSON (status ${response.status})`,
      { status: response.status, cause },
    );
  }

  return parseWorklistApiResponse(response.status, body);
}

// =====================================================================
// THE CONVERSATION WORKLIST SESSION — PURE STATE CORE (CEO Directive #018, R42: CONVERSATION WORKLIST
// SESSION).
//
// R41 shipped the Conversation Worklist Client — the single authorised CONSUMER of the R40 Worklist API: a
// typed, one-shot read that serialises a {@link WorklistClientRequest}, GETs the API once, and parses the
// response into a {@link WorklistPage}. Each call is STATELESS — it remembers no view, no filter, no page
// position and no load status between reads. Nothing yet gave a caller a STATEFUL way to CONSUME the client
// across successive reads: to hold "the worklist I am looking at" (a view + a filter + a page position) and
// move it — page forward, narrow the filter, refresh — while tracking whether the current read is idle,
// in-flight, ready or failed. R42 is the NEXT — the canonical Conversation Worklist Session: the single
// authorised STATE-MANAGEMENT layer over the Worklist Client. This module is its PURE CORE: the immutable
// {@link WorklistSessionState} and the total transitions that evolve it — nothing more.
//
// IT MODELS STATE — IT PERFORMS NO I/O. The session's server runtime
// (`server/services/receptionist-worklist-session.ts`) performs each read THROUGH the R41 client; this core
// does the pure work around that read. It has two families of transition, both TOTAL and DETERMINISTIC: the
// LOAD LIFECYCLE ({@link beginWorklistLoad} → {@link applyWorklistPage} / {@link applyWorklistError}) folds
// a page or an error the runtime obtained into the state, and REQUEST SHAPING ({@link selectWorklistView},
// {@link applyWorklistFilter}, {@link clearWorklistFilter}, {@link setWorklistPageSize},
// {@link toFirstWorklistPage}, {@link toNextWorklistPage}, {@link toPreviousWorklistPage}) computes the NEXT
// {@link WorklistClientRequest} to read. It opens no socket, reaches no clock and no RNG, reads no worklist
// and touches no database — the same state and the same transition always yield the same next state.
//
// IT CONSUMES ONLY THE WORKLIST CLIENT — IT REACHES AROUND NOTHING. This core's ONLY import is the R41
// client contract: its request/response TYPES and its immutable request-shaping helpers
// ({@link withWorklistView}, {@link withWorklistFilter}, {@link withWorklistPage},
// {@link nextWorklistPageRequest}). It names no read surface, no API route, no engine, no reader, no ledger
// and no database. The CLIENT — and, behind it, the AUTHORITATIVE API — stays the single source of every
// worklist: the session RE-DERIVES, RE-ORDERS and RE-PAGINATES NOTHING. It holds the {@link WorklistPage}
// the client returned verbatim and computes only WHICH request to ask for next (which view, which filter,
// which page window) — request shaping and page navigation, never a second implementation of the read
// surface's own filtering or paging of entries.
//
// IT HAS NO CONCEPT OF ORGANISATION — SO ORGANISATION ISOLATION IS PRESERVED STRUCTURALLY. The session state
// carries the {@link WorklistClientRequest} (view / filter / page) and the load status — and NOTHING that
// names an organisation. The request type cannot express one (the client forbids it), and this core adds no
// organisation dimension of its own. WHICH organisation a read is scoped to is resolved by the API from the
// caller's authenticated session — never from anything the session holds — so a session can never be moved
// to another organisation's worklist.
//
// IT IS READ-ONLY — IT OPENS NO EXECUTION PATH. It manages FILTER, PAGINATION and REFRESH state; it assigns
// nobody, dispatches nothing, notifies no one, schedules nothing, enqueues into nothing and — deliberately —
// RETRIES nothing. The refresh model uses a monotonic {@link WorklistSessionState.revision}: each load BEGINS
// by advancing the revision, and a page or error is applied ONLY when its captured revision still matches, so
// a load SUPERSEDED by a newer one (a refresh, a filter change, a page turn) is DISCARDED — never re-driven,
// never allowed to overwrite the fresher read. A failed load is surfaced as `error` status; it is the
// caller's to re-request, never the session's to retry.
// =====================================================================

import {
  withWorklistView,
  withWorklistFilter,
  withWorklistPage,
  nextWorklistPageRequest,
  type WorklistClientRequest,
  type WorklistView,
  type WorklistFilter,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-client";

// The read-surface vocabulary, re-exported THROUGH the client (never imported from the read surface, which
// the session must not name) so a consumer types its session from this one module.
export type {
  WorklistClientRequest,
  WorklistView,
  WorklistFilter,
  WorklistPage,
} from "@/lib/receptionist/conversation-worklist-client";

// ---------------------------------------------------------------------
// The state — a read position over the worklists, plus where its current read stands.
// ---------------------------------------------------------------------

/**
 * The LOAD STATUS of a session's current read — the "refresh state" a consumer renders against. `idle`
 * before the first read; `loading` while a read is in flight; `ready` once a page has been folded in;
 * `error` when the last read failed (the last good page, if any, is retained). A closed union, so a consumer
 * can switch exhaustively.
 */
export type WorklistSessionStatus = "idle" | "loading" | "ready" | "error";

/**
 * A WORKLIST SESSION STATE — the whole, self-contained read position: the {@link WorklistClientRequest} that
 * defines what is being read (view + filter + page window), the last {@link WorklistPage} the client
 * returned, the load `status`, the last `error` message, and a monotonic `revision`. It is IMMUTABLE — every
 * transition returns a new state — and carries NO organisation of any kind.
 */
export type WorklistSessionState = {
  /** What is being read — the view, filter and page window forwarded to the client. Carries no organisation. */
  readonly request: WorklistClientRequest;
  /** Where the current read stands: idle / loading / ready / error. */
  readonly status: WorklistSessionStatus;
  /** The last successfully-read page, or null before the first successful read. Retained across a later error. */
  readonly page: WorklistPage | null;
  /** The message of the last failed read, or null when the session is not in error. */
  readonly error: string | null;
  /** A monotonic freshness token — advanced when a load BEGINS; a result applies only while it still matches. */
  readonly revision: number;
};

// ---------------------------------------------------------------------
// INITIALISATION — an idle session over an initial request.
// ---------------------------------------------------------------------

/**
 * Begin a session over an initial {@link WorklistClientRequest} (default `{}` — the API's default view and
 * page). The session starts `idle` with no page loaded and revision 0; the runtime performs the first read.
 * Pure.
 */
export function initWorklistSession(request: WorklistClientRequest = {}): WorklistSessionState {
  return { request, status: "idle", page: null, error: null, revision: 0 };
}

// ---------------------------------------------------------------------
// LOAD LIFECYCLE — begin a read, then fold the page or error the runtime obtained.
// ---------------------------------------------------------------------

/**
 * BEGIN a load — mark the session `loading`, clear any prior error (the last page is retained so it stays
 * visible while refreshing), and ADVANCE the revision. The advanced revision is this load's freshness token:
 * the runtime captures it and hands it back to {@link applyWorklistPage} / {@link applyWorklistError}. Pure.
 */
export function beginWorklistLoad(state: WorklistSessionState): WorklistSessionState {
  return { ...state, status: "loading", error: null, revision: state.revision + 1 };
}

/**
 * Fold a successfully-read {@link WorklistPage} into the state — BUT ONLY if `revision` still matches the
 * session's current revision. A load superseded by a newer one (its revision has since advanced) is STALE
 * and discarded: the state is returned unchanged, so an older read can never overwrite a fresher one. On a
 * match the page becomes the current page and the status is `ready`. Pure.
 */
export function applyWorklistPage(
  state: WorklistSessionState,
  page: WorklistPage,
  revision: number,
): WorklistSessionState {
  if (revision !== state.revision) return state;
  return { ...state, status: "ready", page, error: null };
}

/**
 * Fold a failed read into the state — BUT ONLY if `revision` still matches (a superseded failure is
 * discarded, exactly like a superseded page). On a match the status is `error` and the message is recorded;
 * the last good page is RETAINED (a failed refresh does not blank the worklist). Pure.
 */
export function applyWorklistError(
  state: WorklistSessionState,
  error: string,
  revision: number,
): WorklistSessionState {
  if (revision !== state.revision) return state;
  return { ...state, status: "error", error };
}

// ---------------------------------------------------------------------
// REQUEST SHAPING — compute the next request: the view, the filter, the page window.
// ---------------------------------------------------------------------

/**
 * Reset a request to its FIRST page — offset 0, page size preserved. With no page window set (the whole view
 * is read as one page) the request is already "first" and returned unchanged. A private helper: selecting a
 * new view or changing the filter resets the position, because a page offset into the old list is meaningless
 * in the new one.
 */
function resetToFirstPage(request: WorklistClientRequest): WorklistClientRequest {
  if (!request.page) return request;
  return withWorklistPage(request, { limit: request.page.limit, offset: 0 });
}

/**
 * SELECT a different {@link WorklistView} — and reset to the first page (the old page position does not carry
 * across views). The runtime reads the new view next. Immutable.
 */
export function selectWorklistView(
  state: WorklistSessionState,
  view: WorklistView,
): WorklistSessionState {
  return { ...state, request: resetToFirstPage(withWorklistView(state.request, view)) };
}

/**
 * MERGE a {@link WorklistFilter} into the session's filter (the new fields win) — and reset to the first page
 * (a narrower filter re-numbers the list). It shapes the request the API will filter by; it filters NO
 * entries itself. Immutable.
 */
export function applyWorklistFilter(
  state: WorklistSessionState,
  filter: WorklistFilter,
): WorklistSessionState {
  return { ...state, request: resetToFirstPage(withWorklistFilter(state.request, filter)) };
}

/**
 * CLEAR all filtering — read the whole current view — and reset to the first page. The view and page size are
 * preserved. Immutable.
 */
export function clearWorklistFilter(state: WorklistSessionState): WorklistSessionState {
  const cleared: WorklistClientRequest = {};
  if (state.request.view !== undefined) cleared.view = state.request.view;
  if (state.request.page !== undefined) cleared.page = state.request.page;
  return { ...state, request: resetToFirstPage(cleared) };
}

/**
 * Set the PAGE SIZE and jump to the first page (offset 0). Turning a whole-view read into a paged one, or
 * changing the page size, both re-number from the top. The bound is forwarded to the client, which forwards
 * it to the API — the API validates it (a non-positive size is the API's 400 to raise, not the session's).
 * Immutable.
 */
export function setWorklistPageSize(
  state: WorklistSessionState,
  limit: number,
): WorklistSessionState {
  return { ...state, request: withWorklistPage(state.request, { limit, offset: 0 }) };
}

// ---------------------------------------------------------------------
// PAGE NAVIGATION — move the page window over the current view + filter.
// ---------------------------------------------------------------------

/** Jump to the FIRST page of the current view + filter — offset 0, page size preserved. Immutable. */
export function toFirstWorklistPage(state: WorklistSessionState): WorklistSessionState {
  return { ...state, request: resetToFirstPage(state.request) };
}

/**
 * Advance to the NEXT page — or return `null` when there is none to advance to (no page has been read yet, or
 * the last page reported `has_more === false`). It reuses the client's {@link nextWorklistPageRequest}, which
 * reads the API's OWN paging metadata to compute the next window; it paginates no entries itself. Immutable.
 */
export function toNextWorklistPage(state: WorklistSessionState): WorklistSessionState | null {
  if (!state.page) return null;
  const next = nextWorklistPageRequest(state.request, state.page);
  if (!next) return null;
  return { ...state, request: next };
}

/**
 * Step back to the PREVIOUS page — or return `null` when already at the first page (or no page window is set).
 * The offset is moved back by the page size (never below 0); the view and filter are unchanged. This is the
 * session's own navigation over the request window — it computes which page to ASK for, it pages no entries.
 * Immutable.
 */
export function toPreviousWorklistPage(state: WorklistSessionState): WorklistSessionState | null {
  const page = state.request.page;
  const offset = page?.offset ?? 0;
  if (!page || offset <= 0) return null;
  return {
    ...state,
    request: withWorklistPage(state.request, { limit: page.limit, offset: Math.max(0, offset - page.limit) }),
  };
}

// ---------------------------------------------------------------------
// SELECTORS — read the pagination state off the session (the API's own metadata, never re-derived).
// ---------------------------------------------------------------------

/** Whether a next page exists — true exactly when the last read page reported more entries. Pure. */
export function hasNextWorklistPage(state: WorklistSessionState): boolean {
  return state.page !== null && state.page.has_more;
}

/** Whether a previous page exists — true exactly when the current request window is past offset 0. Pure. */
export function hasPreviousWorklistPage(state: WorklistSessionState): boolean {
  return (state.request.page?.offset ?? 0) > 0;
}

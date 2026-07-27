import "server-only";
import {
  fetchOrgWorklist,
  type WorklistClientOptions,
} from "@/server/services/receptionist-worklist-client";
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
  type WorklistSessionState,
} from "@/lib/receptionist/conversation-worklist-session";
import type {
  WorklistClientRequest,
  WorklistView,
  WorklistFilter,
} from "@/lib/receptionist/conversation-worklist-client";

// =====================================================================
// THE CONVERSATION WORKLIST SESSION — SERVER RUNTIME (CEO Directive #018, R42: CONVERSATION WORKLIST
// SESSION).
//
// R42's pure core (`lib/receptionist/conversation-worklist-session.ts`) is the immutable STATE MODEL: the
// {@link WorklistSessionState} and the total transitions that evolve it. This module is the RUNTIME that
// makes a session LIVE: a thin, stateful shell that HOLDS the current state, DELEGATES every state change to
// the pure core, and performs each read THROUGH the R41 Worklist Client. It is the single authorised
// STATE-MANAGEMENT layer for consuming Conversation Worklists.
//
// IT CONSUMES ONLY THE WORKLIST CLIENT — IT REACHES AROUND NOTHING. Its ONLY data path is the R41 client's
// {@link fetchOrgWorklist}: every read is one call to the client, which performs the one authenticated GET of
// the R40 API. It imports the client (its runtime + its contract types) and the R42 pure core, and NOTHING
// else operational — no read surface, no API route, no engine, no reader, no session module, no database
// client. It issues NO `fetch` of its own: the client owns the transport, so the API stays authoritative and
// this runtime adds a state machine, not a second read path.
//
// IT OWNS NO LOGIC — THE PURE CORE DOES. Every method is the same shape: apply a pure transition to the held
// state, then (for a read) perform the load and fold the result back through the pure core. The runtime
// declares no state shape, no status, no navigation and no freshness rule of its own — it only sequences the
// core's transitions around the client's read. So there is exactly one implementation of the session's logic.
//
// ORGANISATION ISOLATION IS INHERITED — THE SESSION NAMES NO ORGANISATION. A session is constructed with the
// caller's forwarded `headers` (e.g. the inbound `cookie`); it forwards them UNCHANGED to the client on every
// read, and the API resolves the organisation from that session. The session holds no organisation, selects
// none and cannot switch one — one session reads exactly one organisation's worklists, for the life of the
// session's credentials.
//
// IT IS READ-ONLY — IT EXECUTES NOTHING. Refresh, filter and page navigation are all READS. It assigns
// nobody, dispatches nothing, notifies no one, enqueues into no system, schedules nothing and retries
// nothing: a failed read becomes `error` status (the pure core's job), never an automatic re-drive. A load
// SUPERSEDED by a newer one is discarded by the core's revision rule — not re-issued.
// =====================================================================

/**
 * Options for a Worklist Session. `request` is the initial view / filter / page (default `{}` — the API's
 * default); the client-transport options ({@link WorklistClientOptions}: `baseUrl`, `headers`, `fetchImpl`)
 * are forwarded UNCHANGED to the client on every read — `headers` carries the caller's session so the API
 * resolves the organisation. It names NO organisation of its own.
 */
export interface WorklistSessionOptions extends WorklistClientOptions {
  /** The initial request the session reads — view / filter / page. Omitted ⇒ the API's default. */
  request?: WorklistClientRequest;
}

/**
 * A live Conversation Worklist Session — a stateful read position over the caller's organisation's worklists.
 * Construct it (idle, nothing loaded), then drive it: {@link WorklistSession.refresh} reads the current
 * request; the view / filter / page methods move the position and read the new page; {@link WorklistSession.getState}
 * returns the current {@link WorklistSessionState} synchronously. Every read goes through the R41 client; the
 * session holds state and NOTHING more.
 */
export class WorklistSession {
  private state: WorklistSessionState;
  private readonly clientOptions: WorklistClientOptions;

  constructor(options: WorklistSessionOptions = {}) {
    this.state = initWorklistSession(options.request ?? {});
    // Capture ONLY the client-transport options — the session forwards these unchanged on every read.
    this.clientOptions = {
      baseUrl: options.baseUrl,
      headers: options.headers,
      fetchImpl: options.fetchImpl,
    };
  }

  /** The current state — synchronous, always available (idle before the first read). */
  getState(): WorklistSessionState {
    return this.state;
  }

  /** Re-read the CURRENT request (same view / filter / page). The "refresh" operation. */
  refresh(): Promise<WorklistSessionState> {
    return this.load();
  }

  /** SELECT a different view and read its first page. */
  setView(view: WorklistView): Promise<WorklistSessionState> {
    this.state = selectWorklistView(this.state, view);
    return this.load();
  }

  /** MERGE a filter (new fields win), reset to the first page and read it. */
  setFilter(filter: WorklistFilter): Promise<WorklistSessionState> {
    this.state = applyWorklistFilter(this.state, filter);
    return this.load();
  }

  /** CLEAR all filtering, reset to the first page and read the whole view. */
  clearFilter(): Promise<WorklistSessionState> {
    this.state = clearWorklistFilter(this.state);
    return this.load();
  }

  /** Set the PAGE SIZE, jump to the first page and read it. */
  setPageSize(limit: number): Promise<WorklistSessionState> {
    this.state = setWorklistPageSize(this.state, limit);
    return this.load();
  }

  /** Jump to the FIRST page and read it. */
  firstPage(): Promise<WorklistSessionState> {
    this.state = toFirstWorklistPage(this.state);
    return this.load();
  }

  /**
   * Advance to the NEXT page and read it. When there is no next page (nothing read yet, or the last page had
   * no more entries) this is a NO-OP — the state is returned unchanged, without a read.
   */
  nextPage(): Promise<WorklistSessionState> {
    const advanced = toNextWorklistPage(this.state);
    if (!advanced) return Promise.resolve(this.state);
    this.state = advanced;
    return this.load();
  }

  /**
   * Step back to the PREVIOUS page and read it. When already at the first page (or no page window is set) this
   * is a NO-OP — the state is returned unchanged, without a read.
   */
  previousPage(): Promise<WorklistSessionState> {
    const stepped = toPreviousWorklistPage(this.state);
    if (!stepped) return Promise.resolve(this.state);
    this.state = stepped;
    return this.load();
  }

  /**
   * Perform one read: BEGIN the load (advancing the freshness revision), read the current request through the
   * R41 client, then fold the page — or, on a client error, the message — back through the pure core, which
   * DISCARDS the result if a newer load has since begun. The session never retries a failed read.
   */
  private async load(): Promise<WorklistSessionState> {
    this.state = beginWorklistLoad(this.state);
    const revision = this.state.revision;
    try {
      const page = await fetchOrgWorklist(this.state.request, this.clientOptions);
      this.state = applyWorklistPage(this.state, page, revision);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.state = applyWorklistError(this.state, message, revision);
    }
    return this.state;
  }
}

/**
 * Open a live Conversation Worklist Session — the single authorised way a server-side caller manages the
 * STATE of consuming Conversation Worklists. The session is idle until its first read; drive it with
 * {@link WorklistSession.refresh} and the view / filter / page methods. It reads only through the R41 client,
 * holds no organisation, and executes nothing.
 */
export function createWorklistSession(options: WorklistSessionOptions = {}): WorklistSession {
  return new WorklistSession(options);
}

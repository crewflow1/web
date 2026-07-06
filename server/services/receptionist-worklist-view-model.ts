import "server-only";
import {
  createWorklistSession,
  type WorklistSession,
  type WorklistSessionOptions,
} from "@/server/services/receptionist-worklist-session";
import {
  deriveWorklistViewModel,
  type WorklistViewModel,
  type WorklistView,
  type WorklistFilter,
} from "@/lib/receptionist/conversation-worklist-view-model";

// =====================================================================
// THE CONVERSATION WORKLIST VIEW MODEL — SERVER RUNTIME (CEO Directive #018, R43: CONVERSATION WORKLIST
// VIEW MODEL).
//
// R43's pure core (`lib/receptionist/conversation-worklist-view-model.ts`) is the immutable PRESENTATION
// MODEL: the {@link WorklistViewModel} and the total, deterministic derivations that project it from a
// {@link WorklistSessionState}. This module is the RUNTIME that makes that projection LIVE over a real read
// position: a thin shell that HOLDS a live R42 Worklist Session, DELEGATES every navigation to it, and
// PROJECTS the session's current state through the pure core into a presentation-ready view model. It is the
// single authorised PRESENTATION layer for consuming Conversation Worklists.
//
// IT CONSUMES ONLY THE WORKLIST SESSION — IT REACHES AROUND NOTHING. Its ONLY runtime dependency is the R42
// session runtime: it OPENS one session (via {@link createWorklistSession}, forwarding the caller's options
// unchanged) and drives it. It imports the session runtime (to open and drive the session) and the R43 pure
// core (to derive the view model), and NOTHING else operational — no client, no read surface, no API route,
// no engine, no reader, no session-state module and no database client. It issues NO read of its own: the
// SESSION owns the state and the read, the CLIENT owns the transport, and the API stays authoritative; this
// runtime adds a presentation projection, not a second read path.
//
// IT OWNS NO PRESENTATION LOGIC — THE PURE CORE DOES. Every read accessor is the same shape: take the
// session's current state and hand it to {@link deriveWorklistViewModel}. Every navigation is the same shape:
// delegate to the session, then re-project. The runtime declares no row shape, no summary, no empty / loading
// / error verdict and no label of its own — it only sequences the core's derivation around the session's
// moves. So there is exactly one implementation of the view model's logic.
//
// ORGANISATION ISOLATION IS INHERITED — THE VIEW MODEL NAMES NO ORGANISATION. The runtime opens a session
// with the caller's forwarded options (e.g. the inbound `headers`); the session forwards them to the client,
// and the API resolves the organisation from that session. This runtime holds no organisation, selects none
// and cannot switch one; the view model it projects carries none. One view model presents exactly one
// organisation's worklists, for the life of the session's credentials.
//
// IT IS READ-ONLY — IT EXECUTES NOTHING. Refresh, view selection, filtering and page navigation are all READS
// delegated to the session. It assigns nobody, dispatches nothing, notifies no one, enqueues into no system,
// schedules nothing and retries nothing: it turns a read position into something a surface can show, never
// into something acted upon.
// =====================================================================

/**
 * Options for a Worklist View Model — identical to the {@link WorklistSessionOptions} it opens the session
 * with: the initial `request` (view / filter / page) plus the client-transport options (`baseUrl`, `headers`,
 * `fetchImpl`) forwarded UNCHANGED to the session and, through it, the client. `headers` carries the caller's
 * session so the API resolves the organisation. It names NO organisation of its own.
 */
export type WorklistViewModelOptions = WorklistSessionOptions;

/**
 * A live Conversation Worklist View Model — a presentation projection over a live read position. Construct it
 * (its session is idle, nothing loaded), then drive it: {@link WorklistViewModelRuntime.refresh} reads the
 * current request; the view / filter / page methods move the position and read the new page; each returns the
 * freshly derived {@link WorklistViewModel}. {@link WorklistViewModelRuntime.getViewModel} projects the
 * session's CURRENT state synchronously. Every read goes through the R42 session (and, below it, the R41
 * client); this runtime holds a session and projects it, and NOTHING more.
 */
export class WorklistViewModelRuntime {
  private readonly session: WorklistSession;

  constructor(options: WorklistViewModelOptions = {}) {
    // Open exactly one session, forwarding the caller's options unchanged. The session owns the state and the
    // read; this runtime only projects it.
    this.session = createWorklistSession(options);
  }

  /** The current view model — synchronous, always available (the idle projection before the first read). */
  getViewModel(): WorklistViewModel {
    return deriveWorklistViewModel(this.session.getState());
  }

  /** Re-read the CURRENT request (same view / filter / page) and re-project. The "refresh" operation. */
  async refresh(): Promise<WorklistViewModel> {
    await this.session.refresh();
    return this.getViewModel();
  }

  /** SELECT a different view, read its first page, and re-project. */
  async setView(view: WorklistView): Promise<WorklistViewModel> {
    await this.session.setView(view);
    return this.getViewModel();
  }

  /** MERGE a filter (new fields win), reset to the first page, read it, and re-project. */
  async setFilter(filter: WorklistFilter): Promise<WorklistViewModel> {
    await this.session.setFilter(filter);
    return this.getViewModel();
  }

  /** CLEAR all filtering, reset to the first page, read the whole view, and re-project. */
  async clearFilter(): Promise<WorklistViewModel> {
    await this.session.clearFilter();
    return this.getViewModel();
  }

  /** Set the PAGE SIZE, jump to the first page, read it, and re-project. */
  async setPageSize(limit: number): Promise<WorklistViewModel> {
    await this.session.setPageSize(limit);
    return this.getViewModel();
  }

  /** Jump to the FIRST page, read it, and re-project. */
  async firstPage(): Promise<WorklistViewModel> {
    await this.session.firstPage();
    return this.getViewModel();
  }

  /**
   * Advance to the NEXT page, read it, and re-project. When there is no next page the session's move is a
   * NO-OP; this simply re-projects the unchanged state.
   */
  async nextPage(): Promise<WorklistViewModel> {
    await this.session.nextPage();
    return this.getViewModel();
  }

  /**
   * Step back to the PREVIOUS page, read it, and re-project. When already at the first page the session's move
   * is a NO-OP; this simply re-projects the unchanged state.
   */
  async previousPage(): Promise<WorklistViewModel> {
    await this.session.previousPage();
    return this.getViewModel();
  }
}

/**
 * Open a live Conversation Worklist View Model — the single authorised way a server-side caller obtains a
 * PRESENTATION-ready projection of Conversation Worklists. The view model is idle until its first read; drive
 * it with {@link WorklistViewModelRuntime.refresh} and the view / filter / page methods. It reads only through
 * the R42 session, holds no organisation, and executes nothing.
 */
export function createWorklistViewModel(
  options: WorklistViewModelOptions = {},
): WorklistViewModelRuntime {
  return new WorklistViewModelRuntime(options);
}

// =====================================================================
// THE CONVERSATION WORKLIST VIEW MODEL — PURE PRESENTATION CORE (CEO Directive #018, R43: CONVERSATION
// WORKLIST VIEW MODEL).
//
// R42 shipped the Conversation Worklist Session — the single authorised STATE-MANAGEMENT layer over the R41
// client: an immutable {@link WorklistSessionState} (a view + filter + page window, the last page, a load
// status and a monotonic revision) and the transitions that move it. What a consumer holds is therefore RAW
// STATE: a status enum, a nullable page of already-derived {@link WorklistEntry} records, an error string.
// Nothing yet turned that raw read position into something a PRESENTATION surface can bind to directly — a
// list of display rows, a "showing 1–10 of 25" summary, an is-this-empty / is-this-loading / did-this-fail
// verdict with the message to show. R43 is the NEXT — the canonical Conversation Worklist VIEW MODEL: the
// single authorised PRESENTATION MODEL over the Worklist Session. This module is its PURE CORE: the
// presentation-ready {@link WorklistViewModel} and the total, deterministic derivations that compute it.
//
// IT DERIVES PRESENTATION — IT RENDERS NOTHING. Every export is a PURE function of a
// {@link WorklistSessionState}: {@link deriveWorklistPresentation} maps the page's entries to display
// {@link WorklistRow}s, {@link deriveWorklistSummary} computes the count / range header,
// {@link deriveWorklistPagination} the navigation affordances, and {@link deriveWorklistEmptyState} /
// {@link deriveWorklistLoadingState} / {@link deriveWorklistErrorState} the three lifecycle verdicts; the
// top-level {@link deriveWorklistViewModel} composes all of them. It builds PLAIN DATA — no JSX, no React
// element, no DOM, no component — that a UI COULD bind to but that is not itself a UI. It reaches no clock,
// no RNG and no I/O, so the same state always yields the same view model.
//
// IT CONSUMES ONLY THE WORKLIST SESSION — IT REACHES AROUND NOTHING. This core's ONLY import is the R42
// session core: the {@link WorklistSessionState} / {@link WorklistSessionStatus} it projects, the view /
// filter / page vocabulary it presents (re-exported THROUGH the session, itself re-exported through the
// client), and the session's OWN pagination selectors ({@link hasNextWorklistPage},
// {@link hasPreviousWorklistPage}) — REUSED, never re-implemented. It names no client, no read surface, no
// API, no engine, no reader, no ledger and no database. The SESSION — and, behind it, the client and the
// AUTHORITATIVE API — stays the single source of every worklist: the view model RE-DERIVES, RE-ORDERS and
// RE-PAGINATES NOTHING. It reads the entries the session holds (already grouped, prioritised and ordered by
// the stack below) and LABELS them for display; it computes which page a consumer is on, never which entries
// belong on it.
//
// IT HAS NO CONCEPT OF ORGANISATION — SO ORGANISATION ISOLATION IS PRESERVED STRUCTURALLY. The view model is
// derived purely from the session state, which carries no organisation; this core adds none and NAMES none.
// It projects only the display-relevant fields of each entry and deliberately surfaces NO ownership
// dimension. WHICH organisation's worklist a state describes was resolved by the API from the caller's
// session, far below — never by anything the view model holds — so a view model can never present another
// organisation's worklist.
//
// IT IS READ-ONLY — IT OPENS NO EXECUTION PATH. It derives presentation and nothing else: it assigns nobody,
// dispatches nothing, notifies no one, schedules nothing, enqueues into nothing and retries nothing. A row is
// a label, not an action; an empty / loading / error verdict is a message to show, not a re-drive of a read.
// The view model is the last read-only layer before a surface — it makes the worklist SHOWABLE, it never
// makes it ACTED-UPON.
// =====================================================================

import {
  hasNextWorklistPage,
  hasPreviousWorklistPage,
  type WorklistSessionState,
  type WorklistSessionStatus,
  type WorklistView,
  type WorklistFilter,
  type WorklistPage,
} from "@/lib/receptionist/conversation-worklist-session";

// The session / worklist vocabulary, re-exported THROUGH the session (never imported from the client, the
// read surface or the engine, none of which the view model names) so a consumer types a presentation surface
// from this one module.
export type {
  WorklistSessionState,
  WorklistSessionStatus,
  WorklistView,
  WorklistFilter,
  WorklistPage,
} from "@/lib/receptionist/conversation-worklist-session";

// The already-derived entry the session holds — typed THROUGH the session's page, so this core imports only
// the session and still presents each entry's display fields precisely.
type WorklistEntry = WorklistPage["items"][number];
type EntryPriority = WorklistEntry["priority"];
type EntryCategory = WorklistEntry["categories"][number];
type EntryMode = WorklistEntry["mode"];

// ---------------------------------------------------------------------
// The presentation model — plain, display-ready data derived from a session state.
// ---------------------------------------------------------------------

/**
 * A display ROW — one worklist entry projected to presentation-ready fields. It carries the entry's identity
 * and its already-derived attributes (priority, categories, mode, requires-human, recorded-at) plus a
 * humanised LABEL for each coded value, so a surface can render a row without re-deriving anything. It
 * surfaces NO organisation and NO raw ledger projection — only what a list needs to show.
 */
export type WorklistRow = {
  /** The coordination's ledger id — the row's stable identity / key. */
  readonly coordinationId: string;
  /** The conversation the entry concerns, or null. */
  readonly conversationId: string | null;
  /** The entry's DERIVED priority (coded), for styling / sorting affordances. */
  readonly priority: EntryPriority;
  /** The priority, humanised for display (e.g. `critical` → "Critical"). */
  readonly priorityLabel: string;
  /** The priority's ordinal (0 = most urgent) — surfaced verbatim, never re-derived. */
  readonly priorityRank: number;
  /** The worklists this entry is grouped into (coded), in canonical order. */
  readonly categories: readonly EntryCategory[];
  /** The categories, humanised for display (e.g. `human_review` → "Human review"). */
  readonly categoryLabels: readonly string[];
  /** HOW the response was coordinated (coded). */
  readonly mode: EntryMode;
  /** The mode, humanised for display. */
  readonly modeLabel: string;
  /** Whether the coordinated response requires a human — surfaced verbatim. */
  readonly requiresHuman: boolean;
  /** When the coordination was recorded (ISO instant) — surfaced verbatim for the surface to format. */
  readonly at: string;
};

/**
 * The SUMMARY header — the count / range line a surface shows above the list. `total` is how many entries
 * matched (before paging); `shown` is this page's row count; `rangeStart` / `rangeEnd` are the 1-based index
 * span of the shown rows (0 when nothing is shown); `filtered` is whether a narrowing filter is active; and
 * `label` is the ready-to-render sentence.
 */
export type WorklistSummaryView = {
  readonly view: WorklistView | null;
  readonly total: number;
  readonly shown: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly filtered: boolean;
  readonly label: string;
};

/**
 * The PAGINATION affordances — whether the surface can page forward / back (REUSED from the session's own
 * selectors, never re-derived), and the current window (page size, offset). A surface binds its next / prev
 * controls to these; it does not compute them from `has_more` itself.
 */
export type WorklistPaginationView = {
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly pageSize: number | null;
  readonly offset: number;
};

/** The EMPTY verdict — whether the (ready) worklist has no entries, and the message to show if so. */
export type WorklistEmptyStateView = {
  readonly isEmpty: boolean;
  readonly message: string;
};

/**
 * The LOADING verdict — whether a read is in flight, whether it is the FIRST read (no page yet, so a surface
 * shows a full placeholder) versus a refresh over an existing page (an inline indicator), and the message.
 */
export type WorklistLoadingStateView = {
  readonly isLoading: boolean;
  readonly isInitialLoad: boolean;
  readonly message: string;
};

/**
 * The ERROR verdict — whether the last read failed, the message to show, and whether a stale-but-good page is
 * still retained (so a surface can show the last worklist under an error banner rather than a blank screen).
 */
export type WorklistErrorStateView = {
  readonly isError: boolean;
  readonly message: string | null;
  readonly hasStalePage: boolean;
};

/**
 * A WORKLIST VIEW MODEL — the whole presentation-ready projection of a {@link WorklistSessionState}: the load
 * `status`, the display `rows`, the `summary` header, the `pagination` affordances, and the `empty` /
 * `loading` / `error` lifecycle verdicts. It is PLAIN DATA — immutable, deterministic, UI-agnostic — and
 * carries NO organisation.
 */
export type WorklistViewModel = {
  readonly status: WorklistSessionStatus;
  readonly rows: readonly WorklistRow[];
  readonly summary: WorklistSummaryView;
  readonly pagination: WorklistPaginationView;
  readonly empty: WorklistEmptyStateView;
  readonly loading: WorklistLoadingStateView;
  readonly error: WorklistErrorStateView;
};

// ---------------------------------------------------------------------
// Display messages — the fixed copy a surface renders (kept in one place).
// ---------------------------------------------------------------------

const SUMMARY_EMPTY = "No conversations";
const EMPTY_FILTERED = "No conversations match the current filter.";
const EMPTY_VIEW = "This worklist is empty.";
const LOADING_INITIAL = "Loading conversations…";
const LOADING_REFRESH = "Refreshing…";

// ---------------------------------------------------------------------
// Helpers — humanise a coded token; decide whether a filter narrows anything.
// ---------------------------------------------------------------------

/**
 * Humanise a coded token for display — underscores to spaces, first letter capitalised (`human_review` →
 * "Human review"). A generic, deterministic label transform; it re-declares no worklist vocabulary and
 * derives no attribute — it only formats a value the entry already carries.
 */
function humaniseToken(token: string): string {
  const spaced = token.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whether a filter is active — present with at least one constrained field. Pure. */
function isFilterActive(filter: WorklistFilter | undefined): boolean {
  if (!filter) return false;
  return Object.values(filter).some((value) => value !== undefined);
}

/** Project one already-derived entry to a display row — a pure label mapping, no re-derivation. */
function toWorklistRow(entry: WorklistEntry): WorklistRow {
  return {
    coordinationId: entry.coordination_id,
    conversationId: entry.conversation_id,
    priority: entry.priority,
    priorityLabel: humaniseToken(entry.priority),
    priorityRank: entry.priority_rank,
    categories: entry.categories,
    categoryLabels: entry.categories.map(humaniseToken),
    mode: entry.mode,
    modeLabel: humaniseToken(entry.mode),
    requiresHuman: entry.requires_human,
    at: entry.at,
  };
}

// ---------------------------------------------------------------------
// DERIVATIONS — each a total, deterministic function of the session state.
// ---------------------------------------------------------------------

/**
 * PRESENTATION derivation — the display rows. Maps the current page's already-ordered entries to
 * {@link WorklistRow}s in the SAME order (the session's, from the stack below); with no page loaded it is the
 * empty list. It re-orders and re-paginates nothing. Pure.
 */
export function deriveWorklistPresentation(state: WorklistSessionState): readonly WorklistRow[] {
  const items = state.page?.items ?? [];
  return items.map(toWorklistRow);
}

/**
 * SUMMARY derivation — the count / range header. Reads the page's `total`, `offset` and shown count to
 * compute a 1-based range and a ready-to-render label; with no page (or an empty result) it is the "no
 * conversations" summary. Pure.
 */
export function deriveWorklistSummary(state: WorklistSessionState): WorklistSummaryView {
  const view = state.request.view ?? null;
  const filtered = isFilterActive(state.request.filter);
  const page = state.page;
  if (!page || page.total === 0) {
    return { view, total: 0, shown: 0, rangeStart: 0, rangeEnd: 0, filtered, label: SUMMARY_EMPTY };
  }
  const shown = page.items.length;
  const rangeStart = shown === 0 ? 0 : page.offset + 1;
  const rangeEnd = page.offset + shown;
  const label = `Showing ${rangeStart}–${rangeEnd} of ${page.total}`;
  return { view, total: page.total, shown, rangeStart, rangeEnd, filtered, label };
}

/**
 * PAGINATION derivation — the navigation affordances. REUSES the session's {@link hasNextWorklistPage} /
 * {@link hasPreviousWorklistPage} selectors (the session stays authoritative on paging) and echoes the
 * current window. Pure.
 */
export function deriveWorklistPagination(state: WorklistSessionState): WorklistPaginationView {
  return {
    hasNext: hasNextWorklistPage(state),
    hasPrevious: hasPreviousWorklistPage(state),
    pageSize: state.request.page?.limit ?? null,
    offset: state.request.page?.offset ?? 0,
  };
}

/**
 * EMPTY-STATE derivation — empty exactly when a read has succeeded (`ready`) and returned no entries. The
 * message distinguishes an empty filter result from an empty worklist. When not ready it is not "empty" (it
 * is loading or errored). Pure.
 */
export function deriveWorklistEmptyState(state: WorklistSessionState): WorklistEmptyStateView {
  const isEmpty = state.status === "ready" && (state.page?.items.length ?? 0) === 0;
  if (!isEmpty) return { isEmpty: false, message: "" };
  return { isEmpty: true, message: isFilterActive(state.request.filter) ? EMPTY_FILTERED : EMPTY_VIEW };
}

/**
 * LOADING-STATE derivation — loading exactly when a read is in flight. `isInitialLoad` distinguishes the
 * first read (no page yet ⇒ a full placeholder) from a refresh over an existing page (⇒ an inline
 * indicator). Pure.
 */
export function deriveWorklistLoadingState(state: WorklistSessionState): WorklistLoadingStateView {
  const isLoading = state.status === "loading";
  const isInitialLoad = isLoading && state.page === null;
  const message = !isLoading ? "" : isInitialLoad ? LOADING_INITIAL : LOADING_REFRESH;
  return { isLoading, isInitialLoad, message };
}

/**
 * ERROR-STATE derivation — errored exactly when the last read failed. Surfaces the message and whether a
 * stale-but-good page is still retained, so a surface can keep showing the last worklist under an error
 * banner. Pure.
 */
export function deriveWorklistErrorState(state: WorklistSessionState): WorklistErrorStateView {
  const isError = state.status === "error";
  return { isError, message: isError ? state.error : null, hasStalePage: isError && state.page !== null };
}

/**
 * Derive the whole {@link WorklistViewModel} from a {@link WorklistSessionState} — compose the presentation,
 * summary, pagination and the three lifecycle verdicts into one presentation-ready projection. Total,
 * deterministic and read-only: the same state always yields the same view model. THE single presentation
 * entry point.
 */
export function deriveWorklistViewModel(state: WorklistSessionState): WorklistViewModel {
  return {
    status: state.status,
    rows: deriveWorklistPresentation(state),
    summary: deriveWorklistSummary(state),
    pagination: deriveWorklistPagination(state),
    empty: deriveWorklistEmptyState(state),
    loading: deriveWorklistLoadingState(state),
    error: deriveWorklistErrorState(state),
  };
}

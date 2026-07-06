// =====================================================================
// THE CONVERSATION WORKLIST READ SURFACE — PURE CORE (CEO Directive #018, R39: CONVERSATION WORKLIST
// READ SURFACE).
//
// R38 shipped the Conversation Coordination WORKLIST ENGINE — the pure core that DERIVES a
// {@link WorklistSet} (the three directed worklists — human-review / recovery / escalation — and the
// unified `prioritised` backlog) from the coordinations the R37 Read Model records, and its org-scoped
// runtime reader. Nothing yet gave a future operational capability a STABLE, BOUNDED, FILTERABLE way to
// READ those worklists: R38 derives the whole set, in full, every read. R39 is the NEXT — the single,
// canonical QUERY SURFACE over the derived worklists: "given the worklists the engine DERIVED, let a
// consumer SELECT one, NARROW it to what it cares about, and read it a BOUNDED PAGE at a time, in a
// STABLE order" — the READ SURFACE.
//
// IT READS WORKLISTS — IT NEVER ASSIGNS, DISPATCHES OR EXECUTES WORK. The Read Surface takes the
// {@link WorklistSet} the R38 engine derived and applies three PURE query operations: it SELECTS one
// worklist ({@link readWorklistView}), FILTERS it by a closed set of query predicates over already-
// derived attributes ({@link filterWorklistEntries}), and returns a BOUNDED PAGE in the engine's own
// canonical order ({@link paginateWorklistEntries}). It assigns nobody, dispatches nothing, notifies no
// one, enqueues into no operational system, schedules nothing and retries nothing — assignment,
// dispatch, notifications, scheduling and retries are EXPLICIT R39 non-goals. A read surface is the
// single authorised place a future, explicitly-authorised operational capability (a queue, a dashboard,
// an automation) reads a worklist from — never an act to carry it out.
//
// THE WORKLIST ENGINE REMAINS AUTHORITATIVE — THE READ SURFACE CONSUMES ITS WORKLISTS, IT NEVER
// RE-DERIVES ONE. This core's ONLY worklist input is the R38 {@link WorklistSet} — already grouped,
// already prioritised, already ordered. It RE-READS each entry's already-derived fields (priority,
// categories, mode, requires-human, conversation) to FILTER, and it PAGES a copy; it never re-groups a
// coordination, never re-derives a priority, never re-implements the worklist order. FILTERING is the
// Read Surface's OWN contribution — a query predicate over derived attributes, NOT a re-derivation of a
// worklist (which R38 alone owns). Because a worklist set only exists when R38 derived it from the
// coordinations R37 read (which only exist behind R36→R29's recorded, policy-cleared, human-reviewed
// stack), consuming the Worklist Engine here TRANSITIVELY preserves the Worklist Engine's authority —
// and, through it, the Coordination Read Model's, the Coordination Engine's, and the whole stack below.
// No duplicate worklist logic; no second source of truth.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING, READS NO DB AND OPENS NO EXECUTION PATH. Like
// every core in this stack, a page of a worklist is a TOTAL, DETERMINISTIC function of an already-
// computed input — the {@link WorklistSet} the runtime handed in and the query it was asked. The pure
// core adds NO column and NO migration (it introduces no relation of its own: it reads entirely from the
// R38 set, so the Read Model stays the single query surface over recorded coordinations), reaches NO
// provider, NO ledger, NO DB, NO clock, NO RNG and — the cardinal rule shared with the whole stack — NO
// MODEL: the same set and the same query always yield the same page. WHICH org's worklists are read
// (org-scoped) is the server runtime's job, through the R38 reader; this core only shapes what it is
// given.
//
// THE ORDER IS R38's, REUSED — THE SURFACE DEFINES NONE OF ITS OWN. Every page is returned in the R38
// canonical worklist order (priority first, then the R37 recency order) REUSED verbatim via
// {@link orderWorklistEntries}; the surface FILTERS and PAGES that order, it never re-sorts. So a page
// reconstructs IDENTICALLY every read, and "the worklist order" lives in exactly ONE place across R37,
// R38 and R39.
// =====================================================================

import {
  orderWorklistEntries,
  type WorklistEntry,
  type WorklistSet,
  type WorklistCategory,
  type CoordinationPriority,
} from "@/lib/receptionist/conversation-coordination-worklist";
import type { CoordinationMode } from "@/lib/receptionist/conversation-coordination";

// ---------------------------------------------------------------------
// The READ-SURFACE vocabulary — the worklists a consumer can select, and the query it may pose.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of WORKLIST VIEWS — the worklists the Read Surface can be asked to read. One per
 * field of the R38 {@link WorklistSet}: the unified `prioritised` backlog and the three directed
 * worklists. A closed const tuple, so a consumer can switch exhaustively; naming a view SELECTS which
 * already-derived list to read — it derives nothing.
 */
export const WORKLIST_VIEWS = [
  "prioritised",
  "human_review",
  "recovery",
  "escalation",
] as const;

/** One worklist a consumer can select to read. */
export type WorklistView = (typeof WORKLIST_VIEWS)[number];

/**
 * A WORKLIST FILTER — the closed, composable set of query predicates the Read Surface narrows a worklist
 * by. Every field is OPTIONAL; an omitted field is UNCONSTRAINED. A present field NARROWS by the entry's
 * ALREADY-DERIVED attribute (never a re-derivation): the array fields keep entries whose attribute is in
 * the set (an empty array therefore matches nothing), and the scalar fields keep entries that equal it.
 * All present constraints are AND-ed. Filtering is the Read Surface's own query contribution — it reads
 * what R38 derived, it re-derives no worklist.
 */
export type WorklistFilter = {
  /** Keep entries whose DERIVED priority is in this set. */
  priorities?: readonly CoordinationPriority[];
  /** Keep entries whose RECORDED mode is in this set. */
  modes?: readonly CoordinationMode[];
  /** Keep entries whose DERIVED categories include EVERY category listed (a superset match). */
  categories?: readonly WorklistCategory[];
  /** Keep entries whose SURFACED `requires_human` flag equals this. */
  requires_human?: boolean;
  /** Keep entries for exactly this conversation. */
  conversation_id?: string;
};

/**
 * A PAGE REQUEST — a bounded window over the stably-ordered, filtered worklist. `limit` is the page size
 * (a positive integer); `offset` is how many entries to skip (a non-negative integer, default 0). A
 * request with an invalid bound is rejected — the surface never silently returns a malformed page.
 */
export type WorklistPageRequest = {
  /** The page size — a positive integer. */
  limit: number;
  /** How many entries to skip before the page — a non-negative integer (default 0). */
  offset?: number;
};

/**
 * A WORKLIST QUERY — select a {@link WorklistView}, optionally NARROW it with a {@link WorklistFilter},
 * and optionally BOUND it with a {@link WorklistPageRequest}. With no filter the whole view is read;
 * with no page the whole (filtered) view is returned as a single page.
 */
export type WorklistQuery = {
  /** Which worklist to read. */
  view: WorklistView;
  /** Optional narrowing predicate; omitted ⇒ the whole view. */
  filter?: WorklistFilter;
  /** Optional bounded window; omitted ⇒ the whole (filtered) view in one page. */
  page?: WorklistPageRequest;
};

/**
 * A PAGE of a worklist — the read-only result the Read Surface returns. `items` is the page's entries in
 * the R38 canonical order; `total` is how many entries matched the filter BEFORE pagination; `limit` and
 * `offset` echo the applied window (when no page was requested, `limit` is the whole matching count and
 * `offset` is 0); `has_more` is true when entries remain beyond this page. A consumer pages by advancing
 * `offset` until `has_more` is false.
 */
export type WorklistPage = {
  /** Which worklist this page was drawn from. */
  view: WorklistView;
  /** The page's entries, in the R38 canonical (priority-then-recency) order. */
  items: WorklistEntry[];
  /** How many entries matched the filter, before pagination. */
  total: number;
  /** The applied page size (the whole matching count when no page was requested). */
  limit: number;
  /** The applied offset (0 when no page was requested). */
  offset: number;
  /** Whether entries remain beyond this page. */
  has_more: boolean;
};

// ---------------------------------------------------------------------
// SELECTION — read one worklist from the derived set.
// ---------------------------------------------------------------------

/**
 * Select one worklist from the R38 {@link WorklistSet} — a pure lookup, defined in exactly one place. It
 * returns the engine's already-ordered list VERBATIM (the Read Surface re-derives no worklist); the
 * `never` guard makes the view switch exhaustive at compile time.
 */
export function readWorklistView(set: WorklistSet, view: WorklistView): WorklistEntry[] {
  switch (view) {
    case "prioritised":
      return set.prioritised;
    case "human_review":
      return set.human_review;
    case "recovery":
      return set.recovery;
    case "escalation":
      return set.escalation;
    default: {
      const _exhaustive: never = view;
      throw new Error(`unreachable worklist view: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------
// FILTERING — narrow a worklist by a closed set of predicates over already-derived attributes.
// ---------------------------------------------------------------------

/**
 * Whether a worklist entry matches a {@link WorklistFilter} — the query predicate, defined in exactly one
 * place. Every present constraint must hold (AND); an omitted constraint is unconstrained. Each predicate
 * READS an already-derived / surfaced attribute of the entry and NEVER recomputes it. Pure and total.
 */
export function matchesWorklistFilter(entry: WorklistEntry, filter: WorklistFilter): boolean {
  if (filter.priorities && !filter.priorities.includes(entry.priority)) return false;
  if (filter.modes && !filter.modes.includes(entry.mode)) return false;
  if (filter.categories && !filter.categories.every((c) => entry.categories.includes(c))) return false;
  if (filter.requires_human !== undefined && entry.requires_human !== filter.requires_human) return false;
  if (filter.conversation_id !== undefined && entry.conversation_id !== filter.conversation_id) return false;
  return true;
}

/**
 * Return a NEW array of the entries that match the filter, in the input's order (order-preserving). With
 * no filter it returns a copy of the input unchanged. Non-mutating: a caller's array is never reordered
 * or narrowed under it. Pure.
 */
export function filterWorklistEntries(
  entries: readonly WorklistEntry[],
  filter?: WorklistFilter,
): WorklistEntry[] {
  if (!filter) return [...entries];
  return entries.filter((entry) => matchesWorklistFilter(entry, filter));
}

// ---------------------------------------------------------------------
// PAGINATION — return a bounded window of a worklist, with the metadata to page it.
// ---------------------------------------------------------------------

/**
 * Return a bounded PAGE of the entries, plus the metadata to page them. With no page request the whole
 * input is returned as one page (`limit` = the whole count, `offset` = 0, `has_more` = false). With a
 * page request the bounds are VALIDATED (`limit` a positive integer, `offset` a non-negative integer) —
 * an invalid bound throws, so the surface never returns a malformed page — and the window is sliced from
 * a copy. Non-mutating and pure; `has_more` is true exactly when entries remain beyond the page.
 */
export function paginateWorklistEntries(
  entries: readonly WorklistEntry[],
  page?: WorklistPageRequest,
): Omit<WorklistPage, "view"> {
  const total = entries.length;
  if (!page) {
    return { items: [...entries], total, limit: total, offset: 0, has_more: false };
  }
  const { limit } = page;
  const offset = page.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`worklist page limit must be a positive integer, received ${String(limit)}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`worklist page offset must be a non-negative integer, received ${String(offset)}`);
  }
  const items = entries.slice(offset, offset + limit);
  return { items, total, limit, offset, has_more: offset + items.length < total };
}

// ---------------------------------------------------------------------
// QUERY — select, filter, order (reused), page: the single read-surface entry point.
// ---------------------------------------------------------------------

/**
 * Answer a {@link WorklistQuery} against a derived {@link WorklistSet} — THE read-surface projection. It
 * SELECTS the requested view, FILTERS it by the (optional) predicate, re-asserts the R38 canonical order
 * (REUSED via {@link orderWorklistEntries}, never re-implemented — so the page is stably ordered as a
 * self-contained guarantee of the surface), and returns the requested (optional) PAGE. Pure, total and
 * deterministic: the same set and the same query always yield the same page. It reads the worklists R38
 * derived and re-derives none — the Worklist Engine stays authoritative.
 */
export function queryWorklist(set: WorklistSet, query: WorklistQuery): WorklistPage {
  const selected = readWorklistView(set, query.view);
  const filtered = filterWorklistEntries(selected, query.filter);
  const ordered = orderWorklistEntries(filtered);
  return { view: query.view, ...paginateWorklistEntries(ordered, query.page) };
}

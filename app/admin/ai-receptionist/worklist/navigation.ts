import type { WorklistView } from "@/lib/receptionist/conversation-worklist-view-model";

// =====================================================================
// THE CONVERSATION WORKLIST OPERATOR SURFACE — NAVIGATION (CEO Directive #018, R44: READ-ONLY WORKLIST
// OPERATOR SURFACE).
//
// The surface's PURE navigation arithmetic, kept out of the JSX so it can be reasoned about and unit-tested
// on its own. It declares WHICH worklists the surface can show (as navigation TABS), normalises the URL's
// `?view=` / `?offset=` into a safe view + page window, and builds the hrefs the tabs and page controls
// point at. It is presentation CHROME — it derives no worklist, answers no query and reaches no I/O.
//
// It names the four views ONLY as navigation targets, typed against the R43 view model's {@link WorklistView}
// so a mistyped view is a COMPILE error. The worklist DATA — which entries belong on a view, in what order,
// on which page — is the stack below's (R38 derives, R39 answers, R40 serves, R41/R42/R43 consume); this
// module chooses none of it, it only lets an operator ASK for a view and a page.
// =====================================================================

/** The base path of the operator surface — every navigation href is anchored here. */
const BASE_PATH = "/admin/ai-receptionist/worklist";

/**
 * The fixed page size the surface requests. Pagination is by whole pages of this size; the surface exposes
 * no page-size control (an R44 non-goal — it only DISPLAYS pagination, it does not reshape the read).
 */
export const WORKLIST_PAGE_SIZE = 25;

/**
 * The four worklists the surface presents, as navigation TABS: the coded {@link WorklistView} plus its
 * display label, in the surface's presentation order (the prioritised backlog first). Typed against
 * {@link WorklistView} so the compiler rejects any view the stack below cannot answer — the surface names
 * the views it can SHOW, it derives none of them.
 */
export const WORKLIST_VIEW_TABS: readonly { readonly view: WorklistView; readonly label: string }[] = [
  { view: "prioritised", label: "Prioritised" },
  { view: "human_review", label: "Human review" },
  { view: "recovery", label: "Recovery" },
  { view: "escalation", label: "Escalation" },
];

/** The view the surface opens on when the URL names none (or names an unknown one) — the prioritised backlog. */
const DEFAULT_VIEW: WorklistView = "prioritised";

/** The set of view tokens the surface recognises — derived from the tabs so the two can never drift. */
const KNOWN_VIEWS: ReadonlySet<string> = new Set(WORKLIST_VIEW_TABS.map((tab) => tab.view));

/**
 * Normalise a `?view=` parameter to a known {@link WorklistView}, defaulting to the prioritised backlog. An
 * absent or unrecognised view collapses to the default — the surface can only ever ask for a view it can show.
 */
export function parseWorklistViewParam(raw: string | undefined): WorklistView {
  return raw !== undefined && KNOWN_VIEWS.has(raw) ? (raw as WorklistView) : DEFAULT_VIEW;
}

/**
 * Normalise a `?offset=` parameter to a non-negative integer, defaulting to 0. Anything non-numeric, negative
 * or fractional collapses to 0 — the first page. The surface never asks the API for a nonsensical window.
 */
export function parseOffsetParam(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

/** The offset of the NEXT page — a pure step forward by one page. */
export function nextOffset(offset: number, pageSize: number): number {
  return offset + pageSize;
}

/** The offset of the PREVIOUS page — a pure step back by one page, clamped at the first page. */
export function previousOffset(offset: number, pageSize: number): number {
  return Math.max(0, offset - pageSize);
}

/**
 * Build the surface href for a given view + offset — the anchor for every tab and page control. Offset 0 is
 * omitted so the first page has a clean URL.
 */
export function worklistPath(view: WorklistView, offset: number): string {
  const params = new URLSearchParams({ view });
  if (offset > 0) params.set("offset", String(offset));
  return `${BASE_PATH}?${params.toString()}`;
}

// =====================================================================
// THE CONVERSATION WORKLIST API — REQUEST CONTRACT CORE (CEO Directive #018, R40: CONVERSATION WORKLIST
// API).
//
// R39 shipped the Conversation Worklist Read Surface — the single authorised QUERY surface over the
// read-only worklists the R38 engine derives (`queryOrgWorklist` / `queryConversationWorklist`, each
// answering a {@link WorklistQuery} against an org's derived {@link WorklistSet}). Nothing yet gave an
// AUTHENTICATED application caller a way to pose such a query over HTTP. R40 is the NEXT — the canonical
// Conversation Worklist API: the single authorised APPLICATION INTERFACE for querying Conversation
// Worklists. This module is its PURE REQUEST CONTRACT: it translates the untrusted query string of an
// HTTP request into a validated {@link WorklistQuery} — nothing more.
//
// IT PARSES A QUERY — IT NEVER READS, DERIVES OR EXECUTES. The API's route handler
// (`app/api/receptionist/worklists/route.ts`) authenticates the caller and resolves the caller's
// organisation from the SESSION, then hands this core the request's search params; this core validates
// them and returns a {@link WorklistQuery} the handler passes straight to the R39 read surface. This core
// creates no client, reads no worklist, touches no database, opens no execution path — it is a total,
// deterministic function from a query string to a query object.
//
// IT HAS NO CONCEPT OF ORGANISATION — SO ORGANISATION CAN ONLY COME FROM THE SESSION. The request
// contract deliberately parses ONLY the read-surface query dimensions: the worklist VIEW, the FILTER
// (priority / mode / category / requires-human / conversation) and the PAGE (limit / offset). It parses
// NO organisation identifier of any kind. Because the parsed query carries no org, the route handler can
// only ever scope the read by the org it resolved from the authenticated session (never a client-supplied
// value) — organisation isolation is a STRUCTURAL property of the contract, not a runtime check that
// could be forgotten. A caller cannot ask this API for another organisation's worklist because the
// vocabulary to express that request does not exist.
//
// IT REUSES THE R38/R39 VOCABULARY — IT FORKS NONE. The valid views, priorities and categories are the
// R39 / R38 vocabularies REUSED verbatim ({@link WORKLIST_VIEWS}, {@link COORDINATION_PRIORITIES},
// {@link WORKLIST_CATEGORIES}); this core declares no vocabulary of its own and re-derives no worklist. A
// malformed request (an unknown view, an out-of-range page, a non-boolean flag) is rejected with a typed
// {@link WorklistQueryError} the handler maps to a 400 — the API never silently coerces an unsafe query.
// =====================================================================

import {
  WORKLIST_VIEWS,
  type WorklistView,
  type WorklistFilter,
  type WorklistPageRequest,
  type WorklistQuery,
} from "@/lib/receptionist/conversation-worklist-read-surface";
import {
  COORDINATION_PRIORITIES,
  WORKLIST_CATEGORIES,
  type CoordinationPriority,
  type WorklistCategory,
} from "@/lib/receptionist/conversation-coordination-worklist";
import type { CoordinationMode } from "@/lib/receptionist/conversation-coordination";

// ---------------------------------------------------------------------
// The API request-contract defaults and bounds.
// ---------------------------------------------------------------------

/** The worklist read when the request names no view — the unified prioritised backlog. */
export const DEFAULT_WORKLIST_VIEW: WorklistView = "prioritised";

/** The page size applied when the request names no `limit` — a bounded page, never the whole worklist. */
export const DEFAULT_WORKLIST_LIMIT = 50;

/** The largest page a single request may ask for — the API always returns a bounded page. */
export const MAX_WORKLIST_LIMIT = 200;

/**
 * A malformed WORKLIST QUERY — the request's query string could not be parsed into a valid
 * {@link WorklistQuery} (an unknown view, an unknown priority/category, a non-boolean flag, or an
 * out-of-range page bound). It is a CLIENT error: the route handler maps it to an HTTP 400. It is never
 * thrown for an absent parameter (every parameter has a safe default) — only for a PRESENT, invalid one.
 */
export class WorklistQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorklistQueryError";
  }
}

// ---------------------------------------------------------------------
// Dimension parsers — each reads ONE request parameter, validates it, and defaults when absent.
// ---------------------------------------------------------------------

/** The requested worklist view, defaulting to the prioritised backlog; an unknown view is a 400. */
function parseView(raw: string | null): WorklistView {
  if (raw === null || raw.trim() === "") return DEFAULT_WORKLIST_VIEW;
  const value = raw.trim();
  if ((WORKLIST_VIEWS as readonly string[]).includes(value)) return value as WorklistView;
  throw new WorklistQueryError(
    `unknown worklist view "${value}" (expected one of: ${WORKLIST_VIEWS.join(", ")})`,
  );
}

/**
 * Parse a comma-separated list against a CLOSED vocabulary (priorities, categories). An absent/empty
 * parameter is unconstrained (undefined); a present value with any unknown member is a 400. The valid
 * members are the R38 vocabulary REUSED — this contract forks none.
 */
function parseEnumList<T extends string>(
  raw: string | null,
  vocabulary: readonly string[],
  name: string,
): readonly T[] | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (!vocabulary.includes(value)) {
      throw new WorklistQueryError(
        `unknown ${name} "${value}" (expected one of: ${vocabulary.join(", ")})`,
      );
    }
  }
  return values as unknown as readonly T[];
}

/**
 * Parse a comma-separated list of coordination modes. Modes have no runtime vocabulary tuple to reuse, so
 * values are passed THROUGH to the read-surface filter unchanged (an unrecognised mode simply matches no
 * entries — it is not a 400). This contract declares no mode vocabulary of its own.
 */
function parseModeList(raw: string | null): readonly CoordinationMode[] | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return values.length > 0 ? (values as readonly CoordinationMode[]) : undefined;
}

/** Parse a strict boolean flag ("true"/"false"); absent is unconstrained (undefined); anything else is a 400. */
function parseBoolean(raw: string | null, name: string): boolean | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WorklistQueryError(`${name} must be "true" or "false", received "${value}"`);
}

/** Parse a bounded integer parameter; absent uses the fallback; out-of-range or non-integer is a 400. */
function parseBoundedInt(
  raw: string | null,
  opts: { name: string; min: number; max?: number; fallback: number },
): number {
  if (raw === null || raw.trim() === "") return opts.fallback;
  const value = Number(raw.trim());
  const withinMax = opts.max === undefined || value <= opts.max;
  if (!Number.isInteger(value) || value < opts.min || !withinMax) {
    const ceiling = opts.max === undefined ? `>= ${opts.min}` : `between ${opts.min} and ${opts.max}`;
    throw new WorklistQueryError(`${opts.name} must be an integer ${ceiling}, received "${raw}"`);
  }
  return value;
}

// ---------------------------------------------------------------------
// The request contract — translate a request's search params into a validated WorklistQuery.
// ---------------------------------------------------------------------

/**
 * Translate an HTTP request's search params into a validated {@link WorklistQuery} — THE API request
 * contract. It parses the worklist VIEW (default: prioritised), an optional FILTER over already-derived
 * attributes (priority / mode / category / requires-human / conversation), and a bounded PAGE (limit
 * default {@link DEFAULT_WORKLIST_LIMIT}, capped at {@link MAX_WORKLIST_LIMIT}; offset default 0). A page
 * is ALWAYS returned, so the API never yields an unbounded worklist. It reads NO organisation parameter —
 * organisation scope is the route handler's job, resolved from the authenticated session, never from the
 * request. Pure, total and deterministic; a present-but-invalid parameter throws {@link WorklistQueryError}
 * (a 400), an absent one takes its default.
 */
export function parseWorklistQuery(params: URLSearchParams): WorklistQuery {
  const view = parseView(params.get("view"));

  const priorities = parseEnumList<CoordinationPriority>(
    params.get("priority"),
    COORDINATION_PRIORITIES,
    "priority",
  );
  const modes = parseModeList(params.get("mode"));
  const categories = parseEnumList<WorklistCategory>(
    params.get("category"),
    WORKLIST_CATEGORIES,
    "category",
  );
  const requiresHuman = parseBoolean(params.get("requires_human"), "requires_human");
  const conversationRaw = params.get("conversation_id");
  const conversationId =
    conversationRaw && conversationRaw.trim().length > 0 ? conversationRaw.trim() : undefined;

  const filter: WorklistFilter = {};
  if (priorities) filter.priorities = priorities;
  if (modes) filter.modes = modes;
  if (categories) filter.categories = categories;
  if (requiresHuman !== undefined) filter.requires_human = requiresHuman;
  if (conversationId !== undefined) filter.conversation_id = conversationId;

  const page: WorklistPageRequest = {
    limit: parseBoundedInt(params.get("limit"), {
      name: "limit",
      min: 1,
      max: MAX_WORKLIST_LIMIT,
      fallback: DEFAULT_WORKLIST_LIMIT,
    }),
    offset: parseBoundedInt(params.get("offset"), { name: "offset", min: 0, fallback: 0 }),
  };

  return {
    view,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    page,
  };
}

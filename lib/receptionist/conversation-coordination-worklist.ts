// =====================================================================
// THE CONVERSATION COORDINATION WORKLIST ENGINE — PURE CORE (CEO Directive #018, R38: CONVERSATION
// COORDINATION WORKLIST ENGINE).
//
// R37 shipped the Conversation Coordination READ MODEL — the single, authorised query surface for
// recorded Conversation Coordination decisions (`receptionist_coordination_read_model` + the
// org-scoped reader `server/services/receptionist-coordination-view.ts`), each decision projected into
// a {@link CoordinationRecord} (its recorded mode / lead / plan / flags, six linked per-engine
// contexts, and provenance). Nothing yet DERIVED anything from those records: R37 exposes them, and
// its only consumer is a reader. R38 is the NEXT — the single, canonical authority over a question
// derived from the recorded coordinations above it: "given the coordinations the stack RECORDED, which
// need operational attention, HOW should they be PRIORITISED, and into which WORKLISTS should they be
// GROUPED?" — the WORKLIST.
//
// IT DERIVES WORKLISTS — IT NEVER ASSIGNS, DISPATCHES OR EXECUTES WORK. The Worklist Engine reads the
// coordinations the Read Model surfaces and derives, PURELY, a prioritised, read-only worklist: it
// GROUPS each recorded coordination into the worklists it belongs to (human-review / recovery /
// escalation), DERIVES an operational {@link CoordinationPriority} for it, and ORDERS the result. It
// assigns nobody, dispatches nothing, notifies no one, enqueues into no operational system, schedules
// nothing, retries nothing and reaches no provider — human assignment, operational dispatch, dashboard
// UI, notification delivery, automatic retries and scheduling are EXPLICIT R38 non-goals. The
// "worklist" R38 produces is the durable, auditable DERIVATION — the prioritised grouping a future,
// explicitly-authorised operational capability (a queue, a dashboard, an automation) reads to know what
// needs attention and in what order — never an act to carry it out.
//
// THE READ MODEL REMAINS AUTHORITATIVE — THE WORKLIST ENGINE CONSUMES ITS RECORDS, IT NEVER RE-DERIVES
// A COORDINATION. This core's ONLY coordination input is the R37 {@link CoordinationRecord} — the
// recorded decision, already projected. It RE-READS the recorded fields (mode, lead participant,
// requires-human) to GROUP and PRIORITISE; it never re-folds a mode from a route, never recomputes a
// lead, never re-derives `requires_human` / `autonomous`. The priority it derives is its OWN
// contribution — a mapping of the RECORDED mode onto an operational severity — NOT a re-derivation of
// the coordination decision (which R36 alone owns, and R37 alone surfaces). Because a coordination
// record only exists when R37 read a coordination R36 recorded (which only exists behind R35→R29's
// approved, policy-cleared, human-reviewed stack), consuming the Read Model here TRANSITIVELY preserves
// the Coordination Engine's authority — and, through it, Lifecycle's, Resolution's, Recovery's,
// Verification's and Fulfilment's. No duplicate coordination logic; no second source of truth.
//
// IT IS A PURE, DERIVED FUNCTION — IT PERSISTS NOTHING, READS NO DB AND OPENS NO EXECUTION PATH. Like
// every engine core in this stack, a worklist is a TOTAL, DETERMINISTIC function of an already-computed
// input — the set of coordination records the reader handed in. The pure core adds NO column and NO
// migration (it introduces no relation of its own: it derives entirely from the R37 records, so the
// Read Model stays the single query surface), reaches NO provider, NO ledger, NO DB, NO clock, NO RNG
// and — the cardinal rule shared with the whole stack — NO MODEL: the same set of records always yields
// the same worklists, in the same order. WHICH org's coordinations are read (org-scoped) is the server
// runtime's job, through the R37 reader; this core only shapes what it is given.
//
// THE ORDER IS DEFINED ONCE, ON TOP OF R37's. `compareWorklistEntries` is a TOTAL order — higher
// operational priority first, then the R37 canonical coordination order (newest first, stable tiebreak
// on coordination id) REUSED verbatim via {@link compareCoordinationRecords}, never re-implemented. So
// a worklist reconstructs IDENTICALLY every read, and the recency tiebreak lives in exactly ONE place
// across both increments.
// =====================================================================

import {
  compareCoordinationRecords,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";
import type {
  CoordinationMode,
  CoordinationParticipant,
} from "@/lib/receptionist/conversation-coordination";

// ---------------------------------------------------------------------
// The WORKLIST vocabulary — the closed set of worklists and operational priorities.
// ---------------------------------------------------------------------

/**
 * The closed vocabulary of WORKLIST CATEGORIES — the operational worklists a recorded coordination can
 * be GROUPED into. Each is a distinct LENS over the recorded decision, defined by its OWN predicate
 * (see {@link belongsToWorklist}); the lenses deliberately OVERLAP (an escalated coordination is on
 * BOTH the human-review and the escalation worklists), so this is a set of overlapping projections, NOT
 * a partition. R38 ships exactly THREE, one per directed worklist:
 *   • human_review — coordinations whose RECORDED `requires_human` flag is true (a human must handle the
 *                    coordinated response). Derived from the flag, not the mode, so it correctly
 *                    tracks "needs a human" even if a future lifecycle set the flag without escalating.
 *   • recovery     — coordinations whose RECORDED mode is `remediating` (the recover path; the lifecycle
 *                    was `retained`). The recovery-handling capability leads; tracked as work-in-flight.
 *   • escalation   — coordinations whose RECORDED mode is `escalating` (the escalate path; the lifecycle
 *                    was `escalated`). Routed to human attention.
 * A finalising / concluded coordination (the conversation is done, autonomously) belongs to NO worklist:
 * it needs no attention, so it is not actionable. A closed const tuple, so a consumer can switch
 * exhaustively and the filter order is stable.
 */
export const WORKLIST_CATEGORIES = ["human_review", "recovery", "escalation"] as const;

/** One operational worklist a recorded coordination can be grouped into. */
export type WorklistCategory = (typeof WORKLIST_CATEGORIES)[number];

/**
 * The closed vocabulary of COORDINATION PRIORITIES — the operational severity the Worklist Engine
 * DERIVES for a recorded coordination from its RECORDED mode. This is R38's OWN contribution (the Read
 * Model records the mode; the Worklist Engine maps it to a priority), ordered most-urgent first:
 *   • critical — a coordination that escalated (mode `escalating`; a human is required). Highest
 *                priority: it leads every worklist it is on.
 *   • elevated — a coordination on the recover path (mode `remediating`). Needs attention, below a
 *                human escalation.
 *   • routine  — a coordination that finalised (mode `finalising`; the conversation concluded
 *                autonomously). Lowest priority — and, being non-actionable, it populates NO worklist;
 *                the priority is derived for TOTALITY over every recorded coordination, not because a
 *                routine coordination is ever surfaced as work.
 * A closed union, ordered by {@link coordinationPriorityRank}. Naming a priority is NOT acting on it —
 * the priority is read by a future consumer to order attention, never used here to dispatch anything.
 */
export const COORDINATION_PRIORITIES = ["critical", "elevated", "routine"] as const;

/** One derived operational priority for a recorded coordination. */
export type CoordinationPriority = (typeof COORDINATION_PRIORITIES)[number];

/**
 * The RECORDED-mode → DERIVED-priority mapping — the single declarative table by which the Worklist
 * Engine assigns an operational severity to a recorded coordination. TOTAL over the whole
 * {@link CoordinationMode} vocabulary (the `Record` type makes exhaustiveness a COMPILE-TIME guarantee,
 * so a new mode cannot be added without deciding its priority here). It READS the recorded mode and
 * maps it; it never RE-DERIVES the mode (which R36 folded and R37 surfaced).
 */
const MODE_PRIORITY: Readonly<Record<CoordinationMode, CoordinationPriority>> = {
  escalating: "critical",
  remediating: "elevated",
  finalising: "routine",
};

/**
 * The priority → rank mapping — the ordinal by which {@link compareWorklistEntries} orders priorities
 * (lower rank = higher priority = ordered first). TOTAL over the whole {@link CoordinationPriority}
 * vocabulary, so the ordering can never encounter an unranked priority.
 */
const PRIORITY_RANK: Readonly<Record<CoordinationPriority, number>> = {
  critical: 0,
  elevated: 1,
  routine: 2,
};

// ---------------------------------------------------------------------
// The WORKLIST model — one derived entry, and the grouped set of worklists.
// ---------------------------------------------------------------------

/**
 * One WORKLIST ENTRY — a recorded coordination with the operational attributes the Worklist Engine
 * DERIVES for it, and a pointer to the full R37 record it was derived from. The DERIVED attributes
 * (`priority`, `priority_rank`, `categories`) are the engine's own contribution; the SURFACED
 * attributes (`lead_participant`, `requires_human`, `mode`, `at`, the ids) are read VERBATIM from the
 * record's recorded decision — copied to the entry for ergonomic reading, NEVER recomputed. The full
 * {@link CoordinationRecord} (recorded decision, six linked contexts, provenance) is carried on
 * `record`, so a consumer reads the complete coordination through the entry without a second query.
 */
export type WorklistEntry = {
  /** The coordination's ledger id — the entry's identity (mirrors `record.coordination_id`). */
  coordination_id: string;
  /** The owning organisation (mirrors `record.org_id`) — every entry is org-scoped by construction. */
  org_id: string;
  /** The conversation the coordination concerns (mirrors `record.conversation_id`), or null. */
  conversation_id: string | null;
  /** The worklists this coordination is grouped into — DERIVED, in canonical category order, ≥1 long. */
  categories: WorklistCategory[];
  /** The operational priority — DERIVED from the recorded mode. */
  priority: CoordinationPriority;
  /** The priority's ordinal (0 = most urgent) — DERIVED; the primary sort key of a worklist. */
  priority_rank: number;
  /** The capability the coordinated response centres on — SURFACED from the recorded decision. */
  lead_participant: CoordinationParticipant;
  /** Whether the coordinated response requires a human — SURFACED from the recorded decision. */
  requires_human: boolean;
  /** HOW the response was coordinated — SURFACED from the recorded decision. */
  mode: CoordinationMode;
  /** When the coordination was recorded (ISO instant) — SURFACED; the recency tiebreak of a worklist. */
  at: string;
  /** The full R37 projection this entry was derived from — the recorded decision, contexts, provenance. */
  record: CoordinationRecord;
};

/**
 * The grouped, ordered set of worklists derived from a set of recorded coordinations — the read-only
 * worklist projection every worklist reader returns. The three DIRECTED worklists (each an independently
 * ordered list of the coordinations that belong to it), plus `prioritised`: the unified actionable
 * backlog — the UNION of the three (each coordination once), ordered by {@link compareWorklistEntries},
 * where DERIVED priority actually drives cross-category ordering. Every list is newest-and-most-urgent
 * first; a coordination that is on more than one worklist appears once in each named list AND once in
 * `prioritised`.
 */
export type WorklistSet = {
  /** Coordinations whose recorded `requires_human` is true — a human must handle them. */
  human_review: WorklistEntry[];
  /** Coordinations on the recover path (recorded mode `remediating`). */
  recovery: WorklistEntry[];
  /** Coordinations that escalated (recorded mode `escalating`). */
  escalation: WorklistEntry[];
  /** The unified actionable backlog — every coordination on any worklist, once, priority-ordered. */
  prioritised: WorklistEntry[];
};

// ---------------------------------------------------------------------
// DERIVATION — the pure predicates, priority derivation and grouping.
// ---------------------------------------------------------------------

/**
 * Derive the operational {@link CoordinationPriority} of a recorded coordination — a pure mapping of its
 * RECORDED mode onto a severity, THE single place a coordination's priority is decided. It READS
 * `record.decision.mode` (which R36 folded and R37 surfaced) and maps it through {@link MODE_PRIORITY};
 * it re-derives NOTHING. Total and deterministic — the same record always derives the same priority.
 */
export function deriveCoordinationPriority(record: CoordinationRecord): CoordinationPriority {
  return MODE_PRIORITY[record.decision.mode];
}

/** The ordinal rank of a priority (0 = most urgent). Pure lookup through {@link PRIORITY_RANK}. */
export function coordinationPriorityRank(priority: CoordinationPriority): number {
  return PRIORITY_RANK[priority];
}

/**
 * Whether a recorded coordination belongs to a given worklist — the per-category predicate, defined in
 * exactly ONE place. Each predicate READS a RECORDED field of the decision and NEVER recomputes it:
 *   • human_review → the recorded `requires_human` flag is true;
 *   • recovery     → the recorded mode is `remediating`;
 *   • escalation   → the recorded mode is `escalating`.
 * Pure, total and deterministic; the `never` guard makes the category switch exhaustive at compile time.
 */
export function belongsToWorklist(
  record: CoordinationRecord,
  category: WorklistCategory,
): boolean {
  switch (category) {
    case "human_review":
      return record.decision.requires_human === true;
    case "recovery":
      return record.decision.mode === "remediating";
    case "escalation":
      return record.decision.mode === "escalating";
    default: {
      const _exhaustive: never = category;
      throw new Error(`unreachable worklist category: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Every worklist a recorded coordination is grouped into, in canonical category order (the order of
 * {@link WORKLIST_CATEGORIES}). Empty exactly when the coordination is NON-ACTIONABLE (a finalising /
 * concluded conversation that requires no human): such a coordination populates no worklist. Pure.
 */
export function worklistCategoriesOf(record: CoordinationRecord): WorklistCategory[] {
  return WORKLIST_CATEGORIES.filter((category) => belongsToWorklist(record, category));
}

/**
 * Project one recorded coordination into a {@link WorklistEntry} — THE single place a record becomes a
 * worklist entry. It DERIVES the priority, its rank and the categories, and SURFACES the recorded
 * lead / flag / mode / instant / ids verbatim; it re-derives no coordination decision. Pure and total —
 * the same record always projects to an identical entry.
 */
export function toWorklistEntry(record: CoordinationRecord): WorklistEntry {
  const priority = deriveCoordinationPriority(record);
  return {
    coordination_id: record.coordination_id,
    org_id: record.org_id,
    conversation_id: record.conversation_id,
    categories: worklistCategoriesOf(record),
    priority,
    priority_rank: coordinationPriorityRank(priority),
    lead_participant: record.decision.lead_participant,
    requires_human: record.decision.requires_human,
    mode: record.decision.mode,
    at: record.decision.at,
    record,
  };
}

// ---------------------------------------------------------------------
// ORDERING — the worklist order, defined once on top of the R37 canonical order.
// ---------------------------------------------------------------------

/**
 * The canonical WORKLIST order — a TOTAL order: higher operational PRIORITY first (lower
 * `priority_rank`), then, WITHIN a priority, the R37 canonical coordination order (newest coordination
 * first, stable tiebreak on coordination id) REUSED verbatim via {@link compareCoordinationRecords}.
 * The recency tiebreak is therefore defined in exactly ONE place across R37 and R38 — the worklist
 * order only ADDS the priority dimension on top of it, it never re-implements it. Pure and total.
 */
export function compareWorklistEntries(a: WorklistEntry, b: WorklistEntry): number {
  if (a.priority_rank !== b.priority_rank) return a.priority_rank < b.priority_rank ? -1 : 1;
  return compareCoordinationRecords(a.record, b.record);
}

/**
 * Return a NEW array of the entries in canonical (priority-then-recency) order. Non-mutating: it copies
 * before sorting, so a caller's array is never reordered under it. This is the single definition of
 * "the worklist order".
 */
export function orderWorklistEntries(entries: readonly WorklistEntry[]): WorklistEntry[] {
  return [...entries].sort(compareWorklistEntries);
}

/**
 * Derive the full {@link WorklistSet} from a set of recorded coordinations — THE read-only worklist
 * projection. It maps each record to an entry, keeps only the ACTIONABLE ones (those on at least one
 * worklist), and orders each named worklist and the unified `prioritised` backlog by the single
 * canonical worklist order. Pure, total and deterministic: the same set of records always derives the
 * same worklists, in the same order, regardless of input order. It reads the records the R37 reader
 * handed in and re-derives no coordination — the Read Model stays authoritative.
 */
export function deriveWorklists(records: readonly CoordinationRecord[]): WorklistSet {
  const actionable = records
    .map(toWorklistEntry)
    .filter((entry) => entry.categories.length > 0);
  const inCategory = (category: WorklistCategory): WorklistEntry[] =>
    orderWorklistEntries(actionable.filter((entry) => entry.categories.includes(category)));
  return {
    human_review: inCategory("human_review"),
    recovery: inCategory("recovery"),
    escalation: inCategory("escalation"),
    prioritised: orderWorklistEntries(actionable),
  };
}

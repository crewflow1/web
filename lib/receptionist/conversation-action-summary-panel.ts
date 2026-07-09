import type { CoordinationRecord } from "./conversation-coordination-view";
import type { OwnershipTimelineView } from "./conversation-ownership-timeline";

// =====================================================================
// THE CONVERSATION ACTION SUMMARY PANEL — PURE VIEW CORE (CEO Directive #018, R57: CONVERSATION ACTION SUMMARY PANEL).
//
// The Conversation Detail experience answers many questions across many surfaces: R45's detail view spells out the recorded
// coordination decision in full; R47's Claim Panel offers the single write affordance; R56's Ownership Timeline Panel narrates
// who has held the conversation. R57 adds the surface's canonical AT-A-GLANCE READ: the CONVERSATION ACTION SUMMARY PANEL — a
// single, compact, read-only digest of WHERE this coordinated conversation stands right now, so an operator sees the state
// without reading every panel below it.
//
// This module is that panel's PURE PRESENTATION CORE. It consumes ONLY the two authoritative, already-composed views the page
// has already read — it opens no seam of its own:
//   • the R37 {@link CoordinationRecord} — the canonical read of the RECORDED coordination decision (the R36 Coordination
//     Engine's mode + flags, folding the Lifecycle / Resolution / Recovery / Verification / Fulfilment / Orchestration facts).
//     From it the summary reads the CURRENT LIFECYCLE (`decision.lifecycle_state`), the CURRENT RESOLUTION
//     (`context.resolution?.state`), the CURRENT COORDINATION MODE (`decision.mode`) and the HUMAN-REQUIRED status
//     (`decision.requires_human`) — each STRAIGHT from the record, never recomputed;
//   • the R55 {@link OwnershipTimelineView} — the canonical ownership projection (the R48/R53 Read Model's present owner over
//     the R51 State Engine's append-only events). From it the summary reads the CURRENT OWNER and the OWNERSHIP HISTORY
//     SUMMARY (event count + span) — each COPIED from the composed view, never re-derived.
//
// IT DERIVES NO CONVERSATION STATE INDEPENDENTLY. Every fact it presents is one of those two authorities'. The Lifecycle
// Engine stays the sole authority over the lifecycle; the Resolution Engine over the resolution; the Coordination Engine over
// the mode + human-required flag; the Ownership State Engine over ownership. This core RE-DECIDES NONE OF THEM — it re-shapes
// their already-read outputs into a display digest: it humanises the recorded tokens, formats the instants, and writes the
// summary sentences. It imports the two view TYPES only (erased at runtime), so it is provably a projection over already-read
// facts, not a second reader — and it names neither engine, ledger, database client nor organisation of its own.
//
// IT REACHES NO I/O, NO CLOCK AND NO RNG — the SAME two views always project to the SAME summary. Timestamps are rendered by
// SLICING the ISO string (never a `Date` parse), so the projection is deterministic and zone-stable. It records nothing,
// decides nothing, names no viewer, grants no affordance, and introduces NO execution path: it claims nothing, releases
// nothing, transfers nothing, dispatches nothing, notifies no one, schedules nothing and completes nothing; it promotes no
// customer, retrieves no memory, and reaches no voice, WhatsApp or email channel — every one an explicit R57 non-goal.
// Organisation scoping is the RUNTIME's concern (every seam the page reads to compose the two views is org-scoped); this core
// is org-agnostic, projecting only the two views it is handed.
//
// What it exposes, a single pure projection over the two authoritative views:
//   • projectConversationActionSummary — an R37 {@link CoordinationRecord} + an R55 {@link OwnershipTimelineView} → the
//     {@link ConversationActionSummaryView}: the current LIFECYCLE, the current RESOLUTION, the current COORDINATION MODE, the
//     HUMAN-REQUIRED status, the current OWNER and the OWNERSHIP HISTORY summary — each humanised for display.
// =====================================================================

/** The placeholder shown for any absent (null / empty) value — the panel never invents a fact. */
const EM_DASH = "—";

/**
 * Humanise a recorded vocabulary token (a lifecycle state, a coordination mode, a resolution state) into a display label —
 * split on `_`/`-`, trim, and Title-Case each word. An absent token collapses to the em dash. Pure and total; it re-labels a
 * value the authoritative view already fixed, it re-derives nothing.
 */
function humaniseToken(token: string | null | undefined): string {
  if (token === null || token === undefined) return EM_DASH;
  const spaced = token.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return EM_DASH;
  return spaced
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Render an ISO-8601 instant as `YYYY-MM-DD HH:MM` by SLICING the calendar date and wall-clock minute directly — never a
 * `Date` parse — so the projection is deterministic and zone-stable (the same moment always renders identically). An absent
 * instant collapses to the em dash; a date-only value renders as the date alone. Pure and total.
 */
function formatSummaryInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return EM_DASH;
  const date = iso.slice(0, 10);
  const t = iso.indexOf("T");
  if (t === -1) return date;
  const time = iso.slice(t + 1, t + 6); // HH:MM
  return time ? `${date} ${time}` : date;
}

// The recorded-decision unions, referenced by INDEXED ACCESS off the R37 record's own types so this core pins the exact
// vocabulary without importing a third module (the engine's vocabulary reaches the summary only through the record it reads).
type LifecycleStateValue = CoordinationRecord["decision"]["lifecycle_state"];
type CoordinationModeValue = CoordinationRecord["decision"]["mode"];

/**
 * The CURRENT LIFECYCLE fact — the R37 record's `decision.lifecycle_state`, humanised. The Lifecycle Engine remains the sole
 * authority; this fact is copied from the recorded decision, never recomputed.
 *   • label      — the field's display label ("Lifecycle").
 *   • state      — the raw recorded lifecycle state (`closed` / `retained` / `escalated`).
 *   • stateLabel — that state, humanised ("Closed" / "Retained" / "Escalated").
 *   • summary    — a ready human sentence naming the recorded lifecycle.
 */
export type ConversationActionSummaryLifecycle = {
  readonly label: string;
  readonly state: LifecycleStateValue;
  readonly stateLabel: string;
  readonly summary: string;
};

/**
 * The CURRENT RESOLUTION fact — the R37 record's linked `context.resolution?.state`, humanised. The Resolution Engine remains
 * the sole authority; this fact is copied from the recorded resolution context, never recomputed. The context is legitimately
 * absent for some coordinations, so the value is nullable and the summary distinguishes recorded from unrecorded.
 *   • label      — the field's display label ("Resolution").
 *   • recorded   — whether a resolution state was recorded (the linked context is present with a state).
 *   • state      — the raw recorded resolution state, or null when unrecorded.
 *   • stateLabel — that state, humanised, or the em dash when unrecorded.
 *   • summary    — a ready human sentence naming the recorded resolution, or noting its absence.
 */
export type ConversationActionSummaryResolution = {
  readonly label: string;
  readonly recorded: boolean;
  readonly state: string | null;
  readonly stateLabel: string;
  readonly summary: string;
};

/**
 * The CURRENT COORDINATION MODE fact — the R37 record's `decision.mode`, humanised. The Coordination Engine remains the sole
 * authority; this fact is copied from the recorded decision, never recomputed.
 *   • label     — the field's display label ("Coordination mode").
 *   • mode      — the raw recorded mode (`finalising` / `remediating` / `escalating`).
 *   • modeLabel — that mode, humanised ("Finalising" / "Remediating" / "Escalating").
 *   • summary   — a ready human sentence naming the coordination mode.
 */
export type ConversationActionSummaryCoordination = {
  readonly label: string;
  readonly mode: CoordinationModeValue;
  readonly modeLabel: string;
  readonly summary: string;
};

/** The tone the human-required fact styles with — required (a human must act) or autonomous (no human needed). */
export type ConversationActionSummaryHumanTone = "required" | "autonomous";

/**
 * The HUMAN-REQUIRED status — the R37 record's `decision.requires_human`. The Coordination Engine remains the sole authority;
 * this fact is copied from the recorded decision, never recomputed.
 *   • label       — the field's display label ("Human required").
 *   • required    — whether the coordinated response requires human attention.
 *   • statusLabel — "Required" / "Not required".
 *   • tone        — "required" / "autonomous", for styling.
 *   • summary     — a ready human sentence describing the requirement.
 */
export type ConversationActionSummaryHumanRequired = {
  readonly label: string;
  readonly required: boolean;
  readonly statusLabel: string;
  readonly tone: ConversationActionSummaryHumanTone;
  readonly summary: string;
};

/** The tone the ownership fact styles with — held (an operator owns it now) or unheld (no one does). */
export type ConversationActionSummaryOwnershipTone = "held" | "unheld";

/**
 * The CURRENT OWNER + OWNERSHIP HISTORY summary — copied from the R55 {@link OwnershipTimelineView}. The Ownership State
 * Engine remains the sole authority; every field here is the composed timeline view's, never re-derived.
 *   • label            — the field's display label ("Ownership").
 *   • owned            — is the conversation held by an operator now?
 *   • statusLabel      — "Owned" / "Unowned".
 *   • tone             — "held" / "unheld", for styling.
 *   • currentOwnerLabel — WHO holds it now (the view's owner label), or null when unowned.
 *   • reassigned       — whether the current holder was reached BY a transfer rather than the original claim.
 *   • eventCount       — how many ownership events the history holds.
 *   • firstEventAt / lastEventAt — the span of the history, formatted (or the em dash when empty).
 *   • hasHistory       — whether any ownership event has been recorded.
 *   • summary          — a ready human sentence describing the present ownership.
 *   • historySummary   — a ready human sentence describing the recorded ownership history.
 */
export type ConversationActionSummaryOwnership = {
  readonly label: string;
  readonly owned: boolean;
  readonly statusLabel: string;
  readonly tone: ConversationActionSummaryOwnershipTone;
  readonly currentOwnerLabel: string | null;
  readonly reassigned: boolean;
  readonly eventCount: number;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly hasHistory: boolean;
  readonly summary: string;
  readonly historySummary: string;
};

/**
 * The panel's complete display model — the six at-a-glance facts R57 presents, each copied from an authoritative view and
 * humanised:
 *   • coordinationId / conversationId — the coordination + conversation the summary concerns (provenance).
 *   • lifecycle    — the current lifecycle (R37 decision).
 *   • resolution   — the current resolution (R37 linked context).
 *   • coordination — the current coordination mode (R37 decision).
 *   • humanRequired — the human-required status (R37 decision).
 *   • ownership    — the current owner + ownership history summary (R55 view).
 * Every field is one of the two authoritative views'; the summary re-derives none of them.
 */
export type ConversationActionSummaryView = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly lifecycle: ConversationActionSummaryLifecycle;
  readonly resolution: ConversationActionSummaryResolution;
  readonly coordination: ConversationActionSummaryCoordination;
  readonly humanRequired: ConversationActionSummaryHumanRequired;
  readonly ownership: ConversationActionSummaryOwnership;
};

/** Humanise the CURRENT LIFECYCLE from the R37 record's recorded decision — copied + labelled, never recomputed. Pure + total. */
function projectLifecycle(coordination: CoordinationRecord): ConversationActionSummaryLifecycle {
  const state = coordination.decision.lifecycle_state;
  const stateLabel = humaniseToken(state);
  return {
    label: "Lifecycle",
    state,
    stateLabel,
    summary: `The coordination lifecycle is recorded as ${stateLabel}.`,
  };
}

/** Humanise the CURRENT RESOLUTION from the R37 record's linked context — copied + labelled, never recomputed. Pure + total. */
function projectResolution(coordination: CoordinationRecord): ConversationActionSummaryResolution {
  const state = coordination.context.resolution?.state ?? null;
  const recorded = state !== null;
  return {
    label: "Resolution",
    recorded,
    state,
    stateLabel: humaniseToken(state),
    summary: recorded
      ? `The recorded resolution state is ${humaniseToken(state)}.`
      : "No resolution state has been recorded for this conversation.",
  };
}

/** Humanise the CURRENT COORDINATION MODE from the R37 record's recorded decision — copied + labelled, never recomputed. Pure. */
function projectCoordination(coordination: CoordinationRecord): ConversationActionSummaryCoordination {
  const mode = coordination.decision.mode;
  const modeLabel = humaniseToken(mode);
  return {
    label: "Coordination mode",
    mode,
    modeLabel,
    summary: `The response is coordinated in ${modeLabel} mode.`,
  };
}

/** Copy the HUMAN-REQUIRED status from the R37 record's recorded decision — never recomputed. Pure + total. */
function projectHumanRequired(coordination: CoordinationRecord): ConversationActionSummaryHumanRequired {
  const required = coordination.decision.requires_human;
  return {
    label: "Human required",
    required,
    statusLabel: required ? "Required" : "Not required",
    tone: required ? "required" : "autonomous",
    summary: required
      ? "This coordinated response requires human attention."
      : "This coordinated response is autonomous and requires no human attention.",
  };
}

/** Copy the CURRENT OWNER + OWNERSHIP HISTORY summary from the R55 view — never re-derived. Pure + total. */
function projectOwnershipSummary(ownership: OwnershipTimelineView): ConversationActionSummaryOwnership {
  const owned = ownership.owned;
  const currentOwnerLabel = owned && ownership.currentOwner ? ownership.currentOwner.label : null;
  const hasHistory = ownership.eventCount > 0;
  const firstEventAt = formatSummaryInstant(ownership.firstEventAt);
  const lastEventAt = formatSummaryInstant(ownership.lastEventAt);

  // The PRESENT ownership sentence — who holds it now, or why no one does (never claimed, or claimed then released).
  const summary =
    owned && currentOwnerLabel
      ? ownership.reassigned
        ? `Currently held by ${currentOwnerLabel}, by transfer.`
        : `Currently held by ${currentOwnerLabel}.`
      : hasHistory
        ? "No operator currently holds this conversation — it has been released."
        : "No operator has claimed this conversation yet.";

  // The HISTORY sentence — how many ownership events, and the span they cover (orthogonal to the present owner).
  const historySummary = hasHistory
    ? `${ownership.eventCount} ownership event${ownership.eventCount === 1 ? "" : "s"} recorded, ${firstEventAt} → ${lastEventAt}.`
    : "No ownership events have been recorded yet.";

  return {
    label: "Ownership",
    owned,
    statusLabel: owned ? "Owned" : "Unowned",
    tone: owned ? "held" : "unheld",
    currentOwnerLabel,
    reassigned: ownership.reassigned,
    eventCount: ownership.eventCount,
    firstEventAt,
    lastEventAt,
    hasHistory,
    summary,
    historySummary,
  };
}

/**
 * Project the panel's display model from the two authoritative views — the R37 {@link CoordinationRecord} and the R55
 * {@link OwnershipTimelineView}. Pure, total and deterministic. Each of the six facts is COPIED from the view that owns it
 * (the lifecycle, resolution, mode and human-required flag from the recorded coordination decision + its linked resolution
 * context; the current owner + history from the composed ownership timeline) and humanised for display. It records nothing,
 * decides nothing, names no viewer and RE-DERIVES NO CONVERSATION STATE — it presents the two composed views it is handed.
 */
export function projectConversationActionSummary(input: {
  coordination: CoordinationRecord;
  ownership: OwnershipTimelineView;
}): ConversationActionSummaryView {
  const { coordination, ownership } = input;
  return {
    coordinationId: coordination.coordination_id,
    conversationId: coordination.conversation_id,
    lifecycle: projectLifecycle(coordination),
    resolution: projectResolution(coordination),
    coordination: projectCoordination(coordination),
    humanRequired: projectHumanRequired(coordination),
    ownership: projectOwnershipSummary(ownership),
  };
}

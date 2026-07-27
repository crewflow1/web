import type {
  OwnershipTimelineView,
  OwnershipTimelineEntry,
  TimelineEventKind,
} from "./conversation-ownership-timeline";

// =====================================================================
// THE CONVERSATION OWNERSHIP TIMELINE PANEL — PURE VIEW CORE (CEO Directive #018, R56: CONVERSATION OWNERSHIP TIMELINE
// PANEL).
//
// R55 shipped the canonical HISTORICAL projection of a coordination's ownership — the OWNERSHIP TIMELINE: its
// present-ownership HEADER (from the R48/R53 Read Model) plus its append-only list of ownership TRANSITIONS (relabelled from
// the R51 State Engine's raw claim / release / reassignment events), composed by the R55 Ownership Timeline RUNTIME
// (`getOwnershipTimeline`, org-scoped). R56 is the FIRST operator-facing use of that projection: the CONVERSATION OWNERSHIP
// TIMELINE PANEL on the Conversation Detail surface, which shows an operator who has held this conversation, and who holds
// it now.
//
// This module is that panel's PURE PRESENTATION CORE. It takes the R55 {@link OwnershipTimelineView} — the already-composed
// output of the Timeline Runtime (which itself already folded the Read Model's header + the State Engine's events) — and
// RE-SHAPES it into a display-ready {@link OwnershipTimelinePanelView}: it formats the recorded instants, labels each event
// kind, names the participating operators on each transition, and writes the header summary. It DERIVES NO OWNERSHIP: the
// current owner is the Read Model's (carried on the view), the history is the State Engine's (carried on the view); this core
// re-decides neither. It imports the R55 view TYPES only (erased at runtime), so it is provably a projection over
// already-read facts, not a second reader.
//
// IT REACHES NO I/O, NO CLOCK AND NO RNG — the SAME view always projects to the SAME panel. Timestamps are rendered by
// SLICING the ISO string (never a `Date` parse), so the projection is deterministic and zone-stable. It records nothing,
// decides nothing, names no viewer, grants no affordance, and introduces NO execution path: it claims nothing, releases
// nothing, transfers nothing, dispatches nothing, notifies no one, schedules nothing and completes nothing — every one an
// explicit R56 non-goal. Organisation scoping is the RUNTIME's concern (every seam the Timeline Runtime reads is org-scoped);
// this core is org-agnostic, projecting only the view it is handed.
//
// What it exposes, each a pure projection over the R55 view:
//   • projectOwnershipTimelinePanel — an {@link OwnershipTimelineView} → the panel's display model: the ownership HEADER
//                                     (owned/unowned, current owner, since when, a human summary) + the chronological EVENT
//                                     rows (kind, instant, from/to operators, headline), and the empty state.
//   • formatTimelineInstant         — one ISO instant → `YYYY-MM-DD HH:MM` (or the em dash), by slicing. Presentation.
// =====================================================================

/** The placeholder shown for any absent (null / empty) instant — the panel never invents a fact. */
const EM_DASH = "—";

/**
 * Render an ISO-8601 instant as `YYYY-MM-DD HH:MM` by SLICING the calendar date and wall-clock minute directly — never a
 * `Date` parse — so the projection is deterministic and zone-stable (the same moment always renders identically). An absent
 * instant collapses to the em dash; a date-only value renders as the date alone. Pure and total.
 */
export function formatTimelineInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return EM_DASH;
  const date = iso.slice(0, 10);
  const t = iso.indexOf("T");
  if (t === -1) return date;
  const time = iso.slice(t + 1, t + 6); // HH:MM
  return time ? `${date} ${time}` : date;
}

/**
 * The human label for each ownership event kind — exhaustive over the closed {@link TimelineEventKind} vocabulary, so a new
 * kind must be labelled here or the type check fails. Presentation only — it re-labels, it re-derives nothing.
 */
const KIND_LABEL: Readonly<Record<TimelineEventKind, string>> = {
  claimed: "Claimed",
  reassigned: "Reassigned",
  released: "Released",
};

/** The tone the panel uses to style its ownership header — held (an operator owns it now) or unheld (no one does). */
export type OwnershipTimelineHeaderTone = "held" | "unheld";

/**
 * The panel's OWNERSHIP HEADER — the PRESENT ownership, humanised for display. Every field is the Read Model's (carried on
 * the R55 view); this core formats them, it re-derives none:
 *   • owned            — is the conversation held by an operator now?
 *   • statusLabel      — "Owned" / "Unowned", the header pill's text.
 *   • tone             — "held" / "unheld", for styling.
 *   • currentOwnerLabel — WHO holds it now (email, else id), or null when unowned.
 *   • reassigned       — whether the current holder was reached BY a transfer rather than the original claim.
 *   • claimedAt        — the ORIGINAL claim instant (formatted), or the em dash when unowned.
 *   • heldSince        — WHEN the current owner took hold (formatted), or the em dash when unowned.
 *   • summary          — a ready human sentence describing the present ownership.
 */
export type OwnershipTimelinePanelHeader = {
  readonly owned: boolean;
  readonly statusLabel: string;
  readonly tone: OwnershipTimelineHeaderTone;
  readonly currentOwnerLabel: string | null;
  readonly reassigned: boolean;
  readonly claimedAt: string;
  readonly heldSince: string;
  readonly summary: string;
};

/**
 * ONE ownership event ROW the panel renders — a display shaping of one R55 {@link OwnershipTimelineEntry}:
 *   • sequence  — its 1-based chronological position (from the R55 view; a stable render key).
 *   • kind      — the {@link TimelineEventKind}: `claimed` / `reassigned` / `released`.
 *   • kindLabel — that kind, humanised ("Claimed" / "Reassigned" / "Released").
 *   • at        — the recorded instant of the event, formatted `YYYY-MM-DD HH:MM`.
 *   • fromLabel — the PRIOR holder's display name (email, else id), or null (a claim has no prior holder).
 *   • toLabel   — the NEW holder's display name, or null (a release leaves no holder).
 *   • headline  — the R55 entry's ready headline (e.g. "Reassigned from a@… to b@…").
 */
export type OwnershipTimelinePanelEntry = {
  readonly sequence: number;
  readonly kind: TimelineEventKind;
  readonly kindLabel: string;
  readonly at: string;
  readonly fromLabel: string | null;
  readonly toLabel: string | null;
  readonly headline: string;
};

/**
 * The panel's complete display model — the ownership HEADER + the chronological EVENT rows + the empty state:
 *   • coordinationId — the coordination the panel concerns.
 *   • header         — the PRESENT ownership, humanised.
 *   • entries        — the append-only ownership events, oldest first (the R55 order, preserved).
 *   • eventCount     — how many events the history holds.
 *   • firstEventAt / lastEventAt — the span of the history, formatted (or the em dash when empty).
 *   • isEmpty        — true when no ownership event has been recorded (a never-claimed conversation).
 *   • emptyMessage   — the note the panel shows in that empty state, else null.
 * The header is the PRESENT fact; the entries are the append-only HISTORY. They are orthogonal: a released conversation shows
 * an "Unowned" header AND its full claim → … → release history.
 */
export type OwnershipTimelinePanelView = {
  readonly coordinationId: string;
  readonly header: OwnershipTimelinePanelHeader;
  readonly entries: readonly OwnershipTimelinePanelEntry[];
  readonly eventCount: number;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly isEmpty: boolean;
  readonly emptyMessage: string | null;
};

/** Humanise the PRESENT ownership from the R55 view's header fields — copied + formatted, never re-derived. Pure + total. */
function projectHeader(view: OwnershipTimelineView): OwnershipTimelinePanelHeader {
  // Owned NOW — name the current holder (the Read Model's current owner, carried on the view) and how long they have held it.
  if (view.owned && view.currentOwner) {
    const ownerLabel = view.currentOwner.label;
    return {
      owned: true,
      statusLabel: "Owned",
      tone: "held",
      currentOwnerLabel: ownerLabel,
      reassigned: view.reassigned,
      claimedAt: formatTimelineInstant(view.claimedAt),
      heldSince: formatTimelineInstant(view.heldSince),
      summary: view.reassigned
        ? `Currently held by ${ownerLabel}, by transfer, since ${formatTimelineInstant(view.heldSince)}.`
        : `Currently held by ${ownerLabel}, claimed ${formatTimelineInstant(view.claimedAt)}.`,
    };
  }
  // Unowned NOW — either never claimed, or held once and since released. The header settles to unowned, but any history is
  // preserved in the entries below (orthogonal by construction); the summary distinguishes the two unowned shapes.
  const hasHistory = view.eventCount > 0;
  return {
    owned: false,
    statusLabel: "Unowned",
    tone: "unheld",
    currentOwnerLabel: null,
    reassigned: false,
    claimedAt: EM_DASH,
    heldSince: EM_DASH,
    summary: hasHistory
      ? "No operator currently holds this conversation — it has been released. Its ownership history is preserved below."
      : "No operator has claimed this conversation yet.",
  };
}

/** Shape one R55 timeline entry into a display ROW — format its instant, label its kind, name its operators. Pure + total. */
function toPanelEntry(entry: OwnershipTimelineEntry): OwnershipTimelinePanelEntry {
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    kindLabel: KIND_LABEL[entry.kind],
    at: formatTimelineInstant(entry.at),
    fromLabel: entry.from ? entry.from.label : null,
    toLabel: entry.to ? entry.to.label : null,
    headline: entry.label,
  };
}

/**
 * Project the panel's display model from the R55 {@link OwnershipTimelineView}. Pure, total and deterministic. The HEADER is
 * the view's present-ownership fields, humanised; the ENTRIES are the view's append-only transitions, each formatted +
 * labelled in the SAME chronological order R55 fixed (this core re-orders nothing). An empty history yields `isEmpty: true`
 * and an explanatory note. It records nothing, decides nothing, names no viewer and re-derives no ownership — it presents the
 * composed view it is handed.
 */
export function projectOwnershipTimelinePanel(
  view: OwnershipTimelineView,
): OwnershipTimelinePanelView {
  const entries = view.entries.map(toPanelEntry);
  const isEmpty = entries.length === 0;
  return {
    coordinationId: view.coordinationId,
    header: projectHeader(view),
    entries,
    eventCount: view.eventCount,
    firstEventAt: formatTimelineInstant(view.firstEventAt),
    lastEventAt: formatTimelineInstant(view.lastEventAt),
    isEmpty,
    emptyMessage: isEmpty
      ? "No ownership events have been recorded for this conversation yet."
      : null,
  };
}

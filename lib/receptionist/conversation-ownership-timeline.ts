import type {
  OwnershipClaimEvent,
  OwnershipReleaseEvent,
  OwnershipReassignmentEvent,
} from "./conversation-ownership-state";
import type {
  OwnershipRecord,
  OwnershipStatus,
} from "./conversation-ownership-read-model";

// =====================================================================
// THE CONVERSATION OWNERSHIP TIMELINE — PURE CORE (CEO Directive #018, R55: CONVERSATION OWNERSHIP TIMELINE).
//
// R46 records an operator's CLAIM of a coordinated Conversation Worklist item (append-only
// `receptionist_conversation_claims`); R50 records that operator's RELEASE (append-only
// `receptionist_conversation_claim_releases`); R52 records a TRANSFER (append-only
// `receptionist_conversation_claim_reassignments`, a row per leg of a chain A→B→C). Those three ledgers are the APPEND-ONLY
// OWNERSHIP EVENT STREAM. R51 made the Ownership STATE ENGINE the SINGLE authority that reads that stream and folds it into
// ownership state + the current owner; R48/R53 made the Ownership READ MODEL the authoritative VIEW of the PRESENT owner
// over the engine. R55 adds the canonical HISTORICAL projection ON TOP of both: the OWNERSHIP TIMELINE — the append-only
// history of a coordination's ownership, presented chronologically as a sequence of ownership TRANSITIONS.
//
// This module is the timeline's PURE CORE — the projection + the rendering model, as total, deterministic, dependency-free
// functions. It reaches NO I/O, holds NO clock and NO RNG, records nothing and decides nothing. It imports only TYPES (the
// engine's event shapes + the read model's ownership record), so it is provably a projection, not a second reader.
//
// IT DERIVES OWNERSHIP NOWHERE — IT CONSUMES THE AUTHORISED SEAMS. The two orthogonal facts the timeline presents come from
// the two authorities that already own them, and the timeline RE-DECIDES NEITHER:
//   • the HEADER (who holds it NOW — owned/unowned, the current owner, whether by transfer, since when) is COPIED verbatim
//     from the R48/R53 Read Model's {@link OwnershipRecord}. The timeline calls no `deriveOwnershipState`, no
//     `isOwnedState`, no `resolveCurrentOwner` — it reads the record's already-derived fields;
//   • the ENTRIES (the append-only history) are a structural RELABELLING of the R51 State Engine's RAW events — the claim,
//     the release and every reassignment leg — each mapped to ONE ownership TRANSITION `from → to`. It folds nothing into
//     ownership; it only relabels + orders events the engine already read.
//
// THE TRANSITION MODEL IS UNIFORM. Every ownership event is one move of the "held-by" pointer, expressed as `from → to`:
//   • a CLAIM       is `null → claimant`     (no one held it; now the claimant does);
//   • a REASSIGNMENT is `from_operator → to_operator` (the holder passes it on);
//   • a RELEASE      is `releaser → null`    (the holder relinquishes it; now no one holds it).
// The entries are ordered CHRONOLOGICALLY ASCENDING (oldest first — a timeline reads forward) under a TOTAL order: by
// instant, then by kind (a claim precedes a same-instant reassignment precedes a same-instant release — the only order the
// held-by pointer can move), then — between two same-instant reassignments — by `created_at`, then by `id` (UNIQUE), the
// exact tiebreak the R52 owner-resolution uses. So the same events in any order yield an identical timeline.
//
// APPEND-ONLY HISTORY IS PRESERVED — THE ENTRIES ARE THE RAW EVENTS, NOT THE COLLAPSED HEADER. A RELEASED coordination
// collapses to `unowned` / no-owner in the Read Model's record (ownership is the PRESENT fact), but its claim → … → release
// history still EXISTS in the append-only ledgers, so the engine still reads it and the timeline still shows every entry.
// The header settling to `unowned` never erases a single historical transition — the two are orthogonal by construction.
//
// IT INTRODUCES NO EXECUTION PATH AND NAMES NO VIEWER. It presents history — it claims nothing, releases nothing, transfers
// nothing, dispatches nothing, notifies no one, schedules nothing and completes nothing; every one an explicit R55
// non-goal. It folds in no viewer identity and grants no affordance; a viewer-relative surface composes ON TOP. Organisation
// scoping is the RUNTIME's concern (every seam it reads is org-scoped) — this core is org-agnostic, projecting only the
// events + record it is handed.
//
// What the core exposes, each a pure projection over already-read ownership facts:
//   • projectOwnershipTimeline — a coordination's read-model record + its raw claim/release/reassignment events → the
//                                {@link OwnershipTimelineView}: the current-ownership HEADER + the chronological, append-only
//                                list of ownership TRANSITIONS.
//   • describeTimelineEntry     — one {@link OwnershipTimelineEntry} → its display headline (kind + participants). Presentation.
// =====================================================================

// ---------------------------------------------------------------------
// The closed vocabulary of TIMELINE EVENT KINDS — the three append-only ownership events, each one move of the held-by
// pointer. There is deliberately no `dispatched`, `scheduled`, `notified` or `completed` member: the event stream records
// the TAKING, TRANSFER and RELINQUISHING of ownership only, and everything past that is an explicit non-goal of a later,
// separately-authorised increment.
// ---------------------------------------------------------------------

/** The three kinds of ownership event a timeline entry can represent — a closed const tuple, so a consumer switches exhaustively. */
export const TIMELINE_EVENT_KINDS = ["claimed", "reassigned", "released"] as const;

/** One ownership event kind — a member of the closed {@link TIMELINE_EVENT_KINDS}. */
export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];

/**
 * The chronological rank of each kind — the ONLY order the held-by pointer can move at a single instant: a claim (0) must
 * precede a same-instant reassignment (1), which must precede a same-instant release (2). It breaks ties between DIFFERENT
 * kinds at the same instant; ties between two same-instant reassignments fall through to `created_at`, then `id`.
 */
const KIND_RANK: Readonly<Record<TimelineEventKind, number>> = {
  claimed: 0,
  reassigned: 1,
  released: 2,
};

// ---------------------------------------------------------------------
// A PARTICIPANT — an operator named on one end of an ownership transition (the prior holder, the new holder, or both).
// ---------------------------------------------------------------------

/**
 * An operator PARTICIPATING in an ownership transition — the recorded identity (id + denormalised email) plus a display
 * `label` (the email when present, else the id). Presentation-only: it names WHO, and grants no affordance. The `from` /
 * `to` ends of every {@link OwnershipTimelineEntry} are participants, so a renderer names operators uniformly.
 */
export type TimelineParticipant = {
  readonly operatorId: string;
  readonly operatorEmail: string | null;
  readonly label: string;
};

/** Relabel a recorded operator identity into a display {@link TimelineParticipant} — email when present, else id. Pure. */
function participantOf(operatorId: string, operatorEmail: string | null): TimelineParticipant {
  return { operatorId, operatorEmail, label: operatorEmail ?? operatorId };
}

// ---------------------------------------------------------------------
// A TIMELINE ENTRY — one append-only ownership event, expressed as an ownership TRANSITION `from → to`.
// ---------------------------------------------------------------------

/**
 * ONE ownership event on the timeline — a single move of the held-by pointer, expressed uniformly as `from → to`:
 *   • sequence — its 1-based position in chronological (oldest-first) order. A stable index for rendering.
 *   • kind     — {@link TimelineEventKind}: `claimed` / `reassigned` / `released`.
 *   • at       — the recorded instant of the event (`claimed_at` / `reassigned_at` / `released_at`).
 *   • from     — the PRIOR holder: null for a `claimed` event (no one held it), else a {@link TimelineParticipant}.
 *   • to       — the NEW holder: null for a `released` event (no one holds it after), else a {@link TimelineParticipant}.
 *   • label    — a display headline naming the kind + participants (e.g. "Reassigned from a@… to b@…"). Presentation.
 * A straight relabelling of ONE raw ledger event — it re-derives no ownership and decides nothing.
 */
export type OwnershipTimelineEntry = {
  readonly sequence: number;
  readonly kind: TimelineEventKind;
  readonly at: string;
  readonly from: TimelineParticipant | null;
  readonly to: TimelineParticipant | null;
  readonly label: string;
};

// ---------------------------------------------------------------------
// The TIMELINE VIEW — the current-ownership HEADER + the chronological, append-only list of ownership TRANSITIONS.
// ---------------------------------------------------------------------

/**
 * The canonical HISTORICAL projection of a coordination's ownership — the rendering model R55 exposes:
 *   • coordinationId  — the coordination the timeline concerns.
 *   • conversationId  — the conversation it concerns (the Read Model's PRESENT fact; null once released), for provenance.
 *   • status / owned  — the PRESENT ownership status, COPIED from the Read Model's {@link OwnershipRecord}. Never re-derived.
 *   • currentOwner    — WHO holds it now ({@link TimelineParticipant}), relabelled from the record's owner, or null.
 *   • reassigned      — whether the current holder holds it by TRANSFER (from the record). False when unowned or never moved.
 *   • claimedAt       — the ORIGINAL claim instant when owned, else null (from the record).
 *   • heldSince       — WHEN the current owner took hold when owned, else null (from the record).
 *   • entries         — the append-only ownership TRANSITIONS, oldest first — the history itself, from the RAW events.
 *   • eventCount      — how many ownership events the history holds (`entries.length`).
 *   • firstEventAt    — the instant of the OLDEST entry (the claim, once claimed), or null when the history is empty.
 *   • lastEventAt     — the instant of the NEWEST entry (the latest move), or null when the history is empty.
 * The header is the Read Model's PRESENT ownership; the entries are the append-only HISTORY. They are orthogonal: a released
 * item shows an `unowned` header AND its full claim→…→release history.
 */
export type OwnershipTimelineView = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly status: OwnershipStatus;
  readonly owned: boolean;
  readonly currentOwner: TimelineParticipant | null;
  readonly reassigned: boolean;
  readonly claimedAt: string | null;
  readonly heldSince: string | null;
  readonly entries: readonly OwnershipTimelineEntry[];
  readonly eventCount: number;
  readonly firstEventAt: string | null;
  readonly lastEventAt: string | null;
};

// ---------------------------------------------------------------------
// The chronological order — a TOTAL, order-independent comparator over the raw events' ordering keys.
// ---------------------------------------------------------------------

/** The ordering keys one raw event contributes, carried alongside the entry it builds so the sort is a pure total order. */
type OrderedEntry = {
  readonly base: Omit<OwnershipTimelineEntry, "sequence">;
  readonly atMs: number;
  readonly rank: number;
  readonly createdAtMs: number;
  readonly id: string;
};

/**
 * The canonical timeline order — OLDEST first, TOTAL and order-independent. Compares INSTANTS (via `Date.parse`), never raw
 * timestamp strings, so the same moment in different zone spellings ties and is decided by the next key: the kind rank (a
 * claim before a same-instant reassignment before a same-instant release), then — between two same-instant reassignments —
 * `created_at`, then the UNIQUE `id`. So a coordination's history has exactly ONE chronological arrangement.
 */
function compareTimelineOrder(a: OrderedEntry, b: OrderedEntry): number {
  if (a.atMs !== b.atMs) return a.atMs < b.atMs ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs < b.createdAtMs ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------
// The projection — a coordination's read-model record + its raw events → the timeline view.
// ---------------------------------------------------------------------

/**
 * Project the {@link OwnershipTimelineView} from a coordination's Read Model record + its RAW append-only events. Pure,
 * total and deterministic. The HEADER is COPIED from the record (owned/unowned, the current owner, whether reassigned, the
 * claim + held-since instants) — this core re-derives no ownership. The ENTRIES are a structural relabelling of the raw
 * events: the claim → a `null → claimant` transition, each reassignment → a `from → to` transition, the release → a
 * `releaser → null` transition — then ordered oldest-first under the total {@link compareTimelineOrder}, and numbered. The
 * `release` and `reassignments` arguments are OPTIONAL and default to absent/empty (a claim-only, or never-claimed, history);
 * the reassignments are filtered to THIS coordination defensively. It records nothing, decides nothing and names no viewer.
 */
export function projectOwnershipTimeline(input: {
  coordinationId: string;
  ownership: OwnershipRecord;
  claim: OwnershipClaimEvent | null;
  release?: OwnershipReleaseEvent | null;
  reassignments?: readonly OwnershipReassignmentEvent[];
}): OwnershipTimelineView {
  const { coordinationId, ownership, claim } = input;
  const release = input.release ?? null;
  const reassignments = (input.reassignments ?? []).filter(
    (reassignment) => reassignment.coordination_id === coordinationId,
  );

  const ordered: OrderedEntry[] = [];

  // A CLAIM — the held-by pointer moves from no one to the claimant: `null → claimant`.
  if (claim) {
    const to = participantOf(claim.operator_id, claim.operator_email);
    ordered.push({
      base: { kind: "claimed", at: claim.claimed_at, from: null, to, label: `Claimed by ${to.label}` },
      atMs: Date.parse(claim.claimed_at),
      rank: KIND_RANK.claimed,
      createdAtMs: Date.parse(claim.claimed_at),
      id: `claim:${coordinationId}`,
    });
  }

  // Each REASSIGNMENT — the pointer moves from the prior holder to the named operator: `from → to`.
  for (const reassignment of reassignments) {
    const from = participantOf(reassignment.from_operator_id, reassignment.from_operator_email);
    const to = participantOf(reassignment.to_operator_id, reassignment.to_operator_email);
    ordered.push({
      base: {
        kind: "reassigned",
        at: reassignment.reassigned_at,
        from,
        to,
        label: `Reassigned from ${from.label} to ${to.label}`,
      },
      atMs: Date.parse(reassignment.reassigned_at),
      rank: KIND_RANK.reassigned,
      createdAtMs: Date.parse(reassignment.created_at),
      id: reassignment.id,
    });
  }

  // A RELEASE — the pointer moves from the holder back to no one: `releaser → null`.
  if (release) {
    const from = participantOf(release.operator_id, release.operator_email);
    ordered.push({
      base: { kind: "released", at: release.released_at, from, to: null, label: `Released by ${from.label}` },
      atMs: Date.parse(release.released_at),
      rank: KIND_RANK.released,
      createdAtMs: Date.parse(release.released_at),
      id: `release:${coordinationId}`,
    });
  }

  ordered.sort(compareTimelineOrder);
  const entries: OwnershipTimelineEntry[] = ordered.map((entry, index) => ({
    ...entry.base,
    sequence: index + 1,
  }));

  // The HEADER is the Read Model's PRESENT ownership — copied, never re-derived. `currentOwner` is the record's owner
  // relabelled into a participant so a renderer names it exactly as it names the transition participants.
  const currentOwner = ownership.owner
    ? participantOf(ownership.owner.operatorId, ownership.owner.operatorEmail)
    : null;

  // The first and last transitions bound the history. Captured as locals so a truthy check narrows the (possibly-empty)
  // indexed access — an empty timeline reports null bounds, never an out-of-range read.
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];

  return {
    coordinationId,
    conversationId: ownership.conversationId,
    status: ownership.status,
    owned: ownership.owned,
    currentOwner,
    reassigned: ownership.reassigned,
    claimedAt: ownership.claimedAt,
    heldSince: ownership.heldSince,
    entries,
    eventCount: entries.length,
    firstEventAt: firstEntry ? firstEntry.at : null,
    lastEventAt: lastEntry ? lastEntry.at : null,
  };
}

/**
 * Describe ONE timeline entry as a display headline — the same string carried on the entry's `label`, exposed as a pure
 * function so a renderer can re-derive it from a `kind` + participants without re-reading events. Total over the closed
 * {@link TimelineEventKind} vocabulary; presentation-only.
 */
export function describeTimelineEntry(entry: OwnershipTimelineEntry): string {
  return entry.label;
}

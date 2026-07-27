import { describe, it, expect } from "vitest";
import {
  projectOwnershipTimelinePanel,
  formatTimelineInstant,
} from "@/lib/receptionist/conversation-ownership-timeline-panel";
import {
  projectOwnershipTimeline,
  type OwnershipTimelineView,
} from "@/lib/receptionist/conversation-ownership-timeline";
import type {
  OwnershipClaimEvent,
  OwnershipReleaseEvent,
  OwnershipReassignmentEvent,
} from "@/lib/receptionist/conversation-ownership-state";
import type { OwnershipRecord } from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * Conversation Ownership Timeline PANEL — pure display-model unit tests (the AI Receptionist Programme, R56: CONVERSATION
 * OWNERSHIP TIMELINE PANEL).
 *
 * R55's pure core folds the Read Model's present owner (the HEADER) + the State Engine's raw events (the ENTRIES) into an
 * {@link OwnershipTimelineView}. R56's PANEL CORE is a projection ON TOP of that view: it re-shapes the view into a
 * display-ready panel model — formatting instants by SLICING, labelling each event kind, naming the participating operators,
 * and writing the present-ownership header summary. It reaches no I/O, holds no clock and DERIVES NO OWNERSHIP (the header is
 * the view's, the history is the view's; this core re-decides neither), so it is total, deterministic and dependency-free,
 * and THAT is what this suite pins:
 *   • projectOwnershipTimelinePanel — an {@link OwnershipTimelineView} → the panel's display model: the ownership HEADER
 *                                     (owned/unowned, current owner, since when, a human summary) + the chronological EVENT
 *                                     rows (kind, instant, from/to operators, headline), and the empty state.
 *   • formatTimelineInstant         — one ISO instant → `YYYY-MM-DD HH:MM` (or the em dash), by slicing — zone-stable.
 *
 * The panel's inputs are BUILT from the same raw-event fixtures R55's own suite uses, projected through the R55 core, so the
 * panel is proven to re-shape a REAL timeline view — never a hand-forged one that could drift from the runtime's output.
 */

const EM_DASH = "—";

const T = {
  claim: "2026-07-01T09:00:00.000Z",
  reassign1: "2026-07-02T09:00:00.000Z",
  reassign2: "2026-07-03T09:00:00.000Z",
  release: "2026-07-04T09:00:00.000Z",
} as const;

function claimEvent(overrides: Partial<OwnershipClaimEvent> = {}): OwnershipClaimEvent {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    conversation_id: "conv-1",
    correlation_id: null,
    operator_id: "op-a",
    operator_email: "a@crewflow.uk",
    claim_type: "claim_conversation_work",
    claim_outcome: "work_claimed",
    status: "claimed",
    claimed_at: T.claim,
    ...overrides,
  };
}

function releaseEvent(overrides: Partial<OwnershipReleaseEvent> = {}): OwnershipReleaseEvent {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    operator_id: "op-a",
    operator_email: "a@crewflow.uk",
    released_at: T.release,
    ...overrides,
  };
}

function reassignmentEvent(
  overrides: Partial<OwnershipReassignmentEvent> = {},
): OwnershipReassignmentEvent {
  return {
    id: "rea-1",
    org_id: "org-1",
    coordination_id: "coord-1",
    from_operator_id: "op-a",
    from_operator_email: "a@crewflow.uk",
    to_operator_id: "op-b",
    to_operator_email: "b@crewflow.uk",
    reassigned_at: T.reassign1,
    created_at: T.reassign1,
    ...overrides,
  };
}

function ownedRecord(overrides: Partial<OwnershipRecord> = {}): OwnershipRecord {
  return {
    coordinationId: "coord-1",
    conversationId: "conv-1",
    status: "owned",
    owned: true,
    owner: {
      operatorId: "op-a",
      operatorEmail: "a@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: T.claim,
    },
    claimant: { operatorId: "op-a", operatorEmail: "a@crewflow.uk" },
    reassigned: false,
    claimedAt: T.claim,
    heldSince: T.claim,
    ...overrides,
  };
}

const UNOWNED_RECORD: OwnershipRecord = {
  coordinationId: "coord-1",
  conversationId: null,
  status: "unowned",
  owned: false,
  owner: null,
  claimant: null,
  reassigned: false,
  claimedAt: null,
  heldSince: null,
};

/** Build a REAL timeline view via the R55 core, then project the R56 panel over it — the panel's true input path. */
function panelFrom(input: {
  coordinationId?: string;
  ownership: OwnershipRecord;
  claim: OwnershipClaimEvent | null;
  release?: OwnershipReleaseEvent | null;
  reassignments?: readonly OwnershipReassignmentEvent[];
}) {
  const view = projectOwnershipTimeline({
    coordinationId: input.coordinationId ?? "coord-1",
    ownership: input.ownership,
    claim: input.claim,
    release: input.release ?? null,
    reassignments: input.reassignments ?? [],
  });
  return projectOwnershipTimelinePanel(view);
}

describe("projectOwnershipTimelinePanel — the header (present ownership) + the chronological event rows + the empty state", () => {
  it("a NEVER-CLAIMED coordination projects an empty panel with an unowned, never-claimed header", () => {
    const panel = panelFrom({ ownership: UNOWNED_RECORD, claim: null });
    expect(panel.coordinationId).toBe("coord-1");
    expect(panel.isEmpty).toBe(true);
    expect(panel.entries).toEqual([]);
    expect(panel.eventCount).toBe(0);
    expect(panel.firstEventAt).toBe(EM_DASH);
    expect(panel.lastEventAt).toBe(EM_DASH);
    expect(panel.emptyMessage).toBe(
      "No ownership events have been recorded for this conversation yet.",
    );
    expect(panel.header).toEqual({
      owned: false,
      statusLabel: "Unowned",
      tone: "unheld",
      currentOwnerLabel: null,
      reassigned: false,
      claimedAt: EM_DASH,
      heldSince: EM_DASH,
      summary: "No operator has claimed this conversation yet.",
    });
  });

  it("a CLAIMED item projects an owned/held header (claimed summary) and one Claimed row", () => {
    const panel = panelFrom({ ownership: ownedRecord(), claim: claimEvent() });
    expect(panel.header).toEqual({
      owned: true,
      statusLabel: "Owned",
      tone: "held",
      currentOwnerLabel: "a@crewflow.uk",
      reassigned: false,
      claimedAt: "2026-07-01 09:00",
      heldSince: "2026-07-01 09:00",
      summary: "Currently held by a@crewflow.uk, claimed 2026-07-01 09:00.",
    });
    expect(panel.isEmpty).toBe(false);
    expect(panel.eventCount).toBe(1);
    expect(panel.firstEventAt).toBe("2026-07-01 09:00");
    expect(panel.lastEventAt).toBe("2026-07-01 09:00");
    expect(panel.entries).toEqual([
      {
        sequence: 1,
        kind: "claimed",
        kindLabel: "Claimed",
        at: "2026-07-01 09:00",
        fromLabel: null,
        toLabel: "a@crewflow.uk",
        headline: "Claimed by a@crewflow.uk",
      },
    ]);
  });

  it("a REASSIGNED item projects an owned header by TRANSFER (since heldSince) and a Claimed → Reassigned history", () => {
    const panel = panelFrom({
      ownership: ownedRecord({
        owner: {
          operatorId: "op-b",
          operatorEmail: "b@crewflow.uk",
          claimType: "claim_conversation_work",
          claimOutcome: "work_claimed",
          claimedAt: T.claim,
        },
        reassigned: true,
        heldSince: T.reassign1,
      }),
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
    });
    expect(panel.header.owned).toBe(true);
    expect(panel.header.tone).toBe("held");
    expect(panel.header.reassigned).toBe(true);
    expect(panel.header.currentOwnerLabel).toBe("b@crewflow.uk");
    expect(panel.header.heldSince).toBe("2026-07-02 09:00");
    expect(panel.header.summary).toBe(
      "Currently held by b@crewflow.uk, by transfer, since 2026-07-02 09:00.",
    );
    expect(panel.entries.map((e) => e.kind)).toEqual(["claimed", "reassigned"]);
    const transfer = panel.entries[1]!;
    expect(transfer.kindLabel).toBe("Reassigned");
    expect(transfer.fromLabel).toBe("a@crewflow.uk");
    expect(transfer.toLabel).toBe("b@crewflow.uk");
    expect(transfer.headline).toBe("Reassigned from a@crewflow.uk to b@crewflow.uk");
  });

  it("PRESERVES APPEND-ONLY HISTORY: a RELEASED item shows an Unowned header AND its full claim → release history", () => {
    const panel = panelFrom({
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      release: releaseEvent(),
    });
    // The header COLLAPSES to unowned (the present fact)…
    expect(panel.header).toEqual({
      owned: false,
      statusLabel: "Unowned",
      tone: "unheld",
      currentOwnerLabel: null,
      reassigned: false,
      claimedAt: EM_DASH,
      heldSince: EM_DASH,
      summary:
        "No operator currently holds this conversation — it has been released. Its ownership history is preserved below.",
    });
    // …yet the append-only history is intact and NOT empty.
    expect(panel.isEmpty).toBe(false);
    expect(panel.emptyMessage).toBeNull();
    expect(panel.entries.map((e) => e.kind)).toEqual(["claimed", "released"]);
    const released = panel.entries[1]!;
    expect(released.kindLabel).toBe("Released");
    expect(released.fromLabel).toBe("a@crewflow.uk");
    expect(released.toLabel).toBeNull();
    expect(released.headline).toBe("Released by a@crewflow.uk");
    expect(panel.eventCount).toBe(2);
    expect(panel.firstEventAt).toBe("2026-07-01 09:00");
    expect(panel.lastEventAt).toBe("2026-07-04 09:00");
  });

  it("projects a FULL chain claim → reassign → reassign → release oldest-first, with formatted instants and 1..n sequence", () => {
    const panel = panelFrom({
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments: [
        reassignmentEvent({ id: "rea-1", reassigned_at: T.reassign1, created_at: T.reassign1 }),
        reassignmentEvent({
          id: "rea-2",
          reassigned_at: T.reassign2,
          created_at: T.reassign2,
          from_operator_id: "op-b",
          to_operator_id: "op-c",
        }),
      ],
      release: releaseEvent(),
    });
    expect(panel.entries.map((e) => e.kindLabel)).toEqual([
      "Claimed",
      "Reassigned",
      "Reassigned",
      "Released",
    ]);
    expect(panel.entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(panel.entries.map((e) => e.at)).toEqual([
      "2026-07-01 09:00",
      "2026-07-02 09:00",
      "2026-07-03 09:00",
      "2026-07-04 09:00",
    ]);
    expect(panel.eventCount).toBe(4);
    expect(panel.firstEventAt).toBe("2026-07-01 09:00");
    expect(panel.lastEventAt).toBe("2026-07-04 09:00");
  });

  it("names a participant by email, else by id when the email is absent — on both ends of a row", () => {
    const panel = panelFrom({
      ownership: UNOWNED_RECORD,
      claim: claimEvent({ operator_id: "op-a", operator_email: null }),
      reassignments: [
        reassignmentEvent({
          from_operator_id: "op-a",
          from_operator_email: null,
          to_operator_id: "op-b",
          to_operator_email: "b@crewflow.uk",
        }),
      ],
    });
    expect(panel.entries[0]!.toLabel).toBe("op-a"); // no email → id
    expect(panel.entries[1]!.fromLabel).toBe("op-a");
    expect(panel.entries[1]!.toLabel).toBe("b@crewflow.uk"); // email present
  });

  it("labels each kind exhaustively over the closed vocabulary — Claimed / Reassigned / Released", () => {
    const panel = panelFrom({
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
      release: releaseEvent(),
    });
    expect(panel.entries.map((e) => [e.kind, e.kindLabel])).toEqual([
      ["claimed", "Claimed"],
      ["reassigned", "Reassigned"],
      ["released", "Released"],
    ]);
  });

  it("carries the coordination id through and keeps header + entries orthogonal", () => {
    const panel = panelFrom({
      coordinationId: "coord-xyz",
      ownership: ownedRecord({ coordinationId: "coord-xyz", conversationId: "conv-xyz" }),
      claim: claimEvent({ coordination_id: "coord-xyz" }),
    });
    expect(panel.coordinationId).toBe("coord-xyz");
    expect(panel.header.owned).toBe(true);
    expect(panel.entries).toHaveLength(1);
  });

  it("is deterministic — the same view projects to an equal panel", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: ownedRecord(),
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
      release: null,
    });
    expect(projectOwnershipTimelinePanel(view)).toEqual(projectOwnershipTimelinePanel(view));
  });

  it("copies the header VERBATIM from the view and re-derives no ownership — header and entries are orthogonal", () => {
    // A hand-forged view the runtime would never emit (owned, yet an empty history) proves the panel TRUSTS the view: it
    // copies the present-ownership header from the view's fields and never re-decides ownership from the (empty) entries.
    const forged: OwnershipTimelineView = {
      coordinationId: "coord-forged",
      conversationId: "conv-forged",
      status: "owned",
      owned: true,
      currentOwner: { operatorId: "op-z", operatorEmail: "z@crewflow.uk", label: "z@crewflow.uk" },
      reassigned: false,
      claimedAt: "2026-07-07T08:30:00.000Z",
      heldSince: "2026-07-07T08:30:00.000Z",
      entries: [],
      eventCount: 0,
      firstEventAt: null,
      lastEventAt: null,
    };
    const panel = projectOwnershipTimelinePanel(forged);
    expect(panel.header).toEqual({
      owned: true,
      statusLabel: "Owned",
      tone: "held",
      currentOwnerLabel: "z@crewflow.uk",
      reassigned: false,
      claimedAt: "2026-07-07 08:30",
      heldSince: "2026-07-07 08:30",
      summary: "Currently held by z@crewflow.uk, claimed 2026-07-07 08:30.",
    });
    expect(panel.isEmpty).toBe(true);
    expect(panel.emptyMessage).toBe(
      "No ownership events have been recorded for this conversation yet.",
    );
  });
});

describe("formatTimelineInstant — one ISO instant → YYYY-MM-DD HH:MM, by slicing (zone-stable, deterministic)", () => {
  it("renders a full ISO instant as the calendar date + wall-clock minute", () => {
    expect(formatTimelineInstant("2026-07-01T09:05:00.000Z")).toBe("2026-07-01 09:05");
  });

  it("collapses an absent instant (null / undefined / empty) to the em dash", () => {
    expect(formatTimelineInstant(null)).toBe(EM_DASH);
    expect(formatTimelineInstant(undefined)).toBe(EM_DASH);
    expect(formatTimelineInstant("")).toBe(EM_DASH);
  });

  it("renders a date-only value as the date alone (no T, no time)", () => {
    expect(formatTimelineInstant("2026-07-01")).toBe("2026-07-01");
  });

  it("is zone-stable — it slices the RECORDED wall clock, never re-zones by parsing", () => {
    // Different zone spellings of the SAME wall-clock reading slice identically — the projection never parses a Date.
    expect(formatTimelineInstant("2026-07-01T09:00:00.000Z")).toBe("2026-07-01 09:00");
    expect(formatTimelineInstant("2026-07-01T09:00:00+05:00")).toBe("2026-07-01 09:00");
    expect(formatTimelineInstant("2026-07-01T09:00:00-08:00")).toBe("2026-07-01 09:00");
  });
});

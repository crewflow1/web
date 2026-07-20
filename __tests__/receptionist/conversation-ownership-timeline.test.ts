import { describe, it, expect } from "vitest";
import {
  projectOwnershipTimeline,
  describeTimelineEntry,
  TIMELINE_EVENT_KINDS,
  type OwnershipTimelineEntry,
} from "@/lib/receptionist/conversation-ownership-timeline";
import type {
  OwnershipClaimEvent,
  OwnershipReleaseEvent,
  OwnershipReassignmentEvent,
} from "@/lib/receptionist/conversation-ownership-state";
import type { OwnershipRecord } from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * Conversation Ownership Timeline — pure projection + rendering-model unit tests (the AI Receptionist Programme, R55:
 * CONVERSATION OWNERSHIP TIMELINE).
 *
 * The timeline's PURE CORE consumes the R48/R53 Read Model's OUTPUT (an {@link OwnershipRecord} — the PRESENT owner) for
 * the HEADER and the R51 State Engine's RAW append-only events (claim / release / reassignment chain) for the ENTRIES, and
 * projects the historical view. It reaches no I/O, holds no clock, records nothing and derives ownership NOWHERE (the
 * header is COPIED from the record, the entries are a relabelling of the raw events), so it is total, deterministic and
 * dependency-free, and THAT is what this suite pins:
 *   • projectOwnershipTimeline — a record + raw events → the view: the present-ownership header + the chronological,
 *                                append-only list of ownership TRANSITIONS (claim=null→claimant, reassign=from→to,
 *                                release=releaser→null), oldest first, under a total order.
 *   • describeTimelineEntry     — one entry → its display headline.
 */

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

const kinds = (entries: readonly OwnershipTimelineEntry[]) => entries.map((e) => e.kind);

describe("projectOwnershipTimeline — the header (from the record) + the chronological, append-only entries (from events)", () => {
  it("a NEVER-CLAIMED coordination has an empty timeline and an unowned header", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: null,
    });
    expect(view.owned).toBe(false);
    expect(view.status).toBe("unowned");
    expect(view.currentOwner).toBeNull();
    expect(view.entries).toEqual([]);
    expect(view.eventCount).toBe(0);
    expect(view.firstEventAt).toBeNull();
    expect(view.lastEventAt).toBeNull();
  });

  it("a CLAIMED item shows one entry — the claim, as a null→claimant transition — and an owned header", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: ownedRecord(),
      claim: claimEvent(),
    });
    expect(kinds(view.entries)).toEqual(["claimed"]);
    const entry = view.entries[0]!;
    expect(entry.sequence).toBe(1);
    expect(entry.at).toBe(T.claim);
    expect(entry.from).toBeNull();
    expect(entry.to).toEqual({ operatorId: "op-a", operatorEmail: "a@crewflow.uk", label: "a@crewflow.uk" });
    expect(view.owned).toBe(true);
    expect(view.currentOwner).toEqual({
      operatorId: "op-a",
      operatorEmail: "a@crewflow.uk",
      label: "a@crewflow.uk",
    });
    expect(view.eventCount).toBe(1);
    expect(view.firstEventAt).toBe(T.claim);
    expect(view.lastEventAt).toBe(T.claim);
  });

  it("a REASSIGNED item shows claim then reassignment (from→to), header attributed to the current holder", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
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
    expect(kinds(view.entries)).toEqual(["claimed", "reassigned"]);
    const transfer = view.entries[1]!;
    expect(transfer.from).toEqual({ operatorId: "op-a", operatorEmail: "a@crewflow.uk", label: "a@crewflow.uk" });
    expect(transfer.to).toEqual({ operatorId: "op-b", operatorEmail: "b@crewflow.uk", label: "b@crewflow.uk" });
    expect(transfer.sequence).toBe(2);
    expect(view.reassigned).toBe(true);
    expect(view.currentOwner?.operatorId).toBe("op-b");
    expect(view.heldSince).toBe(T.reassign1);
  });

  it("PRESERVES APPEND-ONLY HISTORY: a RELEASED item shows its full claim→release history under an UNOWNED header", () => {
    // The header COLLAPSES to unowned (present fact) but the entries are the RAW events, which persist append-only.
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      release: releaseEvent(),
    });
    expect(view.owned).toBe(false);
    expect(view.status).toBe("unowned");
    expect(view.currentOwner).toBeNull();
    // ...yet the history is intact:
    expect(kinds(view.entries)).toEqual(["claimed", "released"]);
    expect(view.entries[1]!.from).toEqual({ operatorId: "op-a", operatorEmail: "a@crewflow.uk", label: "a@crewflow.uk" });
    expect(view.entries[1]!.to).toBeNull();
    expect(view.eventCount).toBe(2);
    expect(view.firstEventAt).toBe(T.claim);
    expect(view.lastEventAt).toBe(T.release);
  });

  it("presents a FULL chain claim → reassign → reassign → release in chronological order, numbered 1..n", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
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
      release: releaseEvent({ released_at: T.release }),
    });
    expect(kinds(view.entries)).toEqual(["claimed", "reassigned", "reassigned", "released"]);
    expect(view.entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(view.entries.map((e) => e.at)).toEqual([T.claim, T.reassign1, T.reassign2, T.release]);
  });

  it("orders entries deterministically regardless of the reassignment INPUT order", () => {
    const build = (reassignments: OwnershipReassignmentEvent[]) =>
      projectOwnershipTimeline({
        coordinationId: "coord-1",
        ownership: UNOWNED_RECORD,
        claim: claimEvent(),
        reassignments,
        release: releaseEvent(),
      }).entries.map((e) => e.at);
    const forward = build([
      reassignmentEvent({ id: "rea-1", reassigned_at: T.reassign1, created_at: T.reassign1 }),
      reassignmentEvent({ id: "rea-2", reassigned_at: T.reassign2, created_at: T.reassign2 }),
    ]);
    const shuffled = build([
      reassignmentEvent({ id: "rea-2", reassigned_at: T.reassign2, created_at: T.reassign2 }),
      reassignmentEvent({ id: "rea-1", reassigned_at: T.reassign1, created_at: T.reassign1 }),
    ]);
    expect(forward).toEqual([T.claim, T.reassign1, T.reassign2, T.release]);
    expect(shuffled).toEqual(forward);
  });

  it("at a SHARED instant, orders claim before reassignment before release (the held-by pointer can only move one way)", () => {
    const same = "2026-07-05T12:00:00.000Z";
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent({ claimed_at: same }),
      reassignments: [reassignmentEvent({ reassigned_at: same, created_at: same })],
      release: releaseEvent({ released_at: same }),
    });
    expect(kinds(view.entries)).toEqual(["claimed", "reassigned", "released"]);
  });

  it("breaks a same-instant reassignment tie by created_at, then by id — the R52 order", () => {
    const at = "2026-07-06T12:00:00.000Z";
    const byCreated = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: null,
      reassignments: [
        reassignmentEvent({
          id: "z",
          reassigned_at: at,
          created_at: "2026-07-06T12:00:02.000Z",
          to_operator_id: "op-late",
        }),
        reassignmentEvent({
          id: "a",
          reassigned_at: at,
          created_at: "2026-07-06T12:00:01.000Z",
          to_operator_id: "op-early",
        }),
      ],
    });
    // created_at ascending decides: the 12:00:01 leg precedes the 12:00:02 leg.
    expect(byCreated.entries.map((e) => e.to?.operatorId)).toEqual(["op-early", "op-late"]);
    const byId = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: null,
      reassignments: [
        reassignmentEvent({ id: "b", reassigned_at: at, created_at: at, to_operator_id: "op-y" }),
        reassignmentEvent({ id: "a", reassigned_at: at, created_at: at, to_operator_id: "op-x" }),
      ],
    });
    // same instant + same created_at → id ascending: "a" (op-x) before "b" (op-y).
    expect(byId.entries.map((e) => e.to?.operatorId)).toEqual(["op-x", "op-y"]);
  });

  it("labels a participant by email, else by id when the email is absent", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
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
    expect(view.entries[0]!.to?.label).toBe("op-a"); // no email → id
    expect(view.entries[1]!.from?.label).toBe("op-a");
    expect(view.entries[1]!.to?.label).toBe("b@crewflow.uk"); // email present
  });

  it("filters reassignments to THIS coordination defensively — a foreign leg is ignored", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments: [
        reassignmentEvent({ id: "mine", coordination_id: "coord-1" }),
        reassignmentEvent({ id: "foreign", coordination_id: "coord-2" }),
      ],
    });
    expect(kinds(view.entries)).toEqual(["claimed", "reassigned"]);
    expect(view.eventCount).toBe(2);
  });

  it("copies the HEADER fields verbatim from the record and carries the coordination + conversation ids through", () => {
    const record = ownedRecord({
      coordinationId: "coord-xyz",
      conversationId: "conv-xyz",
      reassigned: true,
      claimedAt: T.claim,
      heldSince: T.reassign1,
    });
    const view = projectOwnershipTimeline({
      coordinationId: "coord-xyz",
      ownership: record,
      claim: claimEvent({ coordination_id: "coord-xyz" }),
    });
    expect(view.coordinationId).toBe("coord-xyz");
    expect(view.conversationId).toBe("conv-xyz");
    expect(view.status).toBe("owned");
    expect(view.owned).toBe(true);
    expect(view.reassigned).toBe(true);
    expect(view.claimedAt).toBe(T.claim);
    expect(view.heldSince).toBe(T.reassign1);
  });

  it("does not mutate its reassignments input", () => {
    const reassignments = [
      reassignmentEvent({ id: "rea-2", reassigned_at: T.reassign2 }),
      reassignmentEvent({ id: "rea-1", reassigned_at: T.reassign1 }),
    ];
    const snapshot = reassignments.map((r) => r.id);
    projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments,
    });
    expect(reassignments.map((r) => r.id)).toEqual(snapshot);
  });

  it("is deterministic — the same inputs yield an equal view", () => {
    const args = {
      coordinationId: "coord-1",
      ownership: ownedRecord(),
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
      release: null,
    } as const;
    expect(projectOwnershipTimeline(args)).toEqual(projectOwnershipTimeline(args));
  });

  it("every entry's kind is a member of the closed TIMELINE_EVENT_KINDS vocabulary", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
      release: releaseEvent(),
    });
    for (const entry of view.entries) {
      expect(TIMELINE_EVENT_KINDS).toContain(entry.kind);
    }
    expect(TIMELINE_EVENT_KINDS).toEqual(["claimed", "reassigned", "released"]);
  });
});

describe("describeTimelineEntry — one entry → its display headline", () => {
  it("names the claimant on a claim, both operators on a transfer, and the releaser on a release", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: UNOWNED_RECORD,
      claim: claimEvent(),
      reassignments: [reassignmentEvent()],
      release: releaseEvent(),
    });
    const claimed = view.entries[0]!;
    const reassigned = view.entries[1]!;
    const released = view.entries[2]!;
    expect(describeTimelineEntry(claimed)).toBe("Claimed by a@crewflow.uk");
    expect(describeTimelineEntry(reassigned)).toBe("Reassigned from a@crewflow.uk to b@crewflow.uk");
    expect(describeTimelineEntry(released)).toBe("Released by a@crewflow.uk");
  });

  it("returns the same string carried on the entry's label", () => {
    const view = projectOwnershipTimeline({
      coordinationId: "coord-1",
      ownership: ownedRecord(),
      claim: claimEvent(),
    });
    for (const entry of view.entries) {
      expect(describeTimelineEntry(entry)).toBe(entry.label);
    }
  });
});

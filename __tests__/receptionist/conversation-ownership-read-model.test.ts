import { describe, it, expect } from "vitest";
import {
  OWNERSHIP_STATES,
  projectOwner,
  projectOwnership,
  projectOwnershipEvent,
  compareOwnershipEvents,
  orderOwnershipEvents,
  selectActiveClaims,
  summariseOwnership,
  type OwnershipClaimRow,
  type OwnershipReleaseRow,
  type OwnershipReassignmentRow,
  type OwnershipEvent,
} from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * Conversation Work Ownership Read Model — pure-core unit tests (the AI Receptionist Programme, R48: CONVERSATION WORK
 * OWNERSHIP READ MODEL; reassignment-aware since R53: OWNERSHIP READ MODEL REASSIGNMENT AWARENESS).
 *
 * The read model's PURE CORE turns already-recorded claim rows — and, since R53, their transfer chains — into ownership
 * FACTS, viewer-agnostic. It reaches no I/O, holds no clock, records nothing and decides no claim, so it is total,
 * deterministic and dependency-free, and THAT is exactly what this suite pins:
 *   • projectOwner          — one raw ledger row → the owner facts (a straight relabelling).
 *   • projectOwnership      — a coordination id + its claim row (or null) + its transfer chain → the per-coordination
 *                             ownership record: the CURRENT owner (operator B after A→B), the original claimant, whether
 *                             it was reassigned, when the holder took hold, the claim timestamp and the status.
 *   • projectOwnershipEvent — one raw ledger row + its transfer chain → one ownership event (current holder + claimant).
 *   • orderOwnershipEvents  — the canonical history order: newest claim first, stable tiebreak on coordination id,
 *                             instant-based, non-mutating.
 *   • summariseOwnership    — a set of ledger rows + transfer chains → the org-wide ownership summary grouped by CURRENT
 *                             owner; a total, ORDER-INDEPENDENT fold.
 */

function makeRow(overrides: Partial<OwnershipClaimRow> = {}): OwnershipClaimRow {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    conversation_id: "conv-1",
    correlation_id: "corr-1",
    operator_id: "operator-1",
    operator_email: "op@crewflow.uk",
    claim_type: "claim_conversation_work",
    claim_outcome: "work_claimed",
    status: "claimed",
    claimed_at: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function makeRelease(overrides: Partial<OwnershipReleaseRow> = {}): OwnershipReleaseRow {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    operator_id: "operator-1",
    operator_email: "op@crewflow.uk",
    released_at: "2026-07-06T13:00:00.000Z",
    ...overrides,
  };
}

function makeReassignment(
  overrides: Partial<OwnershipReassignmentRow> = {},
): OwnershipReassignmentRow {
  return {
    id: "reassign-1",
    org_id: "org-1",
    coordination_id: "coord-1",
    from_operator_id: "operator-1",
    from_operator_email: "op@crewflow.uk",
    to_operator_id: "operator-2",
    to_operator_email: "op2@crewflow.uk",
    reassigned_at: "2026-07-06T14:00:00.000Z",
    created_at: "2026-07-06T14:00:00.000Z",
    ...overrides,
  };
}

describe("OWNERSHIP_STATES — the closed status vocabulary", () => {
  it("is exactly owned + unowned", () => {
    expect(OWNERSHIP_STATES).toEqual(["owned", "unowned"]);
  });
});

describe("projectOwner — one ledger row → owner facts", () => {
  it("relabels the recorded claim into the owner facts", () => {
    expect(projectOwner(makeRow())).toEqual({
      operatorId: "operator-1",
      operatorEmail: "op@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("carries a null operator email through verbatim — the id is the load-bearing identity", () => {
    const owner = projectOwner(makeRow({ operator_email: null }));
    expect(owner.operatorEmail).toBeNull();
    expect(owner.operatorId).toBe("operator-1");
  });
});

describe("projectOwnership — the per-coordination ownership record", () => {
  it("projects a present, never-transferred claim as OWNED — owner === claimant, heldSince === claimedAt", () => {
    const record = projectOwnership({ coordinationId: "coord-9", claim: makeRow({ coordination_id: "coord-9" }) });
    expect(record).toEqual({
      coordinationId: "coord-9",
      conversationId: "conv-1",
      status: "owned",
      owned: true,
      owner: {
        operatorId: "operator-1",
        operatorEmail: "op@crewflow.uk",
        claimType: "claim_conversation_work",
        claimOutcome: "work_claimed",
        claimedAt: "2026-07-06T12:00:00.000Z",
      },
      claimant: { operatorId: "operator-1", operatorEmail: "op@crewflow.uk" },
      reassigned: false,
      claimedAt: "2026-07-06T12:00:00.000Z",
      heldSince: "2026-07-06T12:00:00.000Z",
    });
  });

  it("attributes a reassigned claim to the CURRENT holder (B), preserving the claimant (A) — R53", () => {
    // The R53 required behaviour: after an A→B transfer the current owner is B, the item is still OWNED, and the
    // original claimant (A) + the transfer instant are preserved as the transfer context.
    const claim = makeRow({
      coordination_id: "coord-9",
      operator_id: "operator-A",
      operator_email: "a@crewflow.uk",
    });
    const reassignment = makeReassignment({
      coordination_id: "coord-9",
      from_operator_id: "operator-A",
      from_operator_email: "a@crewflow.uk",
      to_operator_id: "operator-B",
      to_operator_email: "b@crewflow.uk",
      reassigned_at: "2026-07-06T14:00:00.000Z",
    });
    const record = projectOwnership({ coordinationId: "coord-9", claim, reassignments: [reassignment] });
    expect(record.status).toBe("owned");
    expect(record.reassigned).toBe(true);
    // The current owner is B; the claim vocabulary + claimedAt describe the UNDERLYING claim, unchanged by the transfer.
    expect(record.owner).toEqual({
      operatorId: "operator-B",
      operatorEmail: "b@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
    });
    expect(record.claimant).toEqual({ operatorId: "operator-A", operatorEmail: "a@crewflow.uk" });
    expect(record.claimedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(record.heldSince).toBe("2026-07-06T14:00:00.000Z");
  });

  it("projects an absent claim as UNOWNED, with no owner, claimant, transfer or timestamp", () => {
    const record = projectOwnership({ coordinationId: "coord-9", claim: null });
    expect(record).toEqual({
      coordinationId: "coord-9",
      conversationId: null,
      status: "unowned",
      owned: false,
      owner: null,
      claimant: null,
      reassigned: false,
      claimedAt: null,
      heldSince: null,
    });
  });

  it("reports on the coordination it was asked about (uses the queried id)", () => {
    const record = projectOwnership({ coordinationId: "asked-for", claim: null });
    expect(record.coordinationId).toBe("asked-for");
  });

  it("projects a claim with NO release as OWNED — an explicit null release is the claim-only semantics", () => {
    const record = projectOwnership({
      coordinationId: "coord-9",
      claim: makeRow({ coordination_id: "coord-9" }),
      release: null,
    });
    expect(record.status).toBe("owned");
    expect(record.owned).toBe(true);
    expect(record.owner?.operatorId).toBe("operator-1");
  });

  it("projects a claim WITH a release as UNOWNED — a released item returns to the unclaimed state", () => {
    // R50: ownership is the PRESENT fact, not the history. A claim that has been relinquished (a release row names its
    // coordination) reads as the SAME fully-null unowned shape as a never-claimed item.
    const record = projectOwnership({
      coordinationId: "coord-9",
      claim: makeRow({ coordination_id: "coord-9" }),
      release: makeRelease({ coordination_id: "coord-9" }),
    });
    expect(record).toEqual({
      coordinationId: "coord-9",
      conversationId: null,
      status: "unowned",
      owned: false,
      owner: null,
      claimant: null,
      reassigned: false,
      claimedAt: null,
      heldSince: null,
    });
  });

  it("a RELEASED item reads unowned even if it was reassigned before release — present fact, not history", () => {
    // A→B transfer THEN a release: the state is `released`, so ownership is the fully-null unowned shape — the read
    // model states the PRESENT fact (no current owner), not the transfer history.
    const record = projectOwnership({
      coordinationId: "coord-9",
      claim: makeRow({ coordination_id: "coord-9", operator_id: "operator-A" }),
      release: makeRelease({ coordination_id: "coord-9" }),
      reassignments: [makeReassignment({ coordination_id: "coord-9", to_operator_id: "operator-B" })],
    });
    expect(record).toEqual({
      coordinationId: "coord-9",
      conversationId: null,
      status: "unowned",
      owned: false,
      owner: null,
      claimant: null,
      reassigned: false,
      claimedAt: null,
      heldSince: null,
    });
  });

  it("projects NO claim with a release as UNOWNED (a defensive, still-total case)", () => {
    const record = projectOwnership({
      coordinationId: "coord-9",
      claim: null,
      release: makeRelease({ coordination_id: "coord-9" }),
    });
    expect(record.status).toBe("unowned");
    expect(record.owned).toBe(false);
  });
});

describe("selectActiveClaims — subtract released coordinations from the owned set", () => {
  it("returns every claim verbatim when there are no releases", () => {
    const claims = [makeRow({ coordination_id: "c1" }), makeRow({ coordination_id: "c2" })];
    expect(selectActiveClaims(claims, [])).toEqual(claims);
  });

  it("drops exactly the claims whose coordination has a release", () => {
    const claims = [
      makeRow({ coordination_id: "c1" }),
      makeRow({ coordination_id: "c2" }),
      makeRow({ coordination_id: "c3" }),
    ];
    const releases = [makeRelease({ coordination_id: "c2" })];
    expect(selectActiveClaims(claims, releases).map((c) => c.coordination_id)).toEqual(["c1", "c3"]);
  });

  it("ignores releases that match no claim (a release for another coordination drops nothing)", () => {
    const claims = [makeRow({ coordination_id: "c1" })];
    const releases = [makeRelease({ coordination_id: "other" })];
    expect(selectActiveClaims(claims, releases)).toEqual(claims);
  });

  it("returns an empty set when every claim has been released", () => {
    const claims = [makeRow({ coordination_id: "c1" }), makeRow({ coordination_id: "c2" })];
    const releases = [
      makeRelease({ coordination_id: "c1" }),
      makeRelease({ coordination_id: "c2" }),
    ];
    expect(selectActiveClaims(claims, releases)).toEqual([]);
  });

  it("is ORDER-INDEPENDENT — shuffling either input yields the same active set", () => {
    const c1 = makeRow({ coordination_id: "c1" });
    const c2 = makeRow({ coordination_id: "c2" });
    const c3 = makeRow({ coordination_id: "c3" });
    const releases = [makeRelease({ coordination_id: "c2" })];
    const forward = selectActiveClaims([c1, c2, c3], releases).map((c) => c.coordination_id);
    const reversed = selectActiveClaims([c3, c2, c1], [...releases].reverse()).map(
      (c) => c.coordination_id,
    );
    expect(new Set(forward)).toEqual(new Set(reversed));
  });

  it("does not mutate its inputs, and returns a NEW array", () => {
    const claims = [makeRow({ coordination_id: "c1" }), makeRow({ coordination_id: "c2" })];
    const releases = [makeRelease({ coordination_id: "c1" })];
    const claimsSnapshot = claims.map((c) => c.coordination_id);
    const result = selectActiveClaims(claims, releases);
    expect(result).not.toBe(claims);
    expect(claims.map((c) => c.coordination_id)).toEqual(claimsSnapshot);
  });
});

describe("projectOwnershipEvent — one ledger row + its transfer chain → one ownership event", () => {
  it("relabels a never-transferred claim — owner === claimant, not reassigned", () => {
    expect(projectOwnershipEvent(makeRow())).toEqual({
      coordinationId: "coord-1",
      conversationId: "conv-1",
      operatorId: "operator-1",
      operatorEmail: "op@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
      reassigned: false,
      claimant: { operatorId: "operator-1", operatorEmail: "op@crewflow.uk" },
    });
  });

  it("attributes the event to the CURRENT holder while preserving the claimant — R53", () => {
    const claim = makeRow({ operator_id: "operator-A", operator_email: "a@crewflow.uk" });
    const reassignment = makeReassignment({
      from_operator_id: "operator-A",
      to_operator_id: "operator-B",
      to_operator_email: "b@crewflow.uk",
    });
    expect(projectOwnershipEvent(claim, [reassignment])).toEqual({
      coordinationId: "coord-1",
      conversationId: "conv-1",
      operatorId: "operator-B",
      operatorEmail: "b@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
      reassigned: true,
      claimant: { operatorId: "operator-A", operatorEmail: "a@crewflow.uk" },
    });
  });

  it("carries a null conversation id through verbatim", () => {
    expect(projectOwnershipEvent(makeRow({ conversation_id: null })).conversationId).toBeNull();
  });
});

describe("orderOwnershipEvents — the canonical newest-first history order", () => {
  const event = (coordinationId: string, claimedAt: string): OwnershipEvent =>
    projectOwnershipEvent(makeRow({ coordination_id: coordinationId, claimed_at: claimedAt }));

  it("orders newest claim first", () => {
    const ordered = orderOwnershipEvents([
      event("a", "2026-07-01T00:00:00.000Z"),
      event("b", "2026-07-03T00:00:00.000Z"),
      event("c", "2026-07-02T00:00:00.000Z"),
    ]);
    expect(ordered.map((e) => e.coordinationId)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties on equal instants by coordination id (descending) — a total order", () => {
    const ordered = orderOwnershipEvents([
      event("a", "2026-07-01T00:00:00.000Z"),
      event("c", "2026-07-01T00:00:00.000Z"),
      event("b", "2026-07-01T00:00:00.000Z"),
    ]);
    expect(ordered.map((e) => e.coordinationId)).toEqual(["c", "b", "a"]);
  });

  it("compares INSTANTS, not strings — the same moment in different zone spellings ties", () => {
    // 12:00Z and 13:00+01:00 are the SAME instant; the id decides the tie, not the raw string.
    const same = compareOwnershipEvents(
      event("a", "2026-07-06T12:00:00.000Z"),
      event("b", "2026-07-06T13:00:00.000+01:00"),
    );
    // Same instant → decided by id: "a" < "b", so newest-first puts "b" (larger id) first ⇒ a after b ⇒ positive.
    expect(same).toBeGreaterThan(0);
  });

  it("does not mutate its input", () => {
    const input = [event("a", "2026-07-01T00:00:00.000Z"), event("b", "2026-07-03T00:00:00.000Z")];
    const snapshot = input.map((e) => e.coordinationId);
    orderOwnershipEvents(input);
    expect(input.map((e) => e.coordinationId)).toEqual(snapshot);
  });

  it("is idempotent — ordering an ordered list is stable", () => {
    const events = [
      event("a", "2026-07-01T00:00:00.000Z"),
      event("b", "2026-07-03T00:00:00.000Z"),
      event("c", "2026-07-02T00:00:00.000Z"),
    ];
    const once = orderOwnershipEvents(events);
    expect(orderOwnershipEvents(once)).toEqual(once);
  });
});

describe("summariseOwnership — the org-wide ownership summary", () => {
  it("summarises an empty ledger as zeroes and nulls", () => {
    expect(summariseOwnership([])).toEqual({
      totalClaims: 0,
      distinctOwners: 0,
      owners: [],
      latestClaimAt: null,
      earliestClaimAt: null,
    });
  });

  it("counts total claims, distinct owners, and the latest / earliest instants", () => {
    const rows = [
      makeRow({ coordination_id: "c1", operator_id: "op-a", claimed_at: "2026-07-01T00:00:00.000Z" }),
      makeRow({ coordination_id: "c2", operator_id: "op-a", claimed_at: "2026-07-04T00:00:00.000Z" }),
      makeRow({ coordination_id: "c3", operator_id: "op-b", claimed_at: "2026-07-02T00:00:00.000Z" }),
    ];
    const summary = summariseOwnership(rows);
    expect(summary.totalClaims).toBe(3);
    expect(summary.distinctOwners).toBe(2);
    expect(summary.latestClaimAt).toBe("2026-07-04T00:00:00.000Z");
    expect(summary.earliestClaimAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("tallies each owner — claim count, and that owner's LATEST claim + its email", () => {
    const rows = [
      makeRow({ coordination_id: "c1", operator_id: "op-a", operator_email: "old@crewflow.uk", claimed_at: "2026-07-01T00:00:00.000Z" }),
      makeRow({ coordination_id: "c2", operator_id: "op-a", operator_email: "new@crewflow.uk", claimed_at: "2026-07-05T00:00:00.000Z" }),
    ];
    const summary = summariseOwnership(rows);
    expect(summary.owners).toEqual([
      { operatorId: "op-a", operatorEmail: "new@crewflow.uk", claimCount: 2, latestClaimAt: "2026-07-05T00:00:00.000Z" },
    ]);
  });

  it("orders owners by claim count (desc), then latest claim (desc), then operator id", () => {
    const rows = [
      // op-a: 1 claim; op-b: 2 claims; op-c: 1 claim, newer than op-a.
      makeRow({ coordination_id: "c1", operator_id: "op-a", claimed_at: "2026-07-01T00:00:00.000Z" }),
      makeRow({ coordination_id: "c2", operator_id: "op-b", claimed_at: "2026-07-02T00:00:00.000Z" }),
      makeRow({ coordination_id: "c3", operator_id: "op-b", claimed_at: "2026-07-03T00:00:00.000Z" }),
      makeRow({ coordination_id: "c4", operator_id: "op-c", claimed_at: "2026-07-04T00:00:00.000Z" }),
    ];
    const summary = summariseOwnership(rows);
    // op-b first (2 claims); then op-c (1 claim, newer) before op-a (1 claim, older).
    expect(summary.owners.map((o) => o.operatorId)).toEqual(["op-b", "op-c", "op-a"]);
  });

  it("is ORDER-INDEPENDENT — shuffling the input rows yields an identical summary", () => {
    const r1 = makeRow({ coordination_id: "c1", operator_id: "op-a", claimed_at: "2026-07-01T00:00:00.000Z" });
    const r2 = makeRow({ coordination_id: "c2", operator_id: "op-b", claimed_at: "2026-07-02T00:00:00.000Z" });
    const r3 = makeRow({ coordination_id: "c3", operator_id: "op-b", claimed_at: "2026-07-03T00:00:00.000Z" });
    const r4 = makeRow({ coordination_id: "c4", operator_id: "op-c", claimed_at: "2026-07-04T00:00:00.000Z" });
    const rows = [r1, r2, r3, r4];
    const forward = summariseOwnership(rows);
    const reversed = summariseOwnership([...rows].reverse());
    const rotated = summariseOwnership([r3, r1, r4, r2]);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("selects the latest / earliest instants independent of row order, tie-broken by coordination id", () => {
    const rows = [
      makeRow({ coordination_id: "c-late", operator_id: "op-a", claimed_at: "2026-07-06T00:00:00.000Z" }),
      makeRow({ coordination_id: "c-early", operator_id: "op-b", claimed_at: "2026-07-01T00:00:00.000Z" }),
    ];
    const summary = summariseOwnership(rows);
    const flipped = summariseOwnership([...rows].reverse());
    expect(summary.latestClaimAt).toBe("2026-07-06T00:00:00.000Z");
    expect(summary.earliestClaimAt).toBe("2026-07-01T00:00:00.000Z");
    expect(flipped.latestClaimAt).toBe(summary.latestClaimAt);
    expect(flipped.earliestClaimAt).toBe(summary.earliestClaimAt);
  });

  it("groups by CURRENT owner — a reassigned claim tallies under its holder, not its claimant (R53)", () => {
    const rows = [
      makeRow({ coordination_id: "c1", operator_id: "op-a", operator_email: "a@crewflow.uk", claimed_at: "2026-07-01T00:00:00.000Z" }),
      makeRow({ coordination_id: "c2", operator_id: "op-a", operator_email: "a@crewflow.uk", claimed_at: "2026-07-02T00:00:00.000Z" }),
    ];
    // c1 is transferred A→B; c2 stays with A. So A holds ONE (c2), B holds ONE (c1) — two distinct CURRENT owners.
    const reassignments = [
      makeReassignment({
        coordination_id: "c1",
        from_operator_id: "op-a",
        to_operator_id: "op-b",
        to_operator_email: "b@crewflow.uk",
      }),
    ];
    const summary = summariseOwnership(rows, reassignments);
    expect(summary.totalClaims).toBe(2);
    expect(summary.distinctOwners).toBe(2);
    const byOwner = new Map(summary.owners.map((o) => [o.operatorId, o] as const));
    expect(byOwner.get("op-a")?.claimCount).toBe(1);
    expect(byOwner.get("op-b")?.claimCount).toBe(1);
    // B's tally email comes from the HOLDER (the transfer's target), not from any claim row.
    expect(byOwner.get("op-b")?.operatorEmail).toBe("b@crewflow.uk");
  });

  it("collapses to ONE current owner when every claim is reassigned to the same operator (R53)", () => {
    const rows = [
      makeRow({ coordination_id: "c1", operator_id: "op-a", claimed_at: "2026-07-01T00:00:00.000Z" }),
      makeRow({ coordination_id: "c2", operator_id: "op-b", claimed_at: "2026-07-02T00:00:00.000Z" }),
    ];
    // Both A's and B's claims are transferred to C — C holds both, so there is ONE distinct current owner.
    const reassignments = [
      makeReassignment({ id: "r1", coordination_id: "c1", to_operator_id: "op-c", to_operator_email: "c@crewflow.uk" }),
      makeReassignment({ id: "r2", coordination_id: "c2", to_operator_id: "op-c", to_operator_email: "c@crewflow.uk" }),
    ];
    const summary = summariseOwnership(rows, reassignments);
    expect(summary.totalClaims).toBe(2);
    expect(summary.distinctOwners).toBe(1);
    expect(summary.owners).toHaveLength(1);
    expect(summary.owners[0]?.operatorId).toBe("op-c");
    expect(summary.owners[0]?.claimCount).toBe(2);
  });
});

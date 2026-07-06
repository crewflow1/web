import { describe, it, expect } from "vitest";
import {
  OWNERSHIP_STATES,
  projectOwner,
  projectOwnership,
  projectOwnershipEvent,
  compareOwnershipEvents,
  orderOwnershipEvents,
  summariseOwnership,
  type OwnershipClaimRow,
  type OwnershipEvent,
} from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * Conversation Work Ownership Read Model — pure-core unit tests (the AI Receptionist Programme, R48: CONVERSATION WORK
 * OWNERSHIP READ MODEL).
 *
 * The read model's PURE CORE turns already-recorded claim rows into ownership FACTS — viewer-agnostic. It reaches no
 * I/O, holds no clock, records nothing and decides no claim, so it is total, deterministic and dependency-free, and
 * THAT is exactly what this suite pins:
 *   • projectOwner          — one raw ledger row → the owner facts (a straight relabelling).
 *   • projectOwnership      — a coordination id + its claim row (or null) → the per-coordination ownership record:
 *                             current owner, claim timestamp, ownership status (owned / unowned).
 *   • projectOwnershipEvent — one raw ledger row → one ownership event.
 *   • orderOwnershipEvents  — the canonical history order: newest claim first, stable tiebreak on coordination id,
 *                             instant-based, non-mutating.
 *   • summariseOwnership    — a set of ledger rows → the org-wide ownership summary; a total, ORDER-INDEPENDENT fold.
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
  it("projects a present claim as OWNED, with the current owner and claim timestamp", () => {
    const record = projectOwnership({ coordinationId: "coord-9", claim: makeRow({ coordination_id: "coord-9" }) });
    expect(record.status).toBe("owned");
    expect(record.owned).toBe(true);
    expect(record.coordinationId).toBe("coord-9");
    expect(record.conversationId).toBe("conv-1");
    expect(record.claimedAt).toBe("2026-07-06T12:00:00.000Z");
    expect(record.owner).toEqual({
      operatorId: "operator-1",
      operatorEmail: "op@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("projects an absent claim as UNOWNED, with no owner and no timestamp", () => {
    const record = projectOwnership({ coordinationId: "coord-9", claim: null });
    expect(record).toEqual({
      coordinationId: "coord-9",
      conversationId: null,
      status: "unowned",
      owned: false,
      owner: null,
      claimedAt: null,
    });
  });

  it("reports on the coordination it was asked about (uses the queried id)", () => {
    const record = projectOwnership({ coordinationId: "asked-for", claim: null });
    expect(record.coordinationId).toBe("asked-for");
  });
});

describe("projectOwnershipEvent — one ledger row → one ownership event", () => {
  it("relabels the recorded claim into an ownership event", () => {
    expect(projectOwnershipEvent(makeRow())).toEqual({
      coordinationId: "coord-1",
      conversationId: "conv-1",
      operatorId: "operator-1",
      operatorEmail: "op@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
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
});

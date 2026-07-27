import { describe, it, expect } from "vitest";
import {
  OWNERSHIP_LIFECYCLE,
  deriveOwnershipState,
  isUnclaimed,
  isClaimed,
  isReleased,
  isOwnedState,
  latestReassignmentFor,
  resolveCurrentOwner,
  projectOwnershipState,
  reconcileOwnershipStates,
  type OwnershipClaimEvent,
  type OwnershipReleaseEvent,
  type OwnershipReassignmentEvent,
  type OwnershipState,
} from "@/lib/receptionist/conversation-ownership-state";

/**
 * Conversation Ownership STATE ENGINE — pure-core unit tests (the AI Receptionist Programme, R51: CONVERSATION OWNERSHIP
 * STATE ENGINE; reassignment-aware current-owner resolution since R53: OWNERSHIP READ MODEL REASSIGNMENT AWARENESS).
 *
 * The engine's PURE CORE is the single canonical DERIVATION of ownership state from the append-only ownership event
 * stream (the R46 claim ledger + the R50 release ledger) AND — since R53 — the single canonical resolution of the CURRENT
 * OWNER, folding the R52 reassignment ledger. It reaches no I/O, holds no clock, records nothing and decides neither a
 * claim, a release nor a reassignment, so it is total, deterministic and dependency-free — and THAT is exactly what this
 * suite pins:
 *   • OWNERSHIP_LIFECYCLE — the closed three-member vocabulary is exactly R51's unclaimed / claimed / released.
 *   • deriveOwnershipState — THE fold: no claim ⇒ unclaimed; a claim, no release ⇒ claimed; a claim AND a release ⇒
 *     released. Total over any (claim?, release?) pair, deterministic, non-mutating. Reassignment does NOT add a state.
 *   • isUnclaimed / isClaimed / isReleased / isOwnedState — the total predicates + the owned/unowned projection the read
 *     model consumes (owned IFF claimed).
 *   • latestReassignmentFor / resolveCurrentOwner — the transfer-chain tail (by reassigned_at, created_at, id) and the
 *     current holder it resolves: the latest to_operator, else the original claimant, else null when never claimed.
 *   • projectOwnershipState — a coordination's events → its state record (state + current owner + the events it derived
 *     from).
 *   • reconcileOwnershipStates — an org's claim + release + reassignment events → one state record per claimed
 *     coordination, matched by coordination id, order-independent.
 */

const CLAIMED_AT = "2026-07-06T12:00:00.000Z";
const RELEASED_AT = "2026-07-06T13:00:00.000Z";
const REASSIGNED_AT = "2026-07-06T14:00:00.000Z";

function makeClaim(overrides: Partial<OwnershipClaimEvent> = {}): OwnershipClaimEvent {
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
    claimed_at: CLAIMED_AT,
    ...overrides,
  };
}

function makeRelease(overrides: Partial<OwnershipReleaseEvent> = {}): OwnershipReleaseEvent {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    operator_id: "operator-1",
    operator_email: "op@crewflow.uk",
    released_at: RELEASED_AT,
    ...overrides,
  };
}

function makeReassignment(
  overrides: Partial<OwnershipReassignmentEvent> = {},
): OwnershipReassignmentEvent {
  return {
    id: "reassign-1",
    org_id: "org-1",
    coordination_id: "coord-1",
    from_operator_id: "operator-1",
    from_operator_email: "op@crewflow.uk",
    to_operator_id: "operator-2",
    to_operator_email: "op2@crewflow.uk",
    reassigned_at: REASSIGNED_AT,
    created_at: REASSIGNED_AT,
    ...overrides,
  };
}

describe("OWNERSHIP_LIFECYCLE — the closed state vocabulary", () => {
  it("is exactly unclaimed + claimed + released (R51 derives three states)", () => {
    expect(OWNERSHIP_LIFECYCLE).toEqual(["unclaimed", "claimed", "released"]);
  });

  it("is the total domain of every predicate", () => {
    // Each member is classified by exactly one of the three lifecycle predicates.
    for (const state of OWNERSHIP_LIFECYCLE) {
      const hits = [isUnclaimed(state), isClaimed(state), isReleased(state)].filter(Boolean);
      expect(hits).toHaveLength(1);
    }
  });
});

describe("deriveOwnershipState — the single canonical derivation", () => {
  it("derives unclaimed when there is no claim event", () => {
    expect(deriveOwnershipState({})).toBe("unclaimed");
    expect(deriveOwnershipState({ claim: null })).toBe("unclaimed");
    expect(deriveOwnershipState({ claim: null, release: null })).toBe("unclaimed");
  });

  it("derives claimed when there is a claim and NO release", () => {
    expect(deriveOwnershipState({ claim: makeClaim() })).toBe("claimed");
    expect(deriveOwnershipState({ claim: makeClaim(), release: null })).toBe("claimed");
  });

  it("derives released when there is a claim AND a release", () => {
    expect(deriveOwnershipState({ claim: makeClaim(), release: makeRelease() })).toBe("released");
  });

  it("stays TOTAL for the impossible release-without-claim shape — no claim ⇒ unclaimed", () => {
    // R50's ownership gate forbids a release without a claim, but the fold must not throw for ANY input: with no claim,
    // there is no ownership to speak of, so the state is `unclaimed` regardless of a stray release.
    expect(deriveOwnershipState({ release: makeRelease() })).toBe("unclaimed");
    expect(deriveOwnershipState({ claim: null, release: makeRelease() })).toBe("unclaimed");
  });

  it("is deterministic — the same events always yield the same state", () => {
    const events = { claim: makeClaim(), release: makeRelease() };
    expect(deriveOwnershipState(events)).toBe(deriveOwnershipState(events));
  });

  it("does not mutate its input events", () => {
    const events = { claim: makeClaim(), release: makeRelease() };
    const snapshot = JSON.parse(JSON.stringify(events));
    deriveOwnershipState(events);
    expect(events).toEqual(snapshot);
  });

  it("derives from the PRESENCE of events, not their content — a released status on the claim is irrelevant", () => {
    // The derivation looks only at whether a claim/release event exists, never at the claim row's own `status` column.
    const claim = makeClaim({ status: "anything" });
    expect(deriveOwnershipState({ claim })).toBe("claimed");
    expect(deriveOwnershipState({ claim, release: makeRelease() })).toBe("released");
  });
});

describe("isUnclaimed / isClaimed / isReleased — total lifecycle predicates", () => {
  it("classify unclaimed", () => {
    expect(isUnclaimed("unclaimed")).toBe(true);
    expect(isClaimed("unclaimed")).toBe(false);
    expect(isReleased("unclaimed")).toBe(false);
  });

  it("classify claimed", () => {
    expect(isUnclaimed("claimed")).toBe(false);
    expect(isClaimed("claimed")).toBe(true);
    expect(isReleased("claimed")).toBe(false);
  });

  it("classify released", () => {
    expect(isUnclaimed("released")).toBe(false);
    expect(isClaimed("released")).toBe(false);
    expect(isReleased("released")).toBe(true);
  });
});

describe("isOwnedState — the owned/unowned projection of the lifecycle", () => {
  it("is owned ONLY for claimed", () => {
    expect(isOwnedState("claimed")).toBe(true);
    expect(isOwnedState("unclaimed")).toBe(false);
    expect(isOwnedState("released")).toBe(false);
  });

  it("agrees with deriveOwnershipState — a claim with no release is the only owned shape", () => {
    expect(isOwnedState(deriveOwnershipState({ claim: makeClaim() }))).toBe(true);
    expect(isOwnedState(deriveOwnershipState({}))).toBe(false);
    expect(isOwnedState(deriveOwnershipState({ claim: makeClaim(), release: makeRelease() }))).toBe(
      false,
    );
  });
});

describe("latestReassignmentFor / resolveCurrentOwner — the current-owner fold (R53)", () => {
  it("latestReassignmentFor returns null when no reassignment names the coordination", () => {
    expect(latestReassignmentFor("coord-1", [])).toBeNull();
    expect(latestReassignmentFor("coord-1", [makeReassignment({ coordination_id: "coord-2" })])).toBeNull();
  });

  it("resolveCurrentOwner returns null when there is no claim — nothing is held", () => {
    expect(resolveCurrentOwner(null, [])).toBeNull();
    expect(resolveCurrentOwner(null, [makeReassignment()])).toBeNull();
  });

  it("resolveCurrentOwner returns the CLAIMANT when the item was never transferred", () => {
    const claim = makeClaim({ operator_id: "operator-A", operator_email: "a@crewflow.uk" });
    expect(resolveCurrentOwner(claim, [])).toEqual({
      operatorId: "operator-A",
      operatorEmail: "a@crewflow.uk",
    });
  });

  it("resolveCurrentOwner returns the latest target's identity — carrying a null target email verbatim", () => {
    const claim = makeClaim({ operator_id: "operator-A" });
    const reassignment = makeReassignment({ to_operator_id: "operator-B", to_operator_email: null });
    expect(resolveCurrentOwner(claim, [reassignment])).toEqual({
      operatorId: "operator-B",
      operatorEmail: null,
    });
  });

  it("breaks a reassigned_at tie by created_at, then by id — mirroring the R52 database order", () => {
    const claim = makeClaim({ operator_id: "operator-A" });
    const sameInstant = "2026-07-06T15:00:00.000Z";
    // Two legs at the SAME reassigned_at: the one with the newer created_at wins.
    const byCreatedAt = [
      makeReassignment({ id: "x", to_operator_id: "operator-EARLY", reassigned_at: sameInstant, created_at: "2026-07-06T15:00:00.000Z" }),
      makeReassignment({ id: "y", to_operator_id: "operator-LATE", reassigned_at: sameInstant, created_at: "2026-07-06T15:30:00.000Z" }),
    ];
    expect(resolveCurrentOwner(claim, byCreatedAt)?.operatorId).toBe("operator-LATE");
    // Two legs at the SAME reassigned_at AND created_at: the higher id wins.
    const byId = [
      makeReassignment({ id: "id-a", to_operator_id: "operator-LOW", reassigned_at: sameInstant, created_at: sameInstant }),
      makeReassignment({ id: "id-b", to_operator_id: "operator-HIGH", reassigned_at: sameInstant, created_at: sameInstant }),
    ];
    expect(resolveCurrentOwner(claim, byId)?.operatorId).toBe("operator-HIGH");
  });
});

describe("projectOwnershipState — a coordination's events → its state record", () => {
  it("folds a claim-only coordination into a claimed record carrying the claim", () => {
    const claim = makeClaim();
    expect(projectOwnershipState({ coordinationId: "coord-1", claim })).toEqual({
      coordinationId: "coord-1",
      state: "claimed",
      claim,
      release: null,
      reassignments: [],
      currentOwner: { operatorId: "operator-1", operatorEmail: "op@crewflow.uk" },
    });
  });

  it("folds a claimed-then-released coordination into a released record carrying both events", () => {
    const claim = makeClaim();
    const release = makeRelease();
    expect(projectOwnershipState({ coordinationId: "coord-1", claim, release })).toEqual({
      coordinationId: "coord-1",
      state: "released",
      claim,
      release,
      reassignments: [],
      // A released record still names its LAST holder (the claimant here) — state, not owner, decides owned/unowned.
      currentOwner: { operatorId: "operator-1", operatorEmail: "op@crewflow.uk" },
    });
  });

  it("folds a never-claimed coordination into an unclaimed record with both events null", () => {
    expect(projectOwnershipState({ coordinationId: "coord-9" })).toEqual({
      coordinationId: "coord-9",
      state: "unclaimed",
      claim: null,
      release: null,
      reassignments: [],
      currentOwner: null,
    });
  });

  it("resolves the CURRENT OWNER to the latest reassignment's target — a reassigned item is still `claimed`", () => {
    // A→B transfer: the state stays `claimed` (the item is held), but the current owner is B, not the claimant A.
    const claim = makeClaim({ operator_id: "operator-A", operator_email: "a@crewflow.uk" });
    const reassignment = makeReassignment({
      from_operator_id: "operator-A",
      from_operator_email: "a@crewflow.uk",
      to_operator_id: "operator-B",
      to_operator_email: "b@crewflow.uk",
    });
    const record = projectOwnershipState({
      coordinationId: "coord-1",
      claim,
      reassignments: [reassignment],
    });
    expect(record.state).toBe("claimed");
    expect(record.currentOwner).toEqual({ operatorId: "operator-B", operatorEmail: "b@crewflow.uk" });
    expect(record.reassignments).toEqual([reassignment]);
  });

  it("resolves the CURRENT OWNER to the TAIL of a chain A→B→C (latest by reassigned_at, then created_at, then id)", () => {
    const claim = makeClaim({ operator_id: "operator-A" });
    const legs = [
      makeReassignment({
        id: "leg-2",
        from_operator_id: "operator-B",
        to_operator_id: "operator-C",
        to_operator_email: "c@crewflow.uk",
        reassigned_at: "2026-07-06T16:00:00.000Z",
        created_at: "2026-07-06T16:00:00.000Z",
      }),
      makeReassignment({
        id: "leg-1",
        from_operator_id: "operator-A",
        to_operator_id: "operator-B",
        to_operator_email: "b@crewflow.uk",
        reassigned_at: "2026-07-06T15:00:00.000Z",
        created_at: "2026-07-06T15:00:00.000Z",
      }),
    ];
    // The chain is supplied out of order — the tail (C) is resolved regardless, order-independently.
    expect(resolveCurrentOwner(claim, legs)).toEqual({
      operatorId: "operator-C",
      operatorEmail: "c@crewflow.uk",
    });
    expect(latestReassignmentFor("coord-1", legs)?.id).toBe("leg-2");
  });

  it("ignores reassignments naming a DIFFERENT coordination (filtered defensively)", () => {
    const claim = makeClaim({ coordination_id: "coord-1", operator_id: "operator-A", operator_email: "a@crewflow.uk" });
    const strayLeg = makeReassignment({ coordination_id: "coord-2", to_operator_id: "operator-Z" });
    const record = projectOwnershipState({
      coordinationId: "coord-1",
      claim,
      reassignments: [strayLeg],
    });
    // The stray leg names coord-2, so coord-1's current owner is still its claimant, and its chain is empty.
    expect(record.currentOwner).toEqual({ operatorId: "operator-A", operatorEmail: "a@crewflow.uk" });
    expect(record.reassignments).toEqual([]);
  });

  it("normalises omitted events to null (the defaults are absent)", () => {
    const record = projectOwnershipState({ coordinationId: "coord-1", claim: makeClaim() });
    expect(record.release).toBeNull();
  });

  it("carries the coordination id verbatim", () => {
    expect(projectOwnershipState({ coordinationId: "coord-X", claim: makeClaim() }).coordinationId).toBe(
      "coord-X",
    );
  });
});

describe("reconcileOwnershipStates — an org's events → per-claim state records", () => {
  it("maps claims with no releases to all-claimed records, one per claim", () => {
    const claims = [
      makeClaim({ coordination_id: "coord-1" }),
      makeClaim({ coordination_id: "coord-2" }),
    ];
    const records = reconcileOwnershipStates(claims, []);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.state === "claimed")).toBe(true);
    expect(records.map((r) => r.coordinationId)).toEqual(["coord-1", "coord-2"]);
  });

  it("marks a coordination released when a release names it, matched by coordination id", () => {
    const claims = [
      makeClaim({ coordination_id: "coord-1" }),
      makeClaim({ coordination_id: "coord-2" }),
      makeClaim({ coordination_id: "coord-3" }),
    ];
    const releases = [makeRelease({ coordination_id: "coord-2" })];
    const records = reconcileOwnershipStates(claims, releases);
    const byId = new Map(records.map((r) => [r.coordinationId, r] as const));
    expect(byId.get("coord-1")?.state).toBe("claimed");
    expect(byId.get("coord-2")?.state).toBe("released");
    expect(byId.get("coord-2")?.release).toEqual(releases[0]);
    expect(byId.get("coord-3")?.state).toBe("claimed");
  });

  it("threads each coordination's reassignment chain into its record's current owner (R53)", () => {
    const claims = [
      makeClaim({ coordination_id: "coord-1", operator_id: "operator-A", operator_email: "a@crewflow.uk" }),
      makeClaim({ coordination_id: "coord-2", operator_id: "operator-A", operator_email: "a@crewflow.uk" }),
    ];
    // coord-1 is transferred A→B; coord-2 is never transferred, so its owner stays the claimant A.
    const reassignments = [
      makeReassignment({
        coordination_id: "coord-1",
        from_operator_id: "operator-A",
        to_operator_id: "operator-B",
        to_operator_email: "b@crewflow.uk",
      }),
    ];
    const records = reconcileOwnershipStates(claims, [], reassignments);
    const byId = new Map(records.map((r) => [r.coordinationId, r] as const));
    expect(byId.get("coord-1")?.state).toBe("claimed");
    expect(byId.get("coord-1")?.currentOwner).toEqual({ operatorId: "operator-B", operatorEmail: "b@crewflow.uk" });
    expect(byId.get("coord-2")?.currentOwner).toEqual({ operatorId: "operator-A", operatorEmail: "a@crewflow.uk" });
  });

  it("gives each record only ITS OWN transfer chain — reassignments matched by coordination id", () => {
    const claims = [
      makeClaim({ coordination_id: "coord-1", operator_id: "operator-A" }),
      makeClaim({ coordination_id: "coord-2", operator_id: "operator-A" }),
    ];
    const reassignments = [
      makeReassignment({ id: "r1", coordination_id: "coord-1", to_operator_id: "operator-B" }),
      makeReassignment({ id: "r2", coordination_id: "coord-2", to_operator_id: "operator-C" }),
    ];
    const records = reconcileOwnershipStates(claims, [], reassignments);
    const byId = new Map(records.map((r) => [r.coordinationId, r] as const));
    expect(byId.get("coord-1")?.reassignments.map((x) => x.id)).toEqual(["r1"]);
    expect(byId.get("coord-2")?.reassignments.map((x) => x.id)).toEqual(["r2"]);
  });

  it("emits ONE record per CLAIM — a release with no matching claim is ignored (unclaimed is unrecorded)", () => {
    const claims = [makeClaim({ coordination_id: "coord-1" })];
    const releases = [
      makeRelease({ coordination_id: "coord-1" }),
      makeRelease({ coordination_id: "coord-orphan" }),
    ];
    const records = reconcileOwnershipStates(claims, releases);
    expect(records).toHaveLength(1);
    expect(records[0]?.coordinationId).toBe("coord-1");
    expect(records[0]?.state).toBe("released");
  });

  it("is ORDER-INDEPENDENT — shuffling either input yields the same set of records", () => {
    const claims = [
      makeClaim({ coordination_id: "coord-1" }),
      makeClaim({ coordination_id: "coord-2" }),
      makeClaim({ coordination_id: "coord-3" }),
    ];
    const releases = [
      makeRelease({ coordination_id: "coord-1" }),
      makeRelease({ coordination_id: "coord-3" }),
    ];
    const forward = reconcileOwnershipStates(claims, releases);
    const shuffled = reconcileOwnershipStates([...claims].reverse(), [...releases].reverse());
    const key = (r: { coordinationId: string; state: OwnershipState }) => `${r.coordinationId}:${r.state}`;
    expect(new Set(shuffled.map(key))).toEqual(new Set(forward.map(key)));
  });

  it("does not mutate its input arrays", () => {
    const claims = [makeClaim({ coordination_id: "coord-1" })];
    const releases = [makeRelease({ coordination_id: "coord-1" })];
    const claimsSnapshot = JSON.parse(JSON.stringify(claims));
    const releasesSnapshot = JSON.parse(JSON.stringify(releases));
    reconcileOwnershipStates(claims, releases);
    expect(claims).toEqual(claimsSnapshot);
    expect(releases).toEqual(releasesSnapshot);
  });

  it("returns an empty set for no claims", () => {
    expect(reconcileOwnershipStates([], [])).toEqual([]);
    expect(reconcileOwnershipStates([], [makeRelease()])).toEqual([]);
  });
});

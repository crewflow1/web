import { describe, it, expect } from "vitest";
import {
  projectReassignmentView,
  describeReassignmentOutcome,
  toReassignmentCandidates,
  type ReassignmentOperator,
} from "@/lib/receptionist/conversation-reassignment-view";
import { REASSIGNMENT_RESOLUTIONS } from "@/lib/receptionist/conversation-reassignment";
import type {
  OwnershipRecord,
  OwnerView,
} from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * Conversation Work Reassignment Surface — pure view-core unit tests (the AI Receptionist Programme, R54: CONVERSATION
 * WORK REASSIGNMENT SURFACE).
 *
 * The surface's PURE CORE consumes the R48 Ownership Read Model's OUTPUT (an {@link OwnershipRecord} — the CURRENT owner,
 * folded from the R51/R53 transfer chain) plus the org's authorised operator roster, and projects the transfer view. It
 * reaches no I/O, holds no clock, records nothing and decides no reassignment, so it is total, deterministic and
 * dependency-free, and THAT is exactly what this suite pins:
 *   • projectReassignmentView     — ownership record + roster + viewer id → the transfer view: the current owner, the
 *                                   destination candidates (the roster MINUS the current owner, labelled + ordered), and
 *                                   whether a transfer is offered (owned AND another operator exists).
 *   • describeReassignmentOutcome — one runtime resolution → one display row (ok iff reassigned).
 */

function makeOwner(id: string, email: string | null = `${id}@crewflow.uk`): OwnerView {
  return {
    operatorId: id,
    operatorEmail: email,
    claimType: "claim_conversation_work",
    claimOutcome: "work_claimed",
    claimedAt: "2026-07-06T12:00:00.000Z",
  };
}

/** An OWNED ownership record held by `id`, with overridable fields (reassigned / claimedAt / heldSince / …). */
function ownedBy(id: string, overrides: Partial<OwnershipRecord> = {}): OwnershipRecord {
  const owner = makeOwner(id);
  return {
    coordinationId: "coord-1",
    conversationId: "conv-1",
    status: "owned",
    owned: true,
    owner,
    claimant: { operatorId: owner.operatorId, operatorEmail: owner.operatorEmail },
    reassigned: false,
    claimedAt: owner.claimedAt,
    heldSince: owner.claimedAt,
    ...overrides,
  };
}

const UNOWNED: OwnershipRecord = {
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

function op(
  id: string,
  name: string | null = null,
  email: string | null = `${id}@crewflow.uk`,
): ReassignmentOperator {
  return { operatorId: id, operatorEmail: email, operatorName: name };
}

describe("projectReassignmentView — the transfer view over an ownership record + the operator roster", () => {
  it("an UNOWNED item offers no transfer — no owner, no candidates, no affordance", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: UNOWNED,
      operators: [op("a"), op("b")],
      viewerOperatorId: "a",
    });
    expect(view.owned).toBe(false);
    expect(view.canReassign).toBe(false);
    expect(view.candidates).toEqual([]);
    expect(view.currentOwnerId).toBeNull();
    expect(view.currentOwnerLabel).toBeNull();
    expect(view.viewerHoldsOwnership).toBe(false);
  });

  it("labels the current owner 'You' when the viewer holds it, and excludes them from the candidates", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("me"),
      operators: [op("me"), op("other")],
      viewerOperatorId: "me",
    });
    expect(view.owned).toBe(true);
    expect(view.viewerHoldsOwnership).toBe(true);
    expect(view.currentOwnerId).toBe("me");
    expect(view.currentOwnerLabel).toBe("You");
    expect(view.candidates.map((c) => c.operatorId)).toEqual(["other"]);
    expect(view.canReassign).toBe(true);
  });

  it("labels the current owner by email when another operator holds it (viewer does not hold)", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [op("owner"), op("me")],
      viewerOperatorId: "me",
    });
    expect(view.viewerHoldsOwnership).toBe(false);
    expect(view.currentOwnerLabel).toBe("owner@crewflow.uk");
    expect(view.candidates.map((c) => c.operatorId)).toEqual(["me"]);
  });

  it("NEVER offers the current owner as a destination candidate (a transfer must move the item)", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [op("owner"), op("a"), op("b")],
      viewerOperatorId: "x",
    });
    expect(view.candidates.map((c) => c.operatorId)).not.toContain("owner");
    expect(view.candidates.map((c) => c.operatorId)).toEqual(["a", "b"]);
  });

  it("orders the candidates deterministically, regardless of input order", () => {
    const forward = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [op("a"), op("b"), op("c")],
      viewerOperatorId: "x",
    }).candidates.map((c) => c.operatorId);
    const shuffled = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [op("c"), op("a"), op("b")],
      viewerOperatorId: "x",
    }).candidates.map((c) => c.operatorId);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(shuffled).toEqual(forward);
  });

  it("an OWNED item with no OTHER operator offers no transfer (empty candidates, canReassign false)", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [op("owner")],
      viewerOperatorId: "owner",
    });
    expect(view.owned).toBe(true);
    expect(view.candidates).toEqual([]);
    expect(view.canReassign).toBe(false);
  });

  it("carries the reassigned flag, claimedAt and heldSince through from the record", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner", {
        reassigned: true,
        claimedAt: "2026-07-01T00:00:00.000Z",
        heldSince: "2026-07-05T00:00:00.000Z",
      }),
      operators: [op("owner"), op("x")],
      viewerOperatorId: "z",
    });
    expect(view.reassigned).toBe(true);
    expect(view.claimedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(view.heldSince).toBe("2026-07-05T00:00:00.000Z");
  });

  it("labels a candidate by name, else email, else id", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators: [
        op("owner"),
        { operatorId: "n", operatorEmail: "n@crewflow.uk", operatorName: "Nadia" },
        { operatorId: "e", operatorEmail: "e@crewflow.uk", operatorName: null },
        { operatorId: "i", operatorEmail: null, operatorName: null },
      ],
      viewerOperatorId: "z",
    });
    const labelById = Object.fromEntries(view.candidates.map((c) => [c.operatorId, c.label]));
    expect(labelById["n"]).toBe("Nadia");
    expect(labelById["e"]).toBe("e@crewflow.uk");
    expect(labelById["i"]).toBe("i");
  });

  it("does not mutate its operators input", () => {
    const operators = [op("b"), op("a")];
    const snapshot = operators.map((o) => o.operatorId);
    projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators,
      viewerOperatorId: "z",
    });
    expect(operators.map((o) => o.operatorId)).toEqual(snapshot);
  });

  it("is deterministic — the same inputs yield an equal view", () => {
    const ownership = ownedBy("owner");
    const operators = [op("a"), op("b")];
    const a = projectReassignmentView({ coordinationId: "c", ownership, operators, viewerOperatorId: "z" });
    const b = projectReassignmentView({ coordinationId: "c", ownership, operators, viewerOperatorId: "z" });
    expect(a).toEqual(b);
  });

  it("carries the coordination id through verbatim", () => {
    const view = projectReassignmentView({
      coordinationId: "coord-xyz",
      ownership: ownedBy("owner"),
      operators: [],
      viewerOperatorId: "z",
    });
    expect(view.coordinationId).toBe("coord-xyz");
  });
});

describe("toReassignmentCandidates — the shared roster-minus-owner destination projection (R62 reuse)", () => {
  it("excludes the named operator and labels + orders the rest — the SAME set projectReassignmentView folds in", () => {
    const operators = [op("owner"), op("a"), op("b")];
    const candidates = toReassignmentCandidates(operators, { excludeOperatorId: "owner" });
    expect(candidates.map((c) => c.operatorId)).toEqual(["a", "b"]);
    // Byte-for-byte the candidate list projectReassignmentView derives for the same owner — the shared derivation.
    const viaView = projectReassignmentView({
      coordinationId: "coord-1",
      ownership: ownedBy("owner"),
      operators,
      viewerOperatorId: "z",
    }).candidates;
    expect(candidates).toEqual(viaView);
  });

  it("orders deterministically regardless of input order", () => {
    const forward = toReassignmentCandidates([op("a"), op("b"), op("c")], { excludeOperatorId: "x" });
    const shuffled = toReassignmentCandidates([op("c"), op("a"), op("b")], { excludeOperatorId: "x" });
    expect(forward.map((c) => c.operatorId)).toEqual(["a", "b", "c"]);
    expect(shuffled.map((c) => c.operatorId)).toEqual(forward.map((c) => c.operatorId));
  });

  it("labels each candidate by name, else email, else id", () => {
    const candidates = toReassignmentCandidates(
      [
        { operatorId: "n", operatorEmail: "n@crewflow.uk", operatorName: "Nadia" },
        { operatorId: "e", operatorEmail: "e@crewflow.uk", operatorName: null },
        { operatorId: "i", operatorEmail: null, operatorName: null },
      ],
      { excludeOperatorId: null },
    );
    const labelById = Object.fromEntries(candidates.map((c) => [c.operatorId, c.label]));
    expect(labelById["n"]).toBe("Nadia");
    expect(labelById["e"]).toBe("e@crewflow.uk");
    expect(labelById["i"]).toBe("i");
  });

  it("returns empty when the ONLY operator is the excluded one — no destination remains", () => {
    expect(toReassignmentCandidates([op("owner")], { excludeOperatorId: "owner" })).toEqual([]);
  });

  it("a null excludeOperatorId excludes no one — every operator becomes a candidate", () => {
    const candidates = toReassignmentCandidates([op("a"), op("b")], { excludeOperatorId: null });
    expect(candidates.map((c) => c.operatorId)).toEqual(["a", "b"]);
  });

  it("does not mutate its operators input", () => {
    const operators = [op("b"), op("a")];
    const snapshot = operators.map((o) => o.operatorId);
    toReassignmentCandidates(operators, { excludeOperatorId: "z" });
    expect(operators.map((o) => o.operatorId)).toEqual(snapshot);
  });
});

describe("describeReassignmentOutcome — one runtime resolution → one display row", () => {
  it("reassigned → success, ok", () => {
    const v = describeReassignmentOutcome("reassigned");
    expect(v.ok).toBe(true);
    expect(v.tone).toBe("success");
    expect(v.message).toMatch(/reassigned/i);
  });

  it("not_owned → warning, not ok", () => {
    const v = describeReassignmentOutcome("not_owned");
    expect(v.ok).toBe(false);
    expect(v.tone).toBe("warning");
  });

  it("unavailable → error, not ok", () => {
    const v = describeReassignmentOutcome("unavailable");
    expect(v.ok).toBe(false);
    expect(v.tone).toBe("error");
  });

  it("is EXHAUSTIVE over the closed resolution vocabulary; ok iff reassigned", () => {
    for (const resolution of REASSIGNMENT_RESOLUTIONS) {
      const v = describeReassignmentOutcome(resolution);
      expect(v.resolution).toBe(resolution);
      expect(v.ok).toBe(resolution === "reassigned");
      expect(["success", "warning", "error"]).toContain(v.tone);
      expect(v.message.length).toBeGreaterThan(0);
    }
  });
});

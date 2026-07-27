import { describe, it, expect } from "vitest";
import {
  REASSIGNMENT_TYPES,
  REASSIGNMENT_RESOLUTIONS,
  resolveReassignment,
  isReassignmentDecided,
  reassignmentTypeOf,
  reassignmentOutcomeOf,
  type ReassignmentRequest,
  type ReassignmentDecision,
} from "@/lib/receptionist/conversation-reassignment";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work REASSIGNMENT — pure-core unit tests (the AI Receptionist Programme, R52: CONVERSATION WORK
 * REASSIGNMENT).
 *
 * The reassignment's PURE CORE turns a reassignment REQUEST into a reassignment DECISION — validating SHAPE only. It
 * reaches no I/O, holds no clock, records nothing and asserts NO ownership (that guard is the runtime's, over the claim +
 * release + reassignment ledgers), so it is total, deterministic and dependency-free, and THAT is exactly what this
 * suite pins:
 *   • the closed vocabularies (reassignment types + the runtime resolutions) are exactly R52's single / three members.
 *   • resolveReassignment — names the `reassign_conversation_work` reassignment for a well-formed request, and abstains
 *     with the PRECISE reason (in a fixed order: org, then coordination, then source operator, then target operator, then
 *     the source-and-target-differ rule) for an ill-shaped one.
 *   • isReassignmentDecided / reassignmentTypeOf / reassignmentOutcomeOf — the total predicates + projections the runtime
 *     reads.
 */

const OPERATOR_A: OperatorIdentity = { id: "operator-1", email: "a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: "operator-2", email: "b@crewflow.uk" };

function makeRequest(overrides: Partial<ReassignmentRequest> = {}): ReassignmentRequest {
  return {
    org_id: "org-1",
    coordination_id: "coord-1",
    from_operator: OPERATOR_A,
    to_operator: OPERATOR_B,
    conversation_id: "conv-1",
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("REASSIGNMENT_TYPES — the closed reassignment-type vocabulary", () => {
  it("is exactly reassign_conversation_work (R52 ships one reassignment type)", () => {
    expect(REASSIGNMENT_TYPES).toEqual(["reassign_conversation_work"]);
  });
});

describe("REASSIGNMENT_RESOLUTIONS — the closed runtime-resolution vocabulary", () => {
  it("is exactly reassigned + not_owned + unavailable", () => {
    expect(REASSIGNMENT_RESOLUTIONS).toEqual(["reassigned", "not_owned", "unavailable"]);
  });
});

describe("resolveReassignment — the derived reassignment decision", () => {
  it("names the reassignment for a well-formed request — carrying both operators, org and coordination", () => {
    const decision = resolveReassignment(makeRequest());
    expect(decision).toEqual({
      kind: "reassign_conversation_work",
      outcome: "work_reassigned",
      from_operator: OPERATOR_A,
      to_operator: OPERATOR_B,
      org_id: "org-1",
      coordination_id: "coord-1",
    });
  });

  it("does NOT fold the conversation / correlation provenance into the decision", () => {
    // The granted decision is self-describing for the ledger's keying — it is exactly the six fields above and no more;
    // conversation_id / correlation_id are provenance the RUNTIME threads onto the row, not part of the decision.
    const decision = resolveReassignment(
      makeRequest({ conversation_id: "conv-X", correlation_id: "corr-X" }),
    );
    expect(Object.keys(decision).sort()).toEqual(
      ["coordination_id", "from_operator", "kind", "org_id", "outcome", "to_operator"].sort(),
    );
  });

  it("abstains missing_organisation when the org is absent or blank", () => {
    expect(resolveReassignment(makeRequest({ org_id: "" }))).toEqual({
      kind: "none",
      reason: "missing_organisation",
    });
    expect(resolveReassignment(makeRequest({ org_id: "   " })).kind).toBe("none");
  });

  it("abstains missing_coordination when the coordination is absent or blank", () => {
    expect(resolveReassignment(makeRequest({ coordination_id: "" }))).toEqual({
      kind: "none",
      reason: "missing_coordination",
    });
    expect(resolveReassignment(makeRequest({ coordination_id: "  " })).kind).toBe("none");
  });

  it("abstains incomplete_source_operator when the source operator id is absent or blank", () => {
    expect(
      resolveReassignment(makeRequest({ from_operator: { id: "", email: "a@crewflow.uk" } })),
    ).toEqual({
      kind: "none",
      reason: "incomplete_source_operator",
    });
    expect(
      resolveReassignment(makeRequest({ from_operator: { id: "   ", email: null } })).kind,
    ).toBe("none");
  });

  it("abstains incomplete_source_operator when the source operator object is missing entirely", () => {
    // The core guards `request.from_operator?.id`, so a request with no source operator abstains rather than throwing.
    const decision = resolveReassignment(
      makeRequest({ from_operator: undefined as unknown as OperatorIdentity }),
    );
    expect(decision).toEqual({ kind: "none", reason: "incomplete_source_operator" });
  });

  it("abstains incomplete_target_operator when the target operator id is absent or blank", () => {
    expect(
      resolveReassignment(makeRequest({ to_operator: { id: "", email: "b@crewflow.uk" } })),
    ).toEqual({
      kind: "none",
      reason: "incomplete_target_operator",
    });
    expect(
      resolveReassignment(makeRequest({ to_operator: { id: "   ", email: null } })).kind,
    ).toBe("none");
  });

  it("abstains incomplete_target_operator when the target operator object is missing entirely", () => {
    const decision = resolveReassignment(
      makeRequest({ to_operator: undefined as unknown as OperatorIdentity }),
    );
    expect(decision).toEqual({ kind: "none", reason: "incomplete_target_operator" });
  });

  it("abstains same_operator when the source and target are the SAME operator", () => {
    // A self-transfer is a no-op — it names no transfer. The id is what is compared (email is best-effort attribution).
    expect(
      resolveReassignment(
        makeRequest({
          from_operator: { id: "operator-1", email: "a@crewflow.uk" },
          to_operator: { id: "operator-1", email: "different@crewflow.uk" },
        }),
      ),
    ).toEqual({ kind: "none", reason: "same_operator" });
  });

  it("still names the reassignment when the operator emails are absent — the id is the load-bearing identity", () => {
    const decision = resolveReassignment(
      makeRequest({
        from_operator: { id: "operator-9", email: null },
        to_operator: { id: "operator-8", email: null },
      }),
    );
    expect(isReassignmentDecided(decision)).toBe(true);
    if (!isReassignmentDecided(decision)) throw new Error("expected a decided reassignment");
    expect(decision.from_operator).toEqual({ id: "operator-9", email: null });
    expect(decision.to_operator).toEqual({ id: "operator-8", email: null });
  });

  it("validates in a fixed order — org, THEN coordination, THEN source, THEN target, THEN distinctness", () => {
    // A request missing ALL FOUR ids reports the FIRST gate that fails — organisation.
    const allMissing = resolveReassignment(
      makeRequest({
        org_id: "",
        coordination_id: "",
        from_operator: { id: "", email: null },
        to_operator: { id: "", email: null },
      }),
    );
    expect(allMissing).toEqual({ kind: "none", reason: "missing_organisation" });

    // With a valid org but missing coordination + operators → coordination is reported next.
    const orgOnly = resolveReassignment(
      makeRequest({
        coordination_id: "",
        from_operator: { id: "", email: null },
        to_operator: { id: "", email: null },
      }),
    );
    expect(orgOnly).toEqual({ kind: "none", reason: "missing_coordination" });

    // With org + coordination but both operators missing → the SOURCE operator is reported before the target.
    const throughCoordination = resolveReassignment(
      makeRequest({
        from_operator: { id: "", email: null },
        to_operator: { id: "", email: null },
      }),
    );
    expect(throughCoordination).toEqual({ kind: "none", reason: "incomplete_source_operator" });

    // With org + coordination + source but the target missing → the TARGET operator is reported before distinctness.
    const throughSource = resolveReassignment(
      makeRequest({ to_operator: { id: "", email: null } }),
    );
    expect(throughSource).toEqual({ kind: "none", reason: "incomplete_target_operator" });

    // With every id present but source === target → distinctness is the last gate.
    const throughTarget = resolveReassignment(
      makeRequest({ to_operator: { id: OPERATOR_A.id, email: "b@crewflow.uk" } }),
    );
    expect(throughTarget).toEqual({ kind: "none", reason: "same_operator" });
  });

  it("is deterministic — the same request always yields the same decision", () => {
    const request = makeRequest();
    expect(resolveReassignment(request)).toEqual(resolveReassignment(request));
  });

  it("does not mutate its input request", () => {
    const request = makeRequest();
    const snapshot = JSON.parse(JSON.stringify(request));
    resolveReassignment(request);
    expect(request).toEqual(snapshot);
  });
});

describe("isReassignmentDecided — the runtime's write gate", () => {
  it("is true for a granted decision and false for an abstention", () => {
    expect(isReassignmentDecided(resolveReassignment(makeRequest()))).toBe(true);
    expect(isReassignmentDecided(resolveReassignment(makeRequest({ org_id: "" })))).toBe(false);
  });

  it("narrows the decision to its granted arm", () => {
    const decision: ReassignmentDecision = resolveReassignment(makeRequest());
    if (isReassignmentDecided(decision)) {
      // Inside the guard, the granted fields are accessible without a cast.
      expect(decision.kind).toBe("reassign_conversation_work");
      expect(decision.outcome).toBe("work_reassigned");
    } else {
      throw new Error("expected the decision to narrow to granted");
    }
  });
});

describe("reassignmentTypeOf / reassignmentOutcomeOf — total projections over a decision", () => {
  it("map a granted decision to its type and outcome", () => {
    const decision = resolveReassignment(makeRequest());
    expect(reassignmentTypeOf(decision)).toBe("reassign_conversation_work");
    expect(reassignmentOutcomeOf(decision)).toBe("work_reassigned");
  });

  it("map an abstention to null", () => {
    const abstention = resolveReassignment(makeRequest({ org_id: "" }));
    expect(reassignmentTypeOf(abstention)).toBeNull();
    expect(reassignmentOutcomeOf(abstention)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  RELEASE_TYPES,
  RELEASE_RESOLUTIONS,
  resolveRelease,
  isReleaseDecided,
  releaseTypeOf,
  releaseOutcomeOf,
  type ReleaseRequest,
  type ReleaseDecision,
} from "@/lib/receptionist/conversation-release";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work RELEASE — pure-core unit tests (the AI Receptionist Programme, R50: CONVERSATION WORK RELEASE).
 *
 * The release's PURE CORE turns a release REQUEST into a release DECISION — validating SHAPE only. It reaches no I/O,
 * holds no clock, records nothing and asserts NO ownership (that guard is the runtime's, over the claim ledger), so it
 * is total, deterministic and dependency-free, and THAT is exactly what this suite pins:
 *   • the closed vocabularies (release types + the runtime resolutions) are exactly R50's single members.
 *   • resolveRelease — names the `release_conversation_work` release for a well-formed request, and abstains with the
 *     PRECISE reason (in a fixed order: org, then coordination, then operator) for an ill-shaped one.
 *   • isReleaseDecided / releaseTypeOf / releaseOutcomeOf — the total predicates + projections the runtime reads.
 */

const OPERATOR: OperatorIdentity = { id: "operator-1", email: "op@crewflow.uk" };

function makeRequest(overrides: Partial<ReleaseRequest> = {}): ReleaseRequest {
  return {
    org_id: "org-1",
    coordination_id: "coord-1",
    operator: OPERATOR,
    conversation_id: "conv-1",
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("RELEASE_TYPES — the closed release-type vocabulary", () => {
  it("is exactly release_conversation_work (R50 ships one release type)", () => {
    expect(RELEASE_TYPES).toEqual(["release_conversation_work"]);
  });
});

describe("RELEASE_RESOLUTIONS — the closed runtime-resolution vocabulary", () => {
  it("is exactly released + not_owned + unavailable", () => {
    expect(RELEASE_RESOLUTIONS).toEqual(["released", "not_owned", "unavailable"]);
  });
});

describe("resolveRelease — the derived release decision", () => {
  it("names the release for a well-formed request — carrying the operator, org and coordination", () => {
    const decision = resolveRelease(makeRequest());
    expect(decision).toEqual({
      kind: "release_conversation_work",
      outcome: "work_released",
      operator: OPERATOR,
      org_id: "org-1",
      coordination_id: "coord-1",
    });
  });

  it("does NOT fold the conversation / correlation provenance into the decision", () => {
    // The granted decision is self-describing for the ledger's keying — it is exactly the five fields above and no
    // more; conversation_id / correlation_id are provenance the RUNTIME threads onto the row, not part of the decision.
    const decision = resolveRelease(
      makeRequest({ conversation_id: "conv-X", correlation_id: "corr-X" }),
    );
    expect(Object.keys(decision).sort()).toEqual(
      ["coordination_id", "kind", "operator", "org_id", "outcome"].sort(),
    );
  });

  it("abstains missing_organisation when the org is absent or blank", () => {
    expect(resolveRelease(makeRequest({ org_id: "" }))).toEqual({
      kind: "none",
      reason: "missing_organisation",
    });
    expect(resolveRelease(makeRequest({ org_id: "   " })).kind).toBe("none");
  });

  it("abstains missing_coordination when the coordination is absent or blank", () => {
    expect(resolveRelease(makeRequest({ coordination_id: "" }))).toEqual({
      kind: "none",
      reason: "missing_coordination",
    });
    expect(resolveRelease(makeRequest({ coordination_id: "  " })).kind).toBe("none");
  });

  it("abstains incomplete_operator_identity when the operator id is absent or blank", () => {
    expect(resolveRelease(makeRequest({ operator: { id: "", email: "op@crewflow.uk" } }))).toEqual({
      kind: "none",
      reason: "incomplete_operator_identity",
    });
    expect(
      resolveRelease(makeRequest({ operator: { id: "   ", email: null } })).kind,
    ).toBe("none");
  });

  it("abstains incomplete_operator_identity when the operator object is missing entirely", () => {
    // The core guards `request.operator?.id`, so a request with no operator abstains rather than throwing.
    const decision = resolveRelease(
      makeRequest({ operator: undefined as unknown as OperatorIdentity }),
    );
    expect(decision).toEqual({ kind: "none", reason: "incomplete_operator_identity" });
  });

  it("still names the release when the operator email is absent — the id is the load-bearing identity", () => {
    const decision = resolveRelease(makeRequest({ operator: { id: "operator-9", email: null } }));
    expect(isReleaseDecided(decision)).toBe(true);
    if (!isReleaseDecided(decision)) throw new Error("expected a decided release");
    expect(decision.operator).toEqual({ id: "operator-9", email: null });
  });

  it("validates in a fixed order — org, THEN coordination, THEN operator", () => {
    // A request missing ALL THREE reports the FIRST gate that fails — organisation.
    const allMissing = resolveRelease(
      makeRequest({ org_id: "", coordination_id: "", operator: { id: "", email: null } }),
    );
    expect(allMissing).toEqual({ kind: "none", reason: "missing_organisation" });

    // With a valid org but missing coordination + operator → coordination is reported next.
    const orgOnly = resolveRelease(
      makeRequest({ coordination_id: "", operator: { id: "", email: null } }),
    );
    expect(orgOnly).toEqual({ kind: "none", reason: "missing_coordination" });
  });

  it("is deterministic — the same request always yields the same decision", () => {
    const request = makeRequest();
    expect(resolveRelease(request)).toEqual(resolveRelease(request));
  });

  it("does not mutate its input request", () => {
    const request = makeRequest();
    const snapshot = JSON.parse(JSON.stringify(request));
    resolveRelease(request);
    expect(request).toEqual(snapshot);
  });
});

describe("isReleaseDecided — the runtime's write gate", () => {
  it("is true for a granted decision and false for an abstention", () => {
    expect(isReleaseDecided(resolveRelease(makeRequest()))).toBe(true);
    expect(isReleaseDecided(resolveRelease(makeRequest({ org_id: "" })))).toBe(false);
  });

  it("narrows the decision to its granted arm", () => {
    const decision: ReleaseDecision = resolveRelease(makeRequest());
    if (isReleaseDecided(decision)) {
      // Inside the guard, the granted fields are accessible without a cast.
      expect(decision.kind).toBe("release_conversation_work");
      expect(decision.outcome).toBe("work_released");
    } else {
      throw new Error("expected the decision to narrow to granted");
    }
  });
});

describe("releaseTypeOf / releaseOutcomeOf — total projections over a decision", () => {
  it("map a granted decision to its type and outcome", () => {
    const decision = resolveRelease(makeRequest());
    expect(releaseTypeOf(decision)).toBe("release_conversation_work");
    expect(releaseOutcomeOf(decision)).toBe("work_released");
  });

  it("map an abstention to null", () => {
    const abstention = resolveRelease(makeRequest({ org_id: "" }));
    expect(releaseTypeOf(abstention)).toBeNull();
    expect(releaseOutcomeOf(abstention)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  CLAIM_TYPES,
  CLAIM_RESOLUTIONS,
  resolveClaim,
  isClaimDecided,
  claimTypeOf,
  claimOutcomeOf,
  type ClaimRequest,
  type ClaimDecision,
  type OperatorIdentity,
} from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work Claim — pure-core unit tests (the AI Receptionist Programme, R46: CONVERSATION WORK CLAIM).
 *
 * The claim runtime performs the ledger write and the conflict/isolation guards over real Postgres — those are pinned
 * by the integration suite. What is unit-testable in isolation is the pure core's CLAIM DECISION: given a claim
 * request, does it name a well-formed `claim_conversation_work` claim, or abstain with the precise reason? This suite
 * pins exactly that — total, deterministic, dependency-free — plus the closed vocabularies and the named predicates
 * the runtime gates on.
 *
 * The core asserts NO fact about the world (it does not check the coordination exists or belongs to the org); it
 * proves the request is WELL-FORMED and names the claim. So these tests exercise SHAPE only — the world-guards are the
 * runtime's and the database's, verified in the integration tier.
 */

const OPERATOR: OperatorIdentity = { id: "operator-1", email: "op@crewflow.uk" };

function makeRequest(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
  return {
    org_id: "org-1",
    coordination_id: "coord-1",
    operator: OPERATOR,
    conversation_id: "conv-1",
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("claim vocabulary", () => {
  it("ships exactly one claim type — claim_conversation_work", () => {
    expect(CLAIM_TYPES).toEqual(["claim_conversation_work"]);
  });

  it("ships exactly the three runtime resolutions", () => {
    expect(CLAIM_RESOLUTIONS).toEqual(["claimed", "already_claimed", "unavailable"]);
  });
});

describe("resolveClaim — the well-formed claim", () => {
  it("names the claim_conversation_work claim for a complete request", () => {
    const decision = resolveClaim(makeRequest());
    expect(decision.kind).toBe("claim_conversation_work");
    if (decision.kind === "none") throw new Error("expected a granted claim");
    expect(decision.outcome).toBe("work_claimed");
    expect(decision.org_id).toBe("org-1");
    expect(decision.coordination_id).toBe("coord-1");
    expect(decision.operator).toEqual(OPERATOR);
  });

  it("carries the operator identity through verbatim (id + email)", () => {
    const operator: OperatorIdentity = { id: "hq-user-42", email: "hq@crewflow.uk" };
    const decision = resolveClaim(makeRequest({ operator }));
    if (decision.kind === "none") throw new Error("expected a granted claim");
    expect(decision.operator.id).toBe("hq-user-42");
    expect(decision.operator.email).toBe("hq@crewflow.uk");
  });

  it("grants even when the operator email is null — the id is the load-bearing identity", () => {
    const decision = resolveClaim(makeRequest({ operator: { id: "operator-2", email: null } }));
    expect(decision.kind).toBe("claim_conversation_work");
    if (decision.kind === "none") throw new Error("expected a granted claim");
    expect(decision.operator.email).toBeNull();
  });

  it("grants without the optional provenance (conversation_id / correlation_id absent)", () => {
    const decision = resolveClaim({ org_id: "org-1", coordination_id: "coord-1", operator: OPERATOR });
    expect(decision.kind).toBe("claim_conversation_work");
  });
});

describe("resolveClaim — the abstention gates (fixed order)", () => {
  it("abstains missing_organisation when org_id is empty", () => {
    const decision = resolveClaim(makeRequest({ org_id: "" }));
    expect(decision).toEqual({ kind: "none", reason: "missing_organisation" });
  });

  it("abstains missing_organisation when org_id is whitespace only", () => {
    const decision = resolveClaim(makeRequest({ org_id: "   " }));
    expect(decision).toEqual({ kind: "none", reason: "missing_organisation" });
  });

  it("abstains missing_coordination when coordination_id is empty", () => {
    const decision = resolveClaim(makeRequest({ coordination_id: "" }));
    expect(decision).toEqual({ kind: "none", reason: "missing_coordination" });
  });

  it("abstains missing_coordination when coordination_id is whitespace only", () => {
    const decision = resolveClaim(makeRequest({ coordination_id: "\t\n" }));
    expect(decision).toEqual({ kind: "none", reason: "missing_coordination" });
  });

  it("abstains incomplete_operator_identity when operator id is empty", () => {
    const decision = resolveClaim(makeRequest({ operator: { id: "", email: "op@crewflow.uk" } }));
    expect(decision).toEqual({ kind: "none", reason: "incomplete_operator_identity" });
  });

  it("abstains incomplete_operator_identity when operator id is whitespace only", () => {
    const decision = resolveClaim(makeRequest({ operator: { id: "  ", email: null } }));
    expect(decision).toEqual({ kind: "none", reason: "incomplete_operator_identity" });
  });

  it("checks organisation BEFORE coordination — a request missing both abstains on organisation", () => {
    const decision = resolveClaim(makeRequest({ org_id: "", coordination_id: "" }));
    expect(decision).toEqual({ kind: "none", reason: "missing_organisation" });
  });

  it("checks coordination BEFORE operator — a request missing both abstains on coordination", () => {
    const decision = resolveClaim(
      makeRequest({ coordination_id: "", operator: { id: "", email: null } }),
    );
    expect(decision).toEqual({ kind: "none", reason: "missing_coordination" });
  });
});

describe("resolveClaim — determinism and purity", () => {
  it("is deterministic — the same request always yields the same decision", () => {
    const request = makeRequest();
    expect(resolveClaim(request)).toEqual(resolveClaim(request));
  });

  it("does not mutate the request it is handed", () => {
    const request = makeRequest();
    const snapshot = JSON.parse(JSON.stringify(request));
    resolveClaim(request);
    expect(request).toEqual(snapshot);
  });
});

describe("claim predicates and projections", () => {
  const granted = resolveClaim(makeRequest());
  const abstained: ClaimDecision = resolveClaim(makeRequest({ org_id: "" }));

  it("isClaimDecided narrows the granted arm and rejects the abstention", () => {
    expect(isClaimDecided(granted)).toBe(true);
    expect(isClaimDecided(abstained)).toBe(false);
  });

  it("claimTypeOf is the identity on the granted arm and null on the abstention", () => {
    expect(claimTypeOf(granted)).toBe("claim_conversation_work");
    expect(claimTypeOf(abstained)).toBeNull();
  });

  it("claimOutcomeOf is work_claimed on the granted arm and null on the abstention", () => {
    expect(claimOutcomeOf(granted)).toBe("work_claimed");
    expect(claimOutcomeOf(abstained)).toBeNull();
  });

  it("the predicates agree — a decided decision has a type and an outcome; an abstention has neither", () => {
    for (const decision of [granted, abstained]) {
      if (isClaimDecided(decision)) {
        expect(claimTypeOf(decision)).not.toBeNull();
        expect(claimOutcomeOf(decision)).not.toBeNull();
      } else {
        expect(claimTypeOf(decision)).toBeNull();
        expect(claimOutcomeOf(decision)).toBeNull();
      }
    }
  });
});

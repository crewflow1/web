import { describe, it, expect } from "vitest";
import { CLAIM_RESOLUTIONS, type ClaimResolution } from "@/lib/receptionist/conversation-claim";
import {
  projectClaimOwner,
  projectClaimOwnership,
  describeClaimOutcome,
  type ClaimOwnerRow,
  type ClaimOwnerRecord,
} from "@/lib/receptionist/conversation-claim-view";

/**
 * Conversation Work Claim Surface — pure-view-core unit tests (the AI Receptionist Programme, R47: CONVERSATION WORK
 * CLAIM SURFACE).
 *
 * The surface's PURE CORE turns already-recorded facts into what the surface displays and derives the ONE affordance it
 * offers. It reaches no I/O, holds no clock, records nothing and decides no claim — so it is total, deterministic and
 * dependency-free, and THAT is exactly what this suite pins:
 *   • projectClaimOwner     — one raw ledger row → the ownership facts (a straight relabelling).
 *   • projectClaimOwnership — the ownership record + the viewer's id → the ownership view (claimed? viewer holds it?
 *                             MAY claim? owner label? summary?). The ONLY affordance is claiming an UNCLAIMED item.
 *   • describeClaimOutcome  — a runtime resolution → the operator-facing message + tone, EXHAUSTIVE over the closed set.
 */

const VIEWER = "operator-viewer";

function makeRow(overrides: Partial<ClaimOwnerRow> = {}): ClaimOwnerRow {
  return {
    coordination_id: "coord-1",
    org_id: "org-1",
    operator_id: "operator-1",
    operator_email: "op@crewflow.uk",
    claim_type: "claim_conversation_work",
    claim_outcome: "work_claimed",
    status: "claimed",
    claimed_at: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function makeOwner(overrides: Partial<ClaimOwnerRecord> = {}): ClaimOwnerRecord {
  return {
    coordinationId: "coord-1",
    operatorId: "operator-1",
    operatorEmail: "op@crewflow.uk",
    claimType: "claim_conversation_work",
    claimOutcome: "work_claimed",
    status: "claimed",
    claimedAt: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

describe("projectClaimOwner — one ledger row → ownership facts", () => {
  it("relabels every column into the ownership record", () => {
    const record = projectClaimOwner(makeRow());
    expect(record).toEqual({
      coordinationId: "coord-1",
      operatorId: "operator-1",
      operatorEmail: "op@crewflow.uk",
      claimType: "claim_conversation_work",
      claimOutcome: "work_claimed",
      status: "claimed",
      claimedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("carries a null operator email through verbatim — the id is the load-bearing identity", () => {
    const record = projectClaimOwner(makeRow({ operator_email: null }));
    expect(record.operatorEmail).toBeNull();
    expect(record.operatorId).toBe("operator-1");
  });

  it("pins status to 'claimed' — the ledger only ever records a held claim", () => {
    const record = projectClaimOwner(makeRow());
    expect(record.status).toBe("claimed");
  });

  it("does not mutate the row it is handed", () => {
    const row = makeRow();
    const snapshot = JSON.parse(JSON.stringify(row));
    projectClaimOwner(row);
    expect(row).toEqual(snapshot);
  });
});

describe("projectClaimOwnership — the unclaimed item", () => {
  const view = projectClaimOwnership({ owner: null, viewerOperatorId: VIEWER });

  it("is unclaimed and CLAIMABLE — the surface's one affordance is offered only here", () => {
    expect(view.claimed).toBe(false);
    expect(view.canClaim).toBe(true);
  });

  it("has no owner and no one holds it", () => {
    expect(view.viewerHoldsClaim).toBe(false);
    expect(view.ownerId).toBeNull();
    expect(view.ownerLabel).toBeNull();
    expect(view.claimedAt).toBeNull();
  });

  it("summarises the vacancy", () => {
    expect(view.summary).toBe("Unclaimed — no operator has taken ownership of this item yet.");
  });
});

describe("projectClaimOwnership — the viewer holds the claim", () => {
  const view = projectClaimOwnership({
    owner: makeOwner({ operatorId: VIEWER, operatorEmail: "me@crewflow.uk" }),
    viewerOperatorId: VIEWER,
  });

  it("is claimed and NOT claimable — no reassignment, no release", () => {
    expect(view.claimed).toBe(true);
    expect(view.canClaim).toBe(false);
  });

  it("reports the viewer as the holder and labels the owner 'You'", () => {
    expect(view.viewerHoldsClaim).toBe(true);
    expect(view.ownerId).toBe(VIEWER);
    expect(view.ownerLabel).toBe("You");
    expect(view.summary).toBe("You hold this claim.");
  });
});

describe("projectClaimOwnership — another operator holds the claim", () => {
  it("is claimed, NOT claimable, and the viewer does not hold it", () => {
    const view = projectClaimOwnership({
      owner: makeOwner({ operatorId: "operator-other", operatorEmail: "other@crewflow.uk" }),
      viewerOperatorId: VIEWER,
    });
    expect(view.claimed).toBe(true);
    expect(view.canClaim).toBe(false);
    expect(view.viewerHoldsClaim).toBe(false);
    expect(view.ownerId).toBe("operator-other");
  });

  it("names the owner by email when present", () => {
    const view = projectClaimOwnership({
      owner: makeOwner({ operatorId: "operator-other", operatorEmail: "other@crewflow.uk" }),
      viewerOperatorId: VIEWER,
    });
    expect(view.ownerLabel).toBe("other@crewflow.uk");
    expect(view.summary).toBe("Claimed by other@crewflow.uk.");
  });

  it("falls back to the operator id when the email is null", () => {
    const view = projectClaimOwnership({
      owner: makeOwner({ operatorId: "operator-other", operatorEmail: null }),
      viewerOperatorId: VIEWER,
    });
    expect(view.ownerLabel).toBe("operator-other");
    expect(view.summary).toBe("Claimed by operator-other.");
  });
});

describe("projectClaimOwnership — determinism and purity", () => {
  it("is deterministic — the same input always yields the same view", () => {
    const input = { owner: makeOwner(), viewerOperatorId: VIEWER };
    expect(projectClaimOwnership(input)).toEqual(projectClaimOwnership(input));
  });

  it("never marks an already-owned item claimable, whoever the viewer is", () => {
    for (const viewer of [VIEWER, "operator-1", "someone-else"]) {
      const view = projectClaimOwnership({ owner: makeOwner(), viewerOperatorId: viewer });
      expect(view.canClaim).toBe(false);
    }
  });
});

describe("describeClaimOutcome — the operator-facing result", () => {
  it("claimed → success, ok, with the success message", () => {
    const view = describeClaimOutcome("claimed");
    expect(view).toEqual({
      resolution: "claimed",
      ok: true,
      tone: "success",
      message: "You have claimed this item.",
    });
  });

  it("already_claimed → warning, not ok, reports the conflict", () => {
    const view = describeClaimOutcome("already_claimed");
    expect(view).toEqual({
      resolution: "already_claimed",
      ok: false,
      tone: "warning",
      message: "This item was just claimed by another operator.",
    });
  });

  it("unavailable → error, not ok, invites a refresh + retry", () => {
    const view = describeClaimOutcome("unavailable");
    expect(view).toEqual({
      resolution: "unavailable",
      ok: false,
      tone: "error",
      message: "This item could not be claimed. Refresh and try again.",
    });
  });

  it("is EXHAUSTIVE over the closed resolution vocabulary — every resolution has a view", () => {
    for (const resolution of CLAIM_RESOLUTIONS as readonly ClaimResolution[]) {
      const view = describeClaimOutcome(resolution);
      expect(view.resolution).toBe(resolution);
      expect(typeof view.message).toBe("string");
      expect(view.message.length).toBeGreaterThan(0);
      expect(["success", "warning", "error"]).toContain(view.tone);
      // ok is true iff the claim succeeded.
      expect(view.ok).toBe(resolution === "claimed");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  ACTION_DECISIONS,
  NCR_DERIVED_STATUSES,
  NCR_SEVERITIES,
  NCR_SEVERITY_META,
  NCR_STATUSES,
  NCR_STATUS_META,
  canTransition,
  decisionRequiresReason,
  isLive,
  nextSteps,
  type NcrStatus,
} from "@/lib/quality/ncr";
import {
  raiseNcrSchema,
  closeNcrSchema,
  proposeActionSchema,
  decideActionSchema,
  completeActionSchema,
} from "@/lib/quality/schema";

/**
 * Works Quality M2 — NCR pure domain unit tests. No DB, no I/O, no AI.
 *
 * The DB (migration 20261081) is the authority for the transition graph, the
 * derived middle statuses and the write-once decision; what is tested here is
 * the TS mirror the UI drives from, and the input validation that keeps a
 * write from reaching a constraint the operator can't read.
 */

const ITEM = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";

describe("NCR lifecycle", () => {
  it("mirrors the DB transition graph exactly", () => {
    expect(canTransition("open", "corrective_action_proposed")).toBe(true);
    expect(canTransition("open", "cancelled")).toBe(true);
    expect(canTransition("corrective_action_proposed", "corrective_action_approved")).toBe(true);
    expect(canTransition("corrective_action_proposed", "open")).toBe(true); // reject
    expect(canTransition("corrective_action_proposed", "cancelled")).toBe(true);
    expect(canTransition("corrective_action_approved", "completed")).toBe(true);
    expect(canTransition("corrective_action_approved", "cancelled")).toBe(true);
    expect(canTransition("completed", "closed")).toBe(true);
    expect(canTransition("completed", "cancelled")).toBe(true);
    // Every skip and every backwards move is refused.
    expect(canTransition("open", "corrective_action_approved")).toBe(false);
    expect(canTransition("open", "completed")).toBe(false);
    expect(canTransition("open", "closed")).toBe(false);
    expect(canTransition("corrective_action_approved", "open")).toBe(false);
    expect(canTransition("completed", "open")).toBe(false);
    expect(canTransition("closed", "open")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
  });

  it("terminal states are terminal", () => {
    for (const to of NCR_STATUSES) {
      expect(canTransition("closed", to)).toBe(false);
      expect(canTransition("cancelled", to)).toBe(false);
    }
    expect(isLive("closed")).toBe(false);
    expect(isLive("cancelled")).toBe(false);
    for (const s of ["open", "corrective_action_proposed", "corrective_action_approved", "completed"] as NcrStatus[]) {
      expect(isLive(s)).toBe(true);
    }
  });

  it("the middle statuses are DERIVED — the UI never offers them as buttons", () => {
    // These are marker-gated in the DB (crewflow.ncr_cascade): the only route
    // is the corrective-action record. The UI derives its forms from nextSteps.
    expect([...NCR_DERIVED_STATUSES].sort()).toEqual(
      ["completed", "corrective_action_approved", "corrective_action_proposed"].sort(),
    );
  });

  it("nextSteps offers exactly the right surface per status", () => {
    expect(nextSteps("open")).toEqual({
      canPropose: true, canDecide: false, canComplete: false, canClose: false, canCancel: true,
    });
    expect(nextSteps("corrective_action_proposed")).toEqual({
      canPropose: false, canDecide: true, canComplete: false, canClose: false, canCancel: true,
    });
    expect(nextSteps("corrective_action_approved")).toEqual({
      canPropose: false, canDecide: false, canComplete: true, canClose: false, canCancel: true,
    });
    expect(nextSteps("completed")).toEqual({
      canPropose: false, canDecide: false, canComplete: false, canClose: true, canCancel: true,
    });
    expect(nextSteps("closed")).toEqual({
      canPropose: false, canDecide: false, canComplete: false, canClose: false, canCancel: false,
    });
    expect(nextSteps("cancelled")).toEqual({
      canPropose: false, canDecide: false, canComplete: false, canClose: false, canCancel: false,
    });
  });

  it("every status and severity has display metadata", () => {
    for (const s of NCR_STATUSES) expect(NCR_STATUS_META[s].label).toBeTruthy();
    for (const s of NCR_SEVERITIES) {
      expect(NCR_SEVERITY_META[s].label).toBeTruthy();
      expect(NCR_SEVERITY_META[s].help).toBeTruthy();
    }
  });
});

describe("corrective-action decisions", () => {
  it("a rejection must be explained; an acceptance need not be", () => {
    expect(decisionRequiresReason("rejected")).toBe(true);
    expect(decisionRequiresReason("accepted")).toBe(false);
    expect([...ACTION_DECISIONS].sort()).toEqual(["accepted", "rejected"]);
  });
});

describe("input schemas", () => {
  const base = {
    itemId: ITEM,
    title: "Falls out of tolerance",
    description: "Measured 1:120 against 1:80 required.",
    severity: "major",
  };

  it("raising requires a responsible party — member or subcontractor", () => {
    expect(raiseNcrSchema.safeParse({ ...base, responsibleUserId: UID }).success).toBe(true);
    expect(
      raiseNcrSchema.safeParse({ ...base, responsibleSubcontractor: "J Smith Groundworks" }).success,
    ).toBe(true);
    expect(raiseNcrSchema.safeParse(base).success).toBe(false);
    expect(raiseNcrSchema.safeParse({ ...base, responsibleSubcontractor: "   " }).success).toBe(false);
  });

  it("raising requires a real description and a valid severity", () => {
    expect(
      raiseNcrSchema.safeParse({ ...base, description: " ", responsibleUserId: UID }).success,
    ).toBe(false);
    expect(
      raiseNcrSchema.safeParse({ ...base, severity: "catastrophic", responsibleUserId: UID }).success,
    ).toBe(false);
  });

  it("a proposal needs a description; assignment and due date are optional", () => {
    expect(proposeActionSchema.safeParse({ ncrId: ITEM, description: "Re-lay the run" }).success).toBe(true);
    expect(proposeActionSchema.safeParse({ ncrId: ITEM, description: " " }).success).toBe(false);
  });

  it("a rejection carries its reason (mirrors nca_rejection_reason_required)", () => {
    const d = { id: UID, ncrId: ITEM };
    expect(decideActionSchema.safeParse({ ...d, decision: "accepted" }).success).toBe(true);
    expect(decideActionSchema.safeParse({ ...d, decision: "rejected" }).success).toBe(false);
    expect(
      decideActionSchema.safeParse({ ...d, decision: "rejected", decisionReason: "Wrong root cause" })
        .success,
    ).toBe(true);
  });

  it("completion and closure each require their comment", () => {
    expect(completeActionSchema.safeParse({ id: UID, ncrId: ITEM, completionComment: "Re-laid" }).success).toBe(true);
    expect(completeActionSchema.safeParse({ id: UID, ncrId: ITEM, completionComment: "" }).success).toBe(false);
    expect(closeNcrSchema.safeParse({ id: UID, closureComment: "Re-inspected, conforms" }).success).toBe(true);
    expect(closeNcrSchema.safeParse({ id: UID, closureComment: " " }).success).toBe(false);
  });
});

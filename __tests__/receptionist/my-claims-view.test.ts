import { describe, it, expect } from "vitest";
import {
  selectOperatorEvents,
  projectMyClaimRow,
  projectMyClaims,
  type MyClaimRow,
} from "@/lib/receptionist/my-claims-view";
import type {
  OwnershipEvent,
  OwnershipSummary,
  OwnerTally,
} from "@/lib/receptionist/conversation-ownership-read-model";

/**
 * My Claims List — pure view-core unit tests (the AI Receptionist Programme, R49: MY CLAIMS LIST).
 *
 * The surface's PURE CORE consumes the R48 ownership read model's OUTPUT — an org's ownership events + summary — and
 * projects the viewer-relative "My Claims" view. It reaches no I/O, holds no clock, records nothing and decides no
 * claim, so it is total, deterministic and dependency-free, and THAT is exactly what this suite pins:
 *   • selectOperatorEvents — the org's events FILTERED to one operator, in the read model's canonical newest-first order.
 *   • projectMyClaimRow    — one ownership event → one My Claims display row (always `owned`).
 *   • projectMyClaims      — events + summary + viewer identity → the viewer's My Claims view: their rows (newest first)
 *                            and their authoritative tally (count + latest + email), taken from the org summary.
 */

function makeEvent(overrides: Partial<OwnershipEvent> = {}): OwnershipEvent {
  return {
    coordinationId: "coord-1",
    conversationId: "conv-1",
    operatorId: "operator-1",
    operatorEmail: "op@crewflow.uk",
    claimType: "claim_conversation_work",
    claimOutcome: "work_claimed",
    claimedAt: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function makeTally(overrides: Partial<OwnerTally> = {}): OwnerTally {
  return {
    operatorId: "operator-1",
    operatorEmail: "op@crewflow.uk",
    claimCount: 1,
    latestClaimAt: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<OwnershipSummary> = {}): OwnershipSummary {
  return {
    totalClaims: 0,
    distinctOwners: 0,
    owners: [],
    latestClaimAt: null,
    earliestClaimAt: null,
    ...overrides,
  };
}

describe("selectOperatorEvents — the org's events filtered to one operator, newest first", () => {
  it("keeps only the operator's own events", () => {
    const events = [
      makeEvent({ coordinationId: "a", operatorId: "me" }),
      makeEvent({ coordinationId: "b", operatorId: "someone-else" }),
      makeEvent({ coordinationId: "c", operatorId: "me" }),
    ];
    const mine = selectOperatorEvents(events, "me");
    expect(mine.map((e) => e.coordinationId)).toEqual(["c", "a"]); // filtered to me, newest-first tiebreak on id
    expect(mine.every((e) => e.operatorId === "me")).toBe(true);
  });

  it("orders the operator's events newest claim first (instant-based)", () => {
    const events = [
      makeEvent({ coordinationId: "a", operatorId: "me", claimedAt: "2026-07-01T00:00:00.000Z" }),
      makeEvent({ coordinationId: "b", operatorId: "me", claimedAt: "2026-07-03T00:00:00.000Z" }),
      makeEvent({ coordinationId: "c", operatorId: "me", claimedAt: "2026-07-02T00:00:00.000Z" }),
    ];
    expect(selectOperatorEvents(events, "me").map((e) => e.coordinationId)).toEqual(["b", "c", "a"]);
  });

  it("returns an empty list when the operator owns nothing", () => {
    const events = [makeEvent({ operatorId: "someone-else" })];
    expect(selectOperatorEvents(events, "me")).toEqual([]);
  });

  it("does not mutate its input", () => {
    const events = [
      makeEvent({ coordinationId: "a", operatorId: "me", claimedAt: "2026-07-01T00:00:00.000Z" }),
      makeEvent({ coordinationId: "b", operatorId: "me", claimedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const snapshot = events.map((e) => e.coordinationId);
    selectOperatorEvents(events, "me");
    expect(events.map((e) => e.coordinationId)).toEqual(snapshot);
  });

  it("is order-independent — shuffling the input yields the same filtered order", () => {
    const a = makeEvent({ coordinationId: "a", operatorId: "me", claimedAt: "2026-07-01T00:00:00.000Z" });
    const b = makeEvent({ coordinationId: "b", operatorId: "me", claimedAt: "2026-07-03T00:00:00.000Z" });
    const c = makeEvent({ coordinationId: "c", operatorId: "me", claimedAt: "2026-07-02T00:00:00.000Z" });
    const forward = selectOperatorEvents([a, b, c], "me").map((e) => e.coordinationId);
    const shuffled = selectOperatorEvents([c, a, b], "me").map((e) => e.coordinationId);
    expect(shuffled).toEqual(forward);
  });
});

describe("projectMyClaimRow — one ownership event → one My Claims row", () => {
  it("relabels the event into a display row, always owned", () => {
    const row: MyClaimRow = projectMyClaimRow(makeEvent());
    expect(row).toEqual({
      coordinationId: "coord-1",
      conversationId: "conv-1",
      claimedAt: "2026-07-06T12:00:00.000Z",
      status: "owned",
    });
  });

  it("carries a null conversation id through verbatim", () => {
    expect(projectMyClaimRow(makeEvent({ conversationId: null })).conversationId).toBeNull();
  });
});

describe("projectMyClaims — the viewer's My Claims view", () => {
  it("projects only the viewer's claims as rows, newest first", () => {
    const events = [
      makeEvent({ coordinationId: "a", operatorId: "me", claimedAt: "2026-07-01T00:00:00.000Z" }),
      makeEvent({ coordinationId: "b", operatorId: "other", claimedAt: "2026-07-04T00:00:00.000Z" }),
      makeEvent({ coordinationId: "c", operatorId: "me", claimedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const summary = makeSummary({
      totalClaims: 3,
      distinctOwners: 2,
      owners: [makeTally({ operatorId: "me", claimCount: 2, latestClaimAt: "2026-07-03T00:00:00.000Z" })],
    });
    const view = projectMyClaims({ operatorId: "me", operatorEmail: "me@crewflow.uk", events, summary });
    expect(view.rows.map((r) => r.coordinationId)).toEqual(["c", "a"]);
    expect(view.rows.every((r) => r.status === "owned")).toBe(true);
  });

  it("takes the count, latest instant and email from the viewer's summary tally (authoritative, uncapped)", () => {
    const events = [makeEvent({ coordinationId: "a", operatorId: "me", claimedAt: "2026-07-01T00:00:00.000Z" })];
    // The tally reports TWO claims though only ONE row is in the (capped) event window — the count follows the summary.
    const summary = makeSummary({
      totalClaims: 2,
      distinctOwners: 1,
      owners: [
        makeTally({
          operatorId: "me",
          operatorEmail: "latest@crewflow.uk",
          claimCount: 2,
          latestClaimAt: "2026-07-05T00:00:00.000Z",
        }),
      ],
    });
    const view = projectMyClaims({ operatorId: "me", operatorEmail: "fallback@crewflow.uk", events, summary });
    expect(view.claimCount).toBe(2);
    expect(view.latestClaimAt).toBe("2026-07-05T00:00:00.000Z");
    expect(view.operatorEmail).toBe("latest@crewflow.uk");
    expect(view.rows).toHaveLength(1);
  });

  it("falls back to zero / null / supplied email when the viewer holds no claim", () => {
    const events = [makeEvent({ operatorId: "other" })];
    const summary = makeSummary({
      totalClaims: 1,
      distinctOwners: 1,
      owners: [makeTally({ operatorId: "other" })],
    });
    const view = projectMyClaims({ operatorId: "me", operatorEmail: "me@crewflow.uk", events, summary });
    expect(view).toEqual({
      operatorId: "me",
      operatorEmail: "me@crewflow.uk",
      claimCount: 0,
      latestClaimAt: null,
      rows: [],
    });
  });

  it("reports on the operator it was asked about (uses the viewer id)", () => {
    const view = projectMyClaims({
      operatorId: "asked-for",
      operatorEmail: null,
      events: [],
      summary: makeSummary(),
    });
    expect(view.operatorId).toBe("asked-for");
  });
});

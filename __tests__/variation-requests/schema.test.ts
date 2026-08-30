import { describe, expect, it } from "vitest";
import {
  VARIATION_REQUEST_STATUSES,
  VARIATION_REQUEST_TRANSITIONS,
  VARIATION_REQUEST_URGENCIES,
  canTransitionVariationRequest,
  isTerminalVariationRequestStatus,
  portalVariationRequestSchema,
  variationRequestFormSchema,
  variationRequestReviewSchema,
  type VariationRequestStatus,
} from "@/lib/variation-requests/schema";

/**
 * Pure tests for the variation-request vocabulary (G2, migration 20261221).
 *
 * THE TRANSITION MATRIX HERE IS ASSERTED PAIR-BY-PAIR, ALL 25 CELLS. The TS
 * matrix is the UI's copy of the DB trigger (tg_variation_requests_guard);
 * the integration suite proves the trigger, this suite pins the mirror so the
 * two cannot drift apart silently — change either and one of the suites
 * reddens.
 */

describe("variation-request transition matrix", () => {
  // The AUTHORITATIVE expectation, written out in full — not derived from the
  // module under test, so a matrix edit shows up as a diff here.
  const EXPECTED: Record<
    VariationRequestStatus,
    Record<VariationRequestStatus, boolean>
  > = {
    requested: {
      requested: false,
      reviewing: true,
      accepted: true,
      rejected: true,
      converted: false,
    },
    reviewing: {
      requested: false,
      reviewing: false,
      accepted: true,
      rejected: true,
      converted: false,
    },
    accepted: {
      requested: false,
      reviewing: false,
      accepted: false,
      rejected: false,
      converted: true,
    },
    rejected: {
      requested: false,
      reviewing: false,
      accepted: false,
      rejected: false,
      converted: false,
    },
    converted: {
      requested: false,
      reviewing: false,
      accepted: false,
      rejected: false,
      converted: false,
    },
  };

  it("every one of the 25 (from, to) cells matches the documented machine", () => {
    for (const from of VARIATION_REQUEST_STATUSES) {
      for (const to of VARIATION_REQUEST_STATUSES) {
        expect(
          canTransitionVariationRequest(from, to),
          `${from} -> ${to}`,
        ).toBe(EXPECTED[from][to]);
      }
    }
  });

  it("the exported matrix object agrees with canTransition (no dual truth)", () => {
    for (const from of VARIATION_REQUEST_STATUSES) {
      for (const to of VARIATION_REQUEST_STATUSES) {
        expect(VARIATION_REQUEST_TRANSITIONS[from].includes(to)).toBe(
          canTransitionVariationRequest(from, to),
        );
      }
    }
  });

  it("rejected and converted are terminal; nothing else is", () => {
    expect(isTerminalVariationRequestStatus("rejected")).toBe(true);
    expect(isTerminalVariationRequestStatus("converted")).toBe(true);
    expect(isTerminalVariationRequestStatus("requested")).toBe(false);
    expect(isTerminalVariationRequestStatus("reviewing")).toBe(false);
    expect(isTerminalVariationRequestStatus("accepted")).toBe(false);
  });

  it("no status can transition to itself (idempotent 're-decide' is refused)", () => {
    for (const s of VARIATION_REQUEST_STATUSES) {
      expect(canTransitionVariationRequest(s, s), s).toBe(false);
    }
  });
});

describe("variationRequestFormSchema (staff intake)", () => {
  it("accepts a minimal valid request and trims", () => {
    const parsed = variationRequestFormSchema.safeParse({
      title: "  Move the kitchen socket  ",
      description: "",
      reason: "",
      urgency: "normal",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe("Move the kitchen socket");
      // Blank optional fields normalise to undefined, not "".
      expect(parsed.data.description).toBeUndefined();
      expect(parsed.data.reason).toBeUndefined();
    }
  });

  it("refuses a too-short title and an unknown urgency", () => {
    expect(
      variationRequestFormSchema.safeParse({
        title: "ab",
        urgency: "normal",
      }).success,
    ).toBe(false);
    expect(
      variationRequestFormSchema.safeParse({
        title: "Valid title",
        urgency: "immediately",
      }).success,
    ).toBe(false);
  });

  it("caps free text (title 200, description 5000, reason 2000)", () => {
    expect(
      variationRequestFormSchema.safeParse({
        title: "x".repeat(201),
        urgency: "low",
      }).success,
    ).toBe(false);
    expect(
      variationRequestFormSchema.safeParse({
        title: "ok title",
        description: "x".repeat(5001),
        urgency: "low",
      }).success,
    ).toBe(false);
    expect(
      variationRequestFormSchema.safeParse({
        title: "ok title",
        reason: "x".repeat(2001),
        urgency: "low",
      }).success,
    ).toBe(false);
  });

  it("urgency vocabulary is exactly low/normal/high", () => {
    expect([...VARIATION_REQUEST_URGENCIES]).toEqual(["low", "normal", "high"]);
  });
});

describe("portalVariationRequestSchema (customer/worker intake)", () => {
  it("requires a uuid job_id on top of the staff fields", () => {
    const base = { title: "Move the socket", urgency: "high" };
    expect(
      portalVariationRequestSchema.safeParse({ ...base, job_id: "not-a-uuid" })
        .success,
    ).toBe(false);
    expect(
      portalVariationRequestSchema.safeParse({
        ...base,
        job_id: "5f3c1a9e-0000-4000-8000-000000000001",
      }).success,
    ).toBe(true);
  });
});

describe("variationRequestReviewSchema (management review)", () => {
  const requestId = "5f3c1a9e-0000-4000-8000-000000000002";

  it("accepts reviewing/accepted without a note", () => {
    for (const decision of ["reviewing", "accepted"] as const) {
      const parsed = variationRequestReviewSchema.safeParse({
        request_id: requestId,
        decision,
        review_note: "",
      });
      expect(parsed.success, decision).toBe(true);
    }
  });

  it("refuses a rejection without a note — the requester reads the outcome", () => {
    expect(
      variationRequestReviewSchema.safeParse({
        request_id: requestId,
        decision: "rejected",
        review_note: "",
      }).success,
    ).toBe(false);
    expect(
      variationRequestReviewSchema.safeParse({
        request_id: requestId,
        decision: "rejected",
        review_note: "Out of contract scope — happy to price separately.",
      }).success,
    ).toBe(true);
  });

  it("refuses decisions outside the review vocabulary (no direct 'converted')", () => {
    for (const decision of ["converted", "requested", "approved", ""]) {
      expect(
        variationRequestReviewSchema.safeParse({
          request_id: requestId,
          decision,
          review_note: "n",
        }).success,
        decision,
      ).toBe(false);
    }
  });
});

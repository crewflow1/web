import { describe, it, expect } from "vitest";
import {
  REVIEW_FILTERS,
  REVIEW_STATE_LABELS,
  REVIEW_STATE_STYLES,
  deriveReviewState,
  formatReviewTimestamp,
  isPending,
  isReviewFilter,
  stateMatchesFilter,
  type ReviewFilter,
  type ReviewResolutionState,
  type ReviewState,
} from "@/lib/ai-receptionist/review";

/**
 * Reply Review Inbox presentation model — unit tier (the AI Receptionist Programme, R14:
 * HUMAN HANDOFF & REPLY REVIEW INBOX).
 *
 * `deriveReviewState` is the inbox's ONE derived value: it folds a held reply's two resolution
 * columns into the single coarse state the operator triages on. `resolution_id === null` IS the
 * definition of "pending" — the same predicate the orchestration service's `isPendingReview`
 * uses to guard a send. These tests pin every branch of that fold, the state→filter bucketing
 * (which the list surface uses for BOTH its pill counts and its rows, so they can never
 * disagree), and the small pure helpers. Pure logic, no DB — the projection's join behaviour is
 * proven against real Postgres in the integration tier.
 */

/** A minimal resolution shape; override per case. Defaults to a PENDING reply (no resolution). */
function item(overrides: Partial<ReviewResolutionState> = {}): ReviewResolutionState {
  return { resolution_id: null, resolution: null, ...overrides };
}

describe("deriveReviewState — the coarse state for each resolution shape", () => {
  it("pending: no resolution recorded yet (resolution_id is null)", () => {
    expect(deriveReviewState(item())).toBe("pending");
  });

  it("pending: resolution_id null even if a stray resolution string is present (id is the truth)", () => {
    // The id is the single source of "resolved": a null id is pending no matter what.
    expect(deriveReviewState(item({ resolution_id: null, resolution: "sent" }))).toBe("pending");
  });

  it("sent: a resolution row exists with resolution='sent'", () => {
    expect(deriveReviewState(item({ resolution_id: "res-1", resolution: "sent" }))).toBe("sent");
  });

  it("dismissed: a resolution row exists with resolution='dismissed'", () => {
    expect(deriveReviewState(item({ resolution_id: "res-1", resolution: "dismissed" }))).toBe(
      "dismissed",
    );
  });

  it("isPending mirrors deriveReviewState === 'pending' exactly", () => {
    expect(isPending(item())).toBe(true);
    expect(isPending(item({ resolution_id: "res-1", resolution: "sent" }))).toBe(false);
    expect(isPending(item({ resolution_id: "res-1", resolution: "dismissed" }))).toBe(false);
  });
});

describe("stateMatchesFilter — the inbox buckets (counts and rows share this predicate)", () => {
  const states: ReviewState[] = ["pending", "sent", "dismissed"];

  it("'all' matches every state", () => {
    for (const s of states) expect(stateMatchesFilter(s, "all")).toBe(true);
  });

  it("each non-'all' filter matches EXACTLY its own state", () => {
    for (const s of states) {
      const matched = states.filter((x) => stateMatchesFilter(x, s as ReviewFilter));
      expect(matched).toEqual([s]);
    }
  });

  it("every state belongs to exactly one non-'all' bucket (no state is orphaned)", () => {
    const buckets = REVIEW_FILTERS.filter((f) => f.key !== "all");
    for (const s of states) {
      const inCount = buckets.filter((f) => stateMatchesFilter(s, f.key)).length;
      expect(inCount, s).toBe(1);
    }
  });
});

describe("REVIEW_FILTERS — the inbox opens on the actionable bucket", () => {
  it("lists pending first (the inbox default), then sent, dismissed, all", () => {
    expect(REVIEW_FILTERS.map((f) => f.key)).toEqual(["pending", "sent", "dismissed", "all"]);
  });

  it("every filter key has a matching label", () => {
    for (const f of REVIEW_FILTERS) expect(f.label.length).toBeGreaterThan(0);
  });
});

describe("presentation tables cover every state", () => {
  it("labels and styles are defined for pending, sent and dismissed", () => {
    for (const s of ["pending", "sent", "dismissed"] as ReviewState[]) {
      expect(REVIEW_STATE_LABELS[s]).toBeTruthy();
      expect(REVIEW_STATE_STYLES[s]).toBeTruthy();
    }
  });
});

describe("pure helpers", () => {
  it("isReviewFilter narrows only the known filter keys", () => {
    expect(isReviewFilter("pending")).toBe(true);
    expect(isReviewFilter("sent")).toBe(true);
    expect(isReviewFilter("dismissed")).toBe(true);
    expect(isReviewFilter("all")).toBe(true);
    expect(isReviewFilter("nope")).toBe(false);
    expect(isReviewFilter(undefined)).toBe(false);
    expect(isReviewFilter(null)).toBe(false);
  });

  it("formatReviewTimestamp renders 'YYYY-MM-DD HH:MM' or an em dash", () => {
    expect(formatReviewTimestamp("2026-07-03T09:00:05.000Z")).toBe("2026-07-03 09:00");
    expect(formatReviewTimestamp(null)).toBe("—");
    expect(formatReviewTimestamp(undefined)).toBe("—");
  });
});

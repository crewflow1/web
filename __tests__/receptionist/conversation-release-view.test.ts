import { describe, it, expect } from "vitest";
import { RELEASE_RESOLUTIONS, type ReleaseResolution } from "@/lib/receptionist/conversation-release";
import { describeReleaseOutcome } from "@/lib/receptionist/conversation-release-view";

/**
 * Conversation Attention Queue Surface — RELEASE RESULT view-core unit tests (the AI Receptionist Programme, R61:
 * RELEASE FROM QUEUE).
 *
 * R61 is the FIRST operator-facing use of R50's canonical release capability. Its pure view core is minimal — the
 * Attention Queue already surfaces ownership (R59) and its viewer-scoped release eligibility (R61's `canRelease`), so
 * the release view core's ONE job is the mirror of R47's `describeClaimOutcome`: turn a runtime {@link ReleaseResolution}
 * into the operator-facing message + tone. It reaches no I/O, holds no clock, records nothing and decides no release —
 * so it is total, deterministic and dependency-free, and THAT is exactly what this suite pins, EXHAUSTIVELY over the
 * closed release resolution vocabulary.
 */
describe("describeReleaseOutcome — the operator-facing result", () => {
  it("released → success, ok, with the success message", () => {
    const view = describeReleaseOutcome("released");
    expect(view).toEqual({
      resolution: "released",
      ok: true,
      tone: "success",
      message: "You have released this item.",
    });
  });

  it("not_owned → warning, not ok, reports the lost-ownership conflict", () => {
    const view = describeReleaseOutcome("not_owned");
    expect(view).toEqual({
      resolution: "not_owned",
      ok: false,
      tone: "warning",
      message: "You no longer hold this item. Refresh and try again.",
    });
  });

  it("unavailable → error, not ok, invites a refresh + retry", () => {
    const view = describeReleaseOutcome("unavailable");
    expect(view).toEqual({
      resolution: "unavailable",
      ok: false,
      tone: "error",
      message: "This item could not be released. Refresh and try again.",
    });
  });

  it("is EXHAUSTIVE over the closed resolution vocabulary — every resolution has a view", () => {
    for (const resolution of RELEASE_RESOLUTIONS as readonly ReleaseResolution[]) {
      const view = describeReleaseOutcome(resolution);
      expect(view.resolution).toBe(resolution);
      expect(typeof view.message).toBe("string");
      expect(view.message.length).toBeGreaterThan(0);
      expect(["success", "warning", "error"]).toContain(view.tone);
      // ok is true iff the release succeeded.
      expect(view.ok).toBe(resolution === "released");
    }
  });

  it("is deterministic — the same resolution always yields the same view", () => {
    for (const resolution of RELEASE_RESOLUTIONS as readonly ReleaseResolution[]) {
      expect(describeReleaseOutcome(resolution)).toEqual(describeReleaseOutcome(resolution));
    }
  });
});

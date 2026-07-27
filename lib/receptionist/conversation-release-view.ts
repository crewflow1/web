import type { ReleaseResolution } from "./conversation-release";

// =====================================================================
// THE CONVERSATION ATTENTION QUEUE SURFACE — RELEASE RESULT VIEW CORE (CEO Directive #018, R61: RELEASE FROM QUEUE —
// building on R59's ATTENTION QUEUE SURFACE and REUSING R50's canonical Conversation Work Release capability).
//
// R50 shipped the canonical release capability: the pure `resolveRelease` decision, the `releaseConversationWork`
// runtime, and the append-only, owner-guarded release ledger row. It was NEVER surfaced — no operator affordance ever
// consumed it. R61 is its FIRST operator-facing use: it lets an operator release a conversation they OWN directly from
// the Attention Queue. Exactly as R47 was the claim capability's first surface, this module is the release capability's
// first surface projection.
//
// This module is that surface's PURE CORE — and it is MINIMAL, because the Attention Queue already surfaces ownership.
// R59's queue view core already projects WHO holds each row and R61 extends it with the viewer-scoped `canRelease`
// eligibility, so this core needs NO ownership projection of its own. Its ONE job is the mirror of R47's
// `describeClaimOutcome`: turn the runtime's closed {@link ReleaseResolution} into the surface's humanised result
// message + tone. It reaches NO I/O, holds NO clock and NO RNG, and — crucially — it RECORDS NOTHING and DECIDES NO
// RELEASE. The release decision is R50's (`resolveRelease`), the write is R50's (`releaseConversationWork`); this core
// only turns a runtime result into a display message. It introduces NO execution path: it releases nothing, assigns
// nothing, dispatches nothing, notifies no one and mutates no state — it is presentation logic over the R50 result.
// =====================================================================

/** The tone the surface uses to style a release result — a closed set, one per meaningful outcome (the SAME closed
 *  vocabulary the R47 claim surface uses, so the two affordances style identically). */
export type ReleaseActionTone = "success" | "warning" | "error";

/** The operator-facing result of a release attempt — the runtime's resolution, humanised for the surface. Mirrors the
 *  R47 {@link import("./conversation-claim-view").ClaimActionView} exactly, over the release resolution vocabulary. */
export type ReleaseActionView = {
  readonly resolution: ReleaseResolution;
  readonly ok: boolean;
  readonly tone: ReleaseActionTone;
  readonly message: string;
};

/**
 * Humanise a runtime {@link ReleaseResolution} into the surface's result message. Pure and EXHAUSTIVE over the closed
 * release resolution vocabulary — the direct sibling of R47's `describeClaimOutcome`:
 *   • released    — the operator's ownership was released; the row returns to "waiting to be picked up".
 *   • not_owned   — the operator no longer holds the item (it was released or transferred out from under them, or was
 *                   never theirs); nothing was written. The surface reports it lost ownership and invites a refresh —
 *                   the release-flow analogue of the claim-flow's `already_claimed` conflict.
 *   • unavailable — the item could not be released (ill-shaped, unknown/cross-tenant coordination, or a write failure);
 *                   the surface invites a refresh + retry.
 */
export function describeReleaseOutcome(resolution: ReleaseResolution): ReleaseActionView {
  switch (resolution) {
    case "released":
      return { resolution, ok: true, tone: "success", message: "You have released this item." };
    case "not_owned":
      return {
        resolution,
        ok: false,
        tone: "warning",
        message: "You no longer hold this item. Refresh and try again.",
      };
    case "unavailable":
      return {
        resolution,
        ok: false,
        tone: "error",
        message: "This item could not be released. Refresh and try again.",
      };
    default: {
      // Exhaustiveness guard — a new resolution must be handled here, or the type check fails.
      const never: never = resolution;
      return never;
    }
  }
}

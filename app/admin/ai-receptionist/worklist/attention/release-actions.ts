"use server";

import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { releaseConversationWork } from "@/server/services/receptionist-release";
import { describeReleaseOutcome, type ReleaseActionView } from "@/lib/receptionist/conversation-release-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the RELEASE-FROM-QUEUE SERVER ACTION (CEO Directive #018, R61: RELEASE FROM
 * QUEUE — building on R59's ATTENTION QUEUE SURFACE and REUSING R50's canonical Conversation Work Release capability).
 *
 * R59 shipped the read-only Attention Queue; R60 let the operator CLAIM an unowned row without leaving it. R61 is the
 * mirror on the other side of ownership: it lets the operator RELEASE a row they OWN without leaving the queue — and it
 * does so by REUSING THE EXISTING RELEASE CAPABILITY, not by inventing a second one. This action is the ONE bridge
 * between the queue's client Release button ({@link AttentionQueueReleaseButton}) and the R50 runtime
 * {@link releaseConversationWork} — and it consumes THAT RUNTIME AND ONLY THAT RUNTIME. It is the R60 claim action's
 * sibling: the same shape, the same auth, the same org scoping, the same queue revalidation — differing ONLY in which
 * capability it drives (release, not claim).
 *
 * IT CREATES NO NEW RELEASE MECHANISM. It does NOT re-implement the release decision, does NOT reach the ledger, does
 * NOT open a database client, does NOT name the write primitive `record_receptionist_conversation_claim_release`, and
 * issues no insert / update / delete of its own. The release decision stays R50's `resolveRelease`; the write stays
 * R50's `releaseConversationWork`; the owner guard stays the storage primitive (which releases ONLY a claim the calling
 * operator actually holds). The queue cannot bypass the runtime because this action's ONLY release path IS the runtime.
 *
 * IT PRESERVES ORGANISATION ISOLATION AND THE EXISTING AUTH. Auth is the EXISTING HQ gate (`requireHqPage`) — the same
 * gate the queue read surface uses — and the organisation the release is scoped to is resolved ONLY from the session
 * (`requireOrgContext` → `ctx.org.id`), NEVER from the client. The operator identity is the authenticated user the HQ
 * gate resolved (`user.id` + `user.email`), never a client-supplied value. The client supplies only WHICH coordination
 * to release — and even that is checked by the runtime's storage guard, which refuses any coordination not recorded in
 * the caller's organisation (reported as `unavailable`) and any coordination the caller does not currently hold
 * (reported as `not_owned`). So a client can never release across tenants, never forge an operator, never release a row
 * it does not own, and never widen its own organisation scope.
 *
 * IT ALLOWS THE RELEASE ONLY WHEN THE RUNTIME ALLOWS IT — AND REFRESHES. The queue offers the button only on rows the
 * pure view marked `canRelease` (owned BY THE VIEWER), but the RUNTIME is the final gate: on a row the operator does not
 * hold the runtime returns `not_owned` and nothing is written. On success the action revalidates the QUEUE path so the
 * next render re-reads the (now unowned) row through the R58 runtime — the freshly released row moves from "in progress"
 * back to "waiting to be picked up". It assigns nothing, reassigns nothing, claims nothing, dispatches nothing, notifies
 * no one and executes no business action — every one an explicit R61 non-goal. The append-only release audit is the
 * runtime's ledger row; this action writes no audit of its own.
 *
 * BEST-EFFORT, LIKE THE RUNTIME: the R50 runtime never throws (a lost claim, a missing/cross-tenant coordination or a
 * failed write all return a `ReleaseResult`), and this action turns that closed resolution into the surface's humanised
 * {@link ReleaseActionView} via the pure {@link describeReleaseOutcome} — `released`, `not_owned` or `unavailable` —
 * the release capability's first result projection (the mirror of R47's claim projection).
 */
export async function releaseFromQueueAction(coordinationId: string): Promise<ReleaseActionView> {
  // AUTH — the EXISTING HQ gate authenticates the operator (→ /login when anonymous, → 404 for non-HQ). The returned
  // user is the load-bearing operator identity; it is NEVER taken from the client.
  const user = await requireHqPage();
  // ORGANISATION — resolved ONLY from the session, exactly as the queue read surface resolves it. The release is scoped
  // to this org; a client cannot widen or cross it.
  const { ctx } = await requireOrgContext();

  // THE ONE RELEASE PATH — the R50 runtime, and nothing else (the SAME runtime the R50 pipeline exercises; R61 adds no
  // release mechanism). The runtime validates the request shape, enforces coordination authority + organisation
  // isolation at the storage layer, and releases ONLY a claim this operator holds. This action never touches the ledger
  // directly.
  const result = await releaseConversationWork({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
    operator: { id: user.id, email: user.email ?? null },
  });

  // Refresh the QUEUE so the grouped view re-reads the (now released) ownership on the next render — the released row
  // moves from "in progress" back to "waiting to be picked up". This mirrors the R60 claim action's queue revalidation.
  revalidatePath("/admin/ai-receptionist/worklist/attention");

  // Humanise the runtime's closed resolution into the surface's result message + tone — the release capability's first
  // result projection. Exhaustive over `released` / `not_owned` / `unavailable`.
  return describeReleaseOutcome(result.resolution);
}

"use server";

import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { describeClaimOutcome, type ClaimActionView } from "@/lib/receptionist/conversation-claim-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the CLAIM-FROM-QUEUE SERVER ACTION (CEO Directive #018, R60: CLAIM FROM
 * QUEUE — building on R59's ATTENTION QUEUE SURFACE and REUSING R46's canonical Conversation Work Claim capability).
 *
 * R59 shipped the read-only Attention Queue: the operator sees, grouped by ownership, the work that needs attention. R60
 * lets the operator take ownership of an UNOWNED row WITHOUT leaving the queue — and it does so by REUSING THE EXISTING
 * CLAIM CAPABILITY, not by inventing a second one. This action is the ONE bridge between the queue's client Claim button
 * ({@link AttentionQueueClaimButton}) and the R46 runtime {@link claimConversationWork} — and it consumes THAT RUNTIME
 * AND ONLY THAT RUNTIME. It is the R47 detail-surface action's sibling: byte-for-byte the same claim path, differing
 * ONLY in which surface it revalidates (the queue, not the detail page).
 *
 * IT CREATES NO NEW CLAIM MECHANISM. It does NOT re-implement the claim decision, does NOT reach the ledger, does NOT
 * open a database client, does NOT name the write primitive `record_receptionist_conversation_claim`, and issues no
 * insert / update / delete of its own. The claim decision stays R46's `resolveClaim`; the write stays R46's
 * `claimConversationWork`; the conflict guard stays the storage primitive's `ON CONFLICT (coordination_id) DO NOTHING`.
 * The queue cannot bypass the runtime because this action's ONLY claim path IS the runtime — exactly as the R47 action.
 *
 * IT PRESERVES ORGANISATION ISOLATION AND THE EXISTING AUTH. Auth is the EXISTING HQ gate (`requireHqPage`) — the same
 * gate the queue read surface uses — and the organisation the claim is scoped to is resolved ONLY from the session
 * (`requireOrgContext` → `ctx.org.id`), NEVER from the client. The operator identity is the authenticated user the HQ
 * gate resolved (`user.id` + `user.email`), never a client-supplied value. The client supplies only WHICH coordination
 * to claim — and even that is checked by the runtime's storage guard, which refuses any coordination not recorded in the
 * caller's organisation (reported as `unavailable`). So a client can never claim across tenants, never forge an operator,
 * and never widen its own organisation scope.
 *
 * IT ALLOWS THE CLAIM ONLY WHEN THE RUNTIME ALLOWS IT — AND REFRESHES. The queue offers the button only on rows the pure
 * view marked `canClaim` (unowned), but the RUNTIME is the final gate: on an already-owned row the runtime returns
 * `already_claimed` (the conflict) and nothing is written. On success the action revalidates the QUEUE path so the next
 * render re-reads the (now owned) row through the R58 runtime — the freshly claimed row moves from "waiting to be picked
 * up" to "in progress". It assigns nothing, reassigns nothing, releases nothing, dispatches nothing, notifies no one and
 * executes no business action — every one an explicit R60 non-goal. The append-only claim audit is the runtime's ledger
 * row; this action writes no audit of its own.
 *
 * BEST-EFFORT, LIKE THE RUNTIME: the R46 runtime never throws (a conflict, a missing/cross-tenant coordination or a
 * failed write all return a `ClaimResult`), and this action turns that closed resolution into the surface's humanised
 * {@link ClaimActionView} via the pure {@link describeClaimOutcome} — `claimed`, `already_claimed` (the conflict) or
 * `unavailable` — REUSING the very same R47 projection.
 */
export async function claimFromQueueAction(coordinationId: string): Promise<ClaimActionView> {
  // AUTH — the EXISTING HQ gate authenticates the operator (→ /login when anonymous, → 404 for non-HQ). The returned
  // user is the load-bearing operator identity; it is NEVER taken from the client.
  const user = await requireHqPage();
  // ORGANISATION — resolved ONLY from the session, exactly as the queue read surface resolves it. The claim is scoped to
  // this org; a client cannot widen or cross it.
  const { ctx } = await requireOrgContext();

  // THE ONE CLAIM PATH — the R46 runtime, and nothing else (the SAME runtime the R47 detail action uses; R60 adds no
  // claim mechanism). The runtime validates the request shape, enforces coordination authority + organisation isolation
  // at the storage layer, and prevents conflicting active claims. This action never touches the ledger directly.
  const result = await claimConversationWork({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
    operator: { id: user.id, email: user.email ?? null },
  });

  // Refresh the QUEUE so the grouped view re-reads the (now recorded) claim on the next render — the claimed row moves
  // from "waiting to be picked up" into "in progress". This is the ONLY difference from the R47 detail action.
  revalidatePath("/admin/ai-receptionist/worklist/attention");

  // Humanise the runtime's closed resolution into the surface's result message + tone — the SAME pure projection the R47
  // surface uses. Exhaustive over `claimed` / `already_claimed` / `unavailable`.
  return describeClaimOutcome(result.resolution);
}

"use server";

import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { describeClaimOutcome, type ClaimActionView } from "@/lib/receptionist/conversation-claim-view";

/**
 * The CONVERSATION WORK CLAIM SURFACE — the claim SERVER ACTION (CEO Directive #018, R47: CONVERSATION WORK CLAIM
 * SURFACE).
 *
 * THE single authorised entry point by which the operator surface takes ownership of a Conversation Worklist item. It
 * is the one bridge between the client Claim button (`ClaimPanel`) and the R46 runtime — and it consumes that runtime
 * AND ONLY that runtime. It does NOT reach the ledger, does NOT open a database client, does NOT name the write
 * primitive `record_receptionist_conversation_claim`, and issues no insert / update / delete of its own: the surface
 * cannot bypass the runtime because this action's only claim path IS the runtime.
 *
 * IT PRESERVES ORGANISATION ISOLATION AND THE EXISTING AUTH. Auth is the EXISTING HQ gate (`requireHqPage`) — the same
 * gate the read surfaces use — and the organisation the claim is scoped to is resolved ONLY from the session
 * (`requireOrgContext` → `ctx.org.id`), NEVER from the client. The operator identity is the authenticated user the HQ
 * gate resolved (`user.id` + `user.email`), never a client-supplied value. The client supplies only WHICH coordination
 * to claim — and even that is checked by the runtime's storage guard, which refuses any coordination not recorded in
 * the caller's organisation (reported as `unavailable`). So a client can never claim across tenants, never forge an
 * operator, and never widen its own organisation scope.
 *
 * IT INTRODUCES NO EXECUTION PATH. It records ownership through the runtime and revalidates the surface so the refreshed
 * ownership display reflects the new claim; it assigns nothing, reassigns nothing, releases nothing, dispatches nothing,
 * notifies no one and executes no business action — every one an explicit R47 non-goal. The append-only claim audit is
 * the runtime's ledger row; this action writes no audit of its own and mutates no state beyond asking the runtime to
 * record the claim.
 *
 * BEST-EFFORT, LIKE THE RUNTIME: the R46 runtime never throws (a conflict, a missing coordination or a failed write all
 * return a `ClaimResult`), and this action turns that closed resolution into the surface's humanised
 * {@link ClaimActionView} via the pure {@link describeClaimOutcome} — `claimed`, `already_claimed` (the conflict) or
 * `unavailable`.
 */
export async function claimWorkItemAction(coordinationId: string): Promise<ClaimActionView> {
  // AUTH — the EXISTING HQ gate authenticates the operator (→ /login when anonymous, → 404 for non-HQ). The returned
  // user is the load-bearing operator identity; it is NEVER taken from the client.
  const user = await requireHqPage();
  // ORGANISATION — resolved ONLY from the session, exactly as every read surface resolves it. The claim is scoped to
  // this org; a client cannot widen or cross it.
  const { ctx } = await requireOrgContext();

  // THE ONE CLAIM PATH — the R46 runtime, and nothing else. The runtime validates the request shape, enforces
  // coordination authority + organisation isolation at the storage layer, and prevents conflicting active claims. This
  // action never touches the ledger directly.
  const result = await claimConversationWork({
    org_id: ctx.org.id,
    coordination_id: coordinationId,
    operator: { id: user.id, email: user.email ?? null },
  });

  // Refresh the surface so the ownership display re-reads the (now recorded) claim on the next render.
  revalidatePath(`/admin/ai-receptionist/worklist/${coordinationId}`);

  // Humanise the runtime's closed resolution into the surface's result message + tone. Pure and exhaustive.
  return describeClaimOutcome(result.resolution);
}

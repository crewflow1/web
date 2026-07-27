"use server";

import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { listOrgOperators } from "@/server/services/receptionist-operators";
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import {
  describeReassignmentOutcome,
  type ReassignmentActionView,
} from "@/lib/receptionist/conversation-reassignment-view";

/**
 * The CONVERSATION ATTENTION QUEUE SURFACE — the REASSIGN-FROM-QUEUE SERVER ACTION (CEO Directive #018, R62: REASSIGN
 * FROM QUEUE — building on R59's ATTENTION QUEUE SURFACE and REUSING R52's canonical Conversation Work Reassignment
 * capability).
 *
 * R59 shipped the read-only Attention Queue; R60 let the operator CLAIM an unowned row and R61 let them RELEASE a row
 * they own, each without leaving the queue. R62 completes the trio on the same side of ownership as release: it lets the
 * operator TRANSFER a row they OWN to another authorised operator without leaving the queue — and it does so by REUSING
 * THE EXISTING REASSIGNMENT CAPABILITY, not by inventing a second one. This action is the ONE bridge between the queue's
 * client Reassign control ({@link AttentionQueueReassignButton}) and the R52 runtime {@link reassignConversationWork} —
 * and it consumes THAT RUNTIME AND ONLY THAT RUNTIME for the transfer. It is the R60 claim / R61 release actions'
 * sibling: the same shape, the same auth, the same org scoping, the same queue revalidation — differing ONLY in which
 * capability it drives (reassign, not claim or release).
 *
 * IT CREATES NO NEW REASSIGNMENT MECHANISM. It does NOT re-implement the transfer decision, does NOT reach the ledger,
 * does NOT open a database client, does NOT name the write primitive `record_receptionist_conversation_claim_reassignment`,
 * and issues no insert / update / delete of its own. The transfer decision stays R52's `resolveReassignment`; the write
 * stays R52's `reassignConversationWork`; the owner guard stays the storage primitive (which transfers ONLY a claim the
 * calling source operator actually holds). The queue cannot bypass the runtime because this action's ONLY reassignment
 * path IS the runtime.
 *
 * IT PRESERVES ORGANISATION ISOLATION AND THE EXISTING AUTH. Auth is the EXISTING HQ gate (`requireHqPage`) — the same
 * gate the queue read surface uses — and the organisation the transfer is scoped to is resolved ONLY from the session
 * (`requireOrgContext` → `ctx.org.id`), NEVER from the client. The SOURCE operator is the authenticated user the HQ gate
 * resolved (`user.id` + `user.email`), never a client value — exactly as the R60 claim and R61 release actions take the
 * caller as the acting operator; the R52 writer independently refuses unless that source STILL holds the item. The
 * DESTINATION is validated against the org-scoped roster ({@link listOrgOperators}): a target id the roster does not
 * contain names no authorised operator of THIS organisation, so it is reported `unavailable` without touching the
 * runtime. The client supplies only WHICH coordination to transfer and WHICH operator to receive it. So a client can
 * never transfer across tenants, never forge the source owner, never hand an item to a non-member, and never transfer a
 * row it does not hold.
 *
 * IT ALLOWS THE TRANSFER ONLY WHEN THE RUNTIME ALLOWS IT — AND REFRESHES. The queue offers the control only on rows the
 * pure view marked `canReassign` (owned BY THE VIEWER) and only when a destination exists, but the RUNTIME is the final
 * gate: on a row the operator no longer holds the runtime returns `not_owned` and nothing is written. On success the
 * action revalidates the QUEUE path so the next render re-reads the (now transferred) ownership through the R58 runtime —
 * the row leaves the viewer's hands and shows its new owner. It claims nothing, releases nothing, assigns nobody
 * automatically, dispatches nothing, notifies no one, schedules nothing and executes no business action — every one an
 * explicit R62 non-goal, and there is no bulk path (it transfers exactly the one coordination named). The append-only
 * reassignment audit is the runtime's ledger row; this action writes no audit of its own.
 *
 * BEST-EFFORT, LIKE THE RUNTIME: the R52 runtime never throws (a lost claim, a missing/cross-tenant coordination or a
 * failed write all return a `ReassignmentResult`), and this action turns that closed resolution into the surface's
 * humanised {@link ReassignmentActionView} via the pure {@link describeReassignmentOutcome} — `reassigned`, `not_owned`
 * or `unavailable` — the SAME projection R54's detail reassign surface uses.
 */
export async function reassignFromQueueAction(input: {
  coordinationId: string;
  toOperatorId: string;
}): Promise<ReassignmentActionView> {
  // AUTH — the EXISTING HQ gate authenticates the operator (→ /login when anonymous, → 404 for non-HQ). The returned
  // user is the load-bearing SOURCE operator identity; it is NEVER taken from the client, exactly as the R60 claim and
  // R61 release actions take the caller as the acting operator.
  const user = await requireHqPage();
  // ORGANISATION — resolved ONLY from the session, exactly as the queue read surface resolves it. The transfer is scoped
  // to this org; a client cannot widen or cross it.
  const { ctx } = await requireOrgContext();

  // THE DESTINATION OPERATOR — resolved from the org-scoped roster, so a transfer can only ever hand the item to an
  // AUTHORISED operator of THIS organisation. A target id the roster does not contain names no authorised destination and
  // is refused as `unavailable` without touching the runtime.
  const operators = await listOrgOperators({ org_id: ctx.org.id });
  const target = operators.find((op) => op.operatorId === input.toOperatorId);
  if (!target) {
    return describeReassignmentOutcome("unavailable");
  }

  // THE ONE REASSIGNMENT PATH — the R52 runtime, and nothing else (the SAME runtime the R52 pipeline and R54 detail
  // surface exercise; R62 adds no reassignment mechanism). `from_operator` is the authenticated caller — the queue offers
  // the control only on rows the viewer holds, and the runtime's writer refuses unless that source STILL holds the item
  // (→ `not_owned`). The runtime validates the request shape, enforces coordination authority + organisation isolation at
  // the storage layer, and records the transfer. This action never touches the ledger directly.
  const result = await reassignConversationWork({
    org_id: ctx.org.id,
    coordination_id: input.coordinationId,
    from_operator: { id: user.id, email: user.email ?? null },
    to_operator: { id: target.operatorId, email: target.operatorEmail },
  });

  // Refresh the QUEUE so the grouped view re-reads the (now transferred) ownership on the next render — the row leaves
  // the viewer's hands and shows its new owner. This mirrors the R60 claim / R61 release actions' queue revalidation.
  revalidatePath("/admin/ai-receptionist/worklist/attention");

  // Humanise the runtime's closed resolution into the surface's result message + tone — the SAME projection R54 uses.
  // Exhaustive over `reassigned` / `not_owned` / `unavailable`.
  return describeReassignmentOutcome(result.resolution);
}

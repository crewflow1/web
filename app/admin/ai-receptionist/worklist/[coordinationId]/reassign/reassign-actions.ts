"use server";

import { revalidatePath } from "next/cache";
import { requireHqPage } from "@/server/auth/hq";
import { requireOrgContext } from "@/server/auth/session";
import { getOwnership } from "@/server/services/receptionist-ownership-read-model";
import { listOrgOperators } from "@/server/services/receptionist-operators";
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import {
  describeReassignmentOutcome,
  type ReassignmentActionView,
} from "@/lib/receptionist/conversation-reassignment-view";

/**
 * The CONVERSATION WORK REASSIGNMENT SURFACE — the reassignment SERVER ACTION (CEO Directive #018, R54: CONVERSATION
 * WORK REASSIGNMENT SURFACE).
 *
 * THE single authorised entry point by which the operator surface TRANSFERS ownership of a Conversation Worklist item
 * to another operator. It is the one bridge between the client picker (`ReassignPanel`) and the R52 runtime — and it
 * consumes that runtime AND ONLY that runtime for the transfer. It does NOT reach the reassignment ledger, does NOT open
 * a database client, does NOT name the write primitive
 * `record_receptionist_conversation_claim_reassignment`, and issues no insert / update / delete of its own: the surface
 * cannot bypass the runtime because this action's only reassignment path IS the runtime.
 *
 * IT PRESERVES ORGANISATION ISOLATION AND THE EXISTING AUTH. Auth is the EXISTING HQ gate (`requireHqPage`) — the same
 * gate the read surfaces use — and the organisation the transfer is scoped to is resolved ONLY from the session
 * (`requireOrgContext` → `ctx.org.id`), NEVER from the client. The client supplies only WHICH coordination to transfer
 * and WHICH operator to hand it to. Neither identity is trusted raw: the SOURCE operator is read from the org-scoped
 * Ownership Read Model (the recorded CURRENT owner — never a client value), and the TARGET is resolved from the
 * org-scoped operator roster (an id not in this org's roster names no authorised destination → `unavailable`). So a
 * client can never transfer across tenants, never forge the source owner, and never hand an item to a non-member.
 *
 * IT INTRODUCES NO EXECUTION PATH. It records the transfer through the runtime and revalidates the surfaces so the
 * refreshed ownership display reflects the new owner; it dispatches nothing, notifies no one, schedules nothing and
 * executes no business action — every one an explicit R54 non-goal. The append-only reassignment audit is the runtime's
 * ledger row; this action writes no audit of its own and mutates no state beyond asking the runtime to record the
 * transfer. It performs no automatic selection: the destination is the one the operator chose.
 *
 * BEST-EFFORT, LIKE THE RUNTIME: the R52 runtime never throws (a refused ownership guard, a missing coordination or a
 * failed write all return a `ReassignmentResult`), and this action turns that closed resolution into the surface's
 * humanised {@link ReassignmentActionView} via the pure {@link describeReassignmentOutcome} — `reassigned`, `not_owned`
 * (ownership changed under the operator) or `unavailable`.
 */
export async function reassignWorkItemAction(input: {
  coordinationId: string;
  toOperatorId: string;
}): Promise<ReassignmentActionView> {
  // AUTH — the EXISTING HQ gate authenticates the operator (→ /login when anonymous, → 404 for non-HQ). Any authorised
  // HQ operator may initiate a transfer; the runtime's writer independently guards WHO may give the item up.
  await requireHqPage();
  // ORGANISATION — resolved ONLY from the session, exactly as every read surface resolves it. The transfer is scoped to
  // this org; a client cannot widen or cross it.
  const { ctx } = await requireOrgContext();

  // THE SOURCE OPERATOR — the recorded CURRENT owner, read from the org-scoped Ownership Read Model, NEVER a client
  // value. When nothing is held there is no source to transfer from — reported as `not_owned` without touching the
  // runtime. The runtime's writer re-checks this guard, so this is a faithful pre-read, not the authority.
  const ownership = await getOwnership({
    org_id: ctx.org.id,
    coordination_id: input.coordinationId,
  });
  if (!ownership.owned || !ownership.owner) {
    return describeReassignmentOutcome("not_owned");
  }

  // THE TARGET OPERATOR — resolved from the org-scoped roster, so a transfer can only ever hand the item to an
  // AUTHORISED operator of THIS organisation. An id the roster does not contain names no authorised destination.
  const operators = await listOrgOperators({ org_id: ctx.org.id });
  const target = operators.find((op) => op.operatorId === input.toOperatorId);
  if (!target) {
    return describeReassignmentOutcome("unavailable");
  }

  // THE ONE REASSIGNMENT PATH — the R52 runtime, and nothing else. `from_operator` is the recorded current owner; the
  // runtime validates the request shape, enforces coordination authority + organisation isolation, and refuses unless
  // that source operator STILL holds the item. This action never touches the ledger directly.
  const result = await reassignConversationWork({
    org_id: ctx.org.id,
    coordination_id: input.coordinationId,
    from_operator: { id: ownership.owner.operatorId, email: ownership.owner.operatorEmail },
    to_operator: { id: target.operatorId, email: target.operatorEmail },
    conversation_id: ownership.conversationId,
  });

  // Refresh both this surface and the detail surface so their ownership displays re-read the (now recorded) transfer on
  // the next render.
  revalidatePath(`/admin/ai-receptionist/worklist/${input.coordinationId}/reassign`);
  revalidatePath(`/admin/ai-receptionist/worklist/${input.coordinationId}`);

  // Humanise the runtime's closed resolution into the surface's result message + tone. Pure and exhaustive.
  return describeReassignmentOutcome(result.resolution);
}

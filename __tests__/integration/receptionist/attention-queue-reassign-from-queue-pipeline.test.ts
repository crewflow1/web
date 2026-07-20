import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { reassignConversationWork } from "@/server/services/receptionist-reassignment";
import { getConversationAttentionQueue } from "@/server/services/receptionist-attention-queue";
import { projectAttentionQueueSurface } from "@/lib/receptionist/conversation-attention-queue-view";
import { describeReassignmentOutcome } from "@/lib/receptionist/conversation-reassignment-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation ATTENTION QUEUE — REASSIGN FROM QUEUE pipeline — real-Postgres proof of the AI Receptionist Programme R62
 * (REASSIGN FROM QUEUE): an operator transfers a coordination THEY OWN directly from the Attention Queue to another
 * authorised operator, REUSING the existing R52 Conversation Work Reassignment capability — no new reassignment
 * mechanism.
 *
 * The queue's reassign action (`reassignFromQueueAction`) does exactly four things: authenticate the operator through the
 * HQ gate, resolve the org from the session, validate the chosen destination against the org-scoped operator roster, and
 * delegate to the R52 runtime `reassignConversationWork` (with the AUTHENTICATED caller as `from_operator`, exactly as
 * R60's claim and R61's release take the caller as the acting operator) — then humanise the runtime's resolution through
 * the pure `describeReassignmentOutcome` (the SAME projection R54's detail surface uses) and revalidate the queue. This
 * tier proves that REASSIGN DATA PATH end to end against real Postgres — the runtime the action delegates to, composed
 * with the R58 queue runtime + the R59 pure surface (with the R62 VIEWER-SCOPED `canReassign`) — which is exactly what
 * the action runs after resolving the operator + org + target (the HQ gate and the roster lookup are unit/security
 * concerns, exercised elsewhere; because the runtime is called directly the destination need not be a seeded member):
 *
 *   (1) REASSIGN-FROM-QUEUE ELIGIBILITY IS LIVE — the surface marks a coordination the VIEWER holds `canReassign`; the
 *       EXISTING R52 reassignment (the action's one path) transfers exactly that row from its owner (A) to the chosen
 *       operator (B). Afterwards the row belongs to B: for the OLD owner it is no longer reassignable, for the NEW owner
 *       it is owned + reassignable + flagged reassigned. Untouched owned rows stay held + reassignable by their owner.
 *   (2) CONFLICT — the RUNTIME is the final gate: an operator reassigning a coordination they do NOT hold gets
 *       `not_owned` (the action would surface a warning, never a success), the queue stays owned by the holder, and the
 *       append-only reassignment ledger holds ZERO rows for it. The surface agrees — a non-owner never sees the control
 *       (`canReassign` is false for them). No transfer of another's claim.
 *   (3) ORGANISATION ISOLATION — reassigning in one org never touches another org's ownership; a cross-tenant reassign
 *       (naming another org's coordination) is refused as `unavailable`, and each org's eligibility reflects only its own
 *       ownership, scoped through the runtime.
 *
 * Ownership is established ONLY through the R46 claim runtime and transferred ONLY through the R52 reassignment runtime —
 * this suite opens no write path of its own; it reads the reassignment ledger back solely to prove the append-only
 * outcome. Runs only against a live DB (describeIntegration). Each assertion seeds its own org (a fresh uuid) so it sees
 * only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Three distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. The queue
 *  action would take the SOURCE from `requireHqPage()`; here we pass each explicitly to model owner (A), destination (B)
 *  and a non-owner outsider / other-org owner (C). */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };
const OPERATOR_C: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-c@crewflow.uk" };

// The reassignment ledger is a service-role-only internal, NOT in the generated Database types. Cast to the minimal
// surface this suite exercises (the same `as unknown as` convention the reassignment / release suites use) rather than
// reaching for `any` — one RPC (fulfilment seeding) and one read-back of the append-only reassignment rows.
const REASSIGN_LEDGER = "receptionist_conversation_claim_reassignments";
type LedgerRow = { from_operator_id: string; to_operator_id: string };
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type SelectResult = PromiseLike<{ data: LedgerRow[] | null; error: { message: string } | null }>;
type LedgerClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>;
  from(table: string): { select(columns: string): { eq(column: string, value: string): SelectResult } };
};
const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;

/** The append-only reassignment rows recorded against a coordination — the ground truth of what was transferred. */
async function reassignRowsFor(coordinationId: string): Promise<LedgerRow[]> {
  const read = await svc()
    .from(REASSIGN_LEDGER)
    .select("from_operator_id, to_operator_id")
    .eq("coordination_id", coordinationId);
  expect(read.error, read.error?.message).toBeNull();
  return read.data ?? [];
}

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags always match the fold. */
function authorise(verdict: GuardrailVerdict, live: boolean): ApproveBookingAuthorisation {
  const action = {
    kind: "prepare_booking",
    job_type: JOB,
    postcode: POSTCODE,
    phone_number: PHONE,
  } as const;
  const execution = resolveExecution(action, verdict, { liveExecutionEnabled: live });
  const a = resolveAuthorisation(execution);
  if (!isAuthorisationDecided(a)) throw new Error("test setup: expected a decided authorisation");
  return a;
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route.
 *  `divergentTrade` seeds an inconsistent fulfilment (escalated path); `performFulfilment=false` skips
 *  R30 (retained path); the default is the terminal → closed path. */
async function governThroughStack(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
}): Promise<{ lifecycleId: string; lifecycleState: string }> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: opts.conversationId ?? crypto.randomUUID(),
    customer_ref: CALLER,
    correlation_id: crypto.randomUUID(),
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  if (opts.divergentTrade) {
    const divergent = await svc().rpc<string>("record_receptionist_conversation_fulfilment", {
      p_org_id: opts.orgId,
      p_authorisation_id: seeded?.authorisation_id,
      p_fulfilment_type: "fulfil_booking",
      p_fulfilment_outcome: "booking_recorded",
      p_approval_state: "approved",
      p_correlation_id: crypto.randomUUID(),
      p_review_audit_id: opts.reviewAuditId,
      p_sent_audit_id: crypto.randomUUID(),
      p_review_resolution_id: crypto.randomUUID(),
      p_job_type: "electrical", // DIVERGENT — the authorisation is for plumbing
      p_postcode: POSTCODE,
      p_phone_number: PHONE,
    });
    expect(divergent.error, divergent.error?.message).toBeNull();
  } else if (opts.performFulfilment !== false) {
    const fulfilled = await fulfilApprovedBooking({
      org_id: opts.orgId,
      review_audit_id: opts.reviewAuditId,
      sent_audit_id: crypto.randomUUID(),
      review_resolution_id: crypto.randomUUID(),
    });
    expect(fulfilled, "R30 performed the approved booking").not.toBeNull();
  }

  await verifyApprovedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await recoverVerifiedFulfilment({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  await resolveConversationCompletion({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const governed = await governConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(governed, "the resolved conversation's lifecycle was governed").not.toBeNull();
  if (!governed) throw new Error("test setup: expected a governed lifecycle");
  return { lifecycleId: governed.lifecycle_id, lifecycleState: governed.lifecycle_state };
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads, R38 derives worklists
 *  from, R39 queries, R58 groups by ownership, and R59 projects (with the R62 `canReassign` eligibility) for the operator. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
}): Promise<{ coordinationId: string; lifecycleState: string }> {
  const { lifecycleState } = await governThroughStack(opts);
  await orchestrateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  const coordinated = await coordinateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
  if (!coordinated) throw new Error("test setup: expected a coordination to be filed");
  return { coordinationId: coordinated.coordination_id, lifecycleState };
}

/** Seed a coordination AND claim it for `operator` through the R46 runtime — so the row starts OWNED, exactly the state
 *  R62's reassign affordance acts on. Returns the coordination id. */
async function seedOwnedBy(
  operator: OperatorIdentity,
  opts: { orgId: string; reviewAuditId: string; divergentTrade?: boolean; performFulfilment?: boolean },
): Promise<{ coordinationId: string }> {
  const { coordinationId } = await seedCoordination(opts);
  const claimed = await claimConversationWork({ org_id: opts.orgId, coordination_id: coordinationId, operator });
  expect(claimed.resolution, "test setup: the seeded coordination was claimed").toBe("claimed");
  return { coordinationId };
}

/** The page's exact read: the R58 runtime queue, projected through the R59 pure surface, VIEWER-SCOPED to the operator
 *  reading the queue (so each row's R62 `canReassign` is decided against the caller). */
async function surfaceFor(orgId: string, viewerOperatorId: string) {
  return projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }), { viewerOperatorId });
}

describeIntegration("Conversation Attention Queue · REASSIGN FROM QUEUE pipeline · reusing the R52 reassignment (R62)", () => {
  it("REASSIGN-FROM-QUEUE ELIGIBILITY IS LIVE — the existing R52 reassignment transfers a held row from its owner to the chosen operator (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const target = await seedOwnedBy(OPERATOR_A, { orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const other = await seedOwnedBy(OPERATOR_A, { orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // Before any transfer — for their OWNER (A), BOTH rows are owned, in progress, and reassignable; neither is claimable.
    const before = await surfaceFor(orgId, OPERATOR_A.id);
    expect(before.total).toBe(2);
    for (const r of before.rows) {
      expect(r.group).toBe("owned");
      expect(r.ownershipLabel).toBe("Owned");
      expect(r.ownerLabel).toBe(OPERATOR_A.email);
      expect(r.canReassign).toBe(true);
      expect(r.canClaim).toBe(false);
    }

    // The action's ONE reassignment path — the R52 runtime records the transfer, with the AUTHENTICATED caller (A) as
    // `from_operator` and the chosen operator (B) as `to_operator`.
    const reassigned = await reassignConversationWork({
      org_id: orgId,
      coordination_id: target.coordinationId,
      from_operator: OPERATOR_A,
      to_operator: OPERATOR_B,
    });
    expect(reassigned.resolution).toBe("reassigned");
    // The queue action returns EXACTLY this humanised view over the runtime resolution (describeReassignmentOutcome).
    expect(describeReassignmentOutcome(reassigned.resolution)).toMatchObject({ ok: true, tone: "success" });

    // After the transfer — the surface re-reads ownership LIVE. Viewed by the OLD owner (A): the target row is now owned
    // by B, flagged reassigned, and NO LONGER reassignable or claimable by A; the untouched row is still owned + reassignable by A.
    const afterForA = await surfaceFor(orgId, OPERATOR_A.id);
    const targetForA = afterForA.rows.find((r) => r.coordinationId === target.coordinationId)!;
    const otherForA = afterForA.rows.find((r) => r.coordinationId === other.coordinationId)!;

    expect(targetForA.group).toBe("owned");
    expect(targetForA.ownershipLabel).toBe("Owned");
    expect(targetForA.ownerLabel).toBe(OPERATOR_B.email);
    expect(targetForA.reassigned).toBe(true);
    expect(targetForA.canReassign).toBe(false);
    expect(targetForA.canClaim).toBe(false);

    expect(otherForA.ownerLabel).toBe(OPERATOR_A.email);
    expect(otherForA.canReassign).toBe(true);

    // Viewed by the NEW owner (B): the target row is owned by B and reassignable BY B — eligibility moved with ownership.
    const afterForB = await surfaceFor(orgId, OPERATOR_B.id);
    const targetForB = afterForB.rows.find((r) => r.coordinationId === target.coordinationId)!;
    expect(targetForB.ownerLabel).toBe(OPERATOR_B.email);
    expect(targetForB.reassigned).toBe(true);
    expect(targetForB.canReassign).toBe(true);

    // Exactly the target row moved to B across the whole queue; the other stayed with A.
    expect(afterForB.rows.filter((r) => r.canReassign).map((r) => r.coordinationId)).toEqual([target.coordinationId]);

    // The append-only ledger holds exactly ONE reassignment row — A → B. Nothing else was written.
    const rows = await reassignRowsFor(target.coordinationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_operator_id).toBe(OPERATOR_A.id);
    expect(rows[0]!.to_operator_id).toBe(OPERATOR_B.id);
  });

  it("CONFLICT — a non-owner cannot reassign a held row; not_owned, queue unchanged, nothing transferred, no control (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedOwnedBy(OPERATOR_A, {
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    // For a NON-owner (C), the surface never offers the control — the row is owned by A, so `canReassign` is false for C.
    const nonOwnerView = await surfaceFor(orgId, OPERATOR_C.id);
    expect(nonOwnerView.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(nonOwnerView.rows[0]!.canReassign).toBe(false);

    // C attempts to reassign the coordination A holds (C as the caller/source) — the RUNTIME (the final gate) returns the
    // conflict; nothing is written. The queue action would surface a warning, never a success.
    const contested = await reassignConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      from_operator: OPERATOR_C,
      to_operator: OPERATOR_B,
    });
    expect(contested.resolution).toBe("not_owned");
    expect(describeReassignmentOutcome(contested.resolution)).toMatchObject({ ok: false, tone: "warning" });

    // The queue is UNCHANGED — still owned by A, not claimable, not reassigned; A can still reassign it.
    const afterContest = await surfaceFor(orgId, OPERATOR_A.id);
    expect(afterContest.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(afterContest.rows[0]!.group).toBe("owned");
    expect(afterContest.rows[0]!.reassigned).toBe(false);
    expect(afterContest.rows[0]!.canClaim).toBe(false);
    expect(afterContest.rows[0]!.canReassign).toBe(true);

    // The append-only reassignment ledger holds NO rows for this coordination — the failed transfer wrote nothing.
    expect(await reassignRowsFor(coordinationId)).toHaveLength(0);
  });

  it("ORGANISATION ISOLATION — reassigning in one org never touches another org's ownership; cross-tenant is unavailable (demonstration 3)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedOwnedBy(OPERATOR_A, { orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedOwnedBy(OPERATOR_C, { orgId: orgB, reviewAuditId: crypto.randomUUID(), divergentTrade: true });

    // Operator A reassigns org A's coordination to B — scoped to org A, the runtime allows it.
    expect(
      (
        await reassignConversationWork({
          org_id: orgA,
          coordination_id: a.coordinationId,
          from_operator: OPERATOR_A,
          to_operator: OPERATOR_B,
        })
      ).resolution,
    ).toBe("reassigned");

    // A cross-tenant reassign — A, scoped to org A, naming org B's coordination — is refused by the storage guard as
    // `unavailable` (the coordination is not recorded in org A); it never transfers C's claim.
    const crossTenant = await reassignConversationWork({
      org_id: orgA,
      coordination_id: b.coordinationId,
      from_operator: OPERATOR_A,
      to_operator: OPERATOR_B,
    });
    expect(crossTenant.resolution).toBe("unavailable");
    expect(describeReassignmentOutcome(crossTenant.resolution)).toMatchObject({ ok: false, tone: "error" });

    const surfaceA = await surfaceFor(orgA, OPERATOR_B.id);
    const surfaceB = await surfaceFor(orgB, OPERATOR_C.id);

    // A's queue holds ONLY A's coordination — now owned by B (the in-org transfer stayed within org A) and reassignable by B.
    expect(surfaceA.rows.map((r) => r.coordinationId)).toEqual([a.coordinationId]);
    expect(surfaceA.rows[0]!.group).toBe("owned");
    expect(surfaceA.rows[0]!.ownerLabel).toBe(OPERATOR_B.email);
    expect(surfaceA.rows[0]!.reassigned).toBe(true);
    expect(surfaceA.rows[0]!.canReassign).toBe(true);

    // B's queue holds ONLY B's coordination — STILL owned by C and STILL reassignable by C; A's transfer never crossed the
    // boundary, and the cross-tenant attempt wrote nothing.
    expect(surfaceB.rows.map((r) => r.coordinationId)).toEqual([b.coordinationId]);
    expect(surfaceB.rows[0]!.group).toBe("owned");
    expect(surfaceB.rows[0]!.ownerLabel).toBe(OPERATOR_C.email);
    expect(surfaceB.rows[0]!.reassigned).toBe(false);
    expect(surfaceB.rows[0]!.canReassign).toBe(true);
    expect(await reassignRowsFor(b.coordinationId)).toHaveLength(0);
  });
});

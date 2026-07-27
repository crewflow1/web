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
import { getConversationAttentionQueue } from "@/server/services/receptionist-attention-queue";
import { projectAttentionQueueSurface } from "@/lib/receptionist/conversation-attention-queue-view";
import { describeClaimOutcome } from "@/lib/receptionist/conversation-claim-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation ATTENTION QUEUE — CLAIM FROM QUEUE pipeline — real-Postgres proof of the AI Receptionist Programme R60
 * (CLAIM FROM QUEUE): an operator claims an UNOWNED coordination directly from the Attention Queue, REUSING the existing
 * R46 Conversation Work Claim capability — no new claim mechanism.
 *
 * The queue's claim action (`claimFromQueueAction`) does exactly three things: authenticate the operator through the HQ
 * gate, resolve the org from the session, and delegate to the R46 runtime `claimConversationWork` — then humanise the
 * runtime's resolution through the pure `describeClaimOutcome` (the SAME projection the R47 detail surface uses) and
 * revalidate the queue. This tier proves that CLAIM DATA PATH end to end against real Postgres — the runtime the action
 * delegates to, composed with the R58 queue runtime + the R59 pure surface — which is exactly what the action runs after
 * resolving the operator + org (the HQ gate itself is a unit/security concern, exercised elsewhere):
 *
 *   (1) CLAIM-FROM-QUEUE ELIGIBILITY IS LIVE — the surface marks an unowned coordination `canClaim`; the EXISTING R46
 *       claim (the action's one path) flips exactly that row to owned + not-claimable, attributed to the claimant, and
 *       moves it from "waiting to be picked up" into "in progress". Untouched rows stay claimable.
 *   (2) CONFLICT — the RUNTIME is the final gate: a second operator claiming an already-owned coordination gets
 *       `already_claimed` (the action would surface a warning, never a success), the queue stays owned by the first
 *       claimant, and the append-only ledger holds exactly ONE claim row — the first operator's. No double-claim.
 *   (3) ORGANISATION ISOLATION — claiming in one org never makes another org's row owned or un-claimable; each org's
 *       eligibility reflects only its own ownership, scoped through the runtime.
 *
 * The claim is recorded ONLY through the R46 runtime — this suite opens no claim path of its own; it reads the ledger
 * back solely to prove the append-only, single-row outcome. Runs only against a live DB (describeIntegration). Each
 * assertion seeds its own org (a fresh uuid) so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. The queue
 *  action would take the FIRST from `requireHqPage()`; here we pass each explicitly to model the two-operator race. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

// The claim ledger is a service-role-only internal, NOT in the generated Database types. Cast to the minimal surface
// this suite exercises (the same `as unknown as` convention the claim / fulfilment suites use) rather than reaching for
// `any` — one RPC (fulfilment seeding) and one read-back of the append-only claim rows.
const CLAIM_LEDGER = "receptionist_conversation_claims";
type LedgerRow = { operator_id: string; operator_email: string | null };
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type SelectResult = PromiseLike<{ data: LedgerRow[] | null; error: { message: string } | null }>;
type LedgerClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>;
  from(table: string): { select(columns: string): { eq(column: string, value: string): SelectResult } };
};
const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;

/** The append-only claim rows recorded against a coordination — the ground truth the surface re-reads through R48. */
async function claimRowsFor(coordinationId: string): Promise<LedgerRow[]> {
  const read = await svc().from(CLAIM_LEDGER).select("operator_id, operator_email").eq("coordination_id", coordinationId);
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
 *  from, R39 queries, R58 groups by ownership, and R59 projects (with the R60 `canClaim` eligibility) for the operator. */
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

/** The page's exact read: the R58 runtime queue, projected through the R59 pure surface (with R60 `canClaim`). */
async function surfaceFor(orgId: string) {
  return projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }));
}

describeIntegration("Conversation Attention Queue · CLAIM FROM QUEUE pipeline · reusing the R46 claim (R60)", () => {
  it("CLAIM-FROM-QUEUE ELIGIBILITY IS LIVE — the existing R46 claim flips an eligible row to owned + not-claimable (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const target = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const other = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // Before any claim — BOTH rows are unowned and claimable; the queue offers the button on each.
    const before = await surfaceFor(orgId);
    expect(before.total).toBe(2);
    for (const r of before.rows) {
      expect(r.group).toBe("unowned");
      expect(r.ownershipLabel).toBe("Unowned");
      expect(r.canClaim).toBe(true);
    }

    // The action's ONE claim path — the R46 runtime records the claim (here for the operator the HQ gate would resolve).
    const claimed = await claimConversationWork({
      org_id: orgId,
      coordination_id: target.coordinationId,
      operator: OPERATOR_A,
    });
    expect(claimed.resolution).toBe("claimed");
    // The queue action returns EXACTLY this humanised view over the runtime resolution (describeClaimOutcome).
    expect(describeClaimOutcome(claimed.resolution)).toMatchObject({ ok: true, tone: "success" });

    // After the claim — the surface re-reads ownership LIVE. The claimed row is owned, attributed, and NO LONGER
    // claimable; the untouched row is still unowned and still claimable. The surface derives nothing.
    const after = await surfaceFor(orgId);
    const targetRow = after.rows.find((r) => r.coordinationId === target.coordinationId)!;
    const otherRow = after.rows.find((r) => r.coordinationId === other.coordinationId)!;

    expect(targetRow.group).toBe("owned");
    expect(targetRow.ownershipLabel).toBe("Owned");
    expect(targetRow.ownershipTone).toBe("held");
    expect(targetRow.ownerLabel).toBe(OPERATOR_A.email);
    expect(targetRow.canClaim).toBe(false);
    expect(targetRow.heldSince).not.toBe("—");

    expect(otherRow.group).toBe("unowned");
    expect(otherRow.canClaim).toBe(true);

    // Exactly the still-unowned row remains claimable across the whole queue.
    expect(after.rows.filter((r) => r.canClaim).map((r) => r.coordinationId)).toEqual([other.coordinationId]);
  });

  it("CONFLICT — a second operator cannot re-claim an owned row; already_claimed, queue unchanged, ledger append-only (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    // Operator A claims it first — the row becomes owned + not claimable.
    expect(
      (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A })).resolution,
    ).toBe("claimed");
    const owned = await surfaceFor(orgId);
    expect(owned.rows[0]!.canClaim).toBe(false);
    expect(owned.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);

    // Operator B races for the SAME coordination — the RUNTIME (the final gate) returns the conflict; nothing is
    // written. The queue action would surface a warning, never a success.
    const contested = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_B,
    });
    expect(contested.resolution).toBe("already_claimed");
    expect(describeClaimOutcome(contested.resolution)).toMatchObject({ ok: false, tone: "warning" });

    // The queue is UNCHANGED — still owned by A, still not claimable; B never appears.
    const afterContest = await surfaceFor(orgId);
    expect(afterContest.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(afterContest.rows[0]!.canClaim).toBe(false);
    expect(afterContest.rows.map((r) => r.ownerLabel)).not.toContain(OPERATOR_B.email);

    // The append-only ledger holds exactly ONE claim row — the first operator's. The conflict wrote nothing.
    const rows = await claimRowsFor(coordinationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operator_id).toBe(OPERATOR_A.id);
  });

  it("ORGANISATION ISOLATION — claiming in one org never makes another org's row owned or un-claimable (demonstration 3)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), divergentTrade: true });

    // Operator A claims org A's coordination.
    expect(
      (await claimConversationWork({ org_id: orgA, coordination_id: a.coordinationId, operator: OPERATOR_A })).resolution,
    ).toBe("claimed");

    const surfaceA = await surfaceFor(orgA);
    const surfaceB = await surfaceFor(orgB);

    // A's queue holds ONLY A's coordination — owned, not claimable, attributed to A.
    expect(surfaceA.rows.map((r) => r.coordinationId)).toEqual([a.coordinationId]);
    expect(surfaceA.rows[0]!.canClaim).toBe(false);
    expect(surfaceA.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);

    // B's queue holds ONLY B's coordination — still UNOWNED and still CLAIMABLE; A's claim never crossed the boundary.
    expect(surfaceB.rows.map((r) => r.coordinationId)).toEqual([b.coordinationId]);
    expect(surfaceB.rows[0]!.canClaim).toBe(true);
    expect(surfaceB.rows[0]!.ownerLabel).toBeNull();
    expect(surfaceB.rows.map((r) => r.coordinationId)).not.toContain(a.coordinationId);
  });
});

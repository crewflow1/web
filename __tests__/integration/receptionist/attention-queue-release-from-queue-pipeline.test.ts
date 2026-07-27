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
import { releaseConversationWork } from "@/server/services/receptionist-release";
import { getConversationAttentionQueue } from "@/server/services/receptionist-attention-queue";
import { projectAttentionQueueSurface } from "@/lib/receptionist/conversation-attention-queue-view";
import { describeReleaseOutcome } from "@/lib/receptionist/conversation-release-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation ATTENTION QUEUE — RELEASE FROM QUEUE pipeline — real-Postgres proof of the AI Receptionist Programme R61
 * (RELEASE FROM QUEUE): an operator releases a coordination THEY OWN directly from the Attention Queue, REUSING the
 * existing R50 Conversation Work Release capability — no new release mechanism.
 *
 * The queue's release action (`releaseFromQueueAction`) does exactly three things: authenticate the operator through the
 * HQ gate, resolve the org from the session, and delegate to the R50 runtime `releaseConversationWork` — then humanise
 * the runtime's resolution through the pure `describeReleaseOutcome` (release's FIRST result projection, the mirror of
 * R47's claim projection) and revalidate the queue. This tier proves that RELEASE DATA PATH end to end against real
 * Postgres — the runtime the action delegates to, composed with the R58 queue runtime + the R59 pure surface (with the
 * R61 VIEWER-SCOPED `canRelease`) — which is exactly what the action runs after resolving the operator + org (the HQ
 * gate itself is a unit/security concern, exercised elsewhere):
 *
 *   (1) RELEASE-FROM-QUEUE ELIGIBILITY IS LIVE — the surface marks a coordination the VIEWER holds `canRelease`; the
 *       EXISTING R50 release (the action's one path) flips exactly that row back to unowned + claimable, and moves it
 *       from "in progress" back into "waiting to be picked up". Untouched owned rows stay held + releasable by the owner.
 *   (2) CONFLICT — the RUNTIME is the final gate: an operator releasing a coordination they do NOT hold gets `not_owned`
 *       (the action would surface a warning, never a success), the queue stays owned by the holder, and the append-only
 *       release ledger holds ZERO rows for it. The surface agrees — a non-owner never sees the button (`canRelease` is
 *       false for them). No release of another's claim.
 *   (3) ORGANISATION ISOLATION — releasing in one org never touches another org's ownership; a cross-tenant release
 *       (naming another org's coordination) is refused as `unavailable`, and each org's eligibility reflects only its
 *       own ownership, scoped through the runtime.
 *
 * Ownership is established ONLY through the R46 claim runtime and released ONLY through the R50 release runtime — this
 * suite opens no write path of its own; it reads the release ledger back solely to prove the append-only outcome. Runs
 * only against a live DB (describeIntegration). Each assertion seeds its own org (a fresh uuid) so it sees only its own
 * writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. The queue
 *  action would take the FIRST from `requireHqPage()`; here we pass each explicitly to model owner vs non-owner. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

// The release ledger is a service-role-only internal, NOT in the generated Database types. Cast to the minimal surface
// this suite exercises (the same `as unknown as` convention the release / claim suites use) rather than reaching for
// `any` — one RPC (fulfilment seeding) and one read-back of the append-only release rows.
const RELEASE_LEDGER = "receptionist_conversation_claim_releases";
type LedgerRow = { operator_id: string; operator_email: string | null };
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type SelectResult = PromiseLike<{ data: LedgerRow[] | null; error: { message: string } | null }>;
type LedgerClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult<T>>;
  from(table: string): { select(columns: string): { eq(column: string, value: string): SelectResult } };
};
const svc = (): LedgerClient => serviceClient() as unknown as LedgerClient;

/** The append-only release rows recorded against a coordination — the ground truth of what was released. */
async function releaseRowsFor(coordinationId: string): Promise<LedgerRow[]> {
  const read = await svc()
    .from(RELEASE_LEDGER)
    .select("operator_id, operator_email")
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
 *  from, R39 queries, R58 groups by ownership, and R59 projects (with the R61 `canRelease` eligibility) for the operator. */
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
 *  R61's release affordance acts on. Returns the coordination id. */
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
 *  reading the queue (so each row's R61 `canRelease` is decided against the caller). */
async function surfaceFor(orgId: string, viewerOperatorId: string) {
  return projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }), { viewerOperatorId });
}

describeIntegration("Conversation Attention Queue · RELEASE FROM QUEUE pipeline · reusing the R50 release (R61)", () => {
  it("RELEASE-FROM-QUEUE ELIGIBILITY IS LIVE — the existing R50 release flips a held row back to unowned + claimable (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const target = await seedOwnedBy(OPERATOR_A, { orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const other = await seedOwnedBy(OPERATOR_A, { orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // Before any release — for their OWNER (A), BOTH rows are owned, in progress, and releasable; neither is claimable.
    const before = await surfaceFor(orgId, OPERATOR_A.id);
    expect(before.total).toBe(2);
    for (const r of before.rows) {
      expect(r.group).toBe("owned");
      expect(r.ownershipLabel).toBe("Owned");
      expect(r.ownerLabel).toBe(OPERATOR_A.email);
      expect(r.canRelease).toBe(true);
      expect(r.canClaim).toBe(false);
    }

    // The action's ONE release path — the R50 runtime records the release (here for the operator the HQ gate resolves).
    const released = await releaseConversationWork({
      org_id: orgId,
      coordination_id: target.coordinationId,
      operator: OPERATOR_A,
    });
    expect(released.resolution).toBe("released");
    // The queue action returns EXACTLY this humanised view over the runtime resolution (describeReleaseOutcome).
    expect(describeReleaseOutcome(released.resolution)).toMatchObject({ ok: true, tone: "success" });

    // After the release — the surface re-reads ownership LIVE. The released row is unowned, claimable again, and back in
    // "waiting to be picked up"; the untouched row is still owned by A and still releasable by A. The surface derives nothing.
    const after = await surfaceFor(orgId, OPERATOR_A.id);
    const targetRow = after.rows.find((r) => r.coordinationId === target.coordinationId)!;
    const otherRow = after.rows.find((r) => r.coordinationId === other.coordinationId)!;

    expect(targetRow.group).toBe("unowned");
    expect(targetRow.ownershipLabel).toBe("Unowned");
    expect(targetRow.ownershipTone).toBe("unheld");
    expect(targetRow.ownerLabel).toBeNull();
    expect(targetRow.canRelease).toBe(false);
    expect(targetRow.canClaim).toBe(true);
    expect(targetRow.heldSince).toBe("—");

    expect(otherRow.group).toBe("owned");
    expect(otherRow.ownerLabel).toBe(OPERATOR_A.email);
    expect(otherRow.canRelease).toBe(true);
    expect(otherRow.canClaim).toBe(false);

    // Exactly the released row is now claimable across the whole queue.
    expect(after.rows.filter((r) => r.canClaim).map((r) => r.coordinationId)).toEqual([target.coordinationId]);

    // The append-only ledger holds exactly ONE release row — the operator's. Nothing else was written.
    const rows = await releaseRowsFor(target.coordinationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operator_id).toBe(OPERATOR_A.id);
  });

  it("CONFLICT — a non-owner cannot release a held row; not_owned, queue unchanged, nothing released, no button (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedOwnedBy(OPERATOR_A, {
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    // For a NON-owner (B), the surface never offers the button — the row is owned by A, so `canRelease` is false for B.
    const nonOwnerView = await surfaceFor(orgId, OPERATOR_B.id);
    expect(nonOwnerView.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(nonOwnerView.rows[0]!.canRelease).toBe(false);

    // B attempts to release the coordination A holds — the RUNTIME (the final gate) returns the conflict; nothing is
    // written. The queue action would surface a warning, never a success.
    const contested = await releaseConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_B,
    });
    expect(contested.resolution).toBe("not_owned");
    expect(describeReleaseOutcome(contested.resolution)).toMatchObject({ ok: false, tone: "warning" });

    // The queue is UNCHANGED — still owned by A, still not claimable; A can still release it.
    const afterContest = await surfaceFor(orgId, OPERATOR_A.id);
    expect(afterContest.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(afterContest.rows[0]!.group).toBe("owned");
    expect(afterContest.rows[0]!.canClaim).toBe(false);
    expect(afterContest.rows[0]!.canRelease).toBe(true);

    // The append-only release ledger holds NO rows for this coordination — the failed release wrote nothing.
    expect(await releaseRowsFor(coordinationId)).toHaveLength(0);
  });

  it("ORGANISATION ISOLATION — releasing in one org never touches another org's ownership; cross-tenant is unavailable (demonstration 3)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedOwnedBy(OPERATOR_A, { orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedOwnedBy(OPERATOR_B, { orgId: orgB, reviewAuditId: crypto.randomUUID(), divergentTrade: true });

    // Operator A releases org A's coordination — scoped to org A, the runtime allows it.
    expect(
      (await releaseConversationWork({ org_id: orgA, coordination_id: a.coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("released");

    // A cross-tenant release — A, scoped to org A, naming org B's coordination — is refused by the storage guard as
    // `unavailable` (the coordination is not recorded in org A); it never releases B's claim.
    const crossTenant = await releaseConversationWork({
      org_id: orgA,
      coordination_id: b.coordinationId,
      operator: OPERATOR_A,
    });
    expect(crossTenant.resolution).toBe("unavailable");
    expect(describeReleaseOutcome(crossTenant.resolution)).toMatchObject({ ok: false, tone: "error" });

    const surfaceA = await surfaceFor(orgA, OPERATOR_A.id);
    const surfaceB = await surfaceFor(orgB, OPERATOR_B.id);

    // A's queue holds ONLY A's coordination — now unowned and claimable again; A's release stayed within its org.
    expect(surfaceA.rows.map((r) => r.coordinationId)).toEqual([a.coordinationId]);
    expect(surfaceA.rows[0]!.group).toBe("unowned");
    expect(surfaceA.rows[0]!.canClaim).toBe(true);
    expect(surfaceA.rows[0]!.ownerLabel).toBeNull();

    // B's queue holds ONLY B's coordination — STILL owned by B and STILL releasable by B; A's release never crossed the
    // boundary, and the cross-tenant attempt wrote nothing.
    expect(surfaceB.rows.map((r) => r.coordinationId)).toEqual([b.coordinationId]);
    expect(surfaceB.rows[0]!.group).toBe("owned");
    expect(surfaceB.rows[0]!.ownerLabel).toBe(OPERATOR_B.email);
    expect(surfaceB.rows[0]!.canRelease).toBe(true);
    expect(await releaseRowsFor(b.coordinationId)).toHaveLength(0);
  });
});

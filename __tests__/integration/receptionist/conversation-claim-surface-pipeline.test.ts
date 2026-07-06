import { expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import { claimConversationWork } from "@/server/services/receptionist-claim";
import { getClaimForCoordination } from "@/server/services/receptionist-claim-view";
import { projectClaimOwnership } from "@/lib/receptionist/conversation-claim-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work Claim SURFACE pipeline — real-Postgres proof of the AI Receptionist Programme R47 (CONVERSATION
 * WORK CLAIM SURFACE): the FIRST operator-facing use of the R46 claim capability. R46 proved (against a live database)
 * that the RUNTIME records a conflict-guarded, append-only, org-isolated claim. R47 is the surface over it, and the
 * behaviour the mocks can't prove is the SURFACE'S SERVER-SIDE DATA PATH — the composition the detail page performs:
 * the org-scoped ownership READER (`getClaimForCoordination`) reading BACK what the RUNTIME (`claimConversationWork`)
 * recorded, projected (with the viewer's id) through the pure `projectClaimOwnership` into the ownership view the page
 * renders. This tier pins exactly that composition over Postgres:
 *
 *   • BEFORE ANY CLAIM, THE ITEM READS AS UNCLAIMED — the reader returns null for a seeded-but-unclaimed coordination,
 *     and the projection offers the ONE affordance: `canClaim` is true, no one holds it.
 *   • AFTER THE RUNTIME RECORDS A CLAIM, THE READER RETURNS THE OWNER — org-scoped, with the operator id + email, the
 *     fold, the 'claimed' status and a timestamp — and the projection names the owner correctly for BOTH the holder
 *     ("You", `viewerHoldsClaim`) and another viewer ("Claimed by …"); the item is no longer claimable.
 *   • A CONFLICTING CLAIM DOES NOT CHANGE THE DISPLAYED OWNER — a different operator is refused (`already_claimed`) and
 *     the reader still returns the original holder: the surface can never show two owners.
 *   • ORGANISATION ISOLATION HOLDS AT THE READER — the reader NEVER returns another organisation's claim; a claim
 *     recorded under org A reads back as null under org B, so a cross-tenant viewer sees an unclaimed item, never
 *     someone else's ownership.
 *
 * The action wrapper (`claimWorkItemAction`) is NOT exercised here — it depends on the HQ session cookie the page gate
 * resolves, which this tier has no browser for; its gating is pinned as SOURCE by the security suite, and the claim it
 * delegates to is the very runtime proven here and in the R46 pipeline. Runs only against a live DB
 * (describeIntegration): skipped locally with no database, FAILED loudly in CI if the database is missing. The claim
 * ledger is append-only, so these tests intentionally leave their rows behind; each assertion is addressed by a
 * per-call coordination id so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the deterministic fold
 * of the eligibility they are recorded with — a genuine composition of R28 execution + R29 authorisation.
 */
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

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle to route. */
async function governThroughStack(opts: { orgId: string; reviewAuditId: string }): Promise<void> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: crypto.randomUUID(),
    customer_ref: CALLER,
    correlation_id: crypto.randomUUID(),
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  const fulfilled = await fulfilApprovedBooking({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(fulfilled, "R30 performed the approved booking").not.toBeNull();

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
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item R47's surface displays and claims. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
}): Promise<{ coordinationId: string }> {
  await governThroughStack(opts);
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
  return { coordinationId: coordinated.coordination_id };
}

describeIntegration("Conversation Work Claim Surface pipeline · reader + runtime (R47)", () => {
  it("reads an UNCLAIMED coordination as null — and the projection offers the claim", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // The surface reads ownership BEFORE anyone claims — the item is recorded, but unclaimed.
    const owner = await getClaimForCoordination({ org_id: orgId, coordination_id: coordinationId });
    expect(owner, "an unclaimed coordination has no claim row").toBeNull();

    // The projection the page renders: the ONE affordance is offered — this item may be claimed.
    const view = projectClaimOwnership({ owner, viewerOperatorId: OPERATOR_A.id });
    expect(view.claimed).toBe(false);
    expect(view.canClaim).toBe(true);
    expect(view.viewerHoldsClaim).toBe(false);
    expect(view.ownerId).toBeNull();
  });

  it("after the runtime records a claim, the reader returns the owner — projected for holder and onlooker alike", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // The RUNTIME records the claim (exactly as the action would), then the SURFACE reads it back.
    const claimed = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(claimed.resolution).toBe("claimed");

    const owner = await getClaimForCoordination({ org_id: orgId, coordination_id: coordinationId });
    expect(owner, "the recorded claim reads back").not.toBeNull();
    if (!owner) throw new Error("expected a recorded claim to read back");
    // The reader projects the recorded facts the display needs.
    expect(owner.coordinationId).toBe(coordinationId);
    expect(owner.operatorId).toBe(OPERATOR_A.id);
    expect(owner.operatorEmail).toBe(OPERATOR_A.email);
    expect(owner.claimType).toBe("claim_conversation_work");
    expect(owner.claimOutcome).toBe("work_claimed");
    expect(owner.status).toBe("claimed");
    expect(typeof owner.claimedAt).toBe("string");
    expect(owner.claimedAt.length).toBeGreaterThan(0);

    // The HOLDER's view — "You hold this claim", and the item is NOT re-claimable.
    const mine = projectClaimOwnership({ owner, viewerOperatorId: OPERATOR_A.id });
    expect(mine.claimed).toBe(true);
    expect(mine.canClaim).toBe(false);
    expect(mine.viewerHoldsClaim).toBe(true);
    expect(mine.ownerLabel).toBe("You");
    expect(mine.summary).toBe("You hold this claim.");

    // ANOTHER operator's view — named by email, still not claimable, and they do not hold it.
    const theirs = projectClaimOwnership({ owner, viewerOperatorId: OPERATOR_B.id });
    expect(theirs.claimed).toBe(true);
    expect(theirs.canClaim).toBe(false);
    expect(theirs.viewerHoldsClaim).toBe(false);
    expect(theirs.ownerId).toBe(OPERATOR_A.id);
    expect(theirs.ownerLabel).toBe(OPERATOR_A.email);
    expect(theirs.summary).toBe(`Claimed by ${OPERATOR_A.email}.`);
  });

  it("a conflicting claim never changes the displayed owner", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // A claims; B races and is refused. The surface must never show two owners.
    const first = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(first.resolution).toBe("claimed");
    const contested = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_B });
    expect(contested.resolution).toBe("already_claimed");

    // The reader still returns A — the loser's attempt wrote nothing, and the display settles on the winner.
    const owner = await getClaimForCoordination({ org_id: orgId, coordination_id: coordinationId });
    expect(owner?.operatorId).toBe(OPERATOR_A.id);

    // Even B's own view shows A as the owner (not themselves), and offers no claim.
    const bView = projectClaimOwnership({ owner, viewerOperatorId: OPERATOR_B.id });
    expect(bView.viewerHoldsClaim).toBe(false);
    expect(bView.canClaim).toBe(false);
    expect(bView.ownerId).toBe(OPERATOR_A.id);
  });

  it("preserves ORGANISATION ISOLATION at the reader — org B never sees org A's claim", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

    // A records a claim under its own org.
    const claimed = await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(claimed.resolution).toBe("claimed");

    // Org A reads its own claim…
    const ownerA = await getClaimForCoordination({ org_id: orgA, coordination_id: coordinationId });
    expect(ownerA?.operatorId).toBe(OPERATOR_A.id);

    // …but org B, naming the SAME coordination id, reads null — the reader's org filter isolates it structurally.
    const ownerB = await getClaimForCoordination({ org_id: orgB, coordination_id: coordinationId });
    expect(ownerB, "org B must never read org A's claim").toBeNull();

    // So a cross-tenant viewer sees an unclaimed item — never someone else's ownership.
    const bView = projectClaimOwnership({ owner: ownerB, viewerOperatorId: OPERATOR_B.id });
    expect(bView.claimed).toBe(false);
    expect(bView.canClaim).toBe(true);
  });
});

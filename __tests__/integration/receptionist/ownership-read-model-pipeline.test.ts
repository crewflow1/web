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
import {
  getOwnership,
  getOwnershipHistory,
  getOwnershipSummary,
} from "@/server/services/receptionist-ownership-read-model";
import { orderOwnershipEvents } from "@/lib/receptionist/conversation-ownership-read-model";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Work Ownership READ MODEL pipeline — real-Postgres proof of the AI Receptionist Programme R48
 * (CONVERSATION WORK OWNERSHIP READ MODEL): the canonical, authoritative projection of ownership state derived from the
 * append-only claim ledger. R46 proved (against a live database) that the RUNTIME records a conflict-guarded,
 * append-only, org-isolated claim. R48 is the canonical read model over that ledger, and the behaviour the mocks can't
 * prove is its SERVER-SIDE DATA PATH — the org-scoped ownership reader reading BACK what the RUNTIME
 * (`claimConversationWork`) recorded, projected through the pure ownership core. This tier pins exactly that over
 * Postgres:
 *
 *   • BEFORE ANY CLAIM, THE COORDINATION READS AS UNOWNED — the reader returns an `unowned` record for a
 *     seeded-but-unclaimed coordination: no owner, no claim timestamp.
 *   • AFTER THE RUNTIME RECORDS A CLAIM, THE READER RETURNS THE OWNER — org-scoped, `owned`, with the operator id +
 *     email, the fold, and a claim timestamp (the CURRENT owner + claim timestamp + ownership status).
 *   • THE HISTORY LISTS THE ORG'S OWNERSHIP EVENTS NEWEST-FIRST, AND THE SUMMARY AGGREGATES THEM — every claim in the
 *     org appears exactly once in canonical order, and the summary counts the claims, the distinct owners and each
 *     owner's tally deterministically.
 *   • ORGANISATION ISOLATION HOLDS AT THE READER — the read model NEVER returns another organisation's ownership; a
 *     claim recorded under org A reads back as unowned under org B, whose history and summary are empty.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. The claim ledger is append-only, so these tests intentionally leave their rows behind; each
 * assertion uses a FRESH random org id so it sees only its own writes.
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item the ownership read model reads. */
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

describeIntegration("Conversation Work Ownership Read Model pipeline · reader over the append-only claim ledger (R48)", () => {
  it("reads a seeded-but-unclaimed coordination as UNOWNED — no owner, no timestamp", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    const record = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
    expect(record.coordinationId).toBe(coordinationId);
    expect(record.status).toBe("unowned");
    expect(record.owned).toBe(false);
    expect(record.owner).toBeNull();
    expect(record.claimedAt).toBeNull();
  });

  it("after the runtime records a claim, the reader returns OWNED with the current owner and claim timestamp", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // The RUNTIME records the claim (exactly as the surface's action would); the READ MODEL reads it back.
    const claimed = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(claimed.resolution).toBe("claimed");

    const record = await getOwnership({ org_id: orgId, coordination_id: coordinationId });
    expect(record.status).toBe("owned");
    expect(record.owned).toBe(true);
    expect(record.claimedAt, "an owned coordination carries the claim timestamp").not.toBeNull();
    expect(typeof record.claimedAt).toBe("string");
    expect(record.owner).not.toBeNull();
    if (!record.owner) throw new Error("expected an owner on an owned coordination");
    expect(record.owner.operatorId).toBe(OPERATOR_A.id);
    expect(record.owner.operatorEmail).toBe(OPERATOR_A.email);
    expect(record.owner.claimType).toBe("claim_conversation_work");
    expect(record.owner.claimOutcome).toBe("work_claimed");
    expect(record.owner.claimedAt).toBe(record.claimedAt);
  });

  it("lists the org's ownership history newest-first, and summarises it deterministically", async () => {
    const orgId = crypto.randomUUID();
    // Three coordinations in one org: A owns two, B owns one.
    const one = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const two = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const three = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    expect((await claimConversationWork({ org_id: orgId, coordination_id: one.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: two.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: three.coordinationId, operator: OPERATOR_B })).resolution).toBe("claimed");

    // HISTORY — exactly the three ownership events, in canonical newest-first order.
    const history = await getOwnershipHistory({ org_id: orgId });
    expect(history).toHaveLength(3);
    expect(new Set(history.map((e) => e.coordinationId))).toEqual(
      new Set([one.coordinationId, two.coordinationId, three.coordinationId]),
    );
    // The reader returns them already canonically ordered (idempotent under the pure order).
    expect(history).toEqual(orderOwnershipEvents(history));

    // SUMMARY — three claims across two distinct owners; A has the larger tally, so A is listed first.
    const summary = await getOwnershipSummary({ org_id: orgId });
    expect(summary.totalClaims).toBe(3);
    expect(summary.distinctOwners).toBe(2);
    expect(summary.owners).toHaveLength(2);
    expect(summary.owners[0]?.operatorId).toBe(OPERATOR_A.id);
    expect(summary.owners[0]?.claimCount).toBe(2);
    expect(summary.owners[1]?.operatorId).toBe(OPERATOR_B.id);
    expect(summary.owners[1]?.claimCount).toBe(1);
    expect(summary.latestClaimAt).not.toBeNull();
    expect(summary.earliestClaimAt).not.toBeNull();

    // Per-coordination ownership resolves each owner correctly.
    expect((await getOwnership({ org_id: orgId, coordination_id: one.coordinationId })).owner?.operatorId).toBe(OPERATOR_A.id);
    expect((await getOwnership({ org_id: orgId, coordination_id: three.coordinationId })).owner?.operatorId).toBe(OPERATOR_B.id);
  });

  it("preserves ORGANISATION ISOLATION — org B never sees org A's ownership", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

    // A records a claim under its own org.
    const claimed = await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(claimed.resolution).toBe("claimed");

    // Org A sees its own ownership…
    const ownedByA = await getOwnership({ org_id: orgA, coordination_id: coordinationId });
    expect(ownedByA.owned).toBe(true);
    expect(ownedByA.owner?.operatorId).toBe(OPERATOR_A.id);

    // …but org B, naming the SAME coordination id, reads it as UNOWNED — the org filter isolates it structurally.
    const seenByB = await getOwnership({ org_id: orgB, coordination_id: coordinationId });
    expect(seenByB.owned).toBe(false);
    expect(seenByB.status).toBe("unowned");
    expect(seenByB.owner).toBeNull();

    // And org B's history + summary are empty — it never sees another org's claims.
    expect(await getOwnershipHistory({ org_id: orgB })).toEqual([]);
    const summaryB = await getOwnershipSummary({ org_id: orgB });
    expect(summaryB.totalClaims).toBe(0);
    expect(summaryB.distinctOwners).toBe(0);
    expect(summaryB.owners).toEqual([]);
    expect(summaryB.latestClaimAt).toBeNull();
    expect(summaryB.earliestClaimAt).toBeNull();
  });
});

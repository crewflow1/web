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
import { releaseConversationWork } from "@/server/services/receptionist-release";
import {
  getCoordinationOwnershipState,
  listCoordinationOwnershipStates,
} from "@/server/services/receptionist-ownership-state";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation Ownership STATE ENGINE pipeline — real-Postgres proof of the AI Receptionist Programme R51 (CONVERSATION
 * OWNERSHIP STATE ENGINE): the SINGLE authoritative engine that derives ownership state from the append-only ownership
 * event stream (the R46 claim ledger + the R50 release ledger). The unit tier proves the pure fold in isolation
 * (`deriveOwnershipState`: no claim ⇒ unclaimed; claim, no release ⇒ claimed; claim + release ⇒ released); the security
 * tier proves, as SOURCE, that the runtime is the SOLE event-stream reader and that no consumer re-derives ownership.
 * This tier proves the behaviour the mocks can't — that when the engine's runtime seams
 * (`getCoordinationOwnershipState` / `listCoordinationOwnershipStates`) READ BACK what the CANONICAL runtimes recorded
 * (`claimConversationWork` for R46, `releaseConversationWork` for R50) over a LIVE database, the engine derives the
 * whole claim⇄release lifecycle correctly and org-isolated:
 *
 *   • THE ENGINE DERIVES THE THREE-STATE LIFECYCLE FROM THE LEDGERS — a seeded-but-unclaimed coordination reads
 *     `unclaimed`; after the R46 runtime records a claim it reads `claimed`; after the R50 runtime records a release it
 *     reads `released`. The engine reads only the append-only events and folds them; it records nothing.
 *   • THE CLAIM + RELEASE RUNTIMES REMAIN AUTHORITATIVE — the engine derives `released` from the PRESENCE of a release
 *     event, never by rewriting or deleting the claim: the state record still carries BOTH recorded events after a
 *     release, exactly the ledgers' append-only truth.
 *   • THE ORG-WIDE LIST DERIVES ONE STATE PER RECORDED CLAIM — every claimed coordination in the org appears exactly
 *     once, each carrying its derived state (`claimed` until a release names it, then `released`).
 *   • ORGANISATION ISOLATION HOLDS AT THE ENGINE — a claim + release recorded under org A are invisible to org B: org B
 *     derives `unclaimed` for the SAME coordination id and lists nothing. The `org_id` filter is structural on every
 *     ledger read.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. Both ledgers are append-only, so these tests intentionally leave their rows behind; each
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded item the state engine derives over. */
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

describeIntegration("Conversation Ownership State Engine pipeline · derivation over the append-only ownership event stream (R51)", () => {
  it("derives the THREE-STATE LIFECYCLE from the ledgers — unclaimed → claimed → released", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // BEFORE ANY CLAIM — no claim event exists, so the engine derives `unclaimed`, carrying neither event.
    const unclaimed = await getCoordinationOwnershipState({ org_id: orgId, coordination_id: coordinationId });
    expect(unclaimed.coordinationId).toBe(coordinationId);
    expect(unclaimed.state).toBe("unclaimed");
    expect(unclaimed.claim).toBeNull();
    expect(unclaimed.release).toBeNull();

    // AFTER THE R46 RUNTIME RECORDS A CLAIM — a claim event, no release, so the engine derives `claimed`.
    const claimed = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(claimed.resolution).toBe("claimed");

    const afterClaim = await getCoordinationOwnershipState({ org_id: orgId, coordination_id: coordinationId });
    expect(afterClaim.state).toBe("claimed");
    expect(afterClaim.claim, "a claimed state carries the recorded claim event").not.toBeNull();
    expect(afterClaim.claim?.coordination_id).toBe(coordinationId);
    expect(afterClaim.claim?.operator_id).toBe(OPERATOR_A.id);
    expect(afterClaim.claim?.operator_email).toBe(OPERATOR_A.email);
    expect(afterClaim.claim?.claim_type).toBe("claim_conversation_work");
    expect(afterClaim.claim?.claim_outcome).toBe("work_claimed");
    expect(afterClaim.claim?.status).toBe("claimed");
    expect(typeof afterClaim.claim?.claimed_at).toBe("string");
    expect(afterClaim.release, "no release recorded yet").toBeNull();

    // AFTER THE R50 RUNTIME RECORDS A RELEASE — a claim AND a release, so the engine derives `released`.
    const released = await releaseConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(released.resolution).toBe("released");

    const afterRelease = await getCoordinationOwnershipState({ org_id: orgId, coordination_id: coordinationId });
    expect(afterRelease.state).toBe("released");
    // THE CLAIM + RELEASE RUNTIMES REMAIN AUTHORITATIVE — the engine derives `released` from the PRESENCE of the release
    // event; it never rewrites or deletes the claim, so the state record still carries BOTH recorded events.
    expect(afterRelease.claim, "the claim event is untouched by a release").not.toBeNull();
    expect(afterRelease.claim?.operator_id).toBe(OPERATOR_A.id);
    expect(afterRelease.release, "a released state carries the recorded release event").not.toBeNull();
    expect(afterRelease.release?.coordination_id).toBe(coordinationId);
    expect(afterRelease.release?.operator_id).toBe(OPERATOR_A.id);
    expect(afterRelease.release?.operator_email).toBe(OPERATOR_A.email);
    expect(typeof afterRelease.release?.released_at).toBe("string");
  });

  it("lists ONE derived state per recorded claim — claimed until a release names it, then released", async () => {
    const orgId = crypto.randomUUID();
    // Three coordinations in one org; claim all three, then release exactly one.
    const one = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const two = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const three = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // Before any claim, the org has entered no coordination into the lifecycle — the list is empty.
    expect(await listCoordinationOwnershipStates({ org_id: orgId })).toEqual([]);

    expect((await claimConversationWork({ org_id: orgId, coordination_id: one.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: two.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: three.coordinationId, operator: OPERATOR_B })).resolution).toBe("claimed");

    // Release exactly ONE of the three.
    expect(
      (await releaseConversationWork({ org_id: orgId, coordination_id: two.coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("released");

    // The engine lists ONE state record per recorded claim — three in total, matched by coordination id.
    const states = await listCoordinationOwnershipStates({ org_id: orgId });
    expect(states).toHaveLength(3);
    const byId = new Map(states.map((s) => [s.coordinationId, s] as const));

    // The two still-held coordinations derive `claimed`; the released one derives `released` and carries its release.
    expect(byId.get(one.coordinationId)?.state).toBe("claimed");
    expect(byId.get(one.coordinationId)?.release).toBeNull();
    expect(byId.get(three.coordinationId)?.state).toBe("claimed");
    expect(byId.get(two.coordinationId)?.state).toBe("released");
    expect(byId.get(two.coordinationId)?.release, "the released record carries its release event").not.toBeNull();
    expect(byId.get(two.coordinationId)?.release?.operator_id).toBe(OPERATOR_A.id);

    // Every listed record carries the claim it was derived from.
    expect(states.every((s) => s.claim !== null)).toBe(true);
  });

  it("preserves ORGANISATION ISOLATION — org B never derives org A's ownership state", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

    // A records a claim AND a release under its own org — a full lifecycle in org A.
    expect((await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await releaseConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A })).resolution).toBe("released");

    // Org A derives the real state…
    const seenByA = await getCoordinationOwnershipState({ org_id: orgA, coordination_id: coordinationId });
    expect(seenByA.state).toBe("released");
    expect(seenByA.claim).not.toBeNull();
    expect(seenByA.release).not.toBeNull();

    // …but org B, naming the SAME coordination id, derives `unclaimed` — the org filter isolates BOTH ledger reads, so
    // B sees neither A's claim nor A's release.
    const seenByB = await getCoordinationOwnershipState({ org_id: orgB, coordination_id: coordinationId });
    expect(seenByB.state).toBe("unclaimed");
    expect(seenByB.claim).toBeNull();
    expect(seenByB.release).toBeNull();

    // And org B's org-wide list is empty — it never enumerates another org's coordinations.
    expect(await listCoordinationOwnershipStates({ org_id: orgB })).toEqual([]);
  });
});

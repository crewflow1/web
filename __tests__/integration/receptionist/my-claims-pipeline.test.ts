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
  getOwnershipHistory,
  getOwnershipSummary,
} from "@/server/services/receptionist-ownership-read-model";
import { projectMyClaims, type MyClaimsView } from "@/lib/receptionist/my-claims-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * MY CLAIMS LIST pipeline — real-Postgres proof of the AI Receptionist Programme R49 (MY CLAIMS LIST): the read-only,
 * viewer-relative list of the conversation worklist items the signed-in operator has claimed and now owns. R48 proved
 * (against a live database) that the canonical ownership read model reads BACK what the RUNTIME recorded. R49 is the
 * FIRST operator-facing surface over that read model, and the behaviour the mocks can't prove is its SERVER-SIDE DATA
 * PATH — the page's exact composition: the two R48 org-scoped seams (`getOwnershipHistory` + `getOwnershipSummary`)
 * read back over Postgres, then projected through the pure `projectMyClaims` for one viewer. This tier pins exactly
 * that composition over Postgres:
 *
 *   • BEFORE THE OPERATOR CLAIMS, MY CLAIMS IS EMPTY — a seeded-but-unclaimed org yields the viewer no rows, a zero
 *     count and a null latest instant.
 *   • AFTER THE RUNTIME RECORDS THE CLAIM, MY CLAIMS LISTS IT AS OWNED — exactly one row for the claimed coordination,
 *     status `owned`, with the claim timestamp and the authoritative per-owner tally (count + latest + email).
 *   • MY CLAIMS IS VIEWER-RELATIVE — with several operators claiming in one org, each viewer sees ONLY their own
 *     claims (newest-first), never another operator's; the count is the operator's authoritative summary tally.
 *   • ORGANISATION ISOLATION HOLDS — the SAME operator id, reading a different org, sees an EMPTY My Claims: the read
 *     model's mandatory org filter isolates ownership structurally, and the viewer filter narrows on top of it.
 *
 * The surface consumes ONLY the R48 read model here — it opens no client and reads no ledger; the claim is recorded
 * ONLY through the R46 runtime; the reads are org-scoped by the read model. Runs only against a live DB
 * (describeIntegration): skipped locally with no database, FAILED loudly in CI if the database is missing. The claim
 * ledger is append-only, so these tests intentionally leave their rows behind; each assertion uses a FRESH random org
 * id so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };
const OPERATOR_B: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-b@crewflow.uk" };

/** How many events the page fetches for the row list — mirrors the surface's MY_CLAIMS_ROW_LIMIT. */
const ROW_LIMIT = 200;

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

/**
 * Compose the viewer's My Claims view EXACTLY as the page does — the two R48 org-scoped seams read back over Postgres,
 * then the pure `projectMyClaims`. This is the surface's whole server-side data path; nothing else touches the DB.
 */
async function loadMyClaims(input: { orgId: string; operator: OperatorIdentity }): Promise<MyClaimsView> {
  const [events, summary] = await Promise.all([
    getOwnershipHistory({ org_id: input.orgId, limit: ROW_LIMIT }),
    getOwnershipSummary({ org_id: input.orgId }),
  ]);
  return projectMyClaims({
    operatorId: input.operator.id,
    operatorEmail: input.operator.email,
    events,
    summary,
  });
}

describeIntegration("My Claims List pipeline · the R48 seams projected for one viewer (R49)", () => {
  it("shows an EMPTY My Claims view before the operator claims anything", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    const view = await loadMyClaims({ orgId, operator: OPERATOR_A });
    expect(view.operatorId).toBe(OPERATOR_A.id);
    expect(view.rows).toEqual([]);
    expect(view.claimCount).toBe(0);
    expect(view.latestClaimAt).toBeNull();
    // With no tally for the viewer, the email falls back to the supplied identity.
    expect(view.operatorEmail).toBe(OPERATOR_A.email);
  });

  it("after the runtime records the operator's claim, My Claims lists exactly that claim as OWNED", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // The RUNTIME records the claim (exactly as the R47 surface's action would); My Claims reads it back.
    const claimed = await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(claimed.resolution).toBe("claimed");

    const view = await loadMyClaims({ orgId, operator: OPERATOR_A });
    expect(view.claimCount).toBe(1);
    expect(view.rows).toHaveLength(1);
    const [row] = view.rows;
    expect(row?.coordinationId).toBe(coordinationId);
    expect(row?.status).toBe("owned");
    expect(typeof row?.claimedAt).toBe("string");
    // The headline latest instant is the viewer's most recent claim, from the authoritative summary tally.
    expect(view.latestClaimAt).toBe(row?.claimedAt);
    // The authoritative email comes from the recorded claim's tally, not the fallback identity.
    expect(view.operatorEmail).toBe(OPERATOR_A.email);
  });

  it("is VIEWER-RELATIVE — each operator sees only their own claims, newest-first, never another's", async () => {
    const orgId = crypto.randomUUID();
    const one = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const two = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const three = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // A claims two; B claims one — all in the SAME org.
    expect((await claimConversationWork({ org_id: orgId, coordination_id: one.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: two.coordinationId, operator: OPERATOR_A })).resolution).toBe("claimed");
    expect((await claimConversationWork({ org_id: orgId, coordination_id: three.coordinationId, operator: OPERATOR_B })).resolution).toBe("claimed");

    // A's My Claims — exactly A's two coordinations, all owned, never B's.
    const viewA = await loadMyClaims({ orgId, operator: OPERATOR_A });
    expect(viewA.claimCount).toBe(2);
    expect(viewA.rows).toHaveLength(2);
    expect(new Set(viewA.rows.map((r) => r.coordinationId))).toEqual(
      new Set([one.coordinationId, two.coordinationId]),
    );
    expect(viewA.rows.every((r) => r.status === "owned")).toBe(true);
    expect(viewA.rows.some((r) => r.coordinationId === three.coordinationId)).toBe(false);
    // Newest-first: the rows are in non-increasing claim-instant order (robust to equal-instant tiebreaks).
    const instants = viewA.rows.map((r) => r.claimedAt);
    expect([...instants].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(instants);

    // B's My Claims — exactly B's one coordination; it never shows A's.
    const viewB = await loadMyClaims({ orgId, operator: OPERATOR_B });
    expect(viewB.claimCount).toBe(1);
    expect(viewB.rows.map((r) => r.coordinationId)).toEqual([three.coordinationId]);
    expect(viewB.rows.some((r) => r.coordinationId === one.coordinationId)).toBe(false);
    expect(viewB.rows.some((r) => r.coordinationId === two.coordinationId)).toBe(false);
  });

  it("preserves ORGANISATION ISOLATION — the same operator sees nothing in another org", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID() });

    const claimed = await claimConversationWork({ org_id: orgA, coordination_id: coordinationId, operator: OPERATOR_A });
    expect(claimed.resolution).toBe("claimed");

    // In org A, A owns the coordination…
    const viewInA = await loadMyClaims({ orgId: orgA, operator: OPERATOR_A });
    expect(viewInA.claimCount).toBe(1);
    expect(viewInA.rows.map((r) => r.coordinationId)).toEqual([coordinationId]);

    // …but the SAME operator id, reading org B, sees an EMPTY My Claims — the org filter isolates it structurally.
    const viewInB = await loadMyClaims({ orgId: orgB, operator: OPERATOR_A });
    expect(viewInB.claimCount).toBe(0);
    expect(viewInB.rows).toEqual([]);
    expect(viewInB.latestClaimAt).toBeNull();
  });
});

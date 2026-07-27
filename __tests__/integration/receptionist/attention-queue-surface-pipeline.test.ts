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
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation ATTENTION QUEUE SURFACE pipeline — real-Postgres proof of the AI Receptionist Programme R59 (CONVERSATION
 * ATTENTION QUEUE SURFACE): the operator-facing surface that reads the org's attention queue THROUGH the R58 runtime and
 * projects the display model with the R59 pure core — the EXACT composition the page performs, minus the HQ gate.
 *
 * The unit tier pins the pure projection over hand-built views. This tier proves the SURFACE DATA PATH end to end
 * against real Postgres — `getConversationAttentionQueue` (R58) composed with `projectAttentionQueueSurface` (R59) —
 * which is exactly what the page runs after resolving the org from the session:
 *
 *   (1) THE SURFACE PROJECTS THE RUNTIME'S GROUPED QUEUE FAITHFULLY — a mix of actionable coordinations (a subset
 *       CLAIMED through the R46 runtime) is read back as the two titled groups (unowned, owned) in presentation order;
 *       the surface's rows are EXACTLY the runtime view's entries, in the same order, and every raw fact (priority,
 *       mode, requires-human, ownership status, group) is passed through faithfully — humanised, never re-derived.
 *   (2) OWNERSHIP AND HUMAN-REQUIRED STATE ARE DISPLAYED, LIVE — a coordination shows as unowned until an operator
 *       claims it, then owned and attributed to the claimant; the surface re-reads the R48 record and derives nothing.
 *   (3) ORGANISATION ISOLATION IS PRESERVED — the surface is org-scoped through the runtime (R39 → R38 → R37 AND every
 *       R48 read), so one organisation can NEVER see another's queue, nor another org's claim.
 *   (4) THE EMPTY SURFACE — a fresh org yields both groups present and empty, total 0, and the empty summary.
 *
 * The surface consumes ONLY the R58 runtime + the R59 pure core — it opens no client, reads no ledger, derives no
 * worklist and decides no ownership; the claim is recorded ONLY through the R46 runtime. Runs only against a live DB
 * (describeIntegration). Each assertion seeds its own org (a fresh uuid) so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** An authenticated operator — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type RpcClient = { rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T> };
const svc = (): RpcClient => serviceClient() as unknown as RpcClient;

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
 *  from, R39 queries, R58 groups by ownership, and R59 projects for the operator. */
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

describeIntegration("Conversation Attention Queue SURFACE pipeline · runtime queue projected for the operator (R59)", () => {
  it("PROJECTS THE RUNTIME'S GROUPED QUEUE FAITHFULLY — titled groups, same rows + order, raw facts preserved (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const esc1 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const rem1 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const esc2 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const rem2 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // Claim a subset INTERLEAVED across priorities so faithful order-preservation is a STABLE partition, not a re-sort.
    for (const id of [esc1.coordinationId, rem2.coordinationId]) {
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: id, operator: OPERATOR_A })).resolution,
      ).toBe("claimed");
    }

    // The page's exact composition: read the runtime queue, then project the surface over it.
    const view = await getConversationAttentionQueue({ org_id: orgId });
    const surface = projectAttentionQueueSurface(view);

    // Both groups, in presentation order, titled + counted.
    expect(surface.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    expect(surface.groups.find((g) => g.group === "unowned")!.title).toBe("Waiting to be picked up");
    expect(surface.groups.find((g) => g.group === "owned")!.title).toBe("In progress");

    // The surface's rows are EXACTLY the runtime view's entries, in the same (grouped, canonical) order.
    expect(surface.rows.map((r) => r.coordinationId)).toEqual(view.entries.map((e) => e.coordination_id));
    expect(surface.total).toBe(view.total);
    expect(surface.total).toBe(4);
    expect(surface.unownedCount).toBe(2);
    expect(surface.ownedCount).toBe(2);
    for (const group of surface.groups) {
      expect(group.count).toBe(group.rows.length);
    }

    // Membership is exactly the four seeded coordinations.
    expect(new Set(surface.rows.map((r) => r.coordinationId))).toEqual(
      new Set([esc1.coordinationId, rem1.coordinationId, esc2.coordinationId, rem2.coordinationId]),
    );

    // Every raw fact is passed through from the runtime view FAITHFULLY — the surface humanises, it re-derives nothing.
    for (const [i, srow] of surface.rows.entries()) {
      const vrow = view.entries[i]!;
      expect(srow.coordinationId).toBe(vrow.coordination_id);
      expect(srow.group).toBe(vrow.group);
      expect(srow.priority).toBe(vrow.entry.priority);
      expect(srow.mode).toBe(vrow.entry.mode);
      expect(srow.requiresHuman).toBe(vrow.entry.requires_human);
      expect(srow.humanLabel).toBe(vrow.entry.requires_human ? "Required" : "Not required");
      expect(srow.ownershipStatus).toBe(vrow.ownership.status);
      expect(srow.ownershipLabel).toBe(vrow.ownership.owned ? "Owned" : "Unowned");
      // Humanised labels never leak snake_case to the display.
      expect(srow.priorityLabel).not.toMatch(/_/);
      expect(srow.modeLabel).not.toMatch(/_/);
    }
  });

  it("DISPLAYS OWNERSHIP AND HUMAN-REQUIRED STATE, LIVE — unowned until claimed, then owned + attributed (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true, // escalating → requires human attention
    });

    // Before any claim — the surface shows the coordination WAITING (unowned), with the waiting summary and no owner.
    const before = projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }));
    expect(before.total).toBe(1);
    const beforeRow = before.rows[0]!;
    expect(beforeRow.coordinationId).toBe(coordinationId);
    expect(beforeRow.group).toBe("unowned");
    expect(beforeRow.ownershipLabel).toBe("Unowned");
    expect(beforeRow.ownershipTone).toBe("unheld");
    expect(beforeRow.ownerLabel).toBeNull();
    expect(beforeRow.ownershipSummary).toBe("Waiting to be picked up — no operator holds this yet.");
    // The escalating coordination surfaces its human-required state.
    expect(beforeRow.requiresHuman).toBe(true);
    expect(beforeRow.humanLabel).toBe("Required");
    expect(beforeRow.humanTone).toBe("required");

    // The RUNTIME records an operator's claim (R46).
    expect(
      (await claimConversationWork({ org_id: orgId, coordination_id: coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("claimed");

    // The surface re-reads ownership LIVE — the SAME coordination is now IN PROGRESS, attributed to the claimant.
    const after = projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }));
    expect(after.total).toBe(1);
    const afterRow = after.rows[0]!;
    expect(afterRow.coordinationId).toBe(coordinationId);
    expect(afterRow.group).toBe("owned");
    expect(afterRow.ownershipLabel).toBe("Owned");
    expect(afterRow.ownershipTone).toBe("held");
    expect(afterRow.ownerLabel).toBe(OPERATOR_A.email);
    expect(afterRow.ownershipSummary).toBe(`Held by ${OPERATOR_A.email}.`);
    expect(afterRow.heldSince).not.toBe("—"); // a real held-since instant, formatted
  });

  it("ORGANISATION ISOLATION — one org's surface never shows another org's work or claim (demonstration 3)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    expect(
      (await claimConversationWork({ org_id: orgA, coordination_id: a.coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("claimed");

    const surfaceA = projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgA }));
    const surfaceB = projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgB }));

    // A's surface holds ONLY A's coordination (owned by A), never B's.
    expect(surfaceA.rows.map((r) => r.coordinationId)).toEqual([a.coordinationId]);
    expect(surfaceA.ownedCount).toBe(1);
    expect(surfaceA.rows[0]!.ownerLabel).toBe(OPERATOR_A.email);
    expect(surfaceA.rows.map((r) => r.coordinationId)).not.toContain(b.coordinationId);

    // B's surface holds ONLY B's coordination (unowned) — A's claim never leaks across the org boundary.
    expect(surfaceB.rows.map((r) => r.coordinationId)).toEqual([b.coordinationId]);
    expect(surfaceB.unownedCount).toBe(1);
    expect(surfaceB.rows[0]!.ownerLabel).toBeNull();
    expect(surfaceB.rows.map((r) => r.coordinationId)).not.toContain(a.coordinationId);
  });

  it("THE EMPTY SURFACE — a fresh org yields both groups present and empty, total 0, empty summary (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();
    const surface = projectAttentionQueueSurface(await getConversationAttentionQueue({ org_id: orgId }));
    expect(surface.rows).toEqual([]);
    expect(surface.total).toBe(0);
    expect(surface.isEmpty).toBe(true);
    expect(surface.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    expect(surface.groups.every((g) => g.count === 0 && g.rows.length === 0)).toBe(true);
    expect(surface.summaryLabel).toBe("No conversations need attention right now.");
  });
});

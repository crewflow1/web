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
import { queryOrgWorklist } from "@/server/services/receptionist-worklist-read-surface";
import { getConversationAttentionQueue } from "@/server/services/receptionist-attention-queue";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";
import type { OperatorIdentity } from "@/lib/receptionist/conversation-claim";

/**
 * Conversation ATTENTION QUEUE pipeline — real-Postgres proof of the AI Receptionist Programme R58 (CONVERSATION
 * ATTENTION QUEUE): the authorised, read-only queue that JOINS the org's actionable, already-prioritised worklist
 * (delivered through the R39 read surface, derived by the R38 engine) with each entry's ownership (delivered through
 * the R48 ownership read model), and GROUPS it by ownership — unowned first (waiting to be picked up), owned next (in
 * progress) — preserving the R38 canonical order within each group.
 *
 * The unit tier pins the pure JOIN / GROUP / STABLE-PARTITION over hand-built inputs. This tier proves the SERVER-SIDE
 * DATA PATH end to end against real Postgres — `getConversationAttentionQueue` composing the two authorised seams and
 * nothing else — which is exactly what the mocks cannot show:
 *
 *   (1) THE QUEUE GROUPS THE R39 BACKLOG BY OWNERSHIP — a mix of actionable coordinations, coordinated through the real
 *       R29→R36 stack and a subset CLAIMED through the R46 runtime, is read back as the two groups (unowned, owned) in
 *       presentation order; the queue is a STABLE PARTITION of the R39 prioritised page — unowned-first, owned-next —
 *       preserving the page's (R38 canonical) order within each group, and every entry / ownership fact is verbatim.
 *   (2) OWNERSHIP IS AUTHORITATIVE AND LIVE — a coordination is `unowned` until an operator claims it, then `owned`,
 *       attributed to the claimant; the queue re-reads the R48 read model and derives nothing itself.
 *   (3) MEMBERSHIP IS EXACTLY THE R39 PRIORITISED PAGE — the queue neither adds nor drops a coordination; a concluded
 *       (closed) coordination is NON-actionable, absent from the worklist and hence absent from the queue.
 *   (4) ORGANISATION ISOLATION IS PRESERVED — the queue is org-scoped through R39 → R38 → R37 AND through every R48
 *       read, so one organisation can NEVER read another's queue, nor see another org's claim.
 *   (5) THE EMPTY QUEUE — a fresh org with no coordinations yields both groups present and empty, total 0.
 *
 * The queue consumes ONLY the R39 and R48 read seams — it opens no client, reads no ledger, derives no worklist and
 * decides no ownership; the claim is recorded ONLY through the R46 runtime. Runs only against a live DB
 * (describeIntegration): skipped locally with no database, FAILED loudly in CI if the database is missing. Every ledger
 * exercised (R29→R36, R46) is append-only, so these tests leave their rows behind — harmless in the ephemeral CI
 * database. Each assertion seeds its own org (a fresh uuid) so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

/** Two distinct authenticated operators — the `user.id` (a uuid) + `user.email` the HQ gate would resolve. */
const OPERATOR_A: OperatorIdentity = { id: crypto.randomUUID(), email: "operator-a@crewflow.uk" };

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type RpcClient = { rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T> };
const svc = (): RpcClient => serviceClient() as unknown as RpcClient;

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags always match the
 *  deterministic fold. `allow`+live ⇒ pending (fulfillable, so coordinatable end to end). */
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads, R38 derives
 *  worklists from, R39 queries, and R58 groups by ownership. */
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

describeIntegration("Conversation Attention Queue pipeline · R39 worklist joined to R48 ownership (R58)", () => {
  it("GROUPS the R39 backlog by ownership — a STABLE partition (unowned first, owned next) preserving the R38 order (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const esc1 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const rem1 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });
    const esc2 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const rem2 = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // The R39 prioritised page is the GROUND-TRUTH R38 canonical order the queue must preserve within each group.
    const page = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    const pageOrder = page.items.map((e) => e.coordination_id);
    expect(new Set(pageOrder)).toEqual(
      new Set([esc1.coordinationId, rem1.coordinationId, esc2.coordinationId, rem2.coordinationId]),
    );

    // Claim a subset INTERLEAVED across priorities (one critical, one elevated) — so preserving the page order within
    // each group proves the partition is STABLE, not a re-sort.
    const toClaim = [esc1.coordinationId, rem2.coordinationId];
    for (const id of toClaim) {
      expect(
        (await claimConversationWork({ org_id: orgId, coordination_id: id, operator: OPERATOR_A })).resolution,
      ).toBe("claimed");
    }
    const claimed = new Set(toClaim);

    const queue = await getConversationAttentionQueue({ org_id: orgId });

    // Both groups, in presentation order.
    expect(queue.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);

    // The queue is a STABLE PARTITION of the R39 page by ownership: unowned-first (page order), owned-next (page order).
    const expectedUnowned = pageOrder.filter((id) => !claimed.has(id));
    const expectedOwned = pageOrder.filter((id) => claimed.has(id));
    const unownedGroup = queue.groups.find((g) => g.group === "unowned")!;
    const ownedGroup = queue.groups.find((g) => g.group === "owned")!;
    expect(unownedGroup.entries.map((e) => e.coordination_id)).toEqual(expectedUnowned);
    expect(ownedGroup.entries.map((e) => e.coordination_id)).toEqual(expectedOwned);
    expect(queue.entries.map((e) => e.coordination_id)).toEqual([...expectedUnowned, ...expectedOwned]);

    // Counts + total.
    expect(unownedGroup.count).toBe(expectedUnowned.length);
    expect(ownedGroup.count).toBe(expectedOwned.length);
    expect(queue.total).toBe(4);

    // VERBATIM passthrough — each `entry` is the R39 worklist entry, each `ownership` the R48 record; the queue adds
    // no fact, and the group is a pure relabelling of ownership.
    const pageById = new Map(page.items.map((e) => [e.coordination_id, e]));
    for (const row of queue.entries) {
      expect(row.entry).toEqual(pageById.get(row.coordination_id));
      expect(row.ownership.coordinationId).toBe(row.coordination_id);
      expect(row.ownership.owned).toBe(claimed.has(row.coordination_id));
      expect(row.group).toBe(claimed.has(row.coordination_id) ? "owned" : "unowned");
    }
  });

  it("OWNERSHIP IS AUTHORITATIVE AND LIVE — unowned until claimed, then owned and attributed to the claimant (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });

    // Before any claim — the coordination NEEDS ATTENTION and is UNOWNED (no operator holds it).
    const before = await getConversationAttentionQueue({ org_id: orgId });
    expect(before.total).toBe(1);
    expect(before.entries[0]?.coordination_id).toBe(coordinationId);
    expect(before.entries[0]?.group).toBe("unowned");
    expect(before.entries[0]?.ownership.owned).toBe(false);
    expect(before.entries[0]?.ownership.owner).toBeNull();
    expect(before.groups.find((g) => g.group === "owned")!.entries).toEqual([]);

    // The RUNTIME records an operator's claim (R46) — the ownership read model (R48) is now authoritative for it.
    const claim = await claimConversationWork({
      org_id: orgId,
      coordination_id: coordinationId,
      operator: OPERATOR_A,
    });
    expect(claim.resolution).toBe("claimed");

    // The queue re-reads ownership LIVE — the SAME coordination is now OWNED, attributed to the claimant; it derives
    // nothing itself, it reads the R48 record back.
    const after = await getConversationAttentionQueue({ org_id: orgId });
    expect(after.total).toBe(1);
    expect(after.entries[0]?.coordination_id).toBe(coordinationId);
    expect(after.entries[0]?.group).toBe("owned");
    expect(after.entries[0]?.ownership.owned).toBe(true);
    expect(after.entries[0]?.ownership.owner?.operatorId).toBe(OPERATOR_A.id);
    expect(after.entries[0]?.ownership.owner?.operatorEmail).toBe(OPERATOR_A.email);
    expect(typeof after.entries[0]?.ownership.claimedAt).toBe("string");
    expect(after.groups.find((g) => g.group === "unowned")!.entries).toEqual([]);
  });

  it("MEMBERSHIP IS EXACTLY THE R39 PRIORITISED PAGE — the concluded (closed) coordination is absent (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const concluded = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const remediating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });
    expect(concluded.lifecycleState).toBe("closed");

    const page = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    const queue = await getConversationAttentionQueue({ org_id: orgId });

    // The queue NEITHER ADDS NOR DROPS an entry — its membership is EXACTLY the R39 prioritised page (the Worklist
    // Engine's actionable set); the queue derives no conversation state of its own.
    expect(new Set(queue.entries.map((e) => e.coordination_id))).toEqual(
      new Set(page.items.map((e) => e.coordination_id)),
    );
    // The concluded (closed) coordination is NON-actionable — absent from the worklist, hence absent from the queue.
    expect(queue.entries.map((e) => e.coordination_id)).not.toContain(concluded.coordinationId);
    expect(queue.entries.map((e) => e.coordination_id)).toEqual(
      expect.arrayContaining([escalating.coordinationId, remediating.coordinationId]),
    );
    expect(queue.total).toBe(2);
    // Nothing claimed — every entry is unowned, the owned group is present but empty.
    expect(queue.groups.find((g) => g.group === "unowned")!.count).toBe(2);
    expect(queue.groups.find((g) => g.group === "owned")!.count).toBe(0);
    expect(queue.entries.every((e) => e.group === "unowned")).toBe(true);
  });

  it("ORGANISATION ISOLATION — one org's queue never surfaces another org's work or claim (demonstration 4)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    // A claims its own coordination; B leaves its coordination unclaimed.
    expect(
      (await claimConversationWork({ org_id: orgA, coordination_id: a.coordinationId, operator: OPERATOR_A }))
        .resolution,
    ).toBe("claimed");

    const queueA = await getConversationAttentionQueue({ org_id: orgA });
    const queueB = await getConversationAttentionQueue({ org_id: orgB });

    // A's queue holds ONLY A's coordination (owned), never B's.
    expect(queueA.entries.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(queueA.entries.every((e) => e.entry.org_id === orgA)).toBe(true);
    expect(queueA.entries.map((e) => e.coordination_id)).not.toContain(b.coordinationId);
    expect(queueA.groups.find((g) => g.group === "owned")!.count).toBe(1);

    // B's queue holds ONLY B's coordination (unowned), never A's — and A's claim never leaks across the org boundary.
    expect(queueB.entries.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(queueB.entries.every((e) => e.entry.org_id === orgB)).toBe(true);
    expect(queueB.entries.map((e) => e.coordination_id)).not.toContain(a.coordinationId);
    expect(queueB.groups.find((g) => g.group === "unowned")!.count).toBe(1);
    expect(queueB.entries[0]?.ownership.owned).toBe(false);
  });

  it("THE EMPTY QUEUE — a fresh org yields both groups present and empty, total 0 (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    const queue = await getConversationAttentionQueue({ org_id: orgId });
    expect(queue.entries).toEqual([]);
    expect(queue.total).toBe(0);
    expect(queue.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    expect(queue.groups.every((g) => g.count === 0)).toBe(true);
  });
});

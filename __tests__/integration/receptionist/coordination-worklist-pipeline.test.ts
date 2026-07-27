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
import { getCoordinationById } from "@/server/services/receptionist-coordination-view";
import {
  getCoordinationWorklists,
  getCoordinationWorklistsForConversation,
  getHumanReviewWorklist,
  getRecoveryWorklist,
  getEscalationWorklist,
  getPrioritisedWorklist,
} from "@/server/services/receptionist-coordination-worklist";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Coordination WORKLIST ENGINE — real-Postgres proof of the AI Receptionist Programme R38
 * (CONVERSATION COORDINATION WORKLIST ENGINE): a READ-ONLY derivation that GROUPS and PRIORITISES the
 * recorded coordinations the R37 Read Model surfaces, through the org-scoped worklist reader
 * (`server/services/receptionist-coordination-worklist.ts`).
 *
 * R37 shipped the Coordination Read Model — the single authorised query surface for recorded
 * coordination decisions. R38 derives worklists from those records: it reads them THROUGH the R37
 * reader (never a ledger, never the view) and derives, purely, the human-review / recovery / escalation
 * worklists and a unified priority-ordered backlog. The unit tier pins the pure priority derivation,
 * grouping and ordering; the security tier proves, as a matter of SOURCE, that the engine reads only
 * through R37, re-derives no coordination and opens no execution path. This tier proves the BEHAVIOUR
 * end to end against real Postgres:
 *
 *   (1) AN ESCALATION IS GROUPED AND PRIORITISED — a `divergentTrade` conversation, coordinated through
 *       the real R29→R36 stack into an `escalating`/`human_attention` plan, is derived onto BOTH the
 *       human-review AND the escalation worklists, at `critical` priority, with its lead / flag / mode
 *       surfaced VERBATIM from the record — and the entry carries the SAME R37 projection the Read Model
 *       returns (the Read Model stays authoritative; the engine re-derives nothing).
 *   (2) A REMEDIATION IS GROUPED ONTO RECOVERY ALONE — a `retained` conversation is derived onto the
 *       recovery worklist at `elevated` priority, and onto NEITHER human-review nor escalation.
 *   (3) A CONCLUDED CONVERSATION IS NON-ACTIONABLE — a `closed`/`finalising` conversation is on NO
 *       worklist, in NO backlog.
 *   (4) PRIORITY DRIVES THE BACKLOG, DETERMINISTICALLY — a mix of coordinations derives a `prioritised`
 *       backlog with the escalation (critical) ahead of the remediation (elevated) and the conclusion
 *       absent, and reading it twice yields an IDENTICAL order.
 *   (5) ORGANISATION ISOLATION IS PRESERVED — the worklist reader is org-scoped through R37, so one org
 *       can NEVER see another's coordinations in any worklist.
 *   (6) CONVERSATION SCOPING — the conversation-scoped reader derives worklists from only that
 *       conversation's coordinations.
 *   (7) THE PER-WORKLIST ACCESSORS AGREE WITH THE SET — the single-worklist readers return exactly the
 *       corresponding field of the full worklist set.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in
 * CI if the database is missing. Every ledger exercised (R29→R36) is append-only, so these tests leave
 * their rows behind — harmless in the ephemeral CI database. Each assertion seeds its own org (a fresh
 * uuid) so it sees only its own writes.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type RpcClient = { rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T> };
const svc = (): RpcClient => serviceClient() as unknown as RpcClient;

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags always match
 *  the deterministic fold. `allow`+live ⇒ pending (fulfillable, so coordinatable end to end). */
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads and
 *  R38 derives worklists from. */
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

describeIntegration("Conversation Coordination worklist engine · receptionist coordination worklists (R38)", () => {
  it("groups an ESCALATION onto human-review + escalation at critical priority, surfaced VERBATIM (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId, lifecycleState } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });
    expect(lifecycleState).toBe("escalated");

    const worklists = await getCoordinationWorklists({ org_id: orgId });

    // On BOTH the human-review AND the escalation worklists (overlapping projections)…
    expect(worklists.human_review.map((e) => e.coordination_id)).toEqual([coordinationId]);
    expect(worklists.escalation.map((e) => e.coordination_id)).toEqual([coordinationId]);
    // …NOT on the recovery worklist…
    expect(worklists.recovery.map((e) => e.coordination_id)).toEqual([]);
    // …and in the prioritised backlog.
    expect(worklists.prioritised.map((e) => e.coordination_id)).toEqual([coordinationId]);

    const entry = worklists.escalation[0];
    expect(entry, "the escalation entry is present").toBeTruthy();
    if (!entry) throw new Error("unreachable: asserted present");

    // DERIVED operational attributes.
    expect(entry.priority).toBe("critical");
    expect(entry.priority_rank).toBe(0);
    expect(entry.categories).toEqual(["human_review", "escalation"]);
    expect(entry.org_id).toBe(orgId);

    // SURFACED verbatim from the recorded decision (never recomputed).
    expect(entry.requires_human).toBe(true);
    expect(entry.mode).toBe("escalating");
    expect(entry.lead_participant).toBe("human_attention");
    expect(entry.requires_human).toBe(entry.record.decision.requires_human);
    expect(entry.mode).toBe(entry.record.decision.mode);
    expect(entry.lead_participant).toBe(entry.record.decision.lead_participant);

    // THE READ MODEL STAYS AUTHORITATIVE — the entry carries the SAME projection R37 returns.
    const fromReadModel = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
    expect(fromReadModel, "the coordination resolves through the R37 reader").not.toBeNull();
    expect(entry.record.decision).toEqual(fromReadModel?.decision);
    expect(entry.record.context).toEqual(fromReadModel?.context);
  });

  it("groups a REMEDIATION onto recovery ALONE at elevated priority (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId, lifecycleState } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });
    expect(lifecycleState).toBe("retained");

    const worklists = await getCoordinationWorklists({ org_id: orgId });

    expect(worklists.recovery.map((e) => e.coordination_id)).toEqual([coordinationId]);
    expect(worklists.human_review.map((e) => e.coordination_id)).toEqual([]);
    expect(worklists.escalation.map((e) => e.coordination_id)).toEqual([]);
    expect(worklists.prioritised.map((e) => e.coordination_id)).toEqual([coordinationId]);

    const entry = worklists.recovery[0];
    if (!entry) throw new Error("unreachable: asserted present");
    expect(entry.priority).toBe("elevated");
    expect(entry.priority_rank).toBe(1);
    expect(entry.categories).toEqual(["recovery"]);
    expect(entry.mode).toBe("remediating");
    expect(entry.lead_participant).toBe("recovery_handling");
    expect(entry.requires_human).toBe(false);
  });

  it("treats a CONCLUDED conversation as non-actionable — on no worklist (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId, lifecycleState } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
    });
    expect(lifecycleState).toBe("closed");

    const worklists = await getCoordinationWorklists({ org_id: orgId });

    // A finalising / concluded coordination needs no attention — it appears nowhere.
    expect(worklists.human_review).toEqual([]);
    expect(worklists.recovery).toEqual([]);
    expect(worklists.escalation).toEqual([]);
    expect(worklists.prioritised).toEqual([]);
    // …though the coordination itself is still readable through the R37 Read Model.
    const fromReadModel = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
    expect(fromReadModel?.decision.mode).toBe("finalising");
  });

  it("priority drives the backlog, DETERMINISTICALLY — escalation before recovery, conclusion absent (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();

    // Seed a concluded, then a retained, then an escalated coordination (escalation is NEWEST).
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
    expect(remediating.lifecycleState).toBe("retained");
    expect(escalating.lifecycleState).toBe("escalated");

    const worklists = await getCoordinationWorklists({ org_id: orgId });

    // The prioritised backlog: critical (escalation) first, then elevated (recovery); the concluded
    // coordination is non-actionable and absent.
    expect(worklists.prioritised.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
    expect(worklists.prioritised.map((e) => e.priority)).toEqual(["critical", "elevated"]);
    expect(worklists.prioritised.map((e) => e.coordination_id)).not.toContain(concluded.coordinationId);

    // Reading the backlog again yields an IDENTICAL order (determinism against live data).
    const again = await getPrioritisedWorklist({ org_id: orgId });
    expect(again.map((e) => e.coordination_id)).toEqual(
      worklists.prioritised.map((e) => e.coordination_id),
    );
  });

  it("ORGANISATION ISOLATION — one org's worklists never surface another org's coordination (demonstration 5)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();

    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const worklistsA = await getCoordinationWorklists({ org_id: orgA });
    const worklistsB = await getCoordinationWorklists({ org_id: orgB });

    // Org A sees only its escalation; org B sees only its remediation.
    expect(worklistsA.prioritised.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(worklistsA.escalation.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(worklistsA.prioritised.every((e) => e.org_id === orgA)).toBe(true);

    expect(worklistsB.prioritised.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(worklistsB.recovery.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(worklistsB.prioritised.every((e) => e.org_id === orgB)).toBe(true);

    // Neither org's backlog contains the other's coordination.
    expect(worklistsA.prioritised.map((e) => e.coordination_id)).not.toContain(b.coordinationId);
    expect(worklistsB.prioritised.map((e) => e.coordination_id)).not.toContain(a.coordinationId);
  });

  it("conversation-scoped worklists derive from only that conversation's coordinations (demonstration 6)", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
      conversationId,
    });

    const forConversation = await getCoordinationWorklistsForConversation({
      org_id: orgId,
      conversation_id: conversationId,
    });
    expect(forConversation.escalation.map((e) => e.coordination_id)).toEqual([coordinationId]);
    expect(forConversation.prioritised.map((e) => e.coordination_id)).toEqual([coordinationId]);

    // A different conversation in the same org derives empty worklists.
    const other = await getCoordinationWorklistsForConversation({
      org_id: orgId,
      conversation_id: crypto.randomUUID(),
    });
    expect(other).toEqual({ human_review: [], recovery: [], escalation: [], prioritised: [] });
  });

  it("the per-worklist accessors return exactly the corresponding field of the full set (demonstration 7)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const set = await getCoordinationWorklists({ org_id: orgId });
    const [humanReview, recovery, escalation, prioritised] = await Promise.all([
      getHumanReviewWorklist({ org_id: orgId }),
      getRecoveryWorklist({ org_id: orgId }),
      getEscalationWorklist({ org_id: orgId }),
      getPrioritisedWorklist({ org_id: orgId }),
    ]);

    expect(humanReview.map((e) => e.coordination_id)).toEqual(set.human_review.map((e) => e.coordination_id));
    expect(recovery.map((e) => e.coordination_id)).toEqual(set.recovery.map((e) => e.coordination_id));
    expect(escalation.map((e) => e.coordination_id)).toEqual(set.escalation.map((e) => e.coordination_id));
    expect(prioritised.map((e) => e.coordination_id)).toEqual(set.prioritised.map((e) => e.coordination_id));
  });
});

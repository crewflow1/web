import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { coordinateConversationLifecycle } from "@/server/services/receptionist-coordination";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import {
  getCoordinationById,
  getCoordinationByOrchestration,
  listCoordinations,
  listCoordinationsForConversation,
} from "@/server/services/receptionist-coordination-view";
import type { CoordinationRecord } from "@/lib/receptionist/conversation-coordination-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Coordination READ MODEL — real-Postgres proof of the AI Receptionist Programme R37
 * (CONVERSATION COORDINATION READ MODEL), the FIRST CONSUMER of a recorded decision: a READ-ONLY
 * projection over the R36 `receptionist_conversation_coordinations` ledger and its six sibling
 * ledgers, surfaced through the `public.receptionist_coordination_read_model` view and the
 * org-scoped reader (`server/services/receptionist-coordination-view.ts`).
 *
 * R36 built the Coordination Engine — a pure core that COORDINATES a routed R35 orchestration into a
 * participation plan (mode / lead participant / requires-human / autonomous) and a runtime that files
 * ONE idempotent coordination row. R37 reads those recorded decisions back: the canonical, single,
 * authorised query surface for coordination decisions. The unit tier pins the pure PROJECTION (the
 * flat view row → the grouped record) and the single canonical ORDER; the security tier proves, as a
 * matter of SOURCE, that the migration is a projection with no write path, that it re-derives no
 * decision, and that it opens no execution path. This tier proves the BEHAVIOUR the others can't —
 * that when the view and reader actually run against Postgres the directive's guarantees hold end to
 * end:
 *
 *   (1) THE RECORDED DECISION IS SURFACED VERBATIM — a `closed` conversation, coordinated through the
 *       real R29→R36 stack into a `finalising`/`conversation_conclusion` plan, reads back through
 *       `getCoordinationByOrchestration` with its recorded mode / lead / plan / flags / route /
 *       lifecycle-state EXACTLY as the Coordination Engine recorded them (field-for-field equal to the
 *       engine's own returned handle) — the reader re-derives NOTHING, so the engine stays
 *       authoritative.
 *   (2) THE LINKED CONTEXT IS RESOLVED AT READ TIME — the same record carries its linked orchestration
 *       (R35), lifecycle (R34), resolution (R33), recovery (R32), verification (R31) and fulfilment
 *       (R30) context, each resolved BY REFERENCE from its own ledger (matching status sentinel +
 *       recorded verdict), so Lifecycle, Resolution and Recovery stay authoritative — the read model
 *       exposes what they recorded, it never re-governs, re-resolves or re-recovers.
 *   (3) FULFILMENT IS A LEGITIMATE ABSENCE — a `retained` coordination (the operation went unrecorded)
 *       reads back with a NULL fulfilment context and the other five contexts resolved, never dropped.
 *   (4) AN ESCALATION SURFACES ITS PLAN AND ITS EXPECTED BOOKING — an `escalated` coordination reads
 *       back `escalating`/`human_attention`, `requires_human` = true, and the EXPECTED (not the
 *       divergent recorded) booking.
 *   (5) THE INDEX IS DETERMINISTIC — `listCoordinations` returns an org's coordinations newest-first.
 *   (6) ORGANISATION ISOLATION IS PRESERVED — every reader is org-scoped, so one org can NEVER read
 *       another's coordination (not by list, not by id, not by orchestration, not by conversation).
 *   (7) CONVERSATION SCOPING — `listCoordinationsForConversation` returns only that conversation's
 *       coordinations.
 *
 * And the read-only invariant the migration promises: the view is NOT writable — an UPDATE / DELETE /
 * INSERT through `receptionist_coordination_read_model` is rejected by Postgres itself (a
 * seven-relation join is not auto-updatable and no INSTEAD OF trigger exists), and it is readable ONLY
 * by service_role (SELECT revoked from anon; base-table RLS denies JWT clients through the
 * security_invoker view). The read model can observe the coordination ledger and its siblings; it can
 * never mutate them, and it opens no new write or execution path.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly
 * in CI if the database is missing. All eight receptionist ledgers exercised here (R29→R36) are
 * append-only, so these tests intentionally leave their rows behind — harmless in the ephemeral CI
 * database. Each assertion seeds its own org (a fresh uuid) so it sees only its own writes.
 */

// The coordination read-model view is a service-role-only internal, NOT in the generated Database
// types. Cast to the minimal surface this suite exercises (the same `as unknown as` convention the
// ledger + R9 read-model suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Filterable<T> };
type ViewTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Filterable<null>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ViewClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ViewTable;
};

const VIEW = "receptionist_coordination_read_model";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): ViewClient => serviceClient() as unknown as ViewClient;
const anon = (): ViewClient => anonClient() as unknown as ViewClient;

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the state + flags ALWAYS match
 * the deterministic fold of the eligibility they are recorded with. `allow`+live ⇒ pending
 * (fulfillable, so coordinatable end to end); `block` ⇒ foreclosed (never coordinatable).
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

/** Denial is valid whether it arrives as a privilege error or an RLS-filtered empty set. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
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
  enquiryId?: string;
  leadId?: string;
  actionId?: string;
  executionId?: string;
  correlationId?: string;
}): Promise<{ lifecycleId: string; lifecycleState: string }> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: opts.conversationId ?? crypto.randomUUID(),
    enquiry_id: opts.enquiryId,
    lead_id: opts.leadId,
    customer_ref: CALLER,
    correlation_id: opts.correlationId ?? crypto.randomUUID(),
    action_id: opts.actionId,
    execution_id: opts.executionId,
    review_audit_id: opts.reviewAuditId,
    decision: authorise("allow", true),
  });
  expect(seeded?.state).toBe("pending");

  if (opts.divergentTrade) {
    // A DIVERGENT recorded fulfilment (a different trade than the authorisation carries) → R31
    // inconsistent → R32 reconcile → R33 unresolved → R34 escalate/escalated.
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
    // The matching fulfilment → R31 consistent → R32 none → R33 terminal → R34 close/closed.
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

/** Drive R29→R35: govern the lifecycle, then ROUTE it through the real `orchestrateConversationLifecycle`. */
async function orchestrateThroughStack(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
  enquiryId?: string;
  leadId?: string;
  actionId?: string;
  executionId?: string;
  correlationId?: string;
}): Promise<{ orchestrationId: string; lifecycleId: string; lifecycleState: string; orchestrationRoute: string }> {
  const { lifecycleId, lifecycleState } = await governThroughStack(opts);
  const orchestrated = await orchestrateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(orchestrated, "the governed lifecycle's response was orchestrated").not.toBeNull();
  if (!orchestrated) throw new Error("test setup: expected an orchestration");
  return {
    orchestrationId: orchestrated.orchestration_id,
    lifecycleId,
    lifecycleState,
    orchestrationRoute: orchestrated.orchestration_route,
  };
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads back. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
  conversationId?: string;
  enquiryId?: string;
  leadId?: string;
  actionId?: string;
  executionId?: string;
  correlationId?: string;
}): Promise<{
  coordinationId: string;
  orchestrationId: string;
  lifecycleId: string;
  lifecycleState: string;
  orchestrationRoute: string;
  coordinated: NonNullable<Awaited<ReturnType<typeof coordinateConversationLifecycle>>>;
}> {
  const { orchestrationId, lifecycleId, lifecycleState, orchestrationRoute } = await orchestrateThroughStack(opts);
  const coordinated = await coordinateConversationLifecycle({
    org_id: opts.orgId,
    review_audit_id: opts.reviewAuditId,
    sent_audit_id: crypto.randomUUID(),
    review_resolution_id: crypto.randomUUID(),
  });
  expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
  if (!coordinated) throw new Error("test setup: expected a coordination to be filed");
  return {
    coordinationId: coordinated.coordination_id,
    orchestrationId,
    lifecycleId,
    lifecycleState,
    orchestrationRoute,
    coordinated,
  };
}

/** Read one coordination back through the org-scoped reader, keyed by its orchestration, or throw. */
async function readByOrchestration(orgId: string, orchestrationId: string): Promise<CoordinationRecord> {
  const rec = await getCoordinationByOrchestration({ org_id: orgId, orchestration_id: orchestrationId });
  if (!rec) throw new Error(`expected a coordination record for orchestration ${orchestrationId}`);
  return rec;
}

describeIntegration("Conversation Coordination read model · receptionist_coordination_read_model (R37)", () => {
  it("surfaces the RECORDED `closed` decision VERBATIM and resolves all SIX linked contexts (demonstrations 1 + 2)", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const enquiryId = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const reviewAuditId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    const { coordinationId, orchestrationId, lifecycleId, lifecycleState, orchestrationRoute, coordinated } =
      await seedCoordination({
        orgId,
        reviewAuditId,
        conversationId,
        enquiryId,
        leadId,
        actionId,
        executionId,
        correlationId,
      });
    expect(lifecycleState).toBe("closed");
    expect(orchestrationRoute).toBe("conclude");

    const rec = await readByOrchestration(orgId, orchestrationId);

    // Identity + scoping anchors.
    expect(rec.coordination_id).toBe(coordinationId);
    expect(rec.org_id).toBe(orgId);
    expect(rec.conversation_id).toBe(conversationId);
    expect(rec.correlation_id).toBe(correlationId);

    // THE RECORDED DECISION — surfaced VERBATIM. Every field equals what the Coordination Engine
    // itself returned (the reader re-derives NOTHING; the engine stays authoritative).
    expect(rec.decision.type).toBe("coordinate_lifecycle_response");
    expect(rec.decision.outcome).toBe("conversation_response_coordinated");
    expect(rec.decision.mode).toBe("finalising");
    expect(rec.decision.mode).toBe(coordinated.coordination_mode);
    expect(rec.decision.lead_participant).toBe("conversation_conclusion");
    expect(rec.decision.lead_participant).toBe(coordinated.lead_participant);
    expect(rec.decision.participant_count).toBe(1);
    expect(rec.decision.participant_count).toBe(coordinated.participant_count);
    expect(rec.decision.requires_human).toBe(false);
    expect(rec.decision.requires_human).toBe(coordinated.requires_human);
    expect(rec.decision.autonomous).toBe(true);
    expect(rec.decision.autonomous).toBe(coordinated.autonomous);
    expect(rec.decision.orchestration_route).toBe("conclude");
    expect(rec.decision.orchestration_route).toBe(coordinated.orchestration_route);
    expect(rec.decision.lifecycle_state).toBe("closed");
    expect(rec.decision.lifecycle_state).toBe(coordinated.lifecycle_state);
    expect(rec.decision.approval_state).toBe("approved");
    expect(rec.decision.status).toBe("coordinated");

    // The EXPECTED booking, carried through.
    expect(rec.booking.job_type).toBe(JOB);
    expect(rec.booking.postcode).toBe(POSTCODE);
    expect(rec.booking.phone_number).toBe(PHONE);

    // LINKED ORCHESTRATION context (R35) — resolved by reference to the routed disposition.
    const orch = rec.context.orchestration;
    expect(orch, "orchestration context resolved").not.toBeNull();
    expect(orch?.orchestration_id).toBe(orchestrationId);
    expect(orch?.status).toBe("orchestrated");
    expect(orch?.type).toBeTruthy();
    expect(orch?.outcome).toBeTruthy();
    expect(orch?.target).toBe("conversation_conclusion");
    expect(orch?.concluded).toBe(true);
    expect(orch?.active).toBe(false);

    // LINKED LIFECYCLE context (R34) — the governed transition.
    const life = rec.context.lifecycle;
    expect(life, "lifecycle context resolved").not.toBeNull();
    expect(life?.lifecycle_id).toBe(lifecycleId);
    expect(life?.status).toBe("governed");
    expect(life?.closed).toBe(true);
    expect(life?.ongoing).toBe(false);
    expect(life?.transition).toBeTruthy();

    // LINKED RESOLUTION context (R33) — the terminal completion state.
    const resn = rec.context.resolution;
    expect(resn, "resolution context resolved").not.toBeNull();
    expect(resn?.status).toBe("determined");
    expect(resn?.terminal).toBe(true);
    expect(resn?.recovery_classification).toBe("none");

    // LINKED RECOVERY context (R32) — the `none` classification a clean verdict yields.
    const rcov = rec.context.recovery;
    expect(rcov, "recovery context resolved").not.toBeNull();
    expect(rcov?.status).toBe("determined");
    expect(rcov?.classification).toBe("none");

    // LINKED VERIFICATION context (R31) — the `consistent` integrity verdict.
    const veri = rec.context.verification;
    expect(veri, "verification context resolved").not.toBeNull();
    expect(veri?.status).toBe("verified");
    expect(veri?.integrity).toBe("consistent");

    // LINKED FULFILMENT context (R30) — the performed booking (present on a closed conversation).
    const ful = rec.context.fulfilment;
    expect(ful, "fulfilment context resolved").not.toBeNull();
    expect(ful?.status).toBe("fulfilled");
    expect(ful?.fulfilment_id).toBeTruthy();
    expect(ful?.fulfilment_id).toBe(rec.provenance.fulfilment_id);

    // PROVENANCE — the coordination threads back to every ledger it was coordinated from.
    expect(rec.provenance.orchestration_id).toBe(orchestrationId);
    expect(rec.provenance.lifecycle_id).toBe(lifecycleId);
    expect(rec.provenance.review_audit_id).toBe(reviewAuditId);
    expect(rec.provenance.fulfilment_id).not.toBeNull();
    expect(rec.provenance.action_id).toBe(actionId);
    expect(rec.provenance.execution_id).toBe(executionId);
  });

  it("resolves a `retained` coordination with a NULL fulfilment context and the other five present (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const reviewAuditId = crypto.randomUUID();
    const { orchestrationId, lifecycleState, orchestrationRoute } = await seedCoordination({
      orgId,
      reviewAuditId,
      performFulfilment: false,
    });
    expect(lifecycleState).toBe("retained");
    expect(orchestrationRoute).toBe("recover");

    const rec = await readByOrchestration(orgId, orchestrationId);

    // The remediating plan, verbatim.
    expect(rec.decision.mode).toBe("remediating");
    expect(rec.decision.lead_participant).toBe("recovery_handling");
    expect(rec.decision.requires_human).toBe(false);
    expect(rec.decision.autonomous).toBe(true);
    expect(rec.decision.orchestration_route).toBe("recover");
    expect(rec.decision.lifecycle_state).toBe("retained");

    // THE KEY ABSENCE — a `retained` coordination legitimately has NO fulfilment; the context is NULL,
    // not dropped, not fabricated.
    expect(rec.context.fulfilment, "fulfilment context is null when retained").toBeNull();
    expect(rec.provenance.fulfilment_id, "no fulfilment id when retained").toBeNull();

    // …while the other five contexts are all resolved from their own ledgers.
    expect(rec.context.orchestration?.status).toBe("orchestrated");
    expect(rec.context.orchestration?.target).toBe("recovery_handling");
    expect(rec.context.orchestration?.concluded).toBe(false);
    expect(rec.context.orchestration?.active).toBe(true);
    expect(rec.context.lifecycle?.status).toBe("governed");
    expect(rec.context.lifecycle?.closed).toBe(false);
    expect(rec.context.lifecycle?.ongoing).toBe(true);
    expect(rec.context.resolution?.status).toBe("determined");
    expect(rec.context.resolution?.terminal).toBe(false);
    expect(rec.context.resolution?.recovery_classification).toBe("reinstate");
    expect(rec.context.recovery?.status).toBe("determined");
    expect(rec.context.recovery?.classification).toBe("reinstate");
    expect(rec.context.verification?.status).toBe("verified");
    expect(rec.context.verification?.integrity).toBe("missing");
  });

  it("resolves an `escalated` coordination — escalating/human_attention, requires_human, and the EXPECTED booking (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();
    const reviewAuditId = crypto.randomUUID();
    const { orchestrationId, lifecycleState, orchestrationRoute } = await seedCoordination({
      orgId,
      reviewAuditId,
      divergentTrade: true,
    });
    expect(lifecycleState).toBe("escalated");
    expect(orchestrationRoute).toBe("escalate");

    const rec = await readByOrchestration(orgId, orchestrationId);

    expect(rec.decision.mode).toBe("escalating");
    expect(rec.decision.lead_participant).toBe("human_attention");
    expect(rec.decision.requires_human).toBe(true);
    expect(rec.decision.autonomous).toBe(false);
    expect(rec.decision.orchestration_route).toBe("escalate");
    expect(rec.decision.lifecycle_state).toBe("escalated");

    // The read model surfaces the EXPECTED payload (the decision's plumbing), NOT the divergent
    // recorded electrical trade — the ledger never recorded the divergence as the expectation.
    expect(rec.booking.job_type).toBe(JOB);

    // The escalation is coordinated from a PRESENT (divergent) record — fulfilment context resolved.
    expect(rec.context.fulfilment, "an escalation still has a recorded fulfilment").not.toBeNull();
    expect(rec.context.fulfilment?.status).toBe("fulfilled");
    expect(rec.context.orchestration?.status).toBe("orchestrated");
    expect(rec.context.orchestration?.target).toBe("human_attention");
    // The integrity verdict that drove the escalation, resolved from the verification ledger.
    expect(rec.context.verification?.status).toBe("verified");
    expect(rec.context.verification?.integrity).toBe("inconsistent");
    expect(rec.context.recovery?.status).toBe("determined");
    expect(rec.context.recovery?.classification).toBe("reconcile");
    expect(rec.context.resolution?.status).toBe("determined");
    expect(rec.context.resolution?.terminal).toBe(false);
    expect(rec.context.resolution?.recovery_classification).toBe("reconcile");
  });

  it("getCoordinationById resolves the recorded coordination; a foreign id resolves to null", async () => {
    const orgId = crypto.randomUUID();
    const reviewAuditId = crypto.randomUUID();
    const { coordinationId, coordinated } = await seedCoordination({ orgId, reviewAuditId });

    const rec = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
    expect(rec, "the coordination resolves by its ledger id").not.toBeNull();
    expect(rec?.coordination_id).toBe(coordinationId);
    expect(rec?.decision.mode).toBe(coordinated.coordination_mode);
    expect(rec?.decision.lead_participant).toBe(coordinated.lead_participant);

    // A coordination id that does not exist in this org resolves to null (never throws).
    const missing = await getCoordinationById({ org_id: orgId, coordination_id: crypto.randomUUID() });
    expect(missing).toBeNull();
  });

  it("listCoordinations returns the org's coordinations newest-first (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();

    // Seed THREE coordinations in one fresh org, in order (c1 oldest … c3 newest).
    const first = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });
    const second = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });
    const third = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });
    const seededIds = [first.coordinationId, second.coordinationId, third.coordinationId];

    const list = await listCoordinations({ org_id: orgId });

    // The fresh org has EXACTLY these three, and the reader surfaced every one of them.
    expect(list).toHaveLength(3);
    expect(list.every((r) => r.org_id === orgId)).toBe(true);
    expect([...list.map((r) => r.coordination_id)].sort()).toEqual([...seededIds].sort());

    // NEWEST-FIRST — the canonical order the reader applies: coordination_at non-increasing down the list.
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (!prev || !curr) throw new Error("unreachable: bounded index");
      expect(Date.parse(prev.decision.at)).toBeGreaterThanOrEqual(Date.parse(curr.decision.at));
    }
    // The newest seeded coordination leads the index.
    expect(list[0]?.coordination_id).toBe(third.coordinationId);
  });

  it("ORGANISATION ISOLATION — one org's readers never surface another org's coordination (demonstration 6)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const conversationA = crypto.randomUUID();

    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), conversationId: conversationA });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID() });

    // Each org reads ONLY its own — the list is org-scoped both directions.
    const listA = await listCoordinations({ org_id: orgA });
    const listB = await listCoordinations({ org_id: orgB });
    expect(listA.map((r) => r.coordination_id)).toEqual([a.coordinationId]);
    expect(listB.map((r) => r.coordination_id)).toEqual([b.coordinationId]);
    expect(listA.every((r) => r.org_id === orgA)).toBe(true);
    expect(listB.every((r) => r.org_id === orgB)).toBe(true);

    // Org B can NEVER resolve org A's coordination — not by orchestration, not by id, not by
    // conversation — even though it holds A's real ids.
    expect(await getCoordinationByOrchestration({ org_id: orgB, orchestration_id: a.orchestrationId })).toBeNull();
    expect(await getCoordinationById({ org_id: orgB, coordination_id: a.coordinationId })).toBeNull();
    expect(await listCoordinationsForConversation({ org_id: orgB, conversation_id: conversationA })).toEqual([]);

    // …and org A CAN resolve its own (a positive control, so the nulls above are isolation, not absence).
    expect(await getCoordinationByOrchestration({ org_id: orgA, orchestration_id: a.orchestrationId })).not.toBeNull();
    expect(await getCoordinationById({ org_id: orgA, coordination_id: a.coordinationId })).not.toBeNull();
  });

  it("listCoordinationsForConversation is conversation-scoped (demonstration 7)", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), conversationId });

    const forConversation = await listCoordinationsForConversation({ org_id: orgId, conversation_id: conversationId });
    expect(forConversation.map((r) => r.coordination_id)).toEqual([coordinationId]);
    expect(forConversation[0]?.conversation_id).toBe(conversationId);

    // A different conversation in the same org surfaces nothing.
    const other = await listCoordinationsForConversation({ org_id: orgId, conversation_id: crypto.randomUUID() });
    expect(other).toEqual([]);
  });

  it("is NOT WRITABLE — UPDATE / DELETE / INSERT through the view are rejected, the ledger untouched", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId, orchestrationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // A seven-relation join view is not auto-updatable and has no INSTEAD OF trigger, so Postgres
    // itself refuses every write verb through it — the read model can never mutate the ledger.
    const updated = await svc()
      .from(VIEW)
      .update({ coordination_mode: "escalating" })
      .eq("coordination_id", coordinationId);
    expect(updated.error, "UPDATE through the view must be rejected").not.toBeNull();

    const deleted = await svc().from(VIEW).delete().eq("coordination_id", coordinationId);
    expect(deleted.error, "DELETE through the view must be rejected").not.toBeNull();

    const inserted = await svc().from(VIEW).insert({
      coordination_id: crypto.randomUUID(),
      org_id: orgId,
      coordination_mode: "finalising",
    });
    expect(inserted.error, "INSERT through the view must be rejected").not.toBeNull();

    // The underlying coordination is untouched — the recorded `finalising` decision still reads back.
    const rec = await readByOrchestration(orgId, orchestrationId);
    expect(rec.coordination_id).toBe(coordinationId);
    expect(rec.decision.mode).toBe("finalising");
  });

  it("is READABLE ONLY by service_role — anon reads nothing through the view", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID() });

    // service_role (the HQ admin client) sees the coordination…
    const asService = await svc().from(VIEW).select("coordination_id").eq("org_id", orgId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data?.map((r) => r.coordination_id)).toEqual([coordinationId]);

    // …anon does not: SELECT is revoked from anon on the view, and the base-table RLS (enabled, zero
    // policies) denies it through the security_invoker view regardless.
    expectAnonDenied(await anon().from(VIEW).select("coordination_id").eq("org_id", orgId));
  });
});

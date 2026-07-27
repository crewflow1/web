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
import { getCoordinationWorklists } from "@/server/services/receptionist-coordination-worklist";
import {
  queryOrgWorklist,
  queryConversationWorklist,
} from "@/server/services/receptionist-worklist-read-surface";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Worklist READ SURFACE — real-Postgres proof of the AI Receptionist Programme R39
 * (CONVERSATION WORKLIST READ SURFACE): a READ-ONLY query over the worklists the R38 engine DERIVES,
 * through the org-scoped read-surface runtime (`server/services/receptionist-worklist-read-surface.ts`).
 *
 * R38 shipped the Worklist Engine — it derives the three directed worklists and the prioritised backlog
 * from the coordinations the R37 Read Model records. R39 QUERIES those worklists: it reads the derived
 * set THROUGH the R38 engine (never a ledger, never a view), selects a worklist, filters it and returns a
 * bounded, stably-ordered page. The unit tier pins the pure selection / filtering / pagination; the
 * security tier proves, as a matter of SOURCE, that the surface reads only through R38, re-derives no
 * worklist and opens no execution path. This tier proves the BEHAVIOUR end to end against real Postgres:
 *
 *   (1) THE PRIORITISED PAGE READS THE R38 BACKLOG VERBATIM — a mix of coordinations, coordinated through
 *       the real R29→R36 stack, is read back as a prioritised page whose entries ARE the engine's
 *       (critical before elevated, the conclusion absent) — the Worklist Engine stays authoritative.
 *   (2) FILTERING NARROWS THE PAGE — a priority filter returns only the escalation; a mode filter returns
 *       only the remediation.
 *   (3) PAGINATION BOUNDS THE BACKLOG — reading it one entry at a time yields the whole backlog across
 *       pages, with `has_more` / `total` reported correctly.
 *   (4) THE PAGE IS STABLY ORDERED, DETERMINISTICALLY — reading the same page twice yields an IDENTICAL
 *       result.
 *   (5) THE FOUR REQUIRED WORKLISTS ARE EXPOSED — human-review / recovery / escalation / prioritised each
 *       return the expected coordination.
 *   (6) ORGANISATION ISOLATION IS PRESERVED — the surface is org-scoped through R38 → R37, so one org can
 *       NEVER read another's worklist page.
 *   (7) CONVERSATION SCOPING — the conversation-scoped surface queries only that conversation's worklist.
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

/** Drive the WHOLE R29→R36 chain and file a real coordination — the recorded decision R37 reads, R38
 *  derives worklists from, and R39 queries. */
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

describeIntegration("Conversation Worklist read surface · receptionist worklist queries (R39)", () => {
  it("the prioritised PAGE reads the R38 backlog VERBATIM — critical before elevated, conclusion absent (demonstration 1)", async () => {
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
    expect(remediating.lifecycleState).toBe("retained");
    expect(escalating.lifecycleState).toBe("escalated");

    const page = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });

    // Critical (escalation) leads, then elevated (recovery); the concluded coordination is absent.
    expect(page.items.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
    expect(page.items.map((e) => e.priority)).toEqual(["critical", "elevated"]);
    expect(page).toMatchObject({ view: "prioritised", total: 2, offset: 0, has_more: false });
    expect(page.items.map((e) => e.coordination_id)).not.toContain(concluded.coordinationId);

    // THE WORKLIST ENGINE STAYS AUTHORITATIVE — the page carries the SAME entries R38 derived.
    const set = await getCoordinationWorklists({ org_id: orgId });
    expect(page.items.map((e) => e.coordination_id)).toEqual(set.prioritised.map((e) => e.coordination_id));
    expect(page.items[0]?.record.decision).toEqual(set.prioritised[0]?.record.decision);
  });

  it("FILTERING narrows the page (priority, then mode) (demonstration 2)", async () => {
    const orgId = crypto.randomUUID();
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

    const critical = await queryOrgWorklist({
      org_id: orgId,
      view: "prioritised",
      filter: { priorities: ["critical"] },
    });
    expect(critical.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(critical.total).toBe(1);

    const remediation = await queryOrgWorklist({
      org_id: orgId,
      view: "prioritised",
      filter: { modes: ["remediating"] },
    });
    expect(remediation.items.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
  });

  it("PAGINATION bounds the backlog — one entry at a time covers the whole backlog (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
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

    const first = await queryOrgWorklist({ org_id: orgId, view: "prioritised", page: { limit: 1 } });
    expect(first.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(first).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });

    const second = await queryOrgWorklist({
      org_id: orgId,
      view: "prioritised",
      page: { limit: 1, offset: 1 },
    });
    expect(second.items.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
    expect(second).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });

    // The two pages, concatenated, are the whole backlog in order.
    expect([...first.items, ...second.items].map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
  });

  it("the page is STABLY ORDERED, deterministically — reading it twice is identical (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    await seedCoordination({ orgId, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const once = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    const twice = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });
    expect(twice.items.map((e) => e.coordination_id)).toEqual(once.items.map((e) => e.coordination_id));
  });

  it("exposes the FOUR required worklists (demonstration 5)", async () => {
    const orgId = crypto.randomUUID();
    const escalating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
    });
    const remediating = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false,
    });

    const humanReview = await queryOrgWorklist({ org_id: orgId, view: "human_review" });
    const recovery = await queryOrgWorklist({ org_id: orgId, view: "recovery" });
    const escalation = await queryOrgWorklist({ org_id: orgId, view: "escalation" });
    const prioritised = await queryOrgWorklist({ org_id: orgId, view: "prioritised" });

    expect(humanReview.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(escalation.items.map((e) => e.coordination_id)).toEqual([escalating.coordinationId]);
    expect(recovery.items.map((e) => e.coordination_id)).toEqual([remediating.coordinationId]);
    expect(prioritised.items.map((e) => e.coordination_id)).toEqual([
      escalating.coordinationId,
      remediating.coordinationId,
    ]);
  });

  it("ORGANISATION ISOLATION — one org's page never surfaces another org's coordination (demonstration 6)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const a = await seedCoordination({ orgId: orgA, reviewAuditId: crypto.randomUUID(), divergentTrade: true });
    const b = await seedCoordination({ orgId: orgB, reviewAuditId: crypto.randomUUID(), performFulfilment: false });

    const pageA = await queryOrgWorklist({ org_id: orgA, view: "prioritised" });
    const pageB = await queryOrgWorklist({ org_id: orgB, view: "prioritised" });

    expect(pageA.items.map((e) => e.coordination_id)).toEqual([a.coordinationId]);
    expect(pageA.items.every((e) => e.org_id === orgA)).toBe(true);
    expect(pageA.items.map((e) => e.coordination_id)).not.toContain(b.coordinationId);

    expect(pageB.items.map((e) => e.coordination_id)).toEqual([b.coordinationId]);
    expect(pageB.items.every((e) => e.org_id === orgB)).toBe(true);
    expect(pageB.items.map((e) => e.coordination_id)).not.toContain(a.coordinationId);
  });

  it("CONVERSATION SCOPING — the conversation surface queries only that conversation's worklist (demonstration 7)", async () => {
    const orgId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      divergentTrade: true,
      conversationId,
    });

    const scoped = await queryConversationWorklist({
      org_id: orgId,
      conversation_id: conversationId,
      view: "escalation",
    });
    expect(scoped.items.map((e) => e.coordination_id)).toEqual([coordinationId]);

    // A different conversation in the same org queries an empty page.
    const other = await queryConversationWorklist({
      org_id: orgId,
      conversation_id: crypto.randomUUID(),
      view: "prioritised",
    });
    expect(other.items).toEqual([]);
    expect(other).toMatchObject({ total: 0, has_more: false });
  });
});

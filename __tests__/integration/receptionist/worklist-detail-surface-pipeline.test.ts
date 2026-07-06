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
import { projectCoordinationDetail } from "@/app/admin/ai-receptionist/worklist/[coordinationId]/detail-view";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Worklist DETAIL SURFACE — real-Postgres proof of the AI Receptionist Programme R45 (CONVERSATION
 * WORKLIST DETAIL SURFACE): the surface consumes ONLY the authorised read stack — the R37 Coordination Read
 * Model's single-item seam `getCoordinationById` — and projects one recorded coordination into a complete,
 * read-only inspection, over the whole live stack (R37 read model → R30–R36 ledgers → Postgres). The surface
 * itself is a React server component (its rendering is pinned by the production build, its consuming-only-the-
 * read-stack by the security tier); this tier drives the surface's exact DATA path — the org-scoped single-item
 * read the page performs, fed to the REAL detail projection — and proves the BEHAVIOUR the directive requires:
 *
 *   (1) THE SURFACE PROJECTS THE WHOLE WORK ITEM — a seeded coordination read back by id projects a detail view
 *       whose headline is the recorded decision, whose timeline is the full causal chain (fulfilment →
 *       verification → recovery → resolution → lifecycle → orchestration → coordination), and whose six linked
 *       contexts are each present with their own recorded facets. The surface adds presentation, not a read path.
 *   (2) ORGANISATION ISOLATION IS PRESERVED — a coordination id belonging to org A resolves to NULL for org B
 *       (the read is org-scoped), so the page would render a 404. A caller can only ever inspect a coordination
 *       that belongs to the organisation their session resolves to.
 *   (3) A MISSING COORDINATION RESOLVES TO NULL — an id that names no coordination resolves to null, the page's
 *       not-found path. The surface never invents a work item.
 *   (4) THE RETAINED-LIFECYCLE EDGE — a coordination whose lifecycle was retained (the booking was never
 *       fulfilled) projects an ABSENT fulfilment section and a timeline that omits the fulfilment step, exactly
 *       as the read model surfaces a null fulfilment context.
 *
 * Nothing here is mocked — the detail read runs against the real read model over the real ledgers. Runs only
 * against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if it is missing.
 */

const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type RpcClient = { rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T> };
const svc = (): RpcClient => serviceClient() as unknown as RpcClient;

/** Resolve a REAL `approve_booking` decision through the pure cores, so the recorded flags match the fold. */
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
async function governThroughStack(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
}): Promise<void> {
  const seeded = await recordConversationAuthorisation({
    org_id: opts.orgId,
    conversation_id: crypto.randomUUID(),
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
}

/** Drive the WHOLE R29→R36 chain and file a real coordination — the decision R37 reads and R45 inspects. */
async function seedCoordination(opts: {
  orgId: string;
  reviewAuditId: string;
  performFulfilment?: boolean;
  divergentTrade?: boolean;
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

describeIntegration("Conversation Worklist Detail Surface (R45)", () => {
  it("PROJECTS the whole work item — a seeded coordination read by id yields the full detail view (demonstration 1)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
    });

    // The surface's ONE data path — the R37 read model's org-scoped single-item seam.
    const record = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
    expect(record, "the seeded coordination is readable by id").not.toBeNull();
    const detail = projectCoordinationDetail(record!);

    // Identity + the recorded, ledger-pinned decision (approval_state → approved, status → coordinated).
    expect(detail.coordinationId).toBe(coordinationId);
    expect(detail.headline.approvalState).toBe("Approved");
    expect(detail.headline.status).toBe("Coordinated");
    expect(detail.headline.at.length).toBeGreaterThan(0);

    // A fulfilled coordination has every linked context present.
    expect(detail.sections.map((s) => s.key)).toEqual([
      "orchestration",
      "lifecycle",
      "resolution",
      "recovery",
      "verification",
      "fulfilment",
    ]);
    expect(detail.sections.every((s) => s.present)).toBe(true);

    // The timeline is the full causal chain, oldest-first, ending in the coordination itself.
    expect(detail.timeline.map((s) => s.key)).toEqual([
      "fulfilment",
      "verification",
      "recovery",
      "resolution",
      "lifecycle",
      "orchestration",
      "coordination",
    ]);
    expect(detail.timeline.at(-1)!.reference).toBe(coordinationId);

    // The whole provenance chain is surfaced.
    expect(detail.provenance).toHaveLength(15);
  });

  it("preserves ORGANISATION ISOLATION — org B cannot read org A's coordination by id (demonstration 2)", async () => {
    const orgA = crypto.randomUUID();
    const orgB = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId: orgA,
      reviewAuditId: crypto.randomUUID(),
    });

    // org A resolves its own coordination.
    const own = await getCoordinationById({ org_id: orgA, coordination_id: coordinationId });
    expect(own, "org A reads its own coordination").not.toBeNull();

    // org B, naming the SAME id, resolves NULL — the read is org-scoped, so the page would 404.
    const cross = await getCoordinationById({ org_id: orgB, coordination_id: coordinationId });
    expect(cross, "org B cannot read org A's coordination — isolation is structural").toBeNull();
  });

  it("resolves a MISSING coordination to null — the page's not-found path (demonstration 3)", async () => {
    const orgId = crypto.randomUUID();
    const missing = await getCoordinationById({
      org_id: orgId,
      coordination_id: crypto.randomUUID(), // names no coordination
    });
    expect(missing, "an unknown id resolves to null — the surface invents no work item").toBeNull();
  });

  it("surfaces the RETAINED-lifecycle edge — an absent fulfilment section and timeline step (demonstration 4)", async () => {
    const orgId = crypto.randomUUID();
    const { coordinationId } = await seedCoordination({
      orgId,
      reviewAuditId: crypto.randomUUID(),
      performFulfilment: false, // the booking is never fulfilled → the lifecycle is retained
    });

    const record = await getCoordinationById({ org_id: orgId, coordination_id: coordinationId });
    expect(record).not.toBeNull();
    const detail = projectCoordinationDetail(record!);

    // The read model surfaces a null fulfilment context; the projection marks the section absent.
    const fulfilment = detail.sections.find((s) => s.key === "fulfilment")!;
    expect(fulfilment.present).toBe(false);
    expect(fulfilment.fields).toEqual([]);

    // The timeline omits the fulfilment step but keeps the rest of the causal chain.
    expect(detail.timeline.some((s) => s.key === "fulfilment")).toBe(false);
    expect(detail.timeline.map((s) => s.key)).toEqual([
      "verification",
      "recovery",
      "resolution",
      "lifecycle",
      "orchestration",
      "coordination",
    ]);

    // The other five linked contexts remain present.
    for (const key of ["orchestration", "lifecycle", "resolution", "recovery", "verification"]) {
      expect(detail.sections.find((s) => s.key === key)!.present, `${key} present`).toBe(true);
    }
  });
});

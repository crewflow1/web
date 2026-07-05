import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import { recordConversationAuthorisation } from "@/server/services/receptionist-authorisation";
import { verifyApprovedFulfilment } from "@/server/services/receptionist-verification";
import { recoverVerifiedFulfilment } from "@/server/services/receptionist-recovery";
import { resolveConversationCompletion } from "@/server/services/receptionist-resolution";
import { governConversationLifecycle } from "@/server/services/receptionist-lifecycle";
import { orchestrateConversationLifecycle } from "@/server/services/receptionist-orchestration";
import { fulfilApprovedBooking } from "@/server/services/receptionist-fulfilment";
import {
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Orchestration pipeline — real-Postgres proof of the AI Receptionist Programme R35
 * (CONVERSATION ORCHESTRATION ENGINE), the FIFTH layer that does not perform: given an APPROVED, PERFORMED, VERIFIED,
 * RECOVERED, RESOLVED, GOVERNED conversation it reads R34's RECORDED lifecycle disposition and ROUTES it to the platform
 * capability that should RESPOND — `conclude`/`conversation_conclusion` (closed, the operation completed, route it to
 * conclusion), `recover`/`recovery_handling` (retained, a clear recovery path, route it to recovery handling) and
 * `escalate`/`human_attention` (escalated, an ambiguous record, route it to human attention) — filing an auditable
 * ORCHESTRATION. It ROUTES work; it EXECUTES no work (it concludes nothing, recovers nothing, escalates nothing,
 * enqueues nothing, notifies no one, retries nothing, schedules nothing).
 *
 * The unit tier proves the pure core routes an orchestration DECISION deterministically, DEFERS when R34 rendered no
 * decision, folds the lifecycle state to its route and the route to its target, and keeps `concluded` / `active`
 * coherent; the security tier proves, as SOURCE, that the ledger is append-only, service-role-only, approved-only,
 * concluded-coherent, active-coherent, route-fold-coherent, target-fold-coherent, fulfilment-coherent and idempotent,
 * that the Lifecycle (R34), Resolution (R33), Recovery (R32), Verification (R31) and Fulfilment (R30) Engines stay
 * authoritative, that Human Review can never be bypassed, and that no duplicate orchestration logic exists. This tier
 * proves the BEHAVIOUR the mocks can't — that when the CANONICAL RUNTIME actually reads R34's RECORDED lifecycle behind
 * a held reply, reconstructs the lifecycle decision, routes it against a live database, exactly one idempotent
 * orchestration row is really filed with the right route + target, and the migration's storage / RLS / append-only guard
 * / privilege model / vocabulary CHECKs / the APPROVED-ONLY CHECK / the ROUTE FOLD CHECK / the TARGET FOLD CHECK / the
 * FULFILMENT-COHERENCE CHECK / and — the R35 keystone — the CONCLUDED and ACTIVE COHERENCE CHECKs all hold in Postgres.
 * The load-bearing R35 claims are proven here:
 *
 *   • THE RUNTIME ORCHESTRATES `conclude`/`conversation_conclusion` FOR A `closed` LIFECYCLE — driven through the real
 *     `orchestrateConversationLifecycle` (not the RPC directly), after the real R30 `fulfilApprovedBooking` performed the
 *     booking, the real R31 `verifyApprovedFulfilment` recorded a `consistent` verdict, the real R32
 *     `recoverVerifiedFulfilment` determined a `none` recovery, the real R33 `resolveConversationCompletion` determined a
 *     `terminal` resolution and the real R34 `governConversationLifecycle` governed a `closed` lifecycle: it reads the
 *     recorded lifecycle, routes it, and files EXACTLY ONE orchestration row — threaded to the lifecycle it was routed
 *     from, the resolution, the recovery, the authorisation, the verification, the fulfilment, the held reply, the sent
 *     reply and the human's resolution — with `orchestration_route` = 'conclude', `orchestration_target` =
 *     'conversation_conclusion', `concluded` = true, `active` = false, `lifecycle_state` = 'closed', `approval_state` =
 *     'approved' and `status` = 'orchestrated'.
 *   • THE RUNTIME ORCHESTRATES `recover`/`recovery_handling` FOR A `retained` LIFECYCLE — when R34 governed a `retained`
 *     lifecycle (the approved operation went unrecorded), the runtime files an orchestration with `orchestration_route` =
 *     'recover', `orchestration_target` = 'recovery_handling', `concluded` = false, `active` = true and `fulfilment_id`
 *     NULL. Routing the conversation to recovery handling on a clear recovery path is an observable, auditable state —
 *     the whole point of the engine.
 *   • THE RUNTIME ORCHESTRATES `escalate`/`human_attention` FOR AN `escalated` LIFECYCLE — when R34 governed an
 *     `escalated` lifecycle (a divergent record), the runtime files an orchestration with `orchestration_route` =
 *     'escalate', `orchestration_target` = 'human_attention', `concluded` = false, `active` = true and `fulfilment_id`
 *     set. The ambiguity is routed to human attention, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation (a policy-/org-blocked booking) is never fulfilled, so
 *     never verified, so never recovered, so never resolved, so never governed, so the orchestration-context reader finds
 *     NO lifecycle and the runtime orchestrates NOTHING.
 *   • A NON-GOVERNED REPLY ORCHESTRATES NOTHING — when there is no recorded lifecycle behind the held reply (the common
 *     case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same governed lifecycle orchestrates AT MOST ONCE: the second call returns the
 *     SAME orchestration id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved'. There is no path to orchestrating a response for un-approved work.
 *   • THE ORCHESTRATION FLAGS ARE COHERENT WITH THE ROUTE (the R35 keystone) — the write primitive and column CHECKs
 *     REJECT a `concluded` or `active` that contradicts the route (concluded iff route = conclude; active iff route <>
 *     conclude).
 *   • THE ROUTE IS THE DETERMINISTIC FOLD OF THE LIFECYCLE STATE (stage 1) — the write primitive and a column CHECK
 *     REJECT a route that contradicts the source lifecycle state (closed→conclude, retained→recover, escalated→escalate).
 *   • THE TARGET IS THE DETERMINISTIC FOLD OF THE ROUTE (stage 2) — the write primitive and a column CHECK REJECT a
 *     target that contradicts its route (conclude→conversation_conclusion, recover→recovery_handling,
 *     escalate→human_attention).
 *   • THE FULFILMENT PRESENCE IS COHERENT WITH THE SOURCE STATE (inherited transitively) — a `retained` orchestration
 *     carrying a `fulfilment_id`, or a `closed`/`escalated` orchestration carrying none, is rejected.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or call
 *     the orchestration-context reader.
 *   • THE VOCABULARY, THE FOLDS AND THE FIELD SHAPES ARE PINNED — an orchestration type/outcome/route/target/lifecycle
 *     state outside its set, a malformed expected booking field, a missing job type, an absent lifecycle or Human Review
 *     provenance id, or a status other than 'orchestrated' is rejected.
 *   • THE READER CENTRES ON THE LIFECYCLE LEDGER — it returns the RECORDED lifecycle behind a held reply (the input the
 *     runtime routes), and returns nothing when no lifecycle was governed.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All seven receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications, R32 recoveries, R33 resolutions, R34 lifecycles, R35 orchestrations) are append-only (even service_role
 * cannot DELETE), so these tests intentionally leave their rows behind — harmless in the ephemeral CI database, and
 * proving exactly that is one of the tests below. Rows are addressed by a per-call lifecycle id so each assertion sees
 * only its own writes. No FK'd tenant rows are created, so no teardown is required.
 */

// receptionist_conversation_orchestrations / record_receptionist_conversation_orchestration /
// find_receptionist_orchestration_context are service-role-only internals, NOT in the generated Database types. Cast to
// the minimal surface this suite exercises (the same `as unknown as` convention the lifecycle / resolution / recovery
// suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  is(column: string, value: unknown): Filterable<T>;
};
type Insertable = Filterable<null> & {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
};
type OrchestrationTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type OrchestrationClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): OrchestrationTable;
};

const TABLE = "receptionist_conversation_orchestrations";
const RPC = "record_receptionist_conversation_orchestration";
const READER = "find_receptionist_orchestration_context";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): OrchestrationClient => serviceClient() as unknown as OrchestrationClient;
const anon = (): OrchestrationClient => anonClient() as unknown as OrchestrationClient;

// The columns every assertion below reads back — the full captured orchestration record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, review_audit_id, sent_audit_id, review_resolution_id, " +
  "orchestration_type, orchestration_outcome, orchestration_route, orchestration_target, concluded, active, lifecycle_state, " +
  "approval_state, job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a `closed` orchestrate_lifecycle_response (a `conclude`/`conversation_conclusion`
// orchestration) — spread and overridden per case. `closed` requires route='conclude', target='conversation_conclusion',
// concluded=true, active=false and, via the fulfilment-coherence CHECK, a NON-NULL fulfilment_id (a `closed` lifecycle
// means the operation WAS recorded) — so the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_lifecycle_id: crypto.randomUUID(),
  p_resolution_id: crypto.randomUUID(),
  p_recovery_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_id: crypto.randomUUID(),
  p_orchestration_type: "orchestrate_lifecycle_response",
  p_orchestration_outcome: "conversation_response_orchestrated",
  p_orchestration_route: "conclude",
  p_orchestration_target: "conversation_conclusion",
  p_concluded: true,
  p_active: false,
  p_lifecycle_state: "closed",
  p_approval_state: "approved",
  p_correlation_id: crypto.randomUUID(),
  p_review_audit_id: crypto.randomUUID(),
  p_sent_audit_id: crypto.randomUUID(),
  p_review_resolution_id: crypto.randomUUID(),
  p_fulfilment_id: crypto.randomUUID(),
  p_job_type: JOB,
  p_postcode: POSTCODE,
  p_phone_number: PHONE,
});

// A valid RPC payload for a `retained` orchestration (a `recover`/`recovery_handling` route) — route='recover',
// target='recovery_handling', concluded=false, active=true, fulfilment_id NULL (the fulfilment-coherence CHECK). Used for
// the coherence NEGATIVE cases that must start coherent.
const recoverableRpcArgs = () => ({
  ...validRpcArgs(),
  p_orchestration_route: "recover",
  p_orchestration_target: "recovery_handling",
  p_concluded: false,
  p_active: true,
  p_lifecycle_state: "retained",
  p_fulfilment_id: null as string | null,
});

// A valid direct-insert row (every NOT NULL column present, every field well-formed, all folds coherent) — used ONLY for
// the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  lifecycle_id: crypto.randomUUID(),
  resolution_id: crypto.randomUUID(),
  recovery_id: crypto.randomUUID(),
  authorisation_id: crypto.randomUUID(),
  verification_id: crypto.randomUUID(),
  fulfilment_id: crypto.randomUUID(),
  correlation_id: crypto.randomUUID(),
  review_audit_id: crypto.randomUUID(),
  sent_audit_id: crypto.randomUUID(),
  review_resolution_id: crypto.randomUUID(),
  orchestration_type: "orchestrate_lifecycle_response",
  orchestration_outcome: "conversation_response_orchestrated",
  orchestration_route: "conclude",
  orchestration_target: "conversation_conclusion",
  concluded: true,
  active: false,
  lifecycle_state: "closed",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the state + flags ALWAYS match the deterministic
 * fold of the eligibility they are recorded with. `allow`+live ⇒ pending (fulfillable, so verifiable, so recoverable,
 * so resolvable, so governable, so orchestratable); `block` ⇒ foreclosed (never fulfillable, so never verifiable, so
 * never recoverable, so never resolvable, so never governable, so never orchestratable).
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

/** Read every orchestration row filed for one lifecycle id, as service_role (ground truth). */
function rowsForLifecycle(lifecycleId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("lifecycle_id", lifecycleId);
}

/** Read the RECORDED R34 lifecycle row's provenance (the ground truth the orchestration threads VERBATIM). */
function lifecycleProvenance(lifecycleId: string): Filterable<Record<string, unknown>[]> {
  return svc()
    .from("receptionist_conversation_lifecycles")
    .select("sent_audit_id, review_resolution_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id")
    .eq("id", lifecycleId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle the Orchestration Engine can route.
 *  Returns the govern handle's lifecycle id (R35's anchor). `divergentTrade` seeds an inconsistent fulfilment (escalated
 *  path); `performFulfilment=false` skips R30 (retained path); the default is the terminal → closed path. */
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
    // A DIVERGENT recorded fulfilment — a different trade than the authorisation carries → R31 inconsistent → R32
    // reconcile → R33 unresolved → R34 escalate/escalated.
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
  return { lifecycleId: governed?.lifecycle_id as string, lifecycleState: governed?.lifecycle_state as string };
}

describeIntegration(
  "Conversation Orchestration pipeline · receptionist_conversation_orchestrations (R35)",
  () => {
    it("orchestrateConversationLifecycle orchestrates `conclude`/`conversation_conclusion` for a `closed` lifecycle — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed the full R29→R30→R31→R32→R33→R34 chain so the recorded lifecycle the Orchestration Engine reads is genuine.
      const orgId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const enquiryId = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      const actionId = crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();

      const { lifecycleId, lifecycleState } = await governThroughStack({
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

      // The R34 lifecycle row carries the sent-reply + human-grant anchors the Orchestration Engine threads VERBATIM: the
      // runtime reads the RECORDED lifecycle and copies its provenance, it never re-uses the orchestration trigger's own
      // sent/resolution ids. Capture them as the provenance ground truth the orchestration row must match.
      const provRead = await lifecycleProvenance(lifecycleId);
      expect(provRead.error, provRead.error?.message).toBeNull();
      const recordedLifecycle = provRead.data?.[0] ?? {};

      // THE ORCHESTRATION — the runtime reads R34's recorded lifecycle, routes the `closed` disposition, and records the
      // route + target. `closed` ⇒ `conclude`/`conversation_conclusion`, concluded=true, active=false. The trigger's
      // sent / resolution ids are DELIBERATELY fresh (not the recorded ones) to prove the runtime threads from the record.
      const sentAuditId = crypto.randomUUID();
      const reviewResolutionId = crypto.randomUUID();
      const orchestrated = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: reviewResolutionId,
      });
      expect(orchestrated, "the governed conversation's response was orchestrated").not.toBeNull();
      expect(orchestrated?.orchestration_type).toBe("orchestrate_lifecycle_response");
      expect(orchestrated?.orchestration_outcome).toBe("conversation_response_orchestrated");
      expect(orchestrated?.orchestration_route).toBe("conclude");
      expect(orchestrated?.orchestration_target).toBe("conversation_conclusion");
      expect(orchestrated?.concluded).toBe(true);
      expect(orchestrated?.active).toBe(false);
      expect(orchestrated?.lifecycle_state).toBe("closed");

      // EXACTLY ONE row — not zero, not two. Keyed by the R34 lifecycle's id (R35's anchor + idempotency key).
      const read = await rowsForLifecycle(lifecycleId);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(orchestrated?.orchestration_id);
      // The routed disposition is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.lifecycle_id).toBe(lifecycleId); // the lifecycle it was routed from (R35's anchor + idempotency key)
      expect(row.resolution_id).toBe(recordedLifecycle.resolution_id); // the resolution the lifecycle was governed from
      expect(row.recovery_id).toBe(recordedLifecycle.recovery_id); // the recovery the resolution was determined from
      expect(row.authorisation_id).toBe(recordedLifecycle.authorisation_id); // the authorisation the recovery traced
      expect(row.verification_id).toBe(recordedLifecycle.verification_id); // the verification the recovery classified
      expect(row.fulfilment_id).toBe(recordedLifecycle.fulfilment_id); // the fulfilment the verification reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      expect(row.sent_audit_id).toBe(recordedLifecycle.sent_audit_id); // threaded from the recorded lifecycle, NOT the trigger
      expect(row.review_resolution_id).toBe(recordedLifecycle.review_resolution_id); // threaded from the recorded lifecycle
      // ...and the trigger's own ids were NOT copied onto the row — provenance follows the record, never the caller.
      expect(row.sent_audit_id).not.toBe(sentAuditId);
      expect(row.review_resolution_id).not.toBe(reviewResolutionId);
      // The anchors threaded THROUGH the recorded lifecycle the reader routed.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was orchestrated, the route, the target, the flags, the source lifecycle state, and the EXPECTED payload.
      expect(row.orchestration_type).toBe("orchestrate_lifecycle_response");
      expect(row.orchestration_outcome).toBe("conversation_response_orchestrated");
      expect(row.orchestration_route).toBe("conclude");
      expect(row.orchestration_target).toBe("conversation_conclusion");
      expect(row.concluded).toBe(true);
      expect(row.active).toBe(false);
      expect(row.lifecycle_state).toBe("closed");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + ORCHESTRATED BY CONSTRUCTION — the grant that authorised the operation, and the orchestrated status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("orchestrated");
    });

    it("orchestrates `recover`/`recovery_handling` for a `retained` lifecycle (the operation went unrecorded)", async () => {
      // Seed a PENDING approve_booking, DO NOT perform R30 — R31 verifies `missing`, R32 recovers `reinstate`, R33
      // resolves `recoverable`, R34 governs `retain`/`retained`. The Orchestration Engine routes it `recover`/
      // `recovery_handling` with fulfilment_id NULL.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const { lifecycleId, lifecycleState } = await governThroughStack({
        orgId,
        reviewAuditId,
        performFulfilment: false,
      });
      expect(lifecycleState).toBe("retained");

      const orchestrated = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(orchestrated, "a retained lifecycle is routed to recovery handling").not.toBeNull();
      expect(orchestrated?.orchestration_route).toBe("recover");
      expect(orchestrated?.orchestration_target).toBe("recovery_handling");
      expect(orchestrated?.concluded).toBe(false);
      expect(orchestrated?.active).toBe(true);

      const read = await rowsForLifecycle(lifecycleId);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.orchestration_route).toBe("recover");
      expect(row.orchestration_target).toBe("recovery_handling");
      expect(row.concluded).toBe(false);
      expect(row.active).toBe(true);
      expect(row.lifecycle_state).toBe("retained");
      // The coherence invariant, observed end-to-end: a `retained` disposition carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.lifecycle_id).toBe(lifecycleId);
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("orchestrated");
    });

    it("orchestrates `escalate`/`human_attention` for an `escalated` lifecycle (the record diverges from the decision)", async () => {
      // Seed a PENDING approve_booking for JOB=plumbing, file a DIVERGENT R30 fulfilment (a different trade), so R31
      // verifies `inconsistent`, R32 recovers `reconcile`, R33 resolves `unresolved` and R34 governs `escalate`/
      // `escalated`. The Orchestration Engine routes it `escalate`/`human_attention`.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const { lifecycleId, lifecycleState } = await governThroughStack({
        orgId,
        reviewAuditId,
        divergentTrade: true,
      });
      expect(lifecycleState).toBe("escalated");

      const orchestrated = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(orchestrated, "an escalated lifecycle is routed to human attention").not.toBeNull();
      expect(orchestrated?.orchestration_route).toBe("escalate");
      expect(orchestrated?.orchestration_target).toBe("human_attention");
      expect(orchestrated?.concluded).toBe(false);
      expect(orchestrated?.active).toBe(true);

      const read = await rowsForLifecycle(lifecycleId);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.orchestration_route).toBe("escalate");
      expect(row.orchestration_target).toBe("human_attention");
      expect(row.concluded).toBe(false);
      expect(row.active).toBe(true);
      expect(row.lifecycle_state).toBe("escalated");
      // An escalation is still routed from a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).not.toBeNull();
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never governed, so never orchestrated", async () => {
      // A policy-/org-blocked booking folds to FORECLOSED at R29 → never fulfilled → never verified → never recovered →
      // never resolved → never governed → the orchestration-context reader finds no lifecycle → the runtime orchestrates
      // NOTHING.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const seeded = await recordConversationAuthorisation({
        org_id: orgId,
        conversation_id: crypto.randomUUID(),
        correlation_id: crypto.randomUUID(),
        review_audit_id: reviewAuditId,
        decision: authorise("block", true),
      });
      expect(seeded?.state).toBe("foreclosed");

      // (Even if a send fired the whole chain, nothing governs — so nothing orchestrates.)
      await verifyApprovedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      await recoverVerifiedFulfilment({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      await resolveConversationCompletion({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      await governConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const result = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never orchestrated").toBeNull();
    });

    it("a NON-GOVERNED reply orchestrates nothing — no recorded lifecycle behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No lifecycle was governed, so the
      // runtime returns null and files no row.
      const result = await orchestrateConversationLifecycle({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no lifecycle behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same governed lifecycle orchestrates AT MOST ONCE", async () => {
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      // Govern once (as retained; the disposition is immaterial to idempotency).
      const { lifecycleId } = await governThroughStack({ orgId, reviewAuditId, performFulfilment: false });

      const first = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME recorded lifecycle.
      const second = await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call orchestrated nothing; ON CONFLICT (lifecycle_id) returned the existing row.
      expect(second?.orchestration_id).toBe(first?.orchestration_id);

      const read = await rowsForLifecycle(lifecycleId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.orchestration_id);
    });

    it("the write primitive files an orchestration and is idempotent on the lifecycle id (direct RPC)", async () => {
      const lifecycleId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_id: lifecycleId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the orchestration id").toBeTruthy();

      // A repeat with the SAME lifecycle id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_id: lifecycleId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc()
        .from(TABLE)
        .select("id, approval_state, status, orchestration_route, orchestration_target, concluded, active")
        .eq("lifecycle_id", lifecycleId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("orchestrated");
      expect(read.data?.[0]?.orchestration_route).toBe("conclude");
      expect(read.data?.[0]?.orchestration_target).toBe("conversation_conclusion");
      expect(read.data?.[0]?.concluded).toBe(true);
      expect(read.data?.[0]?.active).toBe(false);
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited transitively from R34 → R33 → R32 → R31 → R30: an orchestration can ONLY exist for an approved authorisation.
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }
      const insertUnapproved = await svc().from(TABLE).insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved orchestration, even for service_role",
      ).not.toBeNull();
    });

    it("THE KEYSTONE — concluded/active flags are coherent with the route (RPC and CHECK)", async () => {
      // A `conclude` route claiming NOT concluded is rejected by the RPC's concluded-coherence validation…
      const concludeButNotConcluded = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_concluded: false });
      expect(concludeButNotConcluded.error, "a `conclude` route claiming concluded=false must be rejected").not.toBeNull();

      // …and a `recover` route claiming concluded is rejected too.
      const recoverButConcluded = await svc().rpc<string>(RPC, { ...recoverableRpcArgs(), p_concluded: true });
      expect(recoverButConcluded.error, "a `recover` route claiming concluded=true must be rejected").not.toBeNull();

      // A `conclude` route claiming an active response is routed is rejected…
      const concludeButActive = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_active: true });
      expect(concludeButActive.error, "a `conclude` route claiming active=true must be rejected").not.toBeNull();

      // …and a `recover` route claiming it is NOT active is rejected.
      const recoverButNotActive = await svc().rpc<string>(RPC, { ...recoverableRpcArgs(), p_active: false });
      expect(recoverButNotActive.error, "a `recover` route claiming active=false must be rejected").not.toBeNull();

      // The column CHECKs enforce the same equivalences on a direct service_role insert.
      const insertBadConcluded = await svc().from(TABLE).insert({ ...validInsertRow(), concluded: false });
      expect(
        insertBadConcluded.error,
        "the concluded-coherence CHECK rejects concluded=false on a `conclude` route, even for service_role",
      ).not.toBeNull();
      const insertBadActive = await svc().from(TABLE).insert({ ...validInsertRow(), active: true });
      expect(
        insertBadActive.error,
        "the active-coherence CHECK rejects active=true on a `conclude` route, even for service_role",
      ).not.toBeNull();
    });

    it("THE ROUTE FOLD (stage 1) — the route is the deterministic fold of the lifecycle state (RPC and CHECK)", async () => {
      // `closed` folds to `conclude` ONLY — a `closed` lifecycle state with route `recover` is rejected (target + flags
      // kept coherent with the wrong route so ONLY the route fold is violated)…
      const closedRecover = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_orchestration_route: "recover",
        p_orchestration_target: "recovery_handling",
        p_concluded: false,
        p_active: true,
      });
      expect(closedRecover.error, "closed must fold to conclude, not recover").not.toBeNull();

      // …and a `retained` lifecycle state with route `conclude` is rejected (target + flags + fulfilment coherent).
      const retainedConclude = await svc().rpc<string>(RPC, {
        ...recoverableRpcArgs(),
        p_orchestration_route: "conclude",
        p_orchestration_target: "conversation_conclusion",
        p_concluded: true,
        p_active: false,
      });
      expect(retainedConclude.error, "retained must fold to recover, not conclude").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadRoute = await svc()
        .from(TABLE)
        .insert({
          ...validInsertRow(),
          orchestration_route: "recover",
          orchestration_target: "recovery_handling",
          concluded: false,
          active: true,
        });
      expect(
        insertBadRoute.error,
        "the route-fold CHECK rejects closed + recover, even for service_role",
      ).not.toBeNull();
    });

    it("THE TARGET FOLD (stage 2) — the target is the deterministic fold of the route (RPC and CHECK)", async () => {
      // `conclude` folds to `conversation_conclusion` ONLY — a `conclude` route routing to `recovery_handling` is
      // rejected (route + lifecycle state + flags kept coherent, so ONLY the target fold is violated)…
      const concludeWrongTarget = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_orchestration_target: "recovery_handling",
      });
      expect(concludeWrongTarget.error, "conclude must fold to conversation_conclusion, not recovery_handling").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadTarget = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), orchestration_target: "recovery_handling" });
      expect(
        insertBadTarget.error,
        "the target-fold CHECK rejects conclude + recovery_handling, even for service_role",
      ).not.toBeNull();
    });

    it("THE FULFILMENT PRESENCE is coherent with the source state (inherited) — retained iff no fulfilment_id (RPC and CHECK)", async () => {
      // A `retained` orchestration carrying a fulfilment_id is rejected…
      const retainedWithFulfilment = await svc().rpc<string>(RPC, {
        ...recoverableRpcArgs(),
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(
        retainedWithFulfilment.error,
        "a `retained` orchestration carrying a fulfilment_id must be rejected",
      ).not.toBeNull();

      // …and a `closed` orchestration with NO fulfilment_id is rejected.
      const closedWithoutFulfilment = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_fulfilment_id: null });
      expect(
        closedWithoutFulfilment.error,
        "a `closed` orchestration with no fulfilment_id must be rejected",
      ).not.toBeNull();

      // A COHERENT `retained` (recover, no fulfilment_id) is accepted — the state the engine exists to record.
      const coherentRetained = await svc().rpc<string>(RPC, { ...recoverableRpcArgs() });
      expect(coherentRetained.error, coherentRetained.error?.message).toBeNull();
      expect(coherentRetained.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const lifecycleId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_id: lifecycleId });
      expect(filed.error, filed.error?.message).toBeNull();

      const updated = await svc()
        .from(TABLE)
        .update({ orchestration_route: "escalate" })
        .eq("lifecycle_id", lifecycleId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      const deleted = await svc().from(TABLE).delete().eq("lifecycle_id", lifecycleId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      const read = await rowsForLifecycle(lifecycleId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.orchestration_route).toBe("conclude");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const lifecycleId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_id: lifecycleId });

      const asService = await rowsForLifecycle(lifecycleId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      expectAnonDenied(await anon().from(TABLE).select("id").eq("lifecycle_id", lifecycleId));

      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file an orchestration").not.toBeNull();

      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to read the orchestration context").not.toBeNull();

      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the folds, the field shapes, the provenance and the orchestrated status", async () => {
      // An orchestration type outside {orchestrate_lifecycle_response} is rejected.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_type: "orchestrate_quote_response" });
      expect(badType.error, "an orchestration type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {conversation_response_orchestrated} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_orchestration_outcome: "conversation_response_executed",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A route outside {conclude, recover, escalate} is rejected.
      const badRoute = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_route: "reopen" });
      expect(badRoute.error, "a route outside the vocabulary must be rejected").not.toBeNull();

      // A target outside {conversation_conclusion, recovery_handling, human_attention} is rejected.
      const badTarget = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_target: "queue_dispatch" });
      expect(badTarget.error, "a target outside the vocabulary must be rejected").not.toBeNull();

      // A lifecycle state outside {closed, retained, escalated} is rejected.
      const badState = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lifecycle_state: "terminal",
      });
      expect(badState.error, "a lifecycle state outside the vocabulary must be rejected").not.toBeNull();

      // An orchestration with a malformed expected number / postcode is rejected — the ledger never records an unringable
      // expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // An orchestrate_lifecycle_response with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "an orchestration with no expected job type must be rejected").not.toBeNull();

      // The lifecycle anchor and the full Human Review provenance are MANDATORY.
      const noLifecycle = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_id: null });
      expect(noLifecycle.error, "an orchestration with no lifecycle reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: null });
      expect(noResolution.error, "an orchestration with no resolution reference must be rejected").not.toBeNull();
      const noRecovery = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: null });
      expect(noRecovery.error, "an orchestration with no recovery reference must be rejected").not.toBeNull();
      const noAuthorisation = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: null });
      expect(noAuthorisation.error, "an orchestration with no authorisation reference must be rejected").not.toBeNull();
      const noVerification = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_id: null });
      expect(noVerification.error, "an orchestration with no verification reference must be rejected").not.toBeNull();
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "an orchestration with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "an orchestration with no sent-reply reference must be rejected").not.toBeNull();
      const noReviewResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noReviewResolution.error, "an orchestration with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), orchestration_outcome: "conversation_response_executed" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // ORCHESTRATED BY CONSTRUCTION: a direct service_role insert claiming any status but 'orchestrated' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "executed" });
      expect(badStatus.error, "a status other than 'orchestrated' must be rejected by the CHECK").not.toBeNull();
    });

    it("the orchestration-context reader centres on the lifecycle ledger — returns the recorded lifecycle, or nothing", async () => {
      const orgId = crypto.randomUUID();

      // A recorded lifecycle behind held reply A (via the full R29→R34 chain, governed as `retain`/`retained`).
      const reviewA = crypto.randomUUID();
      const { lifecycleId, lifecycleState } = await governThroughStack({
        orgId,
        reviewAuditId: reviewA,
        performFulfilment: false,
      });
      expect(lifecycleState).toBe("retained");

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const lRow = found.data?.[0] ?? {};
      // The reader returns R34's RECORDED lifecycle verbatim, so the runtime can reconstruct the decision.
      expect(lRow.lifecycle_id).toBe(lifecycleId);
      expect(lRow.lifecycle_type).toBe("govern_resolution_lifecycle");
      expect(lRow.lifecycle_outcome).toBe("conversation_lifecycle_governed");
      expect(lRow.lifecycle_transition).toBe("retain");
      expect(lRow.lifecycle_state).toBe("retained");
      expect(lRow.closed).toBe(false);
      expect(lRow.ongoing).toBe(true);
      expect(lRow.resolution_state).toBe("recoverable");
      expect(lRow.approval_state).toBe("approved");
      expect(lRow.job_type).toBe(JOB);
      expect(lRow.postcode).toBe(POSTCODE);
      expect(lRow.phone_number).toBe(PHONE);
      expect(lRow.fulfilment_id).toBeNull(); // retained → no fulfilment

      // A held reply B with NO recorded lifecycle — the reader returns nothing.
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

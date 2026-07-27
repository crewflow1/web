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
  isAuthorisationDecided,
  resolveAuthorisation,
  type ApproveBookingAuthorisation,
} from "@/lib/receptionist/conversation-authorisation";
import { resolveExecution } from "@/lib/receptionist/conversation-execution";
import type { GuardrailVerdict } from "@/lib/receptionist/policy";

/**
 * Conversation Coordination pipeline — real-Postgres proof of the AI Receptionist Programme R36 (CONVERSATION
 * COORDINATION ENGINE), the SIXTH layer that does not perform: given an APPROVED, PERFORMED, VERIFIED, RECOVERED,
 * RESOLVED, GOVERNED, ORCHESTRATED conversation it reads R35's RECORDED orchestration routing and COORDINATES it into a
 * participation plan — determining the MODE by which the platform's capabilities should be coordinated to respond
 * (`finalising` from a `conclude` route, `remediating` from a `recover` route, `escalating` from an `escalate` route),
 * the lead PARTICIPANT the response centres on (`conversation_conclusion` / `recovery_handling` / `human_attention`), the
 * participation plan cardinality (`participant_count`), and WHETHER the response requires a human and WHETHER it is
 * autonomous — filing an auditable COORDINATION. It COORDINATES work; it EXECUTES no work (it concludes nothing, recovers
 * nothing, escalates nothing, enqueues nothing, notifies no one, retries nothing, schedules nothing).
 *
 * The unit tier proves the pure core coordinates an orchestration DECISION deterministically, DEFERS when R35 rendered no
 * decision, folds the orchestration route to its mode and the mode to its lead, and keeps `requires_human` / `autonomous`
 * coherent with the lead; the security tier proves, as SOURCE, that the ledger is append-only, service-role-only,
 * approved-only, mode-fold-coherent, lead-fold-coherent, requires-human-coherent, autonomous-coherent,
 * single-capability, fulfilment-coherent and idempotent, that the Orchestration (R35), Lifecycle (R34), Resolution
 * (R33), Recovery (R32), Verification (R31) and Fulfilment (R30) Engines stay authoritative, that Human Review can never
 * be bypassed, and that no duplicate coordination logic exists. This tier proves the BEHAVIOUR the mocks can't — that
 * when the CANONICAL RUNTIME actually reads R35's RECORDED orchestration behind a held reply, reconstructs the
 * orchestration decision, coordinates it against a live database, exactly one idempotent coordination row is really filed
 * with the right mode + lead, and the migration's storage / RLS / append-only guard / privilege model / vocabulary
 * CHECKs / the APPROVED-ONLY CHECK / the MODE FOLD CHECK / the LEAD FOLD CHECK / the REQUIRES-HUMAN + AUTONOMOUS
 * COHERENCE CHECKs / the SINGLE-CAPABILITY CHECK / and the FULFILMENT-COHERENCE CHECK all hold in Postgres. The
 * load-bearing R36 claims are proven here:
 *
 *   • THE RUNTIME COORDINATES `finalising`/`conversation_conclusion` FOR A `closed` LIFECYCLE — driven through the real
 *     `coordinateConversationLifecycle` (not the RPC directly), after the real R30 `fulfilApprovedBooking` performed the
 *     booking, the real R31 `verifyApprovedFulfilment` recorded a `consistent` verdict, the real R32
 *     `recoverVerifiedFulfilment` determined a `none` recovery, the real R33 `resolveConversationCompletion` determined a
 *     `terminal` resolution, the real R34 `governConversationLifecycle` governed a `closed` lifecycle and the real R35
 *     `orchestrateConversationLifecycle` routed a `conclude`/`conversation_conclusion` orchestration: it reads the
 *     recorded orchestration, coordinates it, and files EXACTLY ONE coordination row — threaded to the orchestration it
 *     was coordinated from, the lifecycle, the resolution, the recovery, the authorisation, the verification, the
 *     fulfilment, the held reply, the sent reply and the human's resolution — with `coordination_mode` = 'finalising',
 *     `lead_participant` = 'conversation_conclusion', `requires_human` = false, `autonomous` = true, `participant_count`
 *     = 1, `orchestration_route` = 'conclude', `lifecycle_state` = 'closed', `approval_state` = 'approved' and `status` =
 *     'coordinated'.
 *   • THE RUNTIME COORDINATES `remediating`/`recovery_handling` FOR A `retained` LIFECYCLE — when R35 routed a `recover`
 *     orchestration (the approved operation went unrecorded), the runtime files a coordination with `coordination_mode` =
 *     'remediating', `lead_participant` = 'recovery_handling', `requires_human` = false, `autonomous` = true and
 *     `fulfilment_id` NULL. Coordinating the response to remediate on a clear recovery path is an observable, auditable
 *     plan — the whole point of the engine.
 *   • THE RUNTIME COORDINATES `escalating`/`human_attention` FOR AN `escalated` LIFECYCLE — when R35 routed an `escalate`
 *     orchestration (a divergent record), the runtime files a coordination with `coordination_mode` = 'escalating',
 *     `lead_participant` = 'human_attention', `requires_human` = true, `autonomous` = false and `fulfilment_id` set. The
 *     ambiguity is coordinated to human attention, never hidden.
 *   • HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never fulfilled, so never verified, so never
 *     recovered, so never resolved, so never governed, so never orchestrated, so the coordination-context reader finds NO
 *     orchestration and the runtime coordinates NOTHING.
 *   • A NON-ORCHESTRATED REPLY COORDINATES NOTHING — when there is no recorded orchestration behind the held reply (the
 *     common case — an ordinary review), the runtime returns null and files no row.
 *   • IT IS IDEMPOTENT — re-driving the same routed orchestration coordinates AT MOST ONCE: the second call returns the
 *     SAME coordination id and no second row appears.
 *   • THE APPROVAL IS UNBYPASSABLE AT THE STORAGE LAYER — the write primitive and the column CHECK REJECT any
 *     `approval_state` other than 'approved'. There is no path to coordinating a response for un-approved work.
 *   • THE PARTICIPATION FLAGS ARE COHERENT WITH THE LEAD (the R36 keystone) — the write primitive and column CHECKs
 *     REJECT a `requires_human` or `autonomous` that contradicts the lead (requires_human iff lead = human_attention;
 *     autonomous iff lead <> human_attention).
 *   • THE MODE IS THE DETERMINISTIC FOLD OF THE ORCHESTRATION ROUTE (stage 1) — the write primitive and a column CHECK
 *     REJECT a mode that contradicts the source route (conclude→finalising, recover→remediating, escalate→escalating).
 *   • THE LEAD IS THE DETERMINISTIC FOLD OF THE MODE (stage 2) — the write primitive and a column CHECK REJECT a lead
 *     that contradicts its mode (finalising→conversation_conclusion, remediating→recovery_handling,
 *     escalating→human_attention).
 *   • THE PLAN IS SINGLE-CAPABILITY — the write primitive and a column CHECK REJECT a `participant_count` other than 1
 *     (the first, lifecycle implementation coordinates exactly one capability).
 *   • THE FULFILMENT PRESENCE IS COHERENT WITH THE SOURCE STATE (inherited transitively) — a `retained` coordination
 *     carrying a `fulfilment_id`, or a `closed`/`escalated` coordination carrying none, is rejected.
 *   • THE LEDGER IS APPEND-ONLY — UPDATE and DELETE are rejected even for service_role.
 *   • THE LEDGER IS SERVICE-ROLE-ONLY (RLS:hq) — anon cannot read it, insert into it, call the write primitive, or call
 *     the coordination-context reader.
 *   • THE VOCABULARY, THE FOLDS AND THE FIELD SHAPES ARE PINNED — a coordination type/outcome/mode/lead/route/lifecycle
 *     state outside its set, a malformed expected booking field, a missing job type, an absent orchestration or Human
 *     Review provenance id, or a status other than 'coordinated' is rejected.
 *   • THE READER CENTRES ON THE ORCHESTRATION LEDGER — it returns the RECORDED orchestration behind a held reply (the
 *     input the runtime coordinates), and returns nothing when no orchestration was routed.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly in CI if the
 * database is missing. All eight receptionist ledgers exercised here (R29 authorisations, R30 fulfilments, R31
 * verifications, R32 recoveries, R33 resolutions, R34 lifecycles, R35 orchestrations, R36 coordinations) are append-only
 * (even service_role cannot DELETE), so these tests intentionally leave their rows behind — harmless in the ephemeral CI
 * database, and proving exactly that is one of the tests below. Rows are addressed by a per-call orchestration id so each
 * assertion sees only its own writes. No FK'd tenant rows are created, so no teardown is required.
 */

// receptionist_conversation_coordinations / record_receptionist_conversation_coordination /
// find_receptionist_coordination_context are service-role-only internals, NOT in the generated Database types. Cast to
// the minimal surface this suite exercises (the same `as unknown as` convention the orchestration / lifecycle / resolution
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
type CoordinationTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type CoordinationClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): CoordinationTable;
};

const TABLE = "receptionist_conversation_coordinations";
const RPC = "record_receptionist_conversation_coordination";
const READER = "find_receptionist_coordination_context";
const CALLER = "+447700900123";
const PHONE = "+447700900123";
const JOB = "plumbing";
const POSTCODE = "SW1A 1AA";

const svc = (): CoordinationClient => serviceClient() as unknown as CoordinationClient;
const anon = (): CoordinationClient => anonClient() as unknown as CoordinationClient;

// The columns every assertion below reads back — the full captured coordination record.
const COLUMNS =
  "id, org_id, conversation_id, enquiry_id, lead_id, customer_ref, correlation_id, action_id, execution_id, " +
  "orchestration_id, lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, " +
  "review_audit_id, sent_audit_id, review_resolution_id, coordination_type, coordination_outcome, coordination_mode, " +
  "lead_participant, participant_count, requires_human, autonomous, orchestration_route, lifecycle_state, " +
  "approval_state, job_type, postcode, phone_number, status, metadata";

// A valid RPC payload for a `closed` coordinate_lifecycle_response (a `finalising`/`conversation_conclusion`
// coordination) — spread and overridden per case. `closed` routes `conclude`, which folds to mode `finalising`, which
// folds to lead `conversation_conclusion`; `requires_human`=false and `autonomous`=true (the lead is not human_attention)
// and, via the fulfilment-coherence CHECK, a NON-NULL fulfilment_id (a `closed` lifecycle means the operation WAS
// recorded) — so the valid baseline carries one.
const validRpcArgs = () => ({
  p_org_id: crypto.randomUUID(),
  p_orchestration_id: crypto.randomUUID(),
  p_lifecycle_id: crypto.randomUUID(),
  p_resolution_id: crypto.randomUUID(),
  p_recovery_id: crypto.randomUUID(),
  p_authorisation_id: crypto.randomUUID(),
  p_verification_id: crypto.randomUUID(),
  p_coordination_type: "coordinate_lifecycle_response",
  p_coordination_outcome: "conversation_response_coordinated",
  p_coordination_mode: "finalising",
  p_lead_participant: "conversation_conclusion",
  p_participant_count: 1,
  p_requires_human: false,
  p_autonomous: true,
  p_orchestration_route: "conclude",
  p_lifecycle_state: "closed",
  p_approval_state: "approved",
  p_correlation_id: crypto.randomUUID(),
  p_review_audit_id: crypto.randomUUID(),
  p_sent_audit_id: crypto.randomUUID(),
  p_review_resolution_id: crypto.randomUUID(),
  p_fulfilment_id: crypto.randomUUID() as string | null,
  p_job_type: JOB,
  p_postcode: POSTCODE,
  p_phone_number: PHONE,
});

// A valid RPC payload for a `retained` coordination (a `remediating`/`recovery_handling` plan) — route='recover',
// mode='remediating', lead='recovery_handling', requires_human=false, autonomous=true, fulfilment_id NULL (the
// fulfilment-coherence CHECK). Used for the coherence NEGATIVE cases that must start coherent.
const remediatingRpcArgs = () => ({
  ...validRpcArgs(),
  p_coordination_mode: "remediating",
  p_lead_participant: "recovery_handling",
  p_orchestration_route: "recover",
  p_lifecycle_state: "retained",
  p_fulfilment_id: null as string | null,
});

// A valid RPC payload for an `escalated` coordination (an `escalating`/`human_attention` plan) — route='escalate',
// mode='escalating', lead='human_attention', requires_human=true, autonomous=false, fulfilment_id NON-NULL. Used for the
// coherence NEGATIVE cases that must start coherent.
const escalatingRpcArgs = () => ({
  ...validRpcArgs(),
  p_coordination_mode: "escalating",
  p_lead_participant: "human_attention",
  p_orchestration_route: "escalate",
  p_lifecycle_state: "escalated",
  p_requires_human: true,
  p_autonomous: false,
});

// A valid direct-insert row (every NOT NULL column present, every field well-formed, all folds coherent) — used ONLY for
// the NEGATIVE cases (overridden to trip a CHECK) and the anon-denial case.
const validInsertRow = () => ({
  org_id: crypto.randomUUID(),
  orchestration_id: crypto.randomUUID(),
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
  coordination_type: "coordinate_lifecycle_response",
  coordination_outcome: "conversation_response_coordinated",
  coordination_mode: "finalising",
  lead_participant: "conversation_conclusion",
  participant_count: 1,
  requires_human: false,
  autonomous: true,
  orchestration_route: "conclude",
  lifecycle_state: "closed",
  approval_state: "approved",
  job_type: JOB,
  postcode: POSTCODE,
  phone_number: PHONE,
});

/**
 * Resolve a REAL `approve_booking` decision through the pure cores, so the state + flags ALWAYS match the deterministic
 * fold of the eligibility they are recorded with. `allow`+live ⇒ pending (fulfillable, so verifiable, so recoverable,
 * so resolvable, so governable, so orchestratable, so coordinatable); `block` ⇒ foreclosed (never fulfillable, so never
 * coordinatable).
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

/** Read every coordination row filed for one orchestration id, as service_role (ground truth). */
function rowsForOrchestration(orchestrationId: string): Filterable<Record<string, unknown>[]> {
  return svc().from(TABLE).select(COLUMNS).eq("orchestration_id", orchestrationId);
}

/** Read the RECORDED R35 orchestration row's provenance (the ground truth the coordination threads VERBATIM). */
function orchestrationProvenance(orchestrationId: string): Filterable<Record<string, unknown>[]> {
  return svc()
    .from("receptionist_conversation_orchestrations")
    .select(
      "lifecycle_id, resolution_id, recovery_id, authorisation_id, verification_id, fulfilment_id, " +
        "sent_audit_id, review_resolution_id, correlation_id, conversation_id, enquiry_id, lead_id, customer_ref, action_id, execution_id",
    )
    .eq("id", orchestrationId);
}

/** Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard privilege error or an
 *  RLS-filtered empty set. A returned row is the only failure. */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

/** Drive the full R29→R34 chain for a held reply so R34 has RECORDED a lifecycle the Orchestration Engine can route.
 *  Returns the govern handle's lifecycle id. `divergentTrade` seeds an inconsistent fulfilment (escalated path);
 *  `performFulfilment=false` skips R30 (retained path); the default is the terminal → closed path. */
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
    // reconcile → R33 unresolved → R34 escalate/escalated → R35 escalate/human_attention.
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
    // The matching fulfilment → R31 consistent → R32 none → R33 terminal → R34 close/closed → R35 conclude.
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

/** Drive the full R29→R35 chain: govern the lifecycle, then ROUTE it through the real `orchestrateConversationLifecycle`,
 *  so R35 has RECORDED an orchestration the Coordination Engine can coordinate. Returns the orchestration id (R36's
 *  anchor + idempotency key), the lifecycle id, the lifecycle state and the orchestration route. */
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
  return {
    orchestrationId: orchestrated?.orchestration_id as string,
    lifecycleId,
    lifecycleState,
    orchestrationRoute: orchestrated?.orchestration_route as string,
  };
}

describeIntegration(
  "Conversation Coordination pipeline · receptionist_conversation_coordinations (R36)",
  () => {
    it("coordinateConversationLifecycle coordinates `finalising`/`conversation_conclusion` for a `closed` lifecycle — files EXACTLY ONE row threaded to the full provenance", async () => {
      // Seed the full R29→R30→R31→R32→R33→R34→R35 chain so the recorded orchestration the Coordination Engine reads is
      // genuine.
      const orgId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const enquiryId = crypto.randomUUID();
      const leadId = crypto.randomUUID();
      const actionId = crypto.randomUUID();
      const executionId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();

      const { orchestrationId, lifecycleId, lifecycleState, orchestrationRoute } = await orchestrateThroughStack({
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

      // The R35 orchestration row carries the sent-reply + human-grant anchors the Coordination Engine threads VERBATIM:
      // the runtime reads the RECORDED orchestration and copies its provenance, it never re-uses the coordination
      // trigger's own sent/resolution ids. Capture them as the provenance ground truth the coordination row must match.
      const provRead = await orchestrationProvenance(orchestrationId);
      expect(provRead.error, provRead.error?.message).toBeNull();
      const recordedOrchestration = provRead.data?.[0] ?? {};

      // THE COORDINATION — the runtime reads R35's recorded orchestration, coordinates the `conclude` routing, and records
      // the mode + lead. `conclude` ⇒ `finalising`/`conversation_conclusion`, requires_human=false, autonomous=true. The
      // trigger's sent / resolution ids are DELIBERATELY fresh (not the recorded ones) to prove the runtime threads from
      // the record.
      const sentAuditId = crypto.randomUUID();
      const reviewResolutionId = crypto.randomUUID();
      const coordinated = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: sentAuditId,
        review_resolution_id: reviewResolutionId,
      });
      expect(coordinated, "the orchestrated conversation's response was coordinated").not.toBeNull();
      expect(coordinated?.coordination_type).toBe("coordinate_lifecycle_response");
      expect(coordinated?.coordination_outcome).toBe("conversation_response_coordinated");
      expect(coordinated?.coordination_mode).toBe("finalising");
      expect(coordinated?.lead_participant).toBe("conversation_conclusion");
      expect(coordinated?.participant_count).toBe(1);
      expect(coordinated?.requires_human).toBe(false);
      expect(coordinated?.autonomous).toBe(true);
      expect(coordinated?.orchestration_route).toBe("conclude");
      expect(coordinated?.lifecycle_state).toBe("closed");

      // EXACTLY ONE row — not zero, not two. Keyed by the R35 orchestration's id (R36's anchor + idempotency key).
      const read = await rowsForOrchestration(orchestrationId);
      expect(read.error, read.error?.message).toBeNull();
      expect(read.data).toHaveLength(1);

      const row = read.data?.[0] ?? {};
      // The runtime's returned handle is the real stored row.
      expect(row.id).toBe(coordinated?.coordination_id);
      // The coordinated disposition is captured verbatim, with every anchor that threads it to who and what it concerns.
      expect(row.org_id).toBe(orgId);
      expect(row.orchestration_id).toBe(orchestrationId); // the orchestration it was coordinated from (anchor + idempotency key)
      expect(row.lifecycle_id).toBe(lifecycleId); // the lifecycle that orchestration was routed from
      expect(row.lifecycle_id).toBe(recordedOrchestration.lifecycle_id);
      expect(row.resolution_id).toBe(recordedOrchestration.resolution_id); // the resolution the lifecycle was governed from
      expect(row.recovery_id).toBe(recordedOrchestration.recovery_id); // the recovery the resolution was determined from
      expect(row.authorisation_id).toBe(recordedOrchestration.authorisation_id); // the authorisation the recovery traced
      expect(row.verification_id).toBe(recordedOrchestration.verification_id); // the verification the recovery classified
      expect(row.fulfilment_id).toBe(recordedOrchestration.fulfilment_id); // the fulfilment the verification reconciled
      expect(row.review_audit_id).toBe(reviewAuditId); // the held reply a human approved
      expect(row.sent_audit_id).toBe(recordedOrchestration.sent_audit_id); // threaded from the recorded orchestration, NOT the trigger
      expect(row.review_resolution_id).toBe(recordedOrchestration.review_resolution_id); // threaded from the recorded orchestration
      // ...and the trigger's own ids were NOT copied onto the row — provenance follows the record, never the caller.
      expect(row.sent_audit_id).not.toBe(sentAuditId);
      expect(row.review_resolution_id).not.toBe(reviewResolutionId);
      // The anchors threaded THROUGH the recorded orchestration the reader coordinated.
      expect(row.correlation_id).toBe(correlationId);
      expect(row.conversation_id).toBe(conversationId);
      expect(row.enquiry_id).toBe(enquiryId);
      expect(row.lead_id).toBe(leadId);
      expect(row.customer_ref).toBe(CALLER);
      expect(row.action_id).toBe(actionId);
      expect(row.execution_id).toBe(executionId);
      // WHAT was coordinated, the mode, the lead, the plan, the flags, the source route + lifecycle state, and the
      // EXPECTED payload.
      expect(row.coordination_type).toBe("coordinate_lifecycle_response");
      expect(row.coordination_outcome).toBe("conversation_response_coordinated");
      expect(row.coordination_mode).toBe("finalising");
      expect(row.lead_participant).toBe("conversation_conclusion");
      expect(row.participant_count).toBe(1);
      expect(row.requires_human).toBe(false);
      expect(row.autonomous).toBe(true);
      expect(row.orchestration_route).toBe("conclude");
      expect(row.lifecycle_state).toBe("closed");
      expect(row.job_type).toBe(JOB);
      expect(row.postcode).toBe(POSTCODE);
      expect(row.phone_number).toBe(PHONE);
      // APPROVED + COORDINATED BY CONSTRUCTION — the grant that authorised the operation, and the coordinated status.
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("coordinated");
    });

    it("coordinates `remediating`/`recovery_handling` for a `retained` lifecycle (the operation went unrecorded)", async () => {
      // Seed a PENDING approve_booking, DO NOT perform R30 — R31 verifies `missing`, R32 recovers `reinstate`, R33
      // resolves `recoverable`, R34 governs `retain`/`retained`, R35 routes `recover`/`recovery_handling`. The
      // Coordination Engine coordinates it `remediating`/`recovery_handling` with fulfilment_id NULL, autonomous.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const { orchestrationId, lifecycleState, orchestrationRoute } = await orchestrateThroughStack({
        orgId,
        reviewAuditId,
        performFulfilment: false,
      });
      expect(lifecycleState).toBe("retained");
      expect(orchestrationRoute).toBe("recover");

      const coordinated = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(coordinated, "a recover orchestration is coordinated to remediate").not.toBeNull();
      expect(coordinated?.coordination_mode).toBe("remediating");
      expect(coordinated?.lead_participant).toBe("recovery_handling");
      expect(coordinated?.requires_human).toBe(false);
      expect(coordinated?.autonomous).toBe(true);

      const read = await rowsForOrchestration(orchestrationId);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.coordination_mode).toBe("remediating");
      expect(row.lead_participant).toBe("recovery_handling");
      expect(row.requires_human).toBe(false);
      expect(row.autonomous).toBe(true);
      expect(row.participant_count).toBe(1);
      expect(row.orchestration_route).toBe("recover");
      expect(row.lifecycle_state).toBe("retained");
      // The coherence invariant, observed end-to-end: a `retained` disposition carries NO fulfilment_id.
      expect(row.fulfilment_id).toBeNull();
      expect(row.orchestration_id).toBe(orchestrationId);
      expect(row.approval_state).toBe("approved");
      expect(row.status).toBe("coordinated");
    });

    it("coordinates `escalating`/`human_attention` for an `escalated` lifecycle (the record diverges from the decision)", async () => {
      // Seed a PENDING approve_booking for JOB=plumbing, file a DIVERGENT R30 fulfilment (a different trade), so R31
      // verifies `inconsistent`, R32 recovers `reconcile`, R33 resolves `unresolved`, R34 governs `escalate`/`escalated`
      // and R35 routes `escalate`/`human_attention`. The Coordination Engine coordinates it `escalating`/`human_attention`,
      // requiring a human.
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      const { orchestrationId, lifecycleState, orchestrationRoute } = await orchestrateThroughStack({
        orgId,
        reviewAuditId,
        divergentTrade: true,
      });
      expect(lifecycleState).toBe("escalated");
      expect(orchestrationRoute).toBe("escalate");

      const coordinated = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(coordinated, "an escalate orchestration is coordinated to escalate to a human").not.toBeNull();
      expect(coordinated?.coordination_mode).toBe("escalating");
      expect(coordinated?.lead_participant).toBe("human_attention");
      expect(coordinated?.requires_human).toBe(true);
      expect(coordinated?.autonomous).toBe(false);

      const read = await rowsForOrchestration(orchestrationId);
      expect(read.data).toHaveLength(1);
      const row = read.data?.[0] ?? {};
      expect(row.coordination_mode).toBe("escalating");
      expect(row.lead_participant).toBe("human_attention");
      expect(row.requires_human).toBe(true);
      expect(row.autonomous).toBe(false);
      expect(row.orchestration_route).toBe("escalate");
      expect(row.lifecycle_state).toBe("escalated");
      // An escalation is still coordinated from a PRESENT record — the coherence invariant: fulfilment_id is set.
      expect(row.fulfilment_id).not.toBeNull();
      // The row records the EXPECTED payload (the decision's), not the divergent recorded one.
      expect(row.job_type).toBe(JOB);
    });

    it("HUMAN REVIEW IS THE ONLY KEY — a FORECLOSED authorisation is never orchestrated, so never coordinated", async () => {
      // A policy-/org-blocked booking folds to FORECLOSED at R29 → never fulfilled → never verified → never recovered →
      // never resolved → never governed → never orchestrated → the coordination-context reader finds no orchestration →
      // the runtime coordinates NOTHING.
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

      // (Even if a send fired the whole chain, nothing governs, so nothing orchestrates — so nothing coordinates.)
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
      await orchestrateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      const result = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result, "a foreclosed authorisation is never coordinated").toBeNull();
    });

    it("a NON-ORCHESTRATED reply coordinates nothing — no recorded orchestration behind the held reply", async () => {
      // The common case: the held reply was an ordinary review, not a booking approval. No orchestration was routed, so
      // the runtime returns null and files no row.
      const result = await coordinateConversationLifecycle({
        org_id: crypto.randomUUID(),
        review_audit_id: crypto.randomUUID(), // no orchestration behind this held reply
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      expect(result).toBeNull();
    });

    it("is IDEMPOTENT — re-driving the same routed orchestration coordinates AT MOST ONCE", async () => {
      const orgId = crypto.randomUUID();
      const reviewAuditId = crypto.randomUUID();
      // Orchestrate once (as retained; the disposition is immaterial to idempotency).
      const { orchestrationId } = await orchestrateThroughStack({ orgId, reviewAuditId, performFulfilment: false });

      const first = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });
      // A retried review-send / double-fire — DIFFERENT sent + resolution ids, SAME recorded orchestration.
      const second = await coordinateConversationLifecycle({
        org_id: orgId,
        review_audit_id: reviewAuditId,
        sent_audit_id: crypto.randomUUID(),
        review_resolution_id: crypto.randomUUID(),
      });

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // The SAME id — the second call coordinated nothing; ON CONFLICT (orchestration_id) returned the existing row.
      expect(second?.coordination_id).toBe(first?.coordination_id);

      const read = await rowsForOrchestration(orchestrationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(first?.coordination_id);
    });

    it("the write primitive files a coordination and is idempotent on the orchestration id (direct RPC)", async () => {
      const orchestrationId = crypto.randomUUID();
      const first = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_id: orchestrationId });
      expect(first.error, first.error?.message).toBeNull();
      expect(first.data, "the primitive returns the coordination id").toBeTruthy();

      // A repeat with the SAME orchestration id (different provenance) returns the SAME id and files no second row.
      const second = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_orchestration_id: orchestrationId,
        p_sent_audit_id: crypto.randomUUID(),
      });
      expect(second.error, second.error?.message).toBeNull();
      expect(second.data).toBe(first.data);

      const read = await svc()
        .from(TABLE)
        .select("id, approval_state, status, coordination_mode, lead_participant, participant_count, requires_human, autonomous")
        .eq("orchestration_id", orchestrationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.approval_state).toBe("approved");
      expect(read.data?.[0]?.status).toBe("coordinated");
      expect(read.data?.[0]?.coordination_mode).toBe("finalising");
      expect(read.data?.[0]?.lead_participant).toBe("conversation_conclusion");
      expect(read.data?.[0]?.participant_count).toBe(1);
      expect(read.data?.[0]?.requires_human).toBe(false);
      expect(read.data?.[0]?.autonomous).toBe(true);
    });

    it("the APPROVAL is unbypassable — a state other than 'approved' is rejected (RPC and column CHECK)", async () => {
      // Inherited transitively from R35 → R34 → R33 → R32 → R31 → R30: a coordination can ONLY exist for an approved authorisation.
      for (const state of ["pending", "rejected", "foreclosed"]) {
        const rpc = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_approval_state: state });
        expect(rpc.error, `approval_state=${state} must be rejected (Human Review may not be bypassed)`).not.toBeNull();
      }
      const insertUnapproved = await svc().from(TABLE).insert({ ...validInsertRow(), approval_state: "pending" });
      expect(
        insertUnapproved.error,
        "the approval_state CHECK rejects an un-approved coordination, even for service_role",
      ).not.toBeNull();
    });

    it("THE KEYSTONE — requires_human/autonomous flags are coherent with the lead (RPC and CHECK)", async () => {
      // A `conversation_conclusion` lead claiming it requires a human is rejected by the RPC's requires-human-coherence…
      const concludeRequiresHuman = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_requires_human: true });
      expect(concludeRequiresHuman.error, "a conversation_conclusion lead claiming requires_human=true must be rejected").not.toBeNull();

      // …and a `human_attention` lead claiming it does NOT require a human is rejected too.
      const escalateNotRequiresHuman = await svc().rpc<string>(RPC, { ...escalatingRpcArgs(), p_requires_human: false });
      expect(escalateNotRequiresHuman.error, "a human_attention lead claiming requires_human=false must be rejected").not.toBeNull();

      // A `conversation_conclusion` lead claiming it is NOT autonomous is rejected…
      const concludeNotAutonomous = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_autonomous: false });
      expect(concludeNotAutonomous.error, "a conversation_conclusion lead claiming autonomous=false must be rejected").not.toBeNull();

      // …and a `human_attention` lead claiming it IS autonomous is rejected.
      const escalateAutonomous = await svc().rpc<string>(RPC, { ...escalatingRpcArgs(), p_autonomous: true });
      expect(escalateAutonomous.error, "a human_attention lead claiming autonomous=true must be rejected").not.toBeNull();

      // The column CHECKs enforce the same equivalences on a direct service_role insert.
      const insertBadRequiresHuman = await svc().from(TABLE).insert({ ...validInsertRow(), requires_human: true });
      expect(
        insertBadRequiresHuman.error,
        "the requires-human-coherence CHECK rejects requires_human=true on a conversation_conclusion lead, even for service_role",
      ).not.toBeNull();
      const insertBadAutonomous = await svc().from(TABLE).insert({ ...validInsertRow(), autonomous: false });
      expect(
        insertBadAutonomous.error,
        "the autonomous-coherence CHECK rejects autonomous=false on a conversation_conclusion lead, even for service_role",
      ).not.toBeNull();
    });

    it("THE MODE FOLD (stage 1) — the mode is the deterministic fold of the orchestration route (RPC and CHECK)", async () => {
      // `conclude` folds to `finalising` ONLY — a `conclude` route with mode `remediating` is rejected (lead kept coherent
      // with the wrong mode so ONLY the mode fold is violated)…
      const concludeRemediating = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_coordination_mode: "remediating",
        p_lead_participant: "recovery_handling",
      });
      expect(concludeRemediating.error, "conclude must fold to finalising, not remediating").not.toBeNull();

      // …and a `recover` route with mode `finalising` is rejected (lead + fulfilment kept coherent with the wrong mode).
      const recoverFinalising = await svc().rpc<string>(RPC, {
        ...remediatingRpcArgs(),
        p_coordination_mode: "finalising",
        p_lead_participant: "conversation_conclusion",
      });
      expect(recoverFinalising.error, "recover must fold to remediating, not finalising").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadMode = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), coordination_mode: "remediating", lead_participant: "recovery_handling" });
      expect(
        insertBadMode.error,
        "the mode-fold CHECK rejects conclude + remediating, even for service_role",
      ).not.toBeNull();
    });

    it("THE LEAD FOLD (stage 2) — the lead is the deterministic fold of the mode (RPC and CHECK)", async () => {
      // `finalising` folds to `conversation_conclusion` ONLY — a `finalising` mode with lead `recovery_handling` is
      // rejected (mode + route + flags kept coherent, so ONLY the lead fold is violated; recovery_handling is non-human, so
      // the requires_human/autonomous flags stay coherent)…
      const finalisingWrongLead = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_lead_participant: "recovery_handling",
      });
      expect(finalisingWrongLead.error, "finalising must fold to conversation_conclusion, not recovery_handling").not.toBeNull();

      // The column CHECK enforces the same fold on a direct service_role insert.
      const insertBadLead = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), lead_participant: "recovery_handling" });
      expect(
        insertBadLead.error,
        "the lead-fold CHECK rejects finalising + recovery_handling, even for service_role",
      ).not.toBeNull();
    });

    it("THE PLAN is single-capability — a participant_count other than 1 is rejected (RPC and CHECK)", async () => {
      // The first, lifecycle implementation coordinates EXACTLY ONE capability (the lead participates).
      const twoParticipants = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_participant_count: 2 });
      expect(twoParticipants.error, "a participant_count of 2 must be rejected (single-capability plan)").not.toBeNull();
      const zeroParticipants = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_participant_count: 0 });
      expect(zeroParticipants.error, "a participant_count of 0 must be rejected (single-capability plan)").not.toBeNull();

      const insertBadCount = await svc().from(TABLE).insert({ ...validInsertRow(), participant_count: 2 });
      expect(
        insertBadCount.error,
        "the single-capability CHECK rejects participant_count <> 1, even for service_role",
      ).not.toBeNull();
    });

    it("THE FULFILMENT PRESENCE is coherent with the source state (inherited) — retained iff no fulfilment_id (RPC and CHECK)", async () => {
      // A `retained` coordination carrying a fulfilment_id is rejected…
      const retainedWithFulfilment = await svc().rpc<string>(RPC, {
        ...remediatingRpcArgs(),
        p_fulfilment_id: crypto.randomUUID(),
      });
      expect(
        retainedWithFulfilment.error,
        "a `retained` coordination carrying a fulfilment_id must be rejected",
      ).not.toBeNull();

      // …and a `closed` coordination with NO fulfilment_id is rejected.
      const closedWithoutFulfilment = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_fulfilment_id: null });
      expect(
        closedWithoutFulfilment.error,
        "a `closed` coordination with no fulfilment_id must be rejected",
      ).not.toBeNull();

      // A COHERENT `retained` (remediating, no fulfilment_id) is accepted — the state the engine exists to record.
      const coherentRetained = await svc().rpc<string>(RPC, { ...remediatingRpcArgs() });
      expect(coherentRetained.error, coherentRetained.error?.message).toBeNull();
      expect(coherentRetained.data).toBeTruthy();
    });

    it("the ledger is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
      const orchestrationId = crypto.randomUUID();
      const filed = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_id: orchestrationId });
      expect(filed.error, filed.error?.message).toBeNull();

      const updated = await svc()
        .from(TABLE)
        .update({ coordination_mode: "escalating" })
        .eq("orchestration_id", orchestrationId);
      expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

      const deleted = await svc().from(TABLE).delete().eq("orchestration_id", orchestrationId);
      expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

      const read = await rowsForOrchestration(orchestrationId);
      expect(read.data).toHaveLength(1);
      expect(read.data?.[0]?.id).toBe(filed.data);
      expect(read.data?.[0]?.coordination_mode).toBe("finalising");
    });

    it("is service-role-only (RLS:hq) — anon cannot read, insert, or call the write / reader primitives", async () => {
      const orchestrationId = crypto.randomUUID();
      await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_id: orchestrationId });

      const asService = await rowsForOrchestration(orchestrationId);
      expect(asService.error, asService.error?.message).toBeNull();
      expect(asService.data).toHaveLength(1);

      expectAnonDenied(await anon().from(TABLE).select("id").eq("orchestration_id", orchestrationId));

      const anonWrite = await anon().rpc<string>(RPC, { ...validRpcArgs() });
      expect(anonWrite.error, "anon must not be able to file a coordination").not.toBeNull();

      const anonRead = await anon().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: crypto.randomUUID(),
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(anonRead.error, "anon must not be able to read the coordination context").not.toBeNull();

      const anonInsert = await anon().from(TABLE).insert(validInsertRow());
      expect(anonInsert.error, "anon must not be able to insert into the ledger").not.toBeNull();
    });

    it("the database pins the vocabulary, the folds, the field shapes, the provenance and the coordinated status", async () => {
      // A coordination type outside {coordinate_lifecycle_response} is rejected.
      const badType = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_coordination_type: "coordinate_quote_response" });
      expect(badType.error, "a coordination type outside the vocabulary must be rejected").not.toBeNull();

      // An outcome outside {conversation_response_coordinated} is rejected.
      const badOutcome = await svc().rpc<string>(RPC, {
        ...validRpcArgs(),
        p_coordination_outcome: "conversation_response_executed",
      });
      expect(badOutcome.error, "an outcome outside the vocabulary must be rejected").not.toBeNull();

      // A mode outside {finalising, remediating, escalating} is rejected.
      const badMode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_coordination_mode: "resolving" });
      expect(badMode.error, "a mode outside the vocabulary must be rejected").not.toBeNull();

      // A lead outside {conversation_conclusion, recovery_handling, human_attention} is rejected.
      const badLead = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lead_participant: "queue_dispatch" });
      expect(badLead.error, "a lead outside the vocabulary must be rejected").not.toBeNull();

      // A source route outside {conclude, recover, escalate} is rejected.
      const badRoute = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_route: "reopen" });
      expect(badRoute.error, "a source route outside the vocabulary must be rejected").not.toBeNull();

      // A source lifecycle state outside {closed, retained, escalated} is rejected.
      const badState = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_state: "terminal" });
      expect(badState.error, "a lifecycle state outside the vocabulary must be rejected").not.toBeNull();

      // A coordination with a malformed expected number / postcode is rejected — the ledger never records an unringable
      // expectation.
      const badPhone = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_phone_number: "07700 900123" });
      expect(badPhone.error, "a malformed expected booking number must be rejected").not.toBeNull();
      const badPostcode = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_postcode: "ZZ" });
      expect(badPostcode.error, "a malformed expected postcode must be rejected").not.toBeNull();

      // A coordinate_lifecycle_response with NO expected job type is rejected (the RPC requires all three booking facts).
      const noJob = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_job_type: null });
      expect(noJob.error, "a coordination with no expected job type must be rejected").not.toBeNull();

      // The orchestration anchor and the full lifecycle/resolution/recovery/authorisation/verification + Human Review
      // provenance are MANDATORY.
      const noOrchestration = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_orchestration_id: null });
      expect(noOrchestration.error, "a coordination with no orchestration reference must be rejected").not.toBeNull();
      const noLifecycle = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_lifecycle_id: null });
      expect(noLifecycle.error, "a coordination with no lifecycle reference must be rejected").not.toBeNull();
      const noResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_resolution_id: null });
      expect(noResolution.error, "a coordination with no resolution reference must be rejected").not.toBeNull();
      const noRecovery = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_recovery_id: null });
      expect(noRecovery.error, "a coordination with no recovery reference must be rejected").not.toBeNull();
      const noAuthorisation = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_authorisation_id: null });
      expect(noAuthorisation.error, "a coordination with no authorisation reference must be rejected").not.toBeNull();
      const noVerification = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_verification_id: null });
      expect(noVerification.error, "a coordination with no verification reference must be rejected").not.toBeNull();
      const noReviewAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_audit_id: null });
      expect(noReviewAudit.error, "a coordination with no held-reply reference must be rejected").not.toBeNull();
      const noSentAudit = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_sent_audit_id: null });
      expect(noSentAudit.error, "a coordination with no sent-reply reference must be rejected").not.toBeNull();
      const noReviewResolution = await svc().rpc<string>(RPC, { ...validRpcArgs(), p_review_resolution_id: null });
      expect(noReviewResolution.error, "a coordination with no resolution reference must be rejected").not.toBeNull();

      // DETERMINISTIC BY CONSTRUCTION: a direct service_role insert whose outcome contradicts its type is rejected.
      const badFold = await svc()
        .from(TABLE)
        .insert({ ...validInsertRow(), coordination_outcome: "conversation_response_executed" });
      expect(badFold.error, "an outcome that contradicts the type must be rejected, even for service_role").not.toBeNull();

      // COORDINATED BY CONSTRUCTION: a direct service_role insert claiming any status but 'coordinated' is rejected.
      const badStatus = await svc().from(TABLE).insert({ ...validInsertRow(), status: "executed" });
      expect(badStatus.error, "a status other than 'coordinated' must be rejected by the CHECK").not.toBeNull();
    });

    it("the coordination-context reader centres on the orchestration ledger — returns the recorded orchestration, or nothing", async () => {
      const orgId = crypto.randomUUID();

      // A recorded orchestration behind held reply A (via the full R29→R35 chain, routed as `recover`/`recovery_handling`).
      const reviewA = crypto.randomUUID();
      const { orchestrationId, lifecycleId, lifecycleState, orchestrationRoute } = await orchestrateThroughStack({
        orgId,
        reviewAuditId: reviewA,
        performFulfilment: false,
      });
      expect(lifecycleState).toBe("retained");
      expect(orchestrationRoute).toBe("recover");

      const found = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: reviewA,
      });
      expect(found.error, found.error?.message).toBeNull();
      expect(found.data).toHaveLength(1);
      const oRow = found.data?.[0] ?? {};
      // The reader returns R35's RECORDED orchestration verbatim, so the runtime can reconstruct the decision.
      expect(oRow.orchestration_id).toBe(orchestrationId);
      expect(oRow.lifecycle_id).toBe(lifecycleId);
      expect(oRow.orchestration_type).toBe("orchestrate_lifecycle_response");
      expect(oRow.orchestration_outcome).toBe("conversation_response_orchestrated");
      expect(oRow.orchestration_route).toBe("recover");
      expect(oRow.orchestration_target).toBe("recovery_handling");
      expect(oRow.concluded).toBe(false);
      expect(oRow.active).toBe(true);
      expect(oRow.lifecycle_state).toBe("retained");
      expect(oRow.approval_state).toBe("approved");
      expect(oRow.job_type).toBe(JOB);
      expect(oRow.postcode).toBe(POSTCODE);
      expect(oRow.phone_number).toBe(PHONE);
      expect(oRow.fulfilment_id).toBeNull(); // retained → no fulfilment

      // A held reply B with NO recorded orchestration — the reader returns nothing.
      const none = await svc().rpc<Record<string, unknown>[]>(READER, {
        p_org_id: orgId,
        p_review_audit_id: crypto.randomUUID(),
      });
      expect(none.error, none.error?.message).toBeNull();
      expect(none.data ?? []).toHaveLength(0);
    });
  },
);

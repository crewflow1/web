// =====================================================================
// THE CONVERSATION COORDINATION READ MODEL — PURE CORE (CEO Directive #018, R37: CONVERSATION
// COORDINATION READ MODEL).
//
// R36 built the Conversation Coordination Engine — a pure core that COORDINATES a routed R35
// orchestration into a participation plan, and a runtime that files ONE idempotent row into the
// append-only `receptionist_conversation_coordinations` ledger. R37 is the FIRST CONSUMER of that
// recorded decision: the canonical read model over the coordination ledger. This module is its PURE
// CORE — the shape of one coordination read row, a pure PROJECTION that groups the flat view row into
// a structured record, and the single canonical ORDERING. It is the R37 analogue of the R11
// conversation read model's `orderTimeline` (lib → server split), for coordinations.
//
// IT READS THE DECISION — IT NEVER RE-DERIVES IT. This core RE-USES the R36 coordination vocabulary
// as TYPES only (ConversationCoordinationType / CoordinationOutcome / CoordinationMode /
// CoordinationParticipant / CoordinationLifecycleState) and the R35 OrchestrationRoute — the recorded
// decision's own vocabulary. It imports NO resolver, NO predicate and NO fold: it never calls
// `resolveConversationCoordination`, never re-runs `modeOf`, never recomputes a lead, never re-folds
// `requires_human` / `autonomous`. The mode, the lead participant, the participation plan and the
// flags are read STRAIGHT from the row exactly as the Coordination Engine recorded them. The
// Coordination Engine (and, transitively, Lifecycle, Resolution, Recovery, Verification, Fulfilment,
// Orchestration) remains the SOLE authority over the decision; this core only re-SHAPES it for
// reading. There is provably NO duplicate coordination logic here, and no execution path: it persists
// nothing, reaches no I/O, no clock, no RNG and no model — the same row always projects identically.
//
// THE PROJECTION IS A PURE SHAPE TRANSFORM. `projectCoordinationRecord` takes one flat
// {@link CoordinationReadRow} (exactly the columns the `receptionist_coordination_read_model` view
// returns) and groups it into a {@link CoordinationRecord}: the recorded DECISION, the EXPECTED
// booking, the six LINKED per-engine contexts (orchestration → lifecycle → resolution → recovery →
// verification → fulfilment, each NULL when its sibling row is absent — fulfilment legitimately is,
// when the lifecycle was `retained`), and the full PROVENANCE chain. It adds no field the row did not
// already carry; it only regroups. The linked-context values are surfaced as opaque references
// (`string` / `boolean`), NOT re-typed against each sibling engine's vocabulary — the read model
// exposes what the ledgers recorded, it does not re-derive any sibling decision.
//
// THE ORDER IS DEFINED ONCE. `compareCoordinationRecords` is a TOTAL order — newest coordination
// first (by `coordination_at`), then a stable tiebreak on `coordination_id` — so a set of
// coordinations always reconstructs in ONE identical order regardless of how the database returned
// the rows. `orderCoordinationRecords` applies it WITHOUT mutating its input. This is the read model's
// determinism guarantee, pinned as pure logic in the unit tier.
// =====================================================================

import type {
  ConversationCoordinationType,
  CoordinationOutcome,
  CoordinationMode,
  CoordinationParticipant,
  CoordinationLifecycleState,
} from "@/lib/receptionist/conversation-coordination";
import type { OrchestrationRoute } from "@/lib/receptionist/conversation-orchestration";

// ---------------------------------------------------------------------
// The RAW view row — exactly the columns `public.receptionist_coordination_read_model` returns.
// ---------------------------------------------------------------------

/**
 * One RAW row of the `receptionist_coordination_read_model` view — a recorded coordination with its
 * decision surfaced directly from the ledger and its linked per-engine context resolved (by
 * reference) at read time. Internal shape the reader selects and maps through
 * {@link projectCoordinationRecord}. The recorded-decision columns (mode / lead / flags / route /
 * lifecycle_state) carry the R36/R35 vocabulary exactly as recorded (CHECK-constrained, never null);
 * the linked-context columns are LEFT-joined, so they are nullable and surfaced as opaque references.
 */
export type CoordinationReadRow = {
  // Identity + full provenance chain.
  coordination_id: string;
  org_id: string;
  conversation_id: string | null;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
  correlation_id: string;
  action_id: string | null;
  execution_id: string | null;
  orchestration_id: string;
  lifecycle_id: string;
  resolution_id: string;
  recovery_id: string;
  authorisation_id: string;
  verification_id: string;
  fulfilment_id: string | null;
  review_audit_id: string;
  sent_audit_id: string;
  review_resolution_id: string;

  // The RECORDED coordination decision (verbatim from the ledger — never re-derived).
  coordination_type: ConversationCoordinationType;
  coordination_outcome: CoordinationOutcome;
  coordination_mode: CoordinationMode;
  lead_participant: CoordinationParticipant;
  participant_count: number;
  requires_human: boolean;
  autonomous: boolean;
  orchestration_route: OrchestrationRoute;
  lifecycle_state: CoordinationLifecycleState;
  approval_state: string;
  coordination_status: string;
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
  coordination_at: string;

  // Linked ORCHESTRATION context (R35).
  orchestration_type: string | null;
  orchestration_outcome: string | null;
  orchestration_target: string | null;
  orchestration_concluded: boolean | null;
  orchestration_active: boolean | null;
  orchestration_status: string | null;
  orchestration_at: string | null;

  // Linked LIFECYCLE context (R34).
  lifecycle_type: string | null;
  lifecycle_outcome: string | null;
  lifecycle_transition: string | null;
  lifecycle_closed: boolean | null;
  lifecycle_ongoing: boolean | null;
  lifecycle_status: string | null;
  lifecycle_at: string | null;

  // Linked RESOLUTION context (R33).
  resolution_type: string | null;
  resolution_outcome: string | null;
  resolution_state: string | null;
  resolution_terminal: boolean | null;
  resolution_intervention_required: boolean | null;
  resolution_recovery_classification: string | null;
  resolution_status: string | null;
  resolution_at: string | null;

  // Linked RECOVERY context (R32).
  recovery_type: string | null;
  recovery_outcome: string | null;
  recovery_classification: string | null;
  recovery_required: boolean | null;
  recovery_integrity: string | null;
  recovery_status: string | null;
  recovery_at: string | null;

  // Linked VERIFICATION context (R31).
  verification_type: string | null;
  verification_outcome: string | null;
  verification_integrity: string | null;
  verification_status: string | null;
  verification_at: string | null;

  // Linked FULFILMENT context (R30) — NULL exactly when the lifecycle was `retained` (MISSING).
  fulfilment_type: string | null;
  fulfilment_outcome: string | null;
  fulfilment_status: string | null;
  fulfilment_at: string | null;
};

// ---------------------------------------------------------------------
// The PROJECTED record — the grouped shape every coordination reader returns.
// ---------------------------------------------------------------------

/** The RECORDED coordination decision — surfaced verbatim from the ledger, never re-derived. */
export type CoordinationDecisionView = {
  type: ConversationCoordinationType;
  outcome: CoordinationOutcome;
  /** HOW the response is coordinated (`finalising` / `remediating` / `escalating`). */
  mode: CoordinationMode;
  /** The capability the coordinated response centres on (CONSUMED from R35's routed target). */
  lead_participant: CoordinationParticipant;
  /** The cardinality of the participation plan (1 for the lifecycle implementation). */
  participant_count: number;
  /** Whether the coordinated response requires a human (true iff the lead is `human_attention`). */
  requires_human: boolean;
  /** Whether the coordinated response is autonomous (true iff the lead is NOT `human_attention`). */
  autonomous: boolean;
  /** The SOURCE orchestration route the coordination coordinated (`conclude` / `recover` / `escalate`). */
  orchestration_route: OrchestrationRoute;
  /** The SOURCE lifecycle state (`closed` / `retained` / `escalated`). */
  lifecycle_state: CoordinationLifecycleState;
  /** The inherited approval state — CHECK-pinned to `approved` in the ledger. */
  approval_state: string;
  /** The ledger status — CHECK-pinned to `coordinated`. */
  status: string;
  /** When the coordination was recorded (ISO instant). */
  at: string;
};

/** The EXPECTED booking the coordination concerns — carried through from the recorded decision. */
export type CoordinationBookingView = {
  job_type: string | null;
  postcode: string | null;
  phone_number: string | null;
};

/** Linked R35 orchestration context — the routed disposition the coordination coordinated. */
export type OrchestrationContextView = {
  orchestration_id: string;
  type: string | null;
  outcome: string | null;
  target: string | null;
  concluded: boolean | null;
  active: boolean | null;
  status: string | null;
  at: string | null;
};

/** Linked R34 lifecycle context — the governed transition the orchestration routed. */
export type LifecycleContextView = {
  lifecycle_id: string;
  type: string | null;
  outcome: string | null;
  transition: string | null;
  closed: boolean | null;
  ongoing: boolean | null;
  status: string | null;
  at: string | null;
};

/** Linked R33 resolution context — the completion state the lifecycle was governed from. */
export type ResolutionContextView = {
  resolution_id: string;
  type: string | null;
  outcome: string | null;
  state: string | null;
  terminal: boolean | null;
  intervention_required: boolean | null;
  recovery_classification: string | null;
  status: string | null;
  at: string | null;
};

/** Linked R32 recovery context — the recovery classification the resolution was determined from. */
export type RecoveryContextView = {
  recovery_id: string;
  type: string | null;
  outcome: string | null;
  classification: string | null;
  required: boolean | null;
  integrity: string | null;
  status: string | null;
  at: string | null;
};

/** Linked R31 verification context — the integrity verdict the recovery classified. */
export type VerificationContextView = {
  verification_id: string;
  type: string | null;
  outcome: string | null;
  integrity: string | null;
  status: string | null;
  at: string | null;
};

/** Linked R30 fulfilment context — the performed booking; NULL when the lifecycle was `retained`. */
export type FulfilmentContextView = {
  fulfilment_id: string;
  type: string | null;
  outcome: string | null;
  status: string | null;
  at: string | null;
};

/** The full linked provenance chain — the id of every ledger the coordination was threaded to. */
export type CoordinationProvenance = {
  orchestration_id: string;
  lifecycle_id: string;
  resolution_id: string;
  recovery_id: string;
  authorisation_id: string;
  verification_id: string;
  fulfilment_id: string | null;
  review_audit_id: string;
  sent_audit_id: string;
  review_resolution_id: string;
  action_id: string | null;
  execution_id: string | null;
  enquiry_id: string | null;
  lead_id: string | null;
  customer_ref: string | null;
};

/**
 * One recorded coordination as every reader returns it — the RAW row regrouped into the recorded
 * DECISION, the EXPECTED booking, the six LINKED per-engine contexts, and the full PROVENANCE chain.
 * A pure regrouping of {@link CoordinationReadRow}: it adds no field the row did not carry and it
 * re-derives no decision.
 */
export type CoordinationRecord = {
  coordination_id: string;
  org_id: string;
  conversation_id: string | null;
  correlation_id: string;
  decision: CoordinationDecisionView;
  booking: CoordinationBookingView;
  context: {
    orchestration: OrchestrationContextView | null;
    lifecycle: LifecycleContextView | null;
    resolution: ResolutionContextView | null;
    recovery: RecoveryContextView | null;
    verification: VerificationContextView | null;
    fulfilment: FulfilmentContextView | null;
  };
  provenance: CoordinationProvenance;
};

// ---------------------------------------------------------------------
// PROJECTION — the pure shape transform from a raw view row to a grouped record.
// ---------------------------------------------------------------------

/**
 * Project one raw {@link CoordinationReadRow} into a {@link CoordinationRecord} — THE single place a
 * coordination read row is turned into the grouped shape consumers receive. Pure and total: it groups
 * the recorded decision, the booking, the six linked contexts and the provenance, RE-DERIVING NOTHING
 * (the mode, lead, plan and flags are read straight from the row exactly as recorded). Each linked
 * context is NULL when its sibling row is absent — the fulfilment context legitimately is, when the
 * coordination's lifecycle was `retained` (`fulfilment_id` is null); the other five are present for
 * any real coordination (their ids are NOT NULL on the ledger) but are guarded defensively all the
 * same, so a missing join can never throw. Deterministic — the same row always projects identically.
 */
export function projectCoordinationRecord(row: CoordinationReadRow): CoordinationRecord {
  return {
    coordination_id: row.coordination_id,
    org_id: row.org_id,
    conversation_id: row.conversation_id,
    correlation_id: row.correlation_id,
    decision: {
      type: row.coordination_type,
      outcome: row.coordination_outcome,
      mode: row.coordination_mode,
      lead_participant: row.lead_participant,
      participant_count: row.participant_count,
      requires_human: row.requires_human,
      autonomous: row.autonomous,
      orchestration_route: row.orchestration_route,
      lifecycle_state: row.lifecycle_state,
      approval_state: row.approval_state,
      status: row.coordination_status,
      at: row.coordination_at,
    },
    booking: {
      job_type: row.job_type,
      postcode: row.postcode,
      phone_number: row.phone_number,
    },
    context: {
      orchestration:
        row.orchestration_status === null
          ? null
          : {
              orchestration_id: row.orchestration_id,
              type: row.orchestration_type,
              outcome: row.orchestration_outcome,
              target: row.orchestration_target,
              concluded: row.orchestration_concluded,
              active: row.orchestration_active,
              status: row.orchestration_status,
              at: row.orchestration_at,
            },
      lifecycle:
        row.lifecycle_status === null
          ? null
          : {
              lifecycle_id: row.lifecycle_id,
              type: row.lifecycle_type,
              outcome: row.lifecycle_outcome,
              transition: row.lifecycle_transition,
              closed: row.lifecycle_closed,
              ongoing: row.lifecycle_ongoing,
              status: row.lifecycle_status,
              at: row.lifecycle_at,
            },
      resolution:
        row.resolution_status === null
          ? null
          : {
              resolution_id: row.resolution_id,
              type: row.resolution_type,
              outcome: row.resolution_outcome,
              state: row.resolution_state,
              terminal: row.resolution_terminal,
              intervention_required: row.resolution_intervention_required,
              recovery_classification: row.resolution_recovery_classification,
              status: row.resolution_status,
              at: row.resolution_at,
            },
      recovery:
        row.recovery_status === null
          ? null
          : {
              recovery_id: row.recovery_id,
              type: row.recovery_type,
              outcome: row.recovery_outcome,
              classification: row.recovery_classification,
              required: row.recovery_required,
              integrity: row.recovery_integrity,
              status: row.recovery_status,
              at: row.recovery_at,
            },
      verification:
        row.verification_status === null
          ? null
          : {
              verification_id: row.verification_id,
              type: row.verification_type,
              outcome: row.verification_outcome,
              integrity: row.verification_integrity,
              status: row.verification_status,
              at: row.verification_at,
            },
      fulfilment:
        row.fulfilment_id === null
          ? null
          : {
              fulfilment_id: row.fulfilment_id,
              type: row.fulfilment_type,
              outcome: row.fulfilment_outcome,
              status: row.fulfilment_status,
              at: row.fulfilment_at,
            },
    },
    provenance: {
      orchestration_id: row.orchestration_id,
      lifecycle_id: row.lifecycle_id,
      resolution_id: row.resolution_id,
      recovery_id: row.recovery_id,
      authorisation_id: row.authorisation_id,
      verification_id: row.verification_id,
      fulfilment_id: row.fulfilment_id,
      review_audit_id: row.review_audit_id,
      sent_audit_id: row.sent_audit_id,
      review_resolution_id: row.review_resolution_id,
      action_id: row.action_id,
      execution_id: row.execution_id,
      enquiry_id: row.enquiry_id,
      lead_id: row.lead_id,
      customer_ref: row.customer_ref,
    },
  };
}

// ---------------------------------------------------------------------
// ORDERING — the read model's single canonical order (defined in exactly one place).
// ---------------------------------------------------------------------

/**
 * The canonical coordination order — NEWEST coordination first (by `coordination_at`), then a stable
 * tiebreak on `coordination_id` (a TOTAL order) so two same-instant coordinations never swap between
 * reads. Compares INSTANTS (via `Date.parse`), never raw timestamp strings, so the same moment written
 * in different zone spellings ties and is decided by the id — exactly the R11 read model's guarantee,
 * inverted to newest-first for a coordination index. Pure and total; proven directly in the unit tier.
 */
export function compareCoordinationRecords(a: CoordinationRecord, b: CoordinationRecord): number {
  const ta = Date.parse(a.decision.at);
  const tb = Date.parse(b.decision.at);
  if (ta !== tb) return ta < tb ? 1 : -1; // larger instant (newer) first
  if (a.coordination_id !== b.coordination_id) return a.coordination_id < b.coordination_id ? 1 : -1;
  return 0;
}

/**
 * Return a NEW array of the records in canonical (newest-first) order. Non-mutating: it copies before
 * sorting, so a caller's array is never reordered under it. This is the single definition of "the
 * coordination order"; the SQL `order by` on the fetch is a consistency measure, this is the
 * authoritative projection order.
 */
export function orderCoordinationRecords(
  records: readonly CoordinationRecord[],
): CoordinationRecord[] {
  return [...records].sort(compareCoordinationRecords);
}

import type { CoordinationRecord } from "@/lib/receptionist/conversation-coordination-view";

// =====================================================================
// THE CONVERSATION WORKLIST DETAIL SURFACE — PRESENTATION (CEO Directive #018, R45: CONVERSATION
// WORKLIST DETAIL SURFACE).
//
// The Detail Surface is the single authorised read-only INSPECTION surface for one Conversation
// Worklist item. This module is its PURE presentation core — the surface's humanisation and its
// causal TIMELINE assembly, kept out of the JSX so they can be reasoned about and unit-tested on their
// own. It takes the R37 Coordination Read Model's {@link CoordinationRecord} (the authoritative,
// org-scoped single-item read the page performs through `getCoordinationById`) and RE-SHAPES it into a
// display-ready {@link CoordinationDetailView}: it labels the recorded coded facets, orders the linked
// per-engine contexts into a timeline, and lays out the provenance chain.
//
// IT RE-DERIVES NOTHING. The R37 read model surfaces the RECORDED decision verbatim; behind it the
// Coordination Engine (and Lifecycle, Resolution, Recovery, Verification, Fulfilment, Orchestration)
// remain the SOLE authority over every fact. This module never recomputes a mode, never re-folds a
// flag, never re-orders by anything but the fixed causal SEQUENCE below — it presents what the record
// carries. It reaches no I/O, no clock, no RNG and no database: the SAME record always projects to the
// SAME view. It imports the read model's TYPES only (erased at runtime); it names no reader, no engine,
// no ledger and no organisation. It is presentation CHROME with no read path and no execution path.
// =====================================================================

/** The placeholder shown for any absent (null / empty) value — the surface never invents a fact. */
const EM_DASH = "—";

/**
 * Render a coded facet token (a lower_snake / kebab enum the engines recorded — e.g. `human_attention`,
 * `finalising`, `retained`) as a capitalised phrase (`Human attention`, `Finalising`, `Retained`). An
 * absent or empty token collapses to the em dash. Pure and total — it re-labels, it re-derives nothing.
 */
export function humaniseToken(token: string | null | undefined): string {
  if (token === null || token === undefined) return EM_DASH;
  const spaced = token.replace(/[_-]+/g, " ").trim();
  if (spaced === "") return EM_DASH;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render a recorded boolean as `Yes` / `No`, or the em dash when the linked context did not carry it. */
export function formatBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  return value ? "Yes" : "No";
}

/** Render a literal data value (a booking's job type / postcode / phone, a provenance id) or the em dash. */
export function orDash(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? EM_DASH : value;
}

/**
 * Render an ISO-8601 instant as `YYYY-MM-DD HH:MM` by SLICING the calendar date and wall-clock minute
 * directly — never a `Date` parse — so the projection is deterministic and zone-stable (the same moment
 * always renders identically). An absent instant collapses to the em dash; a date-only value renders as
 * the date alone.
 */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return EM_DASH;
  const date = iso.slice(0, 10);
  const t = iso.indexOf("T");
  if (t === -1) return date;
  const time = iso.slice(t + 1, t + 6); // HH:MM
  return time ? `${date} ${time}` : date;
}

// ---------------------------------------------------------------------
// The display shapes the page binds — a labelled headline, a causal timeline, per-engine sections and
// the provenance chain. Every value is already presentation-ready; the page adds pixels, not logic.
// ---------------------------------------------------------------------

/** One labelled value in a detail grid — both sides already rendered by this module. */
export type DetailField = { readonly label: string; readonly value: string };

/**
 * One per-engine context rendered as a titled group of fields. `present` is false exactly when the
 * linked context row was absent (the fulfilment context legitimately is, on a `retained` lifecycle) —
 * the page shows an explicit "not recorded" note rather than an empty card.
 */
export type DetailSection = {
  readonly key: string;
  readonly title: string;
  readonly present: boolean;
  readonly fields: readonly DetailField[];
};

/**
 * One step of the causal timeline — a linked engine context (or the terminal coordination) rendered as
 * a labelled event. Carries only the four facets every context shares plus its own ledger reference; the
 * rich, facet-specific fields live in the matching {@link DetailSection}.
 */
export type TimelineStep = {
  readonly key: string;
  readonly label: string;
  readonly reference: string;
  readonly type: string;
  readonly outcome: string;
  readonly status: string;
  readonly at: string;
};

/** The recorded coordination DECISION, humanised — the "complete work item" headline. */
export type CoordinationHeadlineView = {
  readonly title: string;
  readonly type: string;
  readonly outcome: string;
  readonly mode: string;
  readonly leadParticipant: string;
  readonly participantCount: number;
  readonly requiresHuman: boolean;
  readonly autonomous: boolean;
  readonly orchestrationRoute: string;
  readonly lifecycleState: string;
  readonly approvalState: string;
  readonly status: string;
  readonly at: string;
};

/** The whole detail view the page renders — headline, booking, timeline, per-engine sections, provenance. */
export type CoordinationDetailView = {
  readonly coordinationId: string;
  readonly conversationId: string | null;
  readonly correlationId: string;
  readonly headline: CoordinationHeadlineView;
  readonly booking: {
    readonly jobType: string;
    readonly postcode: string;
    readonly phone: string;
  };
  readonly timeline: readonly TimelineStep[];
  readonly sections: readonly DetailSection[];
  readonly provenance: readonly DetailField[];
};

// ---------------------------------------------------------------------
// TIMELINE — the fixed causal order (oldest engine first). Encoded by the SEQUENCE of pushes, never a
// runtime sort: the booking is fulfilled, then verified, recovered, resolved, the lifecycle governed,
// orchestrated, and finally coordinated. A linked context that is absent is SKIPPED.
// ---------------------------------------------------------------------

/**
 * Assemble the causal timeline for one coordination — the linked per-engine contexts in the fixed order
 * fulfilment → verification → recovery → resolution → lifecycle → orchestration, then the coordination
 * decision itself as the terminal step. Each absent context is skipped (the fulfilment step is, when the
 * lifecycle was `retained`). The order is STRUCTURAL — the sequence of pushes — so the timeline is a pure
 * function of the record and never re-orders it.
 */
export function buildTimeline(record: CoordinationRecord): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const c = record.context;

  if (c.fulfilment) {
    steps.push({
      key: "fulfilment",
      label: "Fulfilment",
      reference: c.fulfilment.fulfilment_id,
      type: humaniseToken(c.fulfilment.type),
      outcome: humaniseToken(c.fulfilment.outcome),
      status: humaniseToken(c.fulfilment.status),
      at: formatInstant(c.fulfilment.at),
    });
  }
  if (c.verification) {
    steps.push({
      key: "verification",
      label: "Verification",
      reference: c.verification.verification_id,
      type: humaniseToken(c.verification.type),
      outcome: humaniseToken(c.verification.outcome),
      status: humaniseToken(c.verification.status),
      at: formatInstant(c.verification.at),
    });
  }
  if (c.recovery) {
    steps.push({
      key: "recovery",
      label: "Recovery",
      reference: c.recovery.recovery_id,
      type: humaniseToken(c.recovery.type),
      outcome: humaniseToken(c.recovery.outcome),
      status: humaniseToken(c.recovery.status),
      at: formatInstant(c.recovery.at),
    });
  }
  if (c.resolution) {
    steps.push({
      key: "resolution",
      label: "Resolution",
      reference: c.resolution.resolution_id,
      type: humaniseToken(c.resolution.type),
      outcome: humaniseToken(c.resolution.outcome),
      status: humaniseToken(c.resolution.status),
      at: formatInstant(c.resolution.at),
    });
  }
  if (c.lifecycle) {
    steps.push({
      key: "lifecycle",
      label: "Lifecycle",
      reference: c.lifecycle.lifecycle_id,
      type: humaniseToken(c.lifecycle.type),
      outcome: humaniseToken(c.lifecycle.outcome),
      status: humaniseToken(c.lifecycle.status),
      at: formatInstant(c.lifecycle.at),
    });
  }
  if (c.orchestration) {
    steps.push({
      key: "orchestration",
      label: "Orchestration",
      reference: c.orchestration.orchestration_id,
      type: humaniseToken(c.orchestration.type),
      outcome: humaniseToken(c.orchestration.outcome),
      status: humaniseToken(c.orchestration.status),
      at: formatInstant(c.orchestration.at),
    });
  }

  // The coordination decision is the terminal step — the culmination the six contexts fed.
  steps.push({
    key: "coordination",
    label: "Coordination",
    reference: record.coordination_id,
    type: humaniseToken(record.decision.type),
    outcome: humaniseToken(record.decision.outcome),
    status: humaniseToken(record.decision.status),
    at: formatInstant(record.decision.at),
  });

  return steps;
}

// ---------------------------------------------------------------------
// SECTIONS — one titled group per linked engine context, in the reference-chain order the coordination
// threads them (coordination → orchestration → lifecycle → resolution → recovery → verification →
// fulfilment). Each surfaces the facet's OWN recorded fields; an absent context renders as "not recorded".
// ---------------------------------------------------------------------

function orchestrationSection(record: CoordinationRecord): DetailSection {
  const o = record.context.orchestration;
  return {
    key: "orchestration",
    title: "Orchestration",
    present: o !== null,
    fields: o
      ? [
          { label: "Type", value: humaniseToken(o.type) },
          { label: "Outcome", value: humaniseToken(o.outcome) },
          { label: "Target", value: humaniseToken(o.target) },
          { label: "Concluded", value: formatBool(o.concluded) },
          { label: "Active", value: formatBool(o.active) },
          { label: "Status", value: humaniseToken(o.status) },
          { label: "Recorded", value: formatInstant(o.at) },
        ]
      : [],
  };
}

function lifecycleSection(record: CoordinationRecord): DetailSection {
  const l = record.context.lifecycle;
  return {
    key: "lifecycle",
    title: "Lifecycle",
    present: l !== null,
    fields: l
      ? [
          { label: "Transition", value: humaniseToken(l.transition) },
          { label: "Type", value: humaniseToken(l.type) },
          { label: "Outcome", value: humaniseToken(l.outcome) },
          { label: "Closed", value: formatBool(l.closed) },
          { label: "Ongoing", value: formatBool(l.ongoing) },
          { label: "Status", value: humaniseToken(l.status) },
          { label: "Recorded", value: formatInstant(l.at) },
        ]
      : [],
  };
}

function resolutionSection(record: CoordinationRecord): DetailSection {
  const r = record.context.resolution;
  return {
    key: "resolution",
    title: "Resolution",
    present: r !== null,
    fields: r
      ? [
          { label: "State", value: humaniseToken(r.state) },
          { label: "Type", value: humaniseToken(r.type) },
          { label: "Outcome", value: humaniseToken(r.outcome) },
          { label: "Terminal", value: formatBool(r.terminal) },
          { label: "Intervention required", value: formatBool(r.intervention_required) },
          { label: "Recovery classification", value: humaniseToken(r.recovery_classification) },
          { label: "Status", value: humaniseToken(r.status) },
          { label: "Recorded", value: formatInstant(r.at) },
        ]
      : [],
  };
}

function recoverySection(record: CoordinationRecord): DetailSection {
  const r = record.context.recovery;
  return {
    key: "recovery",
    title: "Recovery",
    present: r !== null,
    fields: r
      ? [
          { label: "Classification", value: humaniseToken(r.classification) },
          { label: "Type", value: humaniseToken(r.type) },
          { label: "Outcome", value: humaniseToken(r.outcome) },
          { label: "Required", value: formatBool(r.required) },
          { label: "Integrity", value: humaniseToken(r.integrity) },
          { label: "Status", value: humaniseToken(r.status) },
          { label: "Recorded", value: formatInstant(r.at) },
        ]
      : [],
  };
}

function verificationSection(record: CoordinationRecord): DetailSection {
  const v = record.context.verification;
  return {
    key: "verification",
    title: "Verification",
    present: v !== null,
    fields: v
      ? [
          { label: "Integrity", value: humaniseToken(v.integrity) },
          { label: "Type", value: humaniseToken(v.type) },
          { label: "Outcome", value: humaniseToken(v.outcome) },
          { label: "Status", value: humaniseToken(v.status) },
          { label: "Recorded", value: formatInstant(v.at) },
        ]
      : [],
  };
}

function fulfilmentSection(record: CoordinationRecord): DetailSection {
  const f = record.context.fulfilment;
  return {
    key: "fulfilment",
    title: "Fulfilment",
    present: f !== null,
    fields: f
      ? [
          { label: "Type", value: humaniseToken(f.type) },
          { label: "Outcome", value: humaniseToken(f.outcome) },
          { label: "Status", value: humaniseToken(f.status) },
          { label: "Recorded", value: formatInstant(f.at) },
        ]
      : [],
  };
}

/** The full provenance chain — every ledger id the coordination was threaded to, rendered for display. */
function provenanceFields(record: CoordinationRecord): DetailField[] {
  const p = record.provenance;
  return [
    { label: "Orchestration", value: orDash(p.orchestration_id) },
    { label: "Lifecycle", value: orDash(p.lifecycle_id) },
    { label: "Resolution", value: orDash(p.resolution_id) },
    { label: "Recovery", value: orDash(p.recovery_id) },
    { label: "Authorisation", value: orDash(p.authorisation_id) },
    { label: "Verification", value: orDash(p.verification_id) },
    { label: "Fulfilment", value: orDash(p.fulfilment_id) },
    { label: "Review audit", value: orDash(p.review_audit_id) },
    { label: "Sent audit", value: orDash(p.sent_audit_id) },
    { label: "Review resolution", value: orDash(p.review_resolution_id) },
    { label: "Action", value: orDash(p.action_id) },
    { label: "Execution", value: orDash(p.execution_id) },
    { label: "Enquiry", value: orDash(p.enquiry_id) },
    { label: "Lead", value: orDash(p.lead_id) },
    { label: "Customer ref", value: orDash(p.customer_ref) },
  ];
}

// ---------------------------------------------------------------------
// The whole projection — the one place a record becomes the page's view.
// ---------------------------------------------------------------------

/**
 * Project one {@link CoordinationRecord} into the presentation-ready {@link CoordinationDetailView} the
 * page binds — the humanised headline, the expected booking, the causal timeline, the six per-engine
 * sections (in reference-chain order) and the provenance chain. Pure and total: it labels and lays out
 * what the record carries, RE-DERIVING NOTHING. The same record always projects to the same view.
 */
export function projectCoordinationDetail(record: CoordinationRecord): CoordinationDetailView {
  const d = record.decision;
  return {
    coordinationId: record.coordination_id,
    conversationId: record.conversation_id,
    correlationId: record.correlation_id,
    headline: {
      title: humaniseToken(d.outcome),
      type: humaniseToken(d.type),
      outcome: humaniseToken(d.outcome),
      mode: humaniseToken(d.mode),
      leadParticipant: humaniseToken(d.lead_participant),
      participantCount: d.participant_count,
      requiresHuman: d.requires_human,
      autonomous: d.autonomous,
      orchestrationRoute: humaniseToken(d.orchestration_route),
      lifecycleState: humaniseToken(d.lifecycle_state),
      approvalState: humaniseToken(d.approval_state),
      status: humaniseToken(d.status),
      at: formatInstant(d.at),
    },
    booking: {
      jobType: orDash(record.booking.job_type),
      postcode: orDash(record.booking.postcode),
      phone: orDash(record.booking.phone_number),
    },
    timeline: buildTimeline(record),
    sections: [
      orchestrationSection(record),
      lifecycleSection(record),
      resolutionSection(record),
      recoverySection(record),
      verificationSection(record),
      fulfilmentSection(record),
    ],
    provenance: provenanceFields(record),
  };
}

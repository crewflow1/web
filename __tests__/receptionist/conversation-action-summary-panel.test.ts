import { describe, it, expect } from "vitest";
import { projectConversationActionSummary } from "@/lib/receptionist/conversation-action-summary-panel";
import type { CoordinationRecord } from "@/lib/receptionist/conversation-coordination-view";
import type { OwnershipTimelineView } from "@/lib/receptionist/conversation-ownership-timeline";

/**
 * Conversation Action Summary PANEL — pure display-model unit tests (the AI Receptionist Programme, R57: CONVERSATION ACTION
 * SUMMARY PANEL).
 *
 * The R57 SUMMARY CORE is a projection over the two authoritative views the Conversation Detail page has ALREADY read — the
 * R37 {@link CoordinationRecord} (the recorded coordination decision + its linked resolution context) and the R55
 * {@link OwnershipTimelineView} (the composed ownership projection). It re-shapes them into a single at-a-glance digest: the
 * current lifecycle, the current resolution, the current coordination mode, the human-required status, the current owner and
 * the ownership-history summary — each humanised. It reaches no I/O, holds no clock and DERIVES NO CONVERSATION STATE (every
 * fact is one of the two views'; this core re-decides none), so it is total, deterministic and dependency-free, and THAT is
 * what this suite pins:
 *   • projectConversationActionSummary — an R37 record + an R55 view → the summary's display model.
 *
 * The lifecycle / resolution / mode / human-required facts are COPIED from the recorded decision (never recomputed); the
 * owner + history facts are COPIED from the composed timeline view. This suite proves the copy + the humanisation + the
 * summary sentences — and, with a deliberately INCONSISTENT forged input, that the core trusts the views' flags rather than
 * re-deriving state.
 */

const EM_DASH = "—";
const AT = "2026-07-05T10:00:00.000Z";

/** A complete, well-typed R37 record — only `decision` + `context.resolution` drive the summary; the rest satisfies the shape. */
function coordinationRecord(overrides: {
  coordination_id?: string;
  conversation_id?: string | null;
  decision?: Partial<CoordinationRecord["decision"]>;
  resolution?: CoordinationRecord["context"]["resolution"];
} = {}): CoordinationRecord {
  return {
    coordination_id: overrides.coordination_id ?? "coord-1",
    org_id: "org-1",
    conversation_id: overrides.conversation_id === undefined ? "conv-1" : overrides.conversation_id,
    correlation_id: "corr-1",
    decision: {
      type: "coordinate_lifecycle_response",
      outcome: "conversation_response_coordinated",
      mode: "finalising",
      lead_participant: "conversation_conclusion",
      participant_count: 1,
      requires_human: false,
      autonomous: true,
      orchestration_route: "conclude",
      lifecycle_state: "closed",
      approval_state: "approved",
      status: "coordinated",
      at: AT,
      ...overrides.decision,
    },
    booking: { job_type: "plumbing", postcode: "SW1A 1AA", phone_number: "+447700900123" },
    context: {
      orchestration: null,
      lifecycle: null,
      resolution:
        overrides.resolution === undefined
          ? {
              resolution_id: "res-1",
              type: "resolve_completion",
              outcome: "conversation_resolved",
              state: "terminal",
              terminal: true,
              intervention_required: false,
              recovery_classification: null,
              status: "resolved",
              at: AT,
            }
          : overrides.resolution,
      recovery: null,
      verification: null,
      fulfilment: null,
    },
    provenance: {
      orchestration_id: "orch-1",
      lifecycle_id: "life-1",
      resolution_id: "res-1",
      recovery_id: "rec-1",
      authorisation_id: "auth-1",
      verification_id: "ver-1",
      fulfilment_id: null,
      review_audit_id: "rev-1",
      sent_audit_id: "sent-1",
      review_resolution_id: "revres-1",
      action_id: null,
      execution_id: null,
      enquiry_id: null,
      lead_id: null,
      customer_ref: null,
    },
  };
}

/** A complete, well-typed R55 view — the fields the summary copies are set directly; the rest satisfies the shape. */
function ownershipView(overrides: Partial<OwnershipTimelineView> = {}): OwnershipTimelineView {
  return {
    coordinationId: "coord-1",
    conversationId: "conv-1",
    status: "unowned",
    owned: false,
    currentOwner: null,
    reassigned: false,
    claimedAt: null,
    heldSince: null,
    entries: [],
    eventCount: 0,
    firstEventAt: null,
    lastEventAt: null,
    ...overrides,
  };
}

const ownedView = (label: string, reassigned: boolean): OwnershipTimelineView =>
  ownershipView({
    status: "owned",
    owned: true,
    currentOwner: { operatorId: "op-a", operatorEmail: label, label },
    reassigned,
    claimedAt: "2026-07-01T09:00:00.000Z",
    heldSince: reassigned ? "2026-07-02T09:00:00.000Z" : "2026-07-01T09:00:00.000Z",
    eventCount: reassigned ? 2 : 1,
    firstEventAt: "2026-07-01T09:00:00.000Z",
    lastEventAt: reassigned ? "2026-07-02T09:00:00.000Z" : "2026-07-01T09:00:00.000Z",
  });

describe("projectConversationActionSummary — the six at-a-glance facts, each copied from an authoritative view", () => {
  it("copies + humanises the lifecycle, resolution, coordination mode and human-required facts from the recorded decision", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownershipView(),
    });

    expect(summary.coordinationId).toBe("coord-1");
    expect(summary.conversationId).toBe("conv-1");

    expect(summary.lifecycle).toEqual({
      label: "Lifecycle",
      state: "closed",
      stateLabel: "Closed",
      summary: "The coordination lifecycle is recorded as Closed.",
    });
    expect(summary.resolution).toEqual({
      label: "Resolution",
      recorded: true,
      state: "terminal",
      stateLabel: "Terminal",
      summary: "The recorded resolution state is Terminal.",
    });
    expect(summary.coordination).toEqual({
      label: "Coordination mode",
      mode: "finalising",
      modeLabel: "Finalising",
      summary: "The response is coordinated in Finalising mode.",
    });
    expect(summary.humanRequired).toEqual({
      label: "Human required",
      required: false,
      statusLabel: "Not required",
      tone: "autonomous",
      summary: "This coordinated response is autonomous and requires no human attention.",
    });
  });

  it("marks the resolution UNRECORDED when the linked resolution context is absent", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({ resolution: null }),
      ownership: ownershipView(),
    });
    expect(summary.resolution).toEqual({
      label: "Resolution",
      recorded: false,
      state: null,
      stateLabel: EM_DASH,
      summary: "No resolution state has been recorded for this conversation.",
    });
  });

  it("marks the resolution UNRECORDED when the context is present but its state is null", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({
        resolution: {
          resolution_id: "res-1",
          type: null,
          outcome: null,
          state: null,
          terminal: null,
          intervention_required: null,
          recovery_classification: null,
          status: null,
          at: null,
        },
      }),
      ownership: ownershipView(),
    });
    expect(summary.resolution.recorded).toBe(false);
    expect(summary.resolution.state).toBeNull();
    expect(summary.resolution.stateLabel).toBe(EM_DASH);
  });

  it("reports the human-required status when the coordinated response requires a human", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({
        decision: { requires_human: true, autonomous: false, mode: "escalating", lifecycle_state: "escalated" },
      }),
      ownership: ownershipView(),
    });
    expect(summary.humanRequired).toEqual({
      label: "Human required",
      required: true,
      statusLabel: "Required",
      tone: "required",
      summary: "This coordinated response requires human attention.",
    });
    expect(summary.coordination.modeLabel).toBe("Escalating");
    expect(summary.lifecycle.stateLabel).toBe("Escalated");
  });

  it("humanises the remediating / retained vocabulary too", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({ decision: { mode: "remediating", lifecycle_state: "retained" } }),
      ownership: ownershipView(),
    });
    expect(summary.coordination.modeLabel).toBe("Remediating");
    expect(summary.lifecycle.stateLabel).toBe("Retained");
  });
});

describe("projectConversationActionSummary — the ownership summary, copied from the R55 timeline view", () => {
  it("an UNOWNED, never-claimed conversation reports Unowned with no owner and no history", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownershipView(),
    });
    expect(summary.ownership).toEqual({
      label: "Ownership",
      owned: false,
      statusLabel: "Unowned",
      tone: "unheld",
      currentOwnerLabel: null,
      reassigned: false,
      eventCount: 0,
      firstEventAt: EM_DASH,
      lastEventAt: EM_DASH,
      hasHistory: false,
      summary: "No operator has claimed this conversation yet.",
      historySummary: "No ownership events have been recorded yet.",
    });
  });

  it("an OWNED (claimed) conversation names the current owner and a one-event history", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownedView("a@crewflow.uk", false),
    });
    expect(summary.ownership.owned).toBe(true);
    expect(summary.ownership.statusLabel).toBe("Owned");
    expect(summary.ownership.tone).toBe("held");
    expect(summary.ownership.currentOwnerLabel).toBe("a@crewflow.uk");
    expect(summary.ownership.reassigned).toBe(false);
    expect(summary.ownership.summary).toBe("Currently held by a@crewflow.uk.");
    expect(summary.ownership.eventCount).toBe(1);
    expect(summary.ownership.hasHistory).toBe(true);
    expect(summary.ownership.historySummary).toBe(
      "1 ownership event recorded, 2026-07-01 09:00 → 2026-07-01 09:00.",
    );
  });

  it("an OWNED-BY-TRANSFER conversation notes the transfer and a two-event history", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownedView("b@crewflow.uk", true),
    });
    expect(summary.ownership.currentOwnerLabel).toBe("b@crewflow.uk");
    expect(summary.ownership.reassigned).toBe(true);
    expect(summary.ownership.summary).toBe("Currently held by b@crewflow.uk, by transfer.");
    expect(summary.ownership.eventCount).toBe(2);
    expect(summary.ownership.historySummary).toBe(
      "2 ownership events recorded, 2026-07-01 09:00 → 2026-07-02 09:00.",
    );
  });

  it("a RELEASED conversation reports Unowned yet PRESERVES its history summary", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownershipView({
        status: "unowned",
        owned: false,
        currentOwner: null,
        eventCount: 3,
        firstEventAt: "2026-07-01T09:00:00.000Z",
        lastEventAt: "2026-07-04T09:00:00.000Z",
      }),
    });
    expect(summary.ownership.owned).toBe(false);
    expect(summary.ownership.statusLabel).toBe("Unowned");
    expect(summary.ownership.currentOwnerLabel).toBeNull();
    expect(summary.ownership.hasHistory).toBe(true);
    expect(summary.ownership.summary).toBe(
      "No operator currently holds this conversation — it has been released.",
    );
    expect(summary.ownership.historySummary).toBe(
      "3 ownership events recorded, 2026-07-01 09:00 → 2026-07-04 09:00.",
    );
  });
});

describe("projectConversationActionSummary — provenance, determinism and copy-verbatim", () => {
  it("carries the coordination + conversation ids through from the record", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({ coordination_id: "coord-xyz", conversation_id: "conv-xyz" }),
      ownership: ownershipView(),
    });
    expect(summary.coordinationId).toBe("coord-xyz");
    expect(summary.conversationId).toBe("conv-xyz");
  });

  it("carries a null conversation id through unchanged", () => {
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord({ conversation_id: null }),
      ownership: ownershipView(),
    });
    expect(summary.conversationId).toBeNull();
  });

  it("is deterministic — the same inputs project to an equal summary", () => {
    const coordination = coordinationRecord();
    const ownership = ownedView("a@crewflow.uk", true);
    expect(projectConversationActionSummary({ coordination, ownership })).toEqual(
      projectConversationActionSummary({ coordination, ownership }),
    );
  });

  it("TRUSTS the views' flags — it reads `owned` from the view, never re-derives it from the entry count", () => {
    // A forged view the runtime would never emit (owned:true, yet eventCount:0) proves the summary COPIES the ownership
    // flag from the view rather than re-deciding it from the history — exactly as it copies the recorded decision facts.
    const summary = projectConversationActionSummary({
      coordination: coordinationRecord(),
      ownership: ownershipView({
        owned: true,
        currentOwner: { operatorId: "op-z", operatorEmail: "z@crewflow.uk", label: "z@crewflow.uk" },
        eventCount: 0,
      }),
    });
    expect(summary.ownership.owned).toBe(true);
    expect(summary.ownership.statusLabel).toBe("Owned");
    expect(summary.ownership.currentOwnerLabel).toBe("z@crewflow.uk");
    expect(summary.ownership.summary).toBe("Currently held by z@crewflow.uk.");
    expect(summary.ownership.hasHistory).toBe(false);
    expect(summary.ownership.historySummary).toBe("No ownership events have been recorded yet.");
  });
});

import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  type CoordinationReadRow,
} from "@/lib/receptionist/conversation-coordination-view";
import {
  humaniseToken,
  formatBool,
  orDash,
  formatInstant,
  buildTimeline,
  projectCoordinationDetail,
} from "@/app/admin/ai-receptionist/worklist/[coordinationId]/detail-view";
import { detailPath } from "@/app/admin/ai-receptionist/worklist/navigation";

/**
 * Conversation Worklist DETAIL SURFACE — presentation unit tests (the AI Receptionist Programme, R45:
 * CONVERSATION WORKLIST DETAIL SURFACE).
 *
 * The surface itself is a React server component that binds one R37 Coordination Read Model record to
 * pixels — its rendering is pinned by the production build (it compiles + type-checks) and its
 * consumption of ONLY the authorised read stack by the security tier. What is unit-testable in isolation
 * is the surface's PURE presentation: how it humanises the recorded coded facets, how it assembles the
 * causal timeline, and the whole projection it hands the page. This suite pins exactly that — total,
 * deterministic, dependency-free — plus the detail href the worklist row points at.
 */

// A complete, CLOSED coordination read row (fulfilment present) — projected through the R37 core so the
// fixture is always shape-identical to a real read. Distinct per-engine instants let the timeline order
// be asserted directly.
function makeRow(overrides: Partial<CoordinationReadRow> = {}): CoordinationReadRow {
  const base: CoordinationReadRow = {
    coordination_id: "coord-1",
    org_id: "org-1",
    conversation_id: "conv-1",
    enquiry_id: "enq-1",
    lead_id: "lead-1",
    customer_ref: null,
    correlation_id: "corr-1",
    action_id: null,
    execution_id: null,
    orchestration_id: "orch-1",
    lifecycle_id: "life-1",
    resolution_id: "reso-1",
    recovery_id: "reco-1",
    authorisation_id: "auth-1",
    verification_id: "veri-1",
    fulfilment_id: "fulf-1",
    review_audit_id: "revaud-1",
    sent_audit_id: "sentaud-1",
    review_resolution_id: "revres-1",

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
    coordination_status: "coordinated",
    job_type: "boiler_service",
    postcode: "SW1A 1AA",
    phone_number: "+441234567890",
    coordination_at: "2026-07-06T12:34:56.000Z",

    orchestration_type: "orchestrate_lifecycle_response",
    orchestration_outcome: "lifecycle_response_orchestrated",
    orchestration_target: "conversation_conclusion",
    orchestration_concluded: true,
    orchestration_active: false,
    orchestration_status: "orchestrated",
    orchestration_at: "2026-07-06T12:25:00.000Z",

    lifecycle_type: "govern_conversation_lifecycle",
    lifecycle_outcome: "conversation_lifecycle_governed",
    lifecycle_transition: "conclude",
    lifecycle_closed: true,
    lifecycle_ongoing: false,
    lifecycle_status: "governed",
    lifecycle_at: "2026-07-06T12:20:00.000Z",

    resolution_type: "resolve_conversation_completion",
    resolution_outcome: "conversation_completion_resolved",
    resolution_state: "resolved",
    resolution_terminal: true,
    resolution_intervention_required: false,
    resolution_recovery_classification: "none",
    resolution_status: "resolved",
    resolution_at: "2026-07-06T12:15:00.000Z",

    recovery_type: "recover_verified_fulfilment",
    recovery_outcome: "verified_fulfilment_recovered",
    recovery_classification: "healthy",
    recovery_required: false,
    recovery_integrity: "intact",
    recovery_status: "recovered",
    recovery_at: "2026-07-06T12:10:00.000Z",

    verification_type: "verify_approved_fulfilment",
    verification_outcome: "approved_fulfilment_verified",
    verification_integrity: "intact",
    verification_status: "verified",
    verification_at: "2026-07-06T12:05:00.000Z",

    fulfilment_type: "fulfil_approved_booking",
    fulfilment_outcome: "approved_booking_fulfilled",
    fulfilment_status: "fulfilled",
    fulfilment_at: "2026-07-06T12:00:00.000Z",
  };
  return { ...base, ...overrides };
}

/** A RETAINED coordination — the lifecycle was retained, so fulfilment legitimately never happened. */
function makeRetainedRow(): CoordinationReadRow {
  return makeRow({
    lifecycle_state: "retained",
    lifecycle_transition: "retain",
    lifecycle_closed: false,
    lifecycle_ongoing: true,
    fulfilment_id: null,
    fulfilment_type: null,
    fulfilment_outcome: null,
    fulfilment_status: null,
    fulfilment_at: null,
  });
}

const fullRecord = projectCoordinationRecord(makeRow());
const retainedRecord = projectCoordinationRecord(makeRetainedRow());

describe("detail surface — humaniseToken", () => {
  it("renders a coded snake / kebab token as a capitalised phrase", () => {
    expect(humaniseToken("human_attention")).toBe("Human attention");
    expect(humaniseToken("finalising")).toBe("Finalising");
    expect(humaniseToken("conclude")).toBe("Conclude");
    expect(humaniseToken("recovery-handling")).toBe("Recovery handling");
    expect(humaniseToken("closed")).toBe("Closed");
  });

  it("collapses an absent, empty or whitespace token to the em dash", () => {
    expect(humaniseToken(null)).toBe("—");
    expect(humaniseToken(undefined)).toBe("—");
    expect(humaniseToken("")).toBe("—");
    expect(humaniseToken("   ")).toBe("—");
  });
});

describe("detail surface — formatBool", () => {
  it("renders a recorded boolean as Yes / No", () => {
    expect(formatBool(true)).toBe("Yes");
    expect(formatBool(false)).toBe("No");
  });

  it("collapses an absent boolean to the em dash", () => {
    expect(formatBool(null)).toBe("—");
    expect(formatBool(undefined)).toBe("—");
  });
});

describe("detail surface — orDash", () => {
  it("passes a literal value through and collapses an absent one", () => {
    expect(orDash("SW1A 1AA")).toBe("SW1A 1AA");
    expect(orDash(null)).toBe("—");
    expect(orDash(undefined)).toBe("—");
    expect(orDash("")).toBe("—");
  });
});

describe("detail surface — formatInstant", () => {
  it("slices an ISO instant to YYYY-MM-DD HH:MM without a Date parse", () => {
    expect(formatInstant("2026-07-06T12:34:56.000Z")).toBe("2026-07-06 12:34");
    expect(formatInstant("2026-01-02T00:05:59Z")).toBe("2026-01-02 00:05");
  });

  it("renders a date-only value as the date, and an absent instant as the em dash", () => {
    expect(formatInstant("2026-07-06")).toBe("2026-07-06");
    expect(formatInstant(null)).toBe("—");
    expect(formatInstant(undefined)).toBe("—");
    expect(formatInstant("")).toBe("—");
  });
});

describe("detail surface — buildTimeline", () => {
  it("orders the linked contexts oldest-first, ending in the coordination itself", () => {
    const steps = buildTimeline(fullRecord);
    expect(steps.map((s) => s.key)).toEqual([
      "fulfilment",
      "verification",
      "recovery",
      "resolution",
      "lifecycle",
      "orchestration",
      "coordination",
    ]);
    // The terminal step is the coordination decision, referencing the coordination id.
    const last = steps.at(-1)!;
    expect(last.label).toBe("Coordination");
    expect(last.reference).toBe("coord-1");
    expect(last.at).toBe("2026-07-06 12:34");
  });

  it("humanises each step's facets and carries its own ledger reference", () => {
    const steps = buildTimeline(fullRecord);
    const fulfilment = steps[0]!;
    expect(fulfilment.label).toBe("Fulfilment");
    expect(fulfilment.reference).toBe("fulf-1");
    expect(fulfilment.outcome).toBe("Approved booking fulfilled");
    expect(fulfilment.status).toBe("Fulfilled");
    expect(fulfilment.at).toBe("2026-07-06 12:00");
  });

  it("skips the fulfilment step when the lifecycle was retained (fulfilment never happened)", () => {
    const steps = buildTimeline(retainedRecord);
    expect(steps.map((s) => s.key)).toEqual([
      "verification",
      "recovery",
      "resolution",
      "lifecycle",
      "orchestration",
      "coordination",
    ]);
    expect(steps.some((s) => s.key === "fulfilment")).toBe(false);
  });
});

describe("detail surface — projectCoordinationDetail", () => {
  it("carries the item's identity and humanised headline", () => {
    const detail = projectCoordinationDetail(fullRecord);
    expect(detail.coordinationId).toBe("coord-1");
    expect(detail.conversationId).toBe("conv-1");
    expect(detail.correlationId).toBe("corr-1");

    expect(detail.headline.title).toBe("Conversation response coordinated");
    expect(detail.headline.mode).toBe("Finalising");
    expect(detail.headline.leadParticipant).toBe("Conversation conclusion");
    expect(detail.headline.orchestrationRoute).toBe("Conclude");
    expect(detail.headline.lifecycleState).toBe("Closed");
    expect(detail.headline.approvalState).toBe("Approved");
    expect(detail.headline.status).toBe("Coordinated");
    expect(detail.headline.requiresHuman).toBe(false);
    expect(detail.headline.autonomous).toBe(true);
    expect(detail.headline.participantCount).toBe(1);
    expect(detail.headline.at).toBe("2026-07-06 12:34");
  });

  it("renders the booking's literal values (never humanised) with an em-dash fallback", () => {
    const detail = projectCoordinationDetail(fullRecord);
    expect(detail.booking.jobType).toBe("boiler_service");
    expect(detail.booking.postcode).toBe("SW1A 1AA");
    expect(detail.booking.phone).toBe("+441234567890");
  });

  it("lays out the six per-engine sections in reference-chain order, each present with its own fields", () => {
    const detail = projectCoordinationDetail(fullRecord);
    expect(detail.sections.map((s) => s.key)).toEqual([
      "orchestration",
      "lifecycle",
      "resolution",
      "recovery",
      "verification",
      "fulfilment",
    ]);
    for (const section of detail.sections) {
      expect(section.present, `${section.key} present`).toBe(true);
      expect(section.fields.length, `${section.key} has fields`).toBeGreaterThan(0);
    }

    const lifecycle = detail.sections.find((s) => s.key === "lifecycle")!;
    expect(lifecycle.fields).toContainEqual({ label: "Transition", value: "Conclude" });
    expect(lifecycle.fields).toContainEqual({ label: "Closed", value: "Yes" });

    const resolution = detail.sections.find((s) => s.key === "resolution")!;
    expect(resolution.fields).toContainEqual({ label: "Terminal", value: "Yes" });
    expect(resolution.fields).toContainEqual({ label: "Intervention required", value: "No" });
  });

  it("marks the fulfilment section absent (no fields) on a retained coordination", () => {
    const detail = projectCoordinationDetail(retainedRecord);
    const fulfilment = detail.sections.find((s) => s.key === "fulfilment")!;
    expect(fulfilment.present).toBe(false);
    expect(fulfilment.fields).toEqual([]);
    expect(detail.headline.lifecycleState).toBe("Retained");
    // The timeline drops the fulfilment step to match.
    expect(detail.timeline.some((s) => s.key === "fulfilment")).toBe(false);
  });

  it("exposes the whole provenance chain, with absent ids as the em dash", () => {
    const detail = projectCoordinationDetail(fullRecord);
    expect(detail.provenance).toHaveLength(15);
    expect(detail.provenance).toContainEqual({ label: "Enquiry", value: "enq-1" });
    expect(detail.provenance).toContainEqual({ label: "Customer ref", value: "—" });
    expect(detail.provenance).toContainEqual({ label: "Action", value: "—" });
    expect(detail.provenance).toContainEqual({ label: "Verification", value: "veri-1" });
  });

  it("threads the same timeline the pure builder produces", () => {
    const detail = projectCoordinationDetail(fullRecord);
    expect(detail.timeline).toEqual(buildTimeline(fullRecord));
  });
});

describe("detail surface — detailPath", () => {
  it("anchors the detail href under the worklist path, with the coordination id as the segment", () => {
    expect(detailPath("coord-1")).toBe("/admin/ai-receptionist/worklist/coord-1");
    expect(detailPath("11111111-2222-3333-4444-555555555555")).toBe(
      "/admin/ai-receptionist/worklist/11111111-2222-3333-4444-555555555555",
    );
  });

  it("encodes a segment defensively so a stray character cannot break the path", () => {
    expect(detailPath("a/b?c")).toBe("/admin/ai-receptionist/worklist/a%2Fb%3Fc");
  });
});

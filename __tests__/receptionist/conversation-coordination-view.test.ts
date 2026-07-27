import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  compareCoordinationRecords,
  orderCoordinationRecords,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";

/**
 * Conversation Coordination Read Model — projection + canonical ordering, unit tier
 * (the AI Receptionist Programme, R37 — CONVERSATION COORDINATION READ MODEL).
 *
 * The read model has TWO pure guarantees, both pinned here:
 *   1. `projectCoordinationRecord` READS the recorded coordination decision and RE-DERIVES NOTHING —
 *      the mode, lead participant, participation plan and flags are surfaced STRAIGHT from the row
 *      exactly as the Coordination Engine (R36) recorded them. If the projection re-folded the mode
 *      from the route or recomputed `requires_human` from the lead, it would DIFFER from an
 *      incoherent stored row; we prove it does not, so the Coordination Engine stays the sole
 *      authority over the decision and no duplicate coordination logic exists.
 *   2. `compareCoordinationRecords` is a TOTAL order (newest first by `coordination_at`, then a
 *      stable tiebreak on `coordination_id`) and `orderCoordinationRecords` applies it WITHOUT
 *      mutating its input — so a set of coordinations reconstructs IDENTICALLY every read.
 *
 * The end-to-end read over real Postgres (the view's own join + org isolation) is proven in
 * __tests__/integration/receptionist/coordination-read-model-pipeline.test.ts.
 */

// A fully-populated CoordinationReadRow is wide; a factory fills a COHERENT default coordination
// (a finalising / conversation_conclusion plan) and lets each case set the id, the instant and any
// fields under test.
function row(
  coordination_id: string,
  coordination_at: string,
  overrides: Partial<CoordinationReadRow> = {},
): CoordinationReadRow {
  return {
    coordination_id,
    org_id: "org-1",
    conversation_id: "conv-1",
    enquiry_id: "enq-1",
    lead_id: "lead-1",
    customer_ref: "+441234567890",
    correlation_id: "corr-1",
    action_id: "act-1",
    execution_id: "exec-1",
    orchestration_id: "orch-1",
    lifecycle_id: "life-1",
    resolution_id: "res-1",
    recovery_id: "rec-1",
    authorisation_id: "auth-1",
    verification_id: "ver-1",
    fulfilment_id: "ful-1",
    review_audit_id: "raud-1",
    sent_audit_id: "saud-1",
    review_resolution_id: "rres-1",
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
    job_type: "boiler_repair",
    postcode: "SW1A 1AA",
    phone_number: "+441234567890",
    coordination_at,
    orchestration_type: "orchestrate_lifecycle_response",
    orchestration_outcome: "conversation_response_orchestrated",
    orchestration_target: "conversation_conclusion",
    orchestration_concluded: true,
    orchestration_active: false,
    orchestration_status: "orchestrated",
    orchestration_at: "2026-01-01T09:00:00.000Z",
    lifecycle_type: "govern_lifecycle",
    lifecycle_outcome: "conversation_lifecycle_governed",
    lifecycle_transition: "close",
    lifecycle_closed: true,
    lifecycle_ongoing: false,
    lifecycle_status: "governed",
    lifecycle_at: "2026-01-01T08:00:00.000Z",
    resolution_type: "resolve_completion",
    resolution_outcome: "conversation_completion_determined",
    resolution_state: "terminal",
    resolution_terminal: true,
    resolution_intervention_required: false,
    resolution_recovery_classification: "none",
    resolution_status: "determined",
    resolution_at: "2026-01-01T07:00:00.000Z",
    recovery_type: "determine_recovery",
    recovery_outcome: "recovery_determined",
    recovery_classification: "none",
    recovery_required: false,
    recovery_integrity: "consistent",
    recovery_status: "determined",
    recovery_at: "2026-01-01T06:00:00.000Z",
    verification_type: "verify_fulfilment",
    verification_outcome: "fulfilment_verified",
    verification_integrity: "consistent",
    verification_status: "verified",
    verification_at: "2026-01-01T05:00:00.000Z",
    fulfilment_type: "record_booking",
    fulfilment_outcome: "booking_recorded",
    fulfilment_status: "fulfilled",
    fulfilment_at: "2026-01-01T04:00:00.000Z",
    ...overrides,
  };
}

describe("projectCoordinationRecord — a pure regrouping that READS the recorded decision", () => {
  it("surfaces the recorded coordination decision verbatim into the decision group", () => {
    const rec = projectCoordinationRecord(row("c-1", "2026-01-01T10:00:00.000Z"));
    expect(rec.decision).toEqual({
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
      at: "2026-01-01T10:00:00.000Z",
    });
  });

  it("RE-DERIVES NOTHING — an INCOHERENT stored row is surfaced exactly, not recomputed", () => {
    // The Coordination Engine (R36) would never record this (mode is a fold of the route, and the
    // flags are coherent with the lead), but if the projection re-folded the mode from the route or
    // recomputed requires_human/autonomous from the lead, it would "correct" these and DIFFER from
    // the row. It must NOT: the read model reads the recorded decision, it never re-derives it.
    const rec = projectCoordinationRecord(
      row("c-1", "2026-01-01T10:00:00.000Z", {
        orchestration_route: "conclude", // would fold to "finalising"…
        coordination_mode: "escalating", // …but the row says escalating — surface the row
        lead_participant: "conversation_conclusion", // would imply requires_human=false…
        requires_human: true, // …but the row says true — surface the row
        autonomous: false,
      }),
    );
    expect(rec.decision.mode).toBe("escalating");
    expect(rec.decision.orchestration_route).toBe("conclude");
    expect(rec.decision.requires_human).toBe(true);
    expect(rec.decision.autonomous).toBe(false);
    expect(rec.decision.lead_participant).toBe("conversation_conclusion");
  });

  it("groups the six linked per-engine contexts from the row", () => {
    const rec = projectCoordinationRecord(row("c-1", "2026-01-01T10:00:00.000Z"));
    expect(rec.context.orchestration).toEqual({
      orchestration_id: "orch-1",
      type: "orchestrate_lifecycle_response",
      outcome: "conversation_response_orchestrated",
      target: "conversation_conclusion",
      concluded: true,
      active: false,
      status: "orchestrated",
      at: "2026-01-01T09:00:00.000Z",
    });
    expect(rec.context.lifecycle?.transition).toBe("close");
    expect(rec.context.resolution?.state).toBe("terminal");
    expect(rec.context.recovery?.classification).toBe("none");
    expect(rec.context.verification?.integrity).toBe("consistent");
    expect(rec.context.fulfilment?.outcome).toBe("booking_recorded");
  });

  it("nulls the FULFILMENT context when the coordination was retained (fulfilment_id is null)", () => {
    // A retained lifecycle has no fulfilment; the LEFT JOIN yields null columns, and the projection
    // reports the fulfilment context as absent (not an object of nulls).
    const rec = projectCoordinationRecord(
      row("c-1", "2026-01-01T10:00:00.000Z", {
        fulfilment_id: null,
        fulfilment_type: null,
        fulfilment_outcome: null,
        fulfilment_status: null,
        fulfilment_at: null,
        lifecycle_state: "retained",
      }),
    );
    expect(rec.context.fulfilment).toBeNull();
    // The other five contexts are still present.
    expect(rec.context.orchestration).not.toBeNull();
    expect(rec.context.verification).not.toBeNull();
  });

  it("defensively nulls a sibling context when its join found no row (status null)", () => {
    const rec = projectCoordinationRecord(
      row("c-1", "2026-01-01T10:00:00.000Z", {
        orchestration_status: null,
        orchestration_type: null,
        orchestration_outcome: null,
        orchestration_target: null,
        orchestration_concluded: null,
        orchestration_active: null,
        orchestration_at: null,
      }),
    );
    expect(rec.context.orchestration).toBeNull();
  });

  it("carries the full provenance chain (every linked ledger id)", () => {
    const rec = projectCoordinationRecord(row("c-1", "2026-01-01T10:00:00.000Z"));
    expect(rec.provenance).toEqual({
      orchestration_id: "orch-1",
      lifecycle_id: "life-1",
      resolution_id: "res-1",
      recovery_id: "rec-1",
      authorisation_id: "auth-1",
      verification_id: "ver-1",
      fulfilment_id: "ful-1",
      review_audit_id: "raud-1",
      sent_audit_id: "saud-1",
      review_resolution_id: "rres-1",
      action_id: "act-1",
      execution_id: "exec-1",
      enquiry_id: "enq-1",
      lead_id: "lead-1",
      customer_ref: "+441234567890",
    });
  });

  it("is DETERMINISTIC — the same row always projects to an identical record", () => {
    const r = row("c-1", "2026-01-01T10:00:00.000Z");
    expect(projectCoordinationRecord(r)).toEqual(projectCoordinationRecord(r));
  });
});

describe("compareCoordinationRecords — a total newest-first order with a stable tiebreak", () => {
  const rec = (id: string, at: string): CoordinationRecord => projectCoordinationRecord(row(id, at));

  it("orders by coordination_at, NEWEST first (the later instant comes first)", () => {
    const older = rec("c-a", "2026-01-01T10:00:00.000Z");
    const newer = rec("c-b", "2026-01-01T10:00:05.000Z");
    expect(compareCoordinationRecords(newer, older)).toBeLessThan(0);
    expect(compareCoordinationRecords(older, newer)).toBeGreaterThan(0);
  });

  it("compares instants, not raw strings (equal moments in different zone spellings tie)", () => {
    const z = rec("c-a", "2026-01-01T10:00:00.000Z");
    const offset = rec("c-b", "2026-01-01T10:00:00.000+00:00");
    // Same instant → decided by the id tiebreak (descending): c-b before c-a.
    expect(compareCoordinationRecords(offset, z)).toBeLessThan(0);
    expect(compareCoordinationRecords(z, offset)).toBeGreaterThan(0);
  });

  it("tiebreaks on coordination_id (descending) when the instant is identical", () => {
    const a = rec("c-a", "2026-01-01T10:00:00.000Z");
    const b = rec("c-b", "2026-01-01T10:00:00.000Z");
    expect(compareCoordinationRecords(b, a)).toBeLessThan(0); // c-b (larger) first
    expect(compareCoordinationRecords(a, b)).toBeGreaterThan(0);
  });

  it("returns 0 only for the same coordination (same instant AND same id)", () => {
    const a = rec("c-a", "2026-01-01T10:00:00.000Z");
    const same = rec("c-a", "2026-01-01T10:00:00.000Z");
    expect(compareCoordinationRecords(a, same)).toBe(0);
  });

  it("is antisymmetric — compare(a,b) is the negation-sign of compare(b,a)", () => {
    const pairs: Array<[CoordinationRecord, CoordinationRecord]> = [
      [rec("c-a", "2026-01-01T10:00:00.000Z"), rec("c-b", "2026-01-01T10:00:05.000Z")],
      [rec("c-a", "2026-01-01T10:00:00.000Z"), rec("c-b", "2026-01-01T10:00:00.000Z")],
      [rec("c-z", "2026-01-01T11:00:00.000Z"), rec("c-a", "2026-01-01T10:00:00.000Z")],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(compareCoordinationRecords(a, b))).toBe(
        -Math.sign(compareCoordinationRecords(b, a)),
      );
    }
  });
});

describe("orderCoordinationRecords — deterministic, non-mutating, newest-first", () => {
  const rec = (id: string, at: string): CoordinationRecord => projectCoordinationRecord(row(id, at));

  it("sorts a shuffled set newest-first", () => {
    const shuffled = [
      rec("c-1", "2026-01-01T10:00:00.000Z"),
      rec("c-3", "2026-01-01T10:00:10.000Z"),
      rec("c-2", "2026-01-01T10:00:05.000Z"),
    ];
    expect(orderCoordinationRecords(shuffled).map((r) => r.coordination_id)).toEqual([
      "c-3",
      "c-2",
      "c-1",
    ]);
  });

  it("breaks same-instant ties by coordination_id so the order is fully determined", () => {
    const sameInstant = [
      rec("c-a", "2026-01-01T10:00:00.000Z"),
      rec("c-c", "2026-01-01T10:00:00.000Z"),
      rec("c-b", "2026-01-01T10:00:00.000Z"),
    ];
    expect(orderCoordinationRecords(sameInstant).map((r) => r.coordination_id)).toEqual([
      "c-c",
      "c-b",
      "c-a",
    ]);
  });

  it("is DETERMINISTIC — any input permutation of the same set yields one identical order", () => {
    const a = rec("c-a", "2026-01-01T10:00:00.000Z");
    const b = rec("c-b", "2026-01-01T10:00:00.000Z"); // same instant as c-a → tiebreak territory
    const c = rec("c-c", "2026-01-01T10:00:05.000Z");
    const d = rec("c-d", "2026-01-01T09:59:00.000Z");
    const permutations: CoordinationRecord[][] = [
      [a, b, c, d],
      [d, c, b, a],
      [c, a, d, b],
      [b, d, a, c],
    ];
    const canonical = ["c-c", "c-b", "c-a", "c-d"]; // newest first, then id-descending tiebreak
    for (const perm of permutations) {
      expect(orderCoordinationRecords(perm).map((r) => r.coordination_id)).toEqual(canonical);
    }
  });

  it("does NOT mutate its input array", () => {
    const input = [
      rec("c-1", "2026-01-01T10:00:00.000Z"),
      rec("c-2", "2026-01-01T10:00:05.000Z"),
    ];
    const before = input.map((r) => r.coordination_id);
    orderCoordinationRecords(input);
    expect(input.map((r) => r.coordination_id)).toEqual(before); // ["c-1", "c-2"] — untouched
  });

  it("is idempotent — ordering an already-ordered set is a no-op", () => {
    const ordered = orderCoordinationRecords([
      rec("c-1", "2026-01-01T10:00:00.000Z"),
      rec("c-2", "2026-01-01T10:00:05.000Z"),
    ]);
    expect(orderCoordinationRecords(ordered)).toEqual(ordered);
  });

  it("handles the empty and singleton sets", () => {
    expect(orderCoordinationRecords([])).toEqual([]);
    const one = [rec("c-1", "2026-01-01T10:00:00.000Z")];
    expect(orderCoordinationRecords(one).map((r) => r.coordination_id)).toEqual(["c-1"]);
  });
});

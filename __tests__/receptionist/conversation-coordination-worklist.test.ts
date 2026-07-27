import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";
import {
  WORKLIST_CATEGORIES,
  COORDINATION_PRIORITIES,
  deriveCoordinationPriority,
  coordinationPriorityRank,
  belongsToWorklist,
  worklistCategoriesOf,
  toWorklistEntry,
  compareWorklistEntries,
  orderWorklistEntries,
  deriveWorklists,
} from "@/lib/receptionist/conversation-coordination-worklist";

/**
 * Conversation Coordination Worklist Engine — priority derivation, grouping + canonical ordering, unit
 * tier (the AI Receptionist Programme, R38 — CONVERSATION COORDINATION WORKLIST ENGINE).
 *
 * The Worklist Engine has three pure guarantees, all pinned here:
 *   1. PRIORITY + GROUPING READ THE RECORDED DECISION — `deriveCoordinationPriority` maps the RECORDED
 *      mode onto an operational severity, and `belongsToWorklist` groups a coordination by its RECORDED
 *      `requires_human` flag / mode. Neither re-folds a mode from a route nor recomputes a flag from a
 *      lead: fed an INCOHERENT record, the engine groups and prioritises by what the row RECORDS, so
 *      the Coordination Engine (R36) and the Read Model (R37) stay authoritative and no duplicate
 *      coordination logic exists.
 *   2. `compareWorklistEntries` is a TOTAL order (higher priority first, then the R37 canonical
 *      coordination order REUSED verbatim) and `orderWorklistEntries` / `deriveWorklists` apply it
 *      WITHOUT mutating their input — so a set of coordinations derives IDENTICAL worklists every read.
 *   3. The worklists are OVERLAPPING projections, not a partition (an escalation is on BOTH the
 *      human-review and escalation worklists), and a finalising/concluded coordination is NON-ACTIONABLE
 *      (on no worklist).
 *
 * The end-to-end derivation over real Postgres (through the R37 reader) is proven in
 * __tests__/integration/receptionist/coordination-worklist-pipeline.test.ts.
 */

// A fully-populated CoordinationReadRow is wide; this factory fills a COHERENT default (a finalising /
// conversation_conclusion / closed coordination — non-actionable) and lets each case set the id, the
// instant and any recorded-decision fields under test. It mirrors the R37 read-model unit factory so
// the records are exactly what `projectCoordinationRecord` produces from a real view row.
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

/** A `closed` / finalising coordination — the conversation concluded autonomously (non-actionable). */
function closed(id: string, at: string): CoordinationRecord {
  return projectCoordinationRecord(row(id, at));
}

/** A `retained` / remediating coordination — the recover path (recovery worklist, no fulfilment). */
function retained(id: string, at: string): CoordinationRecord {
  return projectCoordinationRecord(
    row(id, at, {
      coordination_mode: "remediating",
      lead_participant: "recovery_handling",
      requires_human: false,
      autonomous: true,
      orchestration_route: "recover",
      lifecycle_state: "retained",
      orchestration_target: "recovery_handling",
      orchestration_concluded: false,
      orchestration_active: true,
      lifecycle_closed: false,
      lifecycle_ongoing: true,
      resolution_terminal: false,
      resolution_recovery_classification: "reinstate",
      recovery_classification: "reinstate",
      recovery_required: true,
      recovery_integrity: "missing",
      verification_integrity: "missing",
      fulfilment_id: null,
      fulfilment_type: null,
      fulfilment_outcome: null,
      fulfilment_status: null,
      fulfilment_at: null,
    }),
  );
}

/** An `escalated` / escalating coordination — routed to a human (human-review + escalation worklists). */
function escalated(id: string, at: string): CoordinationRecord {
  return projectCoordinationRecord(
    row(id, at, {
      coordination_mode: "escalating",
      lead_participant: "human_attention",
      requires_human: true,
      autonomous: false,
      orchestration_route: "escalate",
      lifecycle_state: "escalated",
      orchestration_target: "human_attention",
      orchestration_concluded: false,
      orchestration_active: true,
      lifecycle_closed: false,
      lifecycle_ongoing: true,
      resolution_terminal: false,
      resolution_recovery_classification: "reconcile",
      recovery_classification: "reconcile",
      verification_integrity: "inconsistent",
    }),
  );
}

describe("the worklist vocabulary is closed and exhaustive", () => {
  it("ships exactly the three directed worklists", () => {
    expect([...WORKLIST_CATEGORIES]).toEqual(["human_review", "recovery", "escalation"]);
  });

  it("ships exactly the three priorities, most urgent first", () => {
    expect([...COORDINATION_PRIORITIES]).toEqual(["critical", "elevated", "routine"]);
  });
});

describe("deriveCoordinationPriority — maps the RECORDED mode onto an operational severity", () => {
  it("escalating → critical, remediating → elevated, finalising → routine", () => {
    expect(deriveCoordinationPriority(escalated("c", "2026-01-01T10:00:00.000Z"))).toBe("critical");
    expect(deriveCoordinationPriority(retained("c", "2026-01-01T10:00:00.000Z"))).toBe("elevated");
    expect(deriveCoordinationPriority(closed("c", "2026-01-01T10:00:00.000Z"))).toBe("routine");
  });

  it("ranks critical < elevated < routine (0 = most urgent)", () => {
    expect(coordinationPriorityRank("critical")).toBe(0);
    expect(coordinationPriorityRank("elevated")).toBe(1);
    expect(coordinationPriorityRank("routine")).toBe(2);
  });

  it("RE-DERIVES NOTHING — an INCOHERENT record is prioritised by its RECORDED mode, not recomputed", () => {
    // The route says `conclude` (which R36 would fold to `finalising`/routine), but the RECORDED mode
    // says `escalating`. The engine must prioritise by the RECORDED mode — critical — never re-fold it.
    const incoherent = projectCoordinationRecord(
      row("c", "2026-01-01T10:00:00.000Z", {
        orchestration_route: "conclude",
        coordination_mode: "escalating",
      }),
    );
    expect(incoherent.decision.mode).toBe("escalating");
    expect(deriveCoordinationPriority(incoherent)).toBe("critical");
  });
});

describe("belongsToWorklist — groups by the RECORDED flag / mode, in exactly one place", () => {
  it("human_review ⇔ the recorded requires_human flag is true", () => {
    expect(belongsToWorklist(escalated("c", "2026-01-01T10:00:00.000Z"), "human_review")).toBe(true);
    expect(belongsToWorklist(retained("c", "2026-01-01T10:00:00.000Z"), "human_review")).toBe(false);
    expect(belongsToWorklist(closed("c", "2026-01-01T10:00:00.000Z"), "human_review")).toBe(false);
  });

  it("recovery ⇔ the recorded mode is remediating", () => {
    expect(belongsToWorklist(retained("c", "2026-01-01T10:00:00.000Z"), "recovery")).toBe(true);
    expect(belongsToWorklist(escalated("c", "2026-01-01T10:00:00.000Z"), "recovery")).toBe(false);
    expect(belongsToWorklist(closed("c", "2026-01-01T10:00:00.000Z"), "recovery")).toBe(false);
  });

  it("escalation ⇔ the recorded mode is escalating", () => {
    expect(belongsToWorklist(escalated("c", "2026-01-01T10:00:00.000Z"), "escalation")).toBe(true);
    expect(belongsToWorklist(retained("c", "2026-01-01T10:00:00.000Z"), "escalation")).toBe(false);
    expect(belongsToWorklist(closed("c", "2026-01-01T10:00:00.000Z"), "escalation")).toBe(false);
  });

  it("groups by the RECORDED flag even when it is INCOHERENT with the lead — never recomputed", () => {
    // The lead is `conversation_conclusion` (which would imply requires_human=false), but the RECORDED
    // flag says true. human_review must follow the RECORDED flag, not re-derive it from the lead.
    const incoherent = projectCoordinationRecord(
      row("c", "2026-01-01T10:00:00.000Z", {
        lead_participant: "conversation_conclusion",
        requires_human: true,
      }),
    );
    expect(belongsToWorklist(incoherent, "human_review")).toBe(true);
  });
});

describe("worklistCategoriesOf — every worklist a coordination is on, in canonical order", () => {
  it("an escalation is on BOTH human_review AND escalation (overlapping projections)", () => {
    expect(worklistCategoriesOf(escalated("c", "2026-01-01T10:00:00.000Z"))).toEqual([
      "human_review",
      "escalation",
    ]);
  });

  it("a remediation is on recovery ALONE", () => {
    expect(worklistCategoriesOf(retained("c", "2026-01-01T10:00:00.000Z"))).toEqual(["recovery"]);
  });

  it("a finalising coordination is NON-ACTIONABLE — on no worklist", () => {
    expect(worklistCategoriesOf(closed("c", "2026-01-01T10:00:00.000Z"))).toEqual([]);
  });
});

describe("toWorklistEntry — derives the operational attributes, surfaces the rest verbatim", () => {
  it("DERIVES priority/rank/categories and SURFACES lead/flag/mode/at/ids from the record", () => {
    const record = escalated("c-1", "2026-01-01T10:00:00.000Z");
    const entry = toWorklistEntry(record);
    // Derived by the Worklist Engine.
    expect(entry.priority).toBe("critical");
    expect(entry.priority_rank).toBe(0);
    expect(entry.categories).toEqual(["human_review", "escalation"]);
    // Surfaced VERBATIM from the recorded decision — copied, never recomputed.
    expect(entry.lead_participant).toBe(record.decision.lead_participant);
    expect(entry.requires_human).toBe(record.decision.requires_human);
    expect(entry.mode).toBe(record.decision.mode);
    expect(entry.at).toBe(record.decision.at);
    expect(entry.coordination_id).toBe(record.coordination_id);
    expect(entry.org_id).toBe(record.org_id);
    expect(entry.conversation_id).toBe(record.conversation_id);
    // The full R37 projection is carried through untouched.
    expect(entry.record).toBe(record);
  });

  it("is DETERMINISTIC — the same record always projects to an identical entry", () => {
    const record = retained("c-1", "2026-01-01T10:00:00.000Z");
    expect(toWorklistEntry(record)).toEqual(toWorklistEntry(record));
  });
});

describe("compareWorklistEntries — priority first, then the R37 canonical order (reused)", () => {
  it("orders a higher priority ahead of a lower one, regardless of recency", () => {
    // The recovery (elevated) is NEWER than the escalation (critical), but priority wins.
    const escalation = toWorklistEntry(escalated("c-esc", "2026-01-01T10:00:00.000Z"));
    const recovery = toWorklistEntry(retained("c-rec", "2026-01-01T11:00:00.000Z"));
    expect(compareWorklistEntries(escalation, recovery)).toBeLessThan(0);
    expect(compareWorklistEntries(recovery, escalation)).toBeGreaterThan(0);
  });

  it("within a priority, orders NEWEST coordination first (the R37 recency order)", () => {
    const older = toWorklistEntry(escalated("c-a", "2026-01-01T10:00:00.000Z"));
    const newer = toWorklistEntry(escalated("c-b", "2026-01-01T10:00:05.000Z"));
    expect(compareWorklistEntries(newer, older)).toBeLessThan(0);
    expect(compareWorklistEntries(older, newer)).toBeGreaterThan(0);
  });

  it("within a priority and instant, tiebreaks on coordination_id (descending) — a total order", () => {
    const a = toWorklistEntry(escalated("c-a", "2026-01-01T10:00:00.000Z"));
    const b = toWorklistEntry(escalated("c-b", "2026-01-01T10:00:00.000Z"));
    expect(compareWorklistEntries(b, a)).toBeLessThan(0);
    expect(compareWorklistEntries(a, b)).toBeGreaterThan(0);
    expect(compareWorklistEntries(a, a)).toBe(0);
  });

  it("is antisymmetric — compare(a,b) is the negation-sign of compare(b,a)", () => {
    const pairs: Array<[ReturnType<typeof toWorklistEntry>, ReturnType<typeof toWorklistEntry>]> = [
      [toWorklistEntry(escalated("c-a", "2026-01-01T10:00:00.000Z")), toWorklistEntry(retained("c-b", "2026-01-01T11:00:00.000Z"))],
      [toWorklistEntry(escalated("c-a", "2026-01-01T10:00:00.000Z")), toWorklistEntry(escalated("c-b", "2026-01-01T10:00:05.000Z"))],
      [toWorklistEntry(retained("c-a", "2026-01-01T10:00:00.000Z")), toWorklistEntry(retained("c-b", "2026-01-01T10:00:00.000Z"))],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(compareWorklistEntries(a, b))).toBe(-Math.sign(compareWorklistEntries(b, a)));
    }
  });
});

describe("orderWorklistEntries — deterministic, non-mutating, priority-then-recency", () => {
  it("sorts a mixed set by priority, then recency within a priority", () => {
    const entries = [
      toWorklistEntry(retained("c-rec-old", "2026-01-01T09:00:00.000Z")), // elevated, oldest
      toWorklistEntry(escalated("c-esc-old", "2026-01-01T10:00:00.000Z")), // critical, older
      toWorklistEntry(escalated("c-esc-new", "2026-01-01T10:00:05.000Z")), // critical, newer
      toWorklistEntry(retained("c-rec-new", "2026-01-01T11:00:00.000Z")), // elevated, newest
    ];
    expect(orderWorklistEntries(entries).map((e) => e.coordination_id)).toEqual([
      "c-esc-new", // critical first (newest critical)
      "c-esc-old", // critical
      "c-rec-new", // then elevated (newest)
      "c-rec-old", // then elevated (oldest)
    ]);
  });

  it("does NOT mutate its input array", () => {
    const input = [
      toWorklistEntry(retained("c-1", "2026-01-01T09:00:00.000Z")),
      toWorklistEntry(escalated("c-2", "2026-01-01T10:00:00.000Z")),
    ];
    const before = input.map((e) => e.coordination_id);
    orderWorklistEntries(input);
    expect(input.map((e) => e.coordination_id)).toEqual(before);
  });

  it("handles the empty and singleton sets", () => {
    expect(orderWorklistEntries([])).toEqual([]);
    const one = [toWorklistEntry(escalated("c-1", "2026-01-01T10:00:00.000Z"))];
    expect(orderWorklistEntries(one).map((e) => e.coordination_id)).toEqual(["c-1"]);
  });
});

describe("deriveWorklists — groups into the three worklists + the prioritised backlog", () => {
  it("routes each coordination into the worklists it belongs to (overlap included)", () => {
    const esc = escalated("c-esc", "2026-01-01T10:00:00.000Z");
    const rec = retained("c-rec", "2026-01-01T09:00:00.000Z");
    const fin = closed("c-fin", "2026-01-01T08:00:00.000Z");
    const worklists = deriveWorklists([esc, rec, fin]);

    // The escalation is on BOTH human_review and escalation…
    expect(worklists.human_review.map((e) => e.coordination_id)).toEqual(["c-esc"]);
    expect(worklists.escalation.map((e) => e.coordination_id)).toEqual(["c-esc"]);
    // …the remediation is on recovery…
    expect(worklists.recovery.map((e) => e.coordination_id)).toEqual(["c-rec"]);
    // …and the finalising coordination is on NONE (non-actionable, excluded everywhere).
    expect(worklists.prioritised.map((e) => e.coordination_id)).not.toContain("c-fin");
  });

  it("the prioritised backlog is the UNION of the worklists (each once), priority-ordered", () => {
    const esc = escalated("c-esc", "2026-01-01T10:00:00.000Z");
    const rec = retained("c-rec", "2026-01-01T11:00:00.000Z"); // NEWER but lower priority
    const fin = closed("c-fin", "2026-01-01T12:00:00.000Z"); // newest but non-actionable
    const worklists = deriveWorklists([rec, fin, esc]);

    // Critical (escalation) leads, then elevated (recovery); the non-actionable finalising is absent.
    expect(worklists.prioritised.map((e) => e.coordination_id)).toEqual(["c-esc", "c-rec"]);
    // Each actionable coordination appears exactly once in the backlog.
    expect(worklists.prioritised).toHaveLength(2);
  });

  it("orders WITHIN a worklist newest-first (priority constant there)", () => {
    const older = escalated("c-a", "2026-01-01T10:00:00.000Z");
    const newer = escalated("c-b", "2026-01-01T10:00:05.000Z");
    const worklists = deriveWorklists([older, newer]);
    expect(worklists.escalation.map((e) => e.coordination_id)).toEqual(["c-b", "c-a"]);
    expect(worklists.human_review.map((e) => e.coordination_id)).toEqual(["c-b", "c-a"]);
  });

  it("is DETERMINISTIC — any input permutation of the same set yields identical worklists", () => {
    const esc1 = escalated("c-e1", "2026-01-01T10:00:00.000Z");
    const esc2 = escalated("c-e2", "2026-01-01T10:00:05.000Z");
    const rec1 = retained("c-r1", "2026-01-01T09:00:00.000Z");
    const permutations: CoordinationRecord[][] = [
      [esc1, esc2, rec1],
      [rec1, esc2, esc1],
      [esc2, rec1, esc1],
    ];
    const canonicalPrioritised = ["c-e2", "c-e1", "c-r1"];
    for (const perm of permutations) {
      const w = deriveWorklists(perm);
      expect(w.prioritised.map((e) => e.coordination_id)).toEqual(canonicalPrioritised);
      expect(w.escalation.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
      expect(w.recovery.map((e) => e.coordination_id)).toEqual(["c-r1"]);
      expect(w.human_review.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
    }
  });

  it("derives empty worklists from an empty set, and from an all-finalising set", () => {
    const empty = deriveWorklists([]);
    expect(empty).toEqual({ human_review: [], recovery: [], escalation: [], prioritised: [] });

    const allConcluded = deriveWorklists([
      closed("c-1", "2026-01-01T10:00:00.000Z"),
      closed("c-2", "2026-01-01T10:00:05.000Z"),
    ]);
    expect(allConcluded).toEqual({ human_review: [], recovery: [], escalation: [], prioritised: [] });
  });

  it("does NOT mutate its input array", () => {
    const input = [
      retained("c-1", "2026-01-01T09:00:00.000Z"),
      escalated("c-2", "2026-01-01T10:00:00.000Z"),
    ];
    const before = input.map((r) => r.coordination_id);
    deriveWorklists(input);
    expect(input.map((r) => r.coordination_id)).toEqual(before);
  });
});

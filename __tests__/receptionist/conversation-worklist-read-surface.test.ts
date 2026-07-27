import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";
import {
  toWorklistEntry,
  deriveWorklists,
  type WorklistEntry,
} from "@/lib/receptionist/conversation-coordination-worklist";
import {
  WORKLIST_VIEWS,
  readWorklistView,
  matchesWorklistFilter,
  filterWorklistEntries,
  paginateWorklistEntries,
  queryWorklist,
} from "@/lib/receptionist/conversation-worklist-read-surface";

/**
 * Conversation Worklist READ SURFACE — view selection, filtering, pagination + stable ordering, unit
 * tier (the AI Receptionist Programme, R39 — CONVERSATION WORKLIST READ SURFACE).
 *
 * The Read Surface is a pure QUERY over the worklists the R38 engine DERIVED. Its guarantees, all pinned
 * here:
 *   1. IT RE-DERIVES NOTHING — `readWorklistView` returns the engine's already-ordered list VERBATIM,
 *      and `matchesWorklistFilter` narrows by an entry's ALREADY-DERIVED attributes (priority, mode,
 *      categories, requires_human, conversation). The Worklist Engine (R38) stays authoritative; no
 *      duplicate worklist logic exists.
 *   2. THE ORDER IS R38's, REUSED — every page comes back in the R38 canonical order (priority first,
 *      then recency); the surface FILTERS and PAGES that order, it never re-sorts.
 *   3. FILTERING + PAGINATION ARE PURE, TOTAL and NON-MUTATING — the same set and query always yield the
 *      same page; an invalid page bound is rejected; a caller's arrays are never reordered or narrowed.
 *
 * The end-to-end query over real Postgres (through the R38 → R37 readers) is proven in
 * __tests__/integration/receptionist/worklist-read-surface-pipeline.test.ts.
 */

// The R38 unit factory, reused: a COHERENT default row (a finalising / conversation_conclusion / closed
// coordination — non-actionable) that each case narrows to the recorded-decision fields under test.
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

/** A `closed` / finalising coordination — non-actionable (on no worklist). */
function closed(id: string, at: string, conversationId = "conv-1"): CoordinationRecord {
  return projectCoordinationRecord(row(id, at, { conversation_id: conversationId }));
}

/** A `retained` / remediating coordination — the recovery worklist, elevated. */
function retained(id: string, at: string, conversationId = "conv-1"): CoordinationRecord {
  return projectCoordinationRecord(
    row(id, at, {
      conversation_id: conversationId,
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

/** An `escalated` / escalating coordination — human-review + escalation worklists, critical. */
function escalated(id: string, at: string, conversationId = "conv-1"): CoordinationRecord {
  return projectCoordinationRecord(
    row(id, at, {
      conversation_id: conversationId,
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

// A mixed, coherent worklist set: two escalations (critical), one remediation (elevated), one concluded
// (non-actionable). Conversations vary so the conversation filter is exercised.
//   c-e2 (escalating, conv-2, newest critical) · c-e1 (escalating, conv-1) · c-r1 (remediating, conv-1)
const esc1 = escalated("c-e1", "2026-01-01T10:00:00.000Z", "conv-1");
const esc2 = escalated("c-e2", "2026-01-01T10:00:05.000Z", "conv-2");
const rec1 = retained("c-r1", "2026-01-01T09:00:00.000Z", "conv-1");
const fin1 = closed("c-f1", "2026-01-01T12:00:00.000Z", "conv-3");
const SET = deriveWorklists([esc1, esc2, rec1, fin1]);

describe("the read-surface vocabulary is closed", () => {
  it("ships exactly the four worklist views (one per WorklistSet field)", () => {
    expect([...WORKLIST_VIEWS]).toEqual(["prioritised", "human_review", "recovery", "escalation"]);
  });
});

describe("readWorklistView — selects one derived worklist VERBATIM (re-derives nothing)", () => {
  it("returns the engine's already-ordered list for each view, by reference", () => {
    expect(readWorklistView(SET, "prioritised")).toBe(SET.prioritised);
    expect(readWorklistView(SET, "human_review")).toBe(SET.human_review);
    expect(readWorklistView(SET, "recovery")).toBe(SET.recovery);
    expect(readWorklistView(SET, "escalation")).toBe(SET.escalation);
  });

  it("the prioritised view is the R38 priority-then-recency order (critical newest first, then elevated)", () => {
    expect(readWorklistView(SET, "prioritised").map((e) => e.coordination_id)).toEqual([
      "c-e2",
      "c-e1",
      "c-r1",
    ]);
  });
});

describe("matchesWorklistFilter — narrows by ALREADY-DERIVED attributes, never recomputes", () => {
  const escEntry = toWorklistEntry(esc1); // critical, escalating, [human_review, escalation], conv-1, requires_human
  const recEntry = toWorklistEntry(rec1); // elevated, remediating, [recovery], conv-1, no human

  it("priorities — keeps entries whose derived priority is in the set", () => {
    expect(matchesWorklistFilter(escEntry, { priorities: ["critical"] })).toBe(true);
    expect(matchesWorklistFilter(recEntry, { priorities: ["critical"] })).toBe(false);
    expect(matchesWorklistFilter(recEntry, { priorities: ["critical", "elevated"] })).toBe(true);
  });

  it("modes — keeps entries whose recorded mode is in the set", () => {
    expect(matchesWorklistFilter(escEntry, { modes: ["escalating"] })).toBe(true);
    expect(matchesWorklistFilter(recEntry, { modes: ["escalating"] })).toBe(false);
  });

  it("categories — keeps entries whose derived categories include EVERY listed category (superset)", () => {
    expect(matchesWorklistFilter(escEntry, { categories: ["escalation"] })).toBe(true);
    expect(matchesWorklistFilter(escEntry, { categories: ["human_review", "escalation"] })).toBe(true);
    expect(matchesWorklistFilter(recEntry, { categories: ["escalation"] })).toBe(false);
    // recovery is not on human_review, so the superset match fails.
    expect(matchesWorklistFilter(recEntry, { categories: ["recovery", "human_review"] })).toBe(false);
  });

  it("requires_human / conversation_id — scalar equality", () => {
    expect(matchesWorklistFilter(escEntry, { requires_human: true })).toBe(true);
    expect(matchesWorklistFilter(recEntry, { requires_human: true })).toBe(false);
    expect(matchesWorklistFilter(escEntry, { conversation_id: "conv-1" })).toBe(true);
    expect(matchesWorklistFilter(escEntry, { conversation_id: "conv-2" })).toBe(false);
  });

  it("AND-composes present constraints; an omitted field is unconstrained; an empty array matches nothing", () => {
    expect(matchesWorklistFilter(escEntry, { priorities: ["critical"], requires_human: true })).toBe(true);
    expect(matchesWorklistFilter(escEntry, { priorities: ["critical"], requires_human: false })).toBe(false);
    expect(matchesWorklistFilter(escEntry, {})).toBe(true); // no constraint
    expect(matchesWorklistFilter(escEntry, { priorities: [] })).toBe(false); // ∈ {} ⇒ never
  });
});

describe("filterWorklistEntries — order-preserving, non-mutating", () => {
  it("keeps only matching entries, in input order", () => {
    const filtered = filterWorklistEntries(SET.prioritised, { conversation_id: "conv-1" });
    expect(filtered.map((e) => e.coordination_id)).toEqual(["c-e1", "c-r1"]);
  });

  it("with no filter, returns a copy of the input unchanged", () => {
    const copy = filterWorklistEntries(SET.prioritised);
    expect(copy).not.toBe(SET.prioritised);
    expect(copy.map((e) => e.coordination_id)).toEqual(SET.prioritised.map((e) => e.coordination_id));
  });

  it("does NOT mutate its input array", () => {
    const before = SET.prioritised.map((e) => e.coordination_id);
    filterWorklistEntries(SET.prioritised, { priorities: ["critical"] });
    expect(SET.prioritised.map((e) => e.coordination_id)).toEqual(before);
  });
});

describe("paginateWorklistEntries — bounded windows with paging metadata", () => {
  const entries: WorklistEntry[] = SET.prioritised; // [c-e2, c-e1, c-r1]

  it("with no page request, returns the whole input as one page", () => {
    const page = paginateWorklistEntries(entries);
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1", "c-r1"]);
    expect(page).toMatchObject({ total: 3, limit: 3, offset: 0, has_more: false });
  });

  it("slices the requested window and reports has_more", () => {
    const first = paginateWorklistEntries(entries, { limit: 2 });
    expect(first.items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0, has_more: true });

    const second = paginateWorklistEntries(entries, { limit: 2, offset: 2 });
    expect(second.items.map((e) => e.coordination_id)).toEqual(["c-r1"]);
    expect(second).toMatchObject({ total: 3, limit: 2, offset: 2, has_more: false });
  });

  it("an offset beyond the end yields an empty page, has_more false", () => {
    const page = paginateWorklistEntries(entries, { limit: 5, offset: 10 });
    expect(page.items).toEqual([]);
    expect(page).toMatchObject({ total: 3, has_more: false });
  });

  it("rejects an invalid page bound — the surface never returns a malformed page", () => {
    expect(() => paginateWorklistEntries(entries, { limit: 0 })).toThrow(RangeError);
    expect(() => paginateWorklistEntries(entries, { limit: -1 })).toThrow(RangeError);
    expect(() => paginateWorklistEntries(entries, { limit: 1.5 })).toThrow(RangeError);
    expect(() => paginateWorklistEntries(entries, { limit: 2, offset: -1 })).toThrow(RangeError);
  });

  it("does NOT mutate its input array", () => {
    const before = entries.map((e) => e.coordination_id);
    paginateWorklistEntries(entries, { limit: 1, offset: 1 });
    expect(entries.map((e) => e.coordination_id)).toEqual(before);
  });
});

describe("queryWorklist — select → filter → order (reused) → page, the read-surface projection", () => {
  it("returns the whole view, R38-ordered, when neither filter nor page is given", () => {
    const page = queryWorklist(SET, { view: "prioritised" });
    expect(page.view).toBe("prioritised");
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1", "c-r1"]);
    expect(page).toMatchObject({ total: 3, limit: 3, offset: 0, has_more: false });
  });

  it("keeps the R38 canonical order — the returned items ARE the engine's entries (authoritative)", () => {
    const page = queryWorklist(SET, { view: "escalation" });
    // Same entry objects the engine derived, in the engine's order — the surface re-derives nothing.
    expect(page.items[0]).toBe(SET.escalation[0]);
    expect(page.items[1]).toBe(SET.escalation[1]);
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
  });

  it("filters within a view (priority filter narrows the prioritised backlog)", () => {
    const page = queryWorklist(SET, { view: "prioritised", filter: { priorities: ["critical"] } });
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
    expect(page.total).toBe(2);
  });

  it("filters by conversation across priorities, preserving the R38 order", () => {
    const page = queryWorklist(SET, { view: "prioritised", filter: { conversation_id: "conv-1" } });
    // conv-1 has an escalation (critical) and a remediation (elevated) — critical leads.
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e1", "c-r1"]);
    expect(page.total).toBe(2);
  });

  it("composes a filter with a page — filter first (total reflects the filter), then bound", () => {
    const page = queryWorklist(SET, {
      view: "prioritised",
      filter: { priorities: ["critical"] },
      page: { limit: 1 },
    });
    expect(page.items.map((e) => e.coordination_id)).toEqual(["c-e2"]);
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 0, has_more: true });
  });

  it("reads each of the four required worklists", () => {
    expect(queryWorklist(SET, { view: "human_review" }).items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
    expect(queryWorklist(SET, { view: "recovery" }).items.map((e) => e.coordination_id)).toEqual(["c-r1"]);
    expect(queryWorklist(SET, { view: "escalation" }).items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1"]);
    expect(queryWorklist(SET, { view: "prioritised" }).items.map((e) => e.coordination_id)).toEqual(["c-e2", "c-e1", "c-r1"]);
  });

  it("is DETERMINISTIC — the same set and query always yield an identical page", () => {
    const q = { view: "prioritised", filter: { priorities: ["critical", "elevated"] }, page: { limit: 2 } } as const;
    expect(queryWorklist(SET, q)).toEqual(queryWorklist(SET, q));
  });

  it("a non-actionable coordination is on no view — the concluded coordination is never returned", () => {
    for (const view of WORKLIST_VIEWS) {
      const ids = queryWorklist(SET, { view }).items.map((e) => e.coordination_id);
      expect(ids).not.toContain("c-f1");
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";
import { toWorklistEntry, type WorklistEntry } from "@/lib/receptionist/conversation-coordination-worklist";
import {
  projectOwnership,
  type OwnershipClaimRow,
  type OwnershipRecord,
} from "@/lib/receptionist/conversation-ownership-read-model";
import {
  projectAttentionQueue,
  type AttentionQueueView,
} from "@/lib/receptionist/conversation-attention-queue";
import {
  projectAttentionQueueSurface,
  type AttentionQueueSurfaceView,
} from "@/lib/receptionist/conversation-attention-queue-view";

/**
 * Conversation ATTENTION QUEUE SURFACE — pure view-core unit tests (the AI Receptionist Programme, R59: CONVERSATION
 * ATTENTION QUEUE SURFACE).
 *
 * R58 shipped the ATTENTION QUEUE: the pure JOIN/GROUP core (`projectAttentionQueue`) plus the org-scoped runtime that
 * composes the R39 worklist page and the R48 ownership records into an {@link AttentionQueueView}. R59's pure VIEW core
 * (`projectAttentionQueueSurface`) consumes that view verbatim and projects the operator DISPLAY model — each group
 * titled + described + counted, each row's already-derived facts (priority, mode, categories, requires-human, ownership
 * status + owner) humanised, and the queue's headline summary. It reaches no I/O, holds no clock, records nothing,
 * re-derives no worklist and re-decides no ownership, so it is total, deterministic and dependency-free — and THAT is
 * what this suite pins.
 *
 * Every fixture is assembled through the REAL R58 core (`projectAttentionQueue`) — exactly what the runtime hands the
 * surface — so these tests exercise the honest composition, not a hand-built stand-in. The end-to-end read over real
 * Postgres is proven in __tests__/integration/receptionist/attention-queue-surface-pipeline.test.ts.
 */

// The R38/R48/R58 unit factories, reused verbatim (see conversation-attention-queue.test.ts): a COHERENT default
// coordination row (an escalating / human-attention / escalated coordination — priority `critical`, requires-human) that
// each case narrows, plus owned / unowned ownership records built through the real R48 projection.
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
    coordination_mode: "escalating",
    lead_participant: "human_attention",
    participant_count: 1,
    requires_human: true,
    autonomous: false,
    orchestration_route: "escalate",
    lifecycle_state: "escalated",
    approval_state: "approved",
    coordination_status: "coordinated",
    job_type: "boiler_repair",
    postcode: "SW1A 1AA",
    phone_number: "+441234567890",
    coordination_at,
    orchestration_type: "orchestrate_lifecycle_response",
    orchestration_outcome: "conversation_response_orchestrated",
    orchestration_target: "human_attention",
    orchestration_concluded: false,
    orchestration_active: true,
    orchestration_status: "orchestrated",
    orchestration_at: "2026-01-01T09:00:00.000Z",
    lifecycle_type: "govern_lifecycle",
    lifecycle_outcome: "conversation_lifecycle_governed",
    lifecycle_transition: "escalate",
    lifecycle_closed: false,
    lifecycle_ongoing: true,
    lifecycle_status: "governed",
    lifecycle_at: "2026-01-01T08:00:00.000Z",
    resolution_type: "resolve_completion",
    resolution_outcome: "conversation_completion_determined",
    resolution_state: "intervention",
    resolution_terminal: false,
    resolution_intervention_required: true,
    resolution_recovery_classification: "reconcile",
    resolution_status: "determined",
    resolution_at: "2026-01-01T07:00:00.000Z",
    recovery_type: "determine_recovery",
    recovery_outcome: "recovery_determined",
    recovery_classification: "reconcile",
    recovery_required: false,
    recovery_integrity: "consistent",
    recovery_status: "determined",
    recovery_at: "2026-01-01T06:00:00.000Z",
    verification_type: "verify_fulfilment",
    verification_outcome: "fulfilment_verified",
    verification_integrity: "inconsistent",
    verification_status: "verified",
    verification_at: "2026-01-01T05:00:00.000Z",
    fulfilment_type: "record_booking",
    fulfilment_outcome: "booking_recorded",
    fulfilment_status: "fulfilled",
    fulfilment_at: "2026-01-01T04:00:00.000Z",
    ...overrides,
  };
}

/** A valid worklist entry for a coordination + conversation, at an instant. */
function entryOf(
  coordinationId: string,
  conversationId: string | null,
  at = "2026-07-06T10:00:00.000Z",
): WorklistEntry {
  const record: CoordinationRecord = projectCoordinationRecord(
    row(coordinationId, at, { conversation_id: conversationId }),
  );
  return toWorklistEntry(record);
}

/** An OWNED ownership record for a coordination — a claim exists, no release. */
function owned(coordinationId: string, conversationId: string): OwnershipRecord {
  const claim: OwnershipClaimRow = {
    coordination_id: coordinationId,
    org_id: "org-1",
    conversation_id: conversationId,
    correlation_id: "corr-1",
    operator_id: "operator-1",
    operator_email: "op@crewflow.uk",
    claim_type: "claim_conversation_work",
    claim_outcome: "work_claimed",
    status: "claimed",
    claimed_at: "2026-07-06T12:00:00.000Z",
  };
  return projectOwnership({ coordinationId, claim });
}

/** An UNOWNED ownership record for a coordination — no claim names it. */
function unowned(coordinationId: string): OwnershipRecord {
  return projectOwnership({ coordinationId, claim: null });
}

/** The ownership map the runtime supplies — one record per entry, keyed by coordination id. */
function ownershipMap(...records: OwnershipRecord[]): Map<string, OwnershipRecord> {
  return new Map(records.map((r) => [r.coordinationId, r]));
}

/** Compose the two cores exactly as the runtime does: build the R58 view, then project the R59 surface over it. */
function surfaceOf(
  entries: readonly WorklistEntry[],
  records: readonly OwnershipRecord[],
): AttentionQueueSurfaceView {
  const view: AttentionQueueView = projectAttentionQueue({
    entries,
    ownershipByCoordination: ownershipMap(...records),
  });
  return projectAttentionQueueSurface(view);
}

/** The wall-clock render the surface must produce for an ISO instant — the same SLICE the core performs (never a parse). */
function slice(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

describe("projectAttentionQueueSurface — both groups, titled and counted, in presentation order", () => {
  it("always names both groups (unowned then owned), each titled and described", () => {
    const surface = surfaceOf([entryOf("coord-a", "conv-a")], [unowned("coord-a")]);
    expect(surface.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    const [unownedGroup, ownedGroup] = surface.groups;
    expect(unownedGroup?.title).toBe("Waiting to be picked up");
    expect(ownedGroup?.title).toBe("In progress");
    expect(unownedGroup?.description).toMatch(/no operator holds/i);
    expect(ownedGroup?.description).toMatch(/claimed/i);
  });

  it("counts each group and the whole queue, and surfaces the split counts for the headline", () => {
    const surface = surfaceOf(
      [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b"), entryOf("coord-c", "conv-c")],
      [unowned("coord-a"), unowned("coord-b"), owned("coord-c", "conv-c")],
    );
    const counts = Object.fromEntries(surface.groups.map((g) => [g.group, g.count]));
    expect(counts).toEqual({ unowned: 2, owned: 1 });
    expect(surface.total).toBe(3);
    expect(surface.unownedCount).toBe(2);
    expect(surface.ownedCount).toBe(1);
    expect(surface.isEmpty).toBe(false);
  });
});

describe("projectAttentionQueueSurface — preserves the R58 grouping and canonical order", () => {
  it("keeps rows unowned-first, owned-next, preserving the input order within each group", () => {
    // Interleave owned / unowned to prove the surface RE-ORDERS nothing — it renders the R58 view's order verbatim.
    const entries = [
      entryOf("coord-a", "conv-a"), // owned
      entryOf("coord-b", "conv-b"), // unowned
      entryOf("coord-c", "conv-c"), // owned
      entryOf("coord-d", "conv-d"), // unowned
    ];
    const surface = surfaceOf(entries, [
      owned("coord-a", "conv-a"),
      unowned("coord-b"),
      owned("coord-c", "conv-c"),
      unowned("coord-d"),
    ]);
    const unownedGroup = surface.groups.find((g) => g.group === "unowned")!;
    const ownedGroup = surface.groups.find((g) => g.group === "owned")!;
    expect(unownedGroup.rows.map((r) => r.coordinationId)).toEqual(["coord-b", "coord-d"]);
    expect(ownedGroup.rows.map((r) => r.coordinationId)).toEqual(["coord-a", "coord-c"]);
    // The flat `rows` list is the groups concatenated in presentation order: unowned then owned.
    expect(surface.rows.map((r) => r.coordinationId)).toEqual(["coord-b", "coord-d", "coord-a", "coord-c"]);
    // Every row carries its group label from the R48 status.
    expect(surface.rows.map((r) => r.group)).toEqual(["unowned", "unowned", "owned", "owned"]);
  });
});

describe("projectAttentionQueueSurface — humanises each row's already-derived facts", () => {
  it("humanises the derived priority, the recorded mode and the worklist categories", () => {
    const entry = entryOf("coord-a", "conv-a");
    const surface = surfaceOf([entry], [unowned("coord-a")]);
    const r = surface.rows[0]!;
    // The default coordination is escalating → priority `critical`; both are surfaced raw + humanised.
    expect(r.priority).toBe("critical");
    expect(r.priorityLabel).toBe("Critical");
    expect(r.mode).toBe("escalating");
    expect(r.modeLabel).toBe("Escalating");
    // Categories are humanised (no snake_case reaches the display), one label per derived category.
    expect(r.categoryLabels).toHaveLength(entry.categories.length);
    for (const label of r.categoryLabels) {
      expect(label).not.toMatch(/_/);
      expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
    }
  });

  it("surfaces the human-required flag with its label and tone", () => {
    const required = surfaceOf([entryOf("coord-a", "conv-a")], [unowned("coord-a")]).rows[0]!;
    expect(required.requiresHuman).toBe(true);
    expect(required.humanLabel).toBe("Required");
    expect(required.humanTone).toBe("required");

    // An autonomous coordination (no human needed) surfaces the opposite tone.
    const autoEntry = entryOf("coord-x", "conv-x");
    const autonomous = projectAttentionQueueSurface(
      projectAttentionQueue({
        entries: [{ ...autoEntry, requires_human: false }],
        ownershipByCoordination: ownershipMap(unowned("coord-x")),
      }),
    ).rows[0]!;
    expect(autonomous.requiresHuman).toBe(false);
    expect(autonomous.humanLabel).toBe("Not required");
    expect(autonomous.humanTone).toBe("autonomous");
  });

  it("renders instants by SLICING (zone-stable) — never a Date parse — and the em dash for an absent held-since", () => {
    const entry = entryOf("coord-a", "conv-a", "2026-07-06T10:34:56.000Z");
    const ownership = owned("coord-a", "conv-a");
    const r = surfaceOf([entry], [ownership]).rows[0]!;
    expect(r.recordedAt).toBe(slice("2026-07-06T10:34:56.000Z"));
    expect(r.heldSince).toBe(ownership.heldSince ? slice(ownership.heldSince) : "—");

    // An unowned row has no held-since — the em dash, never a fabricated time.
    const unownedRow = surfaceOf([entryOf("coord-b", "conv-b")], [unowned("coord-b")]).rows[0]!;
    expect(unownedRow.heldSince).toBe("—");
  });

  it("keeps a positive offset instant on its own calendar day (proves the slice is not a UTC parse)", () => {
    const r = surfaceOf([entryOf("coord-a", "conv-a", "2026-07-06T01:15:00.000+05:00")], [unowned("coord-a")]).rows[0]!;
    // A `Date` parse would shift 01:15+05:00 back to the previous UTC day; the slice keeps the wall clock as written.
    expect(r.recordedAt).toBe("2026-07-06 01:15");
  });
});

describe("projectAttentionQueueSurface — ownership state and its summary", () => {
  it("labels an owned row with its owner (email, else operator id) and a held-by summary", () => {
    const r = surfaceOf([entryOf("coord-a", "conv-a")], [owned("coord-a", "conv-a")]).rows[0]!;
    expect(r.ownershipStatus).toBe("owned");
    expect(r.ownershipLabel).toBe("Owned");
    expect(r.ownershipTone).toBe("held");
    expect(r.ownerLabel).toBe("op@crewflow.uk");
    expect(r.reassigned).toBe(false);
    expect(r.ownershipSummary).toBe("Held by op@crewflow.uk.");
  });

  it("falls back to the operator id when the owner has no email", () => {
    const base = owned("coord-a", "conv-a");
    const record: OwnershipRecord = { ...base, owner: { ...base.owner!, operatorEmail: null } };
    const r = surfaceOf([entryOf("coord-a", "conv-a")], [record]).rows[0]!;
    expect(r.ownerLabel).toBe("operator-1");
    expect(r.ownershipSummary).toBe("Held by operator-1.");
  });

  it("notes a transfer when the current holder was reached by reassignment", () => {
    const record: OwnershipRecord = { ...owned("coord-a", "conv-a"), reassigned: true };
    const r = surfaceOf([entryOf("coord-a", "conv-a")], [record]).rows[0]!;
    expect(r.reassigned).toBe(true);
    expect(r.ownershipSummary).toBe("Held by op@crewflow.uk, by transfer.");
  });

  it("labels an unowned row as waiting, with no owner", () => {
    const r = surfaceOf([entryOf("coord-a", "conv-a")], [unowned("coord-a")]).rows[0]!;
    expect(r.ownershipStatus).toBe("unowned");
    expect(r.ownershipLabel).toBe("Unowned");
    expect(r.ownershipTone).toBe("unheld");
    expect(r.ownerLabel).toBeNull();
    expect(r.ownershipSummary).toBe("Waiting to be picked up — no operator holds this yet.");
  });

  it("carries a null conversation id through verbatim, with no short form", () => {
    const r = surfaceOf([entryOf("coord-a", null)], [unowned("coord-a")]).rows[0]!;
    expect(r.conversationId).toBeNull();
    expect(r.conversationIdShort).toBeNull();
    expect(r.coordinationIdShort).toBe("coord-a".slice(0, 8));
  });
});

describe("projectAttentionQueueSurface — the headline summary", () => {
  it("reports the size and the unowned / owned split (plural)", () => {
    const surface = surfaceOf(
      [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b"), entryOf("coord-c", "conv-c")],
      [unowned("coord-a"), owned("coord-b", "conv-b"), unowned("coord-c")],
    );
    expect(surface.summaryLabel).toBe(
      "3 conversations need attention — 2 waiting to be picked up, 1 in progress.",
    );
  });

  it("uses the singular for a single conversation", () => {
    const surface = surfaceOf([entryOf("coord-a", "conv-a")], [owned("coord-a", "conv-a")]);
    expect(surface.summaryLabel).toBe("1 conversation needs attention — 0 waiting to be picked up, 1 in progress.");
  });
});

describe("projectAttentionQueueSurface — the empty queue", () => {
  it("names both groups (present and empty), total 0, isEmpty, and the empty summary", () => {
    const surface = surfaceOf([], []);
    expect(surface.rows).toEqual([]);
    expect(surface.total).toBe(0);
    expect(surface.isEmpty).toBe(true);
    expect(surface.unownedCount).toBe(0);
    expect(surface.ownedCount).toBe(0);
    expect(surface.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    expect(surface.groups.every((g) => g.count === 0 && g.rows.length === 0)).toBe(true);
    expect(surface.summaryLabel).toBe("No conversations need attention right now.");
  });
});

describe("projectAttentionQueueSurface — deterministic and non-mutating", () => {
  it("is a pure function — the same view yields an equal surface, and the input view is untouched", () => {
    const entries = [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b")];
    const view = projectAttentionQueue({
      entries,
      ownershipByCoordination: ownershipMap(owned("coord-a", "conv-a"), unowned("coord-b")),
    });
    const snapshot = view.entries.map((e) => e.coordination_id);
    const first = projectAttentionQueueSurface(view);
    const second = projectAttentionQueueSurface(view);
    expect(first).toEqual(second);
    expect(view.entries.map((e) => e.coordination_id)).toEqual(snapshot); // input untouched
  });
});

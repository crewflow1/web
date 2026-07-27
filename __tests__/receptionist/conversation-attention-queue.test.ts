import { describe, it, expect } from "vitest";
import {
  projectCoordinationRecord,
  type CoordinationReadRow,
  type CoordinationRecord,
} from "@/lib/receptionist/conversation-coordination-view";
import {
  toWorklistEntry,
  type WorklistEntry,
} from "@/lib/receptionist/conversation-coordination-worklist";
import {
  projectOwnership,
  type OwnershipClaimRow,
  type OwnershipRecord,
} from "@/lib/receptionist/conversation-ownership-read-model";
import {
  ATTENTION_GROUPS,
  projectAttentionQueue,
} from "@/lib/receptionist/conversation-attention-queue";

/**
 * Conversation ATTENTION QUEUE — pure-core unit tests (the AI Receptionist Programme, R58: CONVERSATION
 * ATTENTION QUEUE).
 *
 * The queue's PURE CORE JOINS already-ordered worklist entries (the R38 `prioritised` backlog, delivered
 * through R39) with their R48 ownership records and GROUPS them by ownership — unowned first (waiting to be
 * picked up), owned next (in progress) — preserving the R38 canonical order within each group. It reaches no
 * I/O, holds no clock, records nothing, re-derives no worklist and re-decides no ownership, so it is total,
 * deterministic and dependency-free — and THAT is what this suite pins:
 *   • ATTENTION_GROUPS      — the closed, ordered presentation vocabulary (unowned, owned).
 *   • projectAttentionQueue — entries + an ownership map → the grouped, ordered, counted queue; the group is
 *                             read from the R48 status alone, the order within a group is the input's, and
 *                             every entry / ownership fact is passed through verbatim.
 *
 * The end-to-end read over real Postgres (through the R39 → R38 → R37 and R48 readers) is proven in
 * __tests__/integration/receptionist/attention-queue-pipeline.test.ts.
 */

// The R38 unit factory, reused: a COHERENT default row (a finalising / conversation_conclusion / closed
// coordination) that each case narrows. The core groups by ownership regardless of actionability, so the
// coordination shape only has to be VALID — its coordination + conversation ids give each entry an identity.
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
function entryOf(coordinationId: string, conversationId: string, at = "2026-07-06T10:00:00.000Z"): WorklistEntry {
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

/** Build the ownership map the runtime would supply: one record per entry, keyed by coordination id. */
function ownershipMap(...records: OwnershipRecord[]): Map<string, OwnershipRecord> {
  return new Map(records.map((r) => [r.coordinationId, r]));
}

describe("ATTENTION_GROUPS — the closed, ordered presentation vocabulary", () => {
  it("is exactly unowned then owned", () => {
    expect(ATTENTION_GROUPS).toEqual(["unowned", "owned"]);
  });
});

describe("projectAttentionQueue — join, group by ownership, preserve the R38 order", () => {
  it("labels each row's group from the R48 ownership status alone", () => {
    const a = entryOf("coord-a", "conv-a");
    const b = entryOf("coord-b", "conv-b");
    const view = projectAttentionQueue({
      entries: [a, b],
      ownershipByCoordination: ownershipMap(owned("coord-a", "conv-a"), unowned("coord-b")),
    });
    const byId = new Map(view.entries.map((e) => [e.coordination_id, e.group]));
    expect(byId.get("coord-a")).toBe("owned");
    expect(byId.get("coord-b")).toBe("unowned");
  });

  it("always names both groups, in presentation order (unowned then owned)", () => {
    const view = projectAttentionQueue({
      entries: [entryOf("coord-a", "conv-a")],
      ownershipByCoordination: ownershipMap(owned("coord-a", "conv-a")),
    });
    expect(view.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
  });

  it("partitions unowned-first and preserves the input (R38 canonical) order within each group", () => {
    // Input order is the R38 canonical order R39 delivers. Interleave owned/unowned to prove the partition
    // is STABLE — the relative order within each group is the input's, never re-sorted.
    const a = entryOf("coord-a", "conv-a"); // owned
    const b = entryOf("coord-b", "conv-b"); // unowned
    const c = entryOf("coord-c", "conv-c"); // owned
    const d = entryOf("coord-d", "conv-d"); // unowned
    const view = projectAttentionQueue({
      entries: [a, b, c, d],
      ownershipByCoordination: ownershipMap(
        owned("coord-a", "conv-a"),
        unowned("coord-b"),
        owned("coord-c", "conv-c"),
        unowned("coord-d"),
      ),
    });
    const unownedGroup = view.groups.find((g) => g.group === "unowned")!;
    const ownedGroup = view.groups.find((g) => g.group === "owned")!;
    expect(unownedGroup.entries.map((e) => e.coordination_id)).toEqual(["coord-b", "coord-d"]);
    expect(ownedGroup.entries.map((e) => e.coordination_id)).toEqual(["coord-a", "coord-c"]);
    // The flat list is the groups concatenated in presentation order: unowned then owned.
    expect(view.entries.map((e) => e.coordination_id)).toEqual([
      "coord-b",
      "coord-d",
      "coord-a",
      "coord-c",
    ]);
  });

  it("counts each group and the whole queue", () => {
    const view = projectAttentionQueue({
      entries: [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b"), entryOf("coord-c", "conv-c")],
      ownershipByCoordination: ownershipMap(
        unowned("coord-a"),
        unowned("coord-b"),
        owned("coord-c", "conv-c"),
      ),
    });
    const counts = Object.fromEntries(view.groups.map((g) => [g.group, g.count]));
    expect(counts).toEqual({ unowned: 2, owned: 1 });
    expect(view.total).toBe(3);
  });

  it("passes the worklist entry and ownership record through verbatim", () => {
    const a = entryOf("coord-a", "conv-a");
    const ownership = owned("coord-a", "conv-a");
    const view = projectAttentionQueue({
      entries: [a],
      ownershipByCoordination: ownershipMap(ownership),
    });
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]?.entry).toBe(a);
    expect(view.entries[0]?.ownership).toBe(ownership);
    expect(view.entries[0]?.coordination_id).toBe("coord-a");
    expect(view.entries[0]?.conversation_id).toBe("conv-a");
  });

  it("handles an all-unowned queue — the owned group is present but empty", () => {
    const view = projectAttentionQueue({
      entries: [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b")],
      ownershipByCoordination: ownershipMap(unowned("coord-a"), unowned("coord-b")),
    });
    const ownedGroup = view.groups.find((g) => g.group === "owned")!;
    const unownedGroup = view.groups.find((g) => g.group === "unowned")!;
    expect(ownedGroup.entries).toEqual([]);
    expect(ownedGroup.count).toBe(0);
    expect(unownedGroup.count).toBe(2);
  });

  it("handles an empty queue — both groups present and empty, total 0", () => {
    const view = projectAttentionQueue({ entries: [], ownershipByCoordination: new Map() });
    expect(view.entries).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.groups.map((g) => g.group)).toEqual(["unowned", "owned"]);
    expect(view.groups.every((g) => g.count === 0)).toBe(true);
  });

  it("throws when an entry has no ownership record — the runtime must supply one for every entry", () => {
    expect(() =>
      projectAttentionQueue({
        entries: [entryOf("coord-a", "conv-a")],
        ownershipByCoordination: new Map(), // missing coord-a
      }),
    ).toThrow(/no ownership record/i);
  });

  it("is non-mutating and deterministic — inputs are untouched and the same inputs yield the same queue", () => {
    const entries = [entryOf("coord-a", "conv-a"), entryOf("coord-b", "conv-b")];
    const map = ownershipMap(owned("coord-a", "conv-a"), unowned("coord-b"));
    const snapshot = entries.map((e) => e.coordination_id);
    const first = projectAttentionQueue({ entries, ownershipByCoordination: map });
    const second = projectAttentionQueue({ entries, ownershipByCoordination: map });
    expect(entries.map((e) => e.coordination_id)).toEqual(snapshot); // input array untouched
    expect(first).toEqual(second); // deterministic
  });
});

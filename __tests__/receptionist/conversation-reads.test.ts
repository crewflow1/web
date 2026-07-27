import { describe, it, expect } from "vitest";
import {
  compareTimelineEvents,
  orderTimeline,
  type TimelineEvent,
} from "@/server/services/receptionist-conversation-reads";

/**
 * Conversation Timeline Read Model — canonical ordering, unit tier
 * (the AI Receptionist Programme, R11 — CONVERSATION TIMELINE READ MODEL).
 *
 * The read model's ONE hard guarantee is that a conversation reconstructs IDENTICALLY every
 * time — the same set of messages always yields the same ordered timeline. That guarantee is
 * a pure function: `compareTimelineEvents` is a TOTAL order over events (chronological by
 * `event_at`, then a stable tiebreak on `message_id`), and `orderTimeline` applies it
 * WITHOUT mutating its input. These tests pin that determinism as pure logic; the database's
 * own `order by` and the end-to-end deterministic reconstruction over real Postgres are proven
 * in __tests__/integration/receptionist/conversation-read-model.test.ts.
 *
 * If the comparator were not a total order (e.g. it left same-instant events unordered), two
 * reads of the same conversation could return the messages in different orders — exactly the
 * non-determinism the read model exists to eliminate.
 */

// A fully-populated TimelineEvent is wide; tests only care about the two ordering keys, so a
// factory fills the rest with inert nulls and lets each case set message_id + event_at.
function evt(message_id: string, event_at: string): TimelineEvent {
  return {
    message_id,
    conversation_id: "conv-1",
    org_id: "org-1",
    direction: "inbound",
    channel: "sms",
    event_at,
    enquiry_id: null,
    inbound_text: null,
    inbound_caller: null,
    inbound_summary: null,
    inbound_job_type: null,
    inbound_urgency: null,
    inbound_postcode: null,
    inbound_confidence: null,
    inbound_status: null,
    inbound_at: null,
    audit_id: null,
    outbound_employee_slug: null,
    outbound_correlation_id: null,
    outbound_customer_ref: null,
    outbound_draft: null,
    outbound_verdict: null,
    outbound_allowed: null,
    outbound_categories: null,
    outbound_enforcement_reason: null,
    outbound_safe_text: null,
    outbound_audit_at: null,
    transport_id: null,
    transport_status: null,
    transport_provider: null,
    provider_message_id: null,
    transport_failure_reason: null,
    transport_at: null,
    receipt_id: null,
    delivery_status: null,
    delivery_terminal: null,
    delivery_provider_status: null,
    delivery_error_code: null,
    receipt_at: null,
    receipt_count: null,
  };
}

describe("compareTimelineEvents — a total chronological order with a stable tiebreak", () => {
  it("orders by event_at (the earlier instant comes first)", () => {
    const early = evt("m-b", "2026-01-01T10:00:00.000Z");
    const late = evt("m-a", "2026-01-01T10:00:05.000Z");
    expect(compareTimelineEvents(early, late)).toBeLessThan(0);
    expect(compareTimelineEvents(late, early)).toBeGreaterThan(0);
  });

  it("compares instants, not raw strings (equal moments in different zone spellings tie)", () => {
    // The same instant written as Z and as +00:00 must be treated as equal, then decided by
    // the message_id tiebreak — never left to lexical string comparison of the timestamps.
    const z = evt("m-a", "2026-01-01T10:00:00.000Z");
    const offset = evt("m-b", "2026-01-01T10:00:00.000+00:00");
    expect(compareTimelineEvents(z, offset)).toBeLessThan(0); // decided by m-a < m-b
    expect(compareTimelineEvents(offset, z)).toBeGreaterThan(0);
  });

  it("tiebreaks on message_id when the instant is identical", () => {
    const a = evt("m-a", "2026-01-01T10:00:00.000Z");
    const b = evt("m-b", "2026-01-01T10:00:00.000Z");
    expect(compareTimelineEvents(a, b)).toBeLessThan(0);
    expect(compareTimelineEvents(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 only for the same event (same instant AND same id)", () => {
    const a = evt("m-a", "2026-01-01T10:00:00.000Z");
    const same = evt("m-a", "2026-01-01T10:00:00.000Z");
    expect(compareTimelineEvents(a, same)).toBe(0);
  });

  it("is antisymmetric — compare(a,b) is the negation-sign of compare(b,a)", () => {
    const pairs: Array<[TimelineEvent, TimelineEvent]> = [
      [evt("m-a", "2026-01-01T10:00:00.000Z"), evt("m-b", "2026-01-01T10:00:05.000Z")],
      [evt("m-a", "2026-01-01T10:00:00.000Z"), evt("m-b", "2026-01-01T10:00:00.000Z")],
      [evt("m-z", "2026-01-01T11:00:00.000Z"), evt("m-a", "2026-01-01T10:00:00.000Z")],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(compareTimelineEvents(a, b))).toBe(-Math.sign(compareTimelineEvents(b, a)));
    }
  });
});

describe("orderTimeline — deterministic, non-mutating canonical ordering", () => {
  it("sorts a shuffled set into chronological order", () => {
    const shuffled = [
      evt("m-3", "2026-01-01T10:00:10.000Z"),
      evt("m-1", "2026-01-01T10:00:00.000Z"),
      evt("m-2", "2026-01-01T10:00:05.000Z"),
    ];
    expect(orderTimeline(shuffled).map((e) => e.message_id)).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("breaks same-instant ties by message_id so the order is fully determined", () => {
    const sameInstant = [
      evt("m-c", "2026-01-01T10:00:00.000Z"),
      evt("m-a", "2026-01-01T10:00:00.000Z"),
      evt("m-b", "2026-01-01T10:00:00.000Z"),
    ];
    expect(orderTimeline(sameInstant).map((e) => e.message_id)).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("is DETERMINISTIC — any input permutation of the same set yields one identical order", () => {
    // This is the read model's core promise: the same conversation reconstructs identically
    // no matter what order the database handed the rows back in.
    const a = evt("m-a", "2026-01-01T10:00:00.000Z");
    const b = evt("m-b", "2026-01-01T10:00:00.000Z"); // same instant as m-a → tiebreak territory
    const c = evt("m-c", "2026-01-01T10:00:05.000Z");
    const d = evt("m-d", "2026-01-01T09:59:00.000Z");
    const permutations: TimelineEvent[][] = [
      [a, b, c, d],
      [d, c, b, a],
      [c, a, d, b],
      [b, d, a, c],
    ];
    const canonical = ["m-d", "m-a", "m-b", "m-c"];
    for (const perm of permutations) {
      expect(orderTimeline(perm).map((e) => e.message_id)).toEqual(canonical);
    }
  });

  it("does NOT mutate its input array", () => {
    const input = [
      evt("m-2", "2026-01-01T10:00:05.000Z"),
      evt("m-1", "2026-01-01T10:00:00.000Z"),
    ];
    const before = input.map((e) => e.message_id);
    orderTimeline(input);
    expect(input.map((e) => e.message_id)).toEqual(before); // ["m-2", "m-1"] — untouched
  });

  it("is idempotent — ordering an already-ordered timeline is a no-op", () => {
    const ordered = orderTimeline([
      evt("m-2", "2026-01-01T10:00:05.000Z"),
      evt("m-1", "2026-01-01T10:00:00.000Z"),
    ]);
    expect(orderTimeline(ordered)).toEqual(ordered);
  });

  it("handles the empty and singleton timelines", () => {
    expect(orderTimeline([])).toEqual([]);
    const one = [evt("m-1", "2026-01-01T10:00:00.000Z")];
    expect(orderTimeline(one).map((e) => e.message_id)).toEqual(["m-1"]);
  });
});

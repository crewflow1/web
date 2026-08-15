import { describe, it, expect } from "vitest";
import {
  orderMessages,
  assembleThread,
  summariseConversation,
  previewBody,
  contactLabel,
  type InboxConversation,
  type InboxMessage,
} from "@/lib/inbox/thread";

/**
 * P3 Inbox — thread assembly pins. Deterministic ordering (created_at, id tiebreaker),
 * awaiting-reply derivation, and list-summary shaping.
 */

const conv: InboxConversation = {
  id: "c1",
  org_id: "o1",
  channel: "sms",
  contact_ref: "+447700900123",
  contact_name: "Jane Doe",
  subject: null,
  status: "active",
  last_message_at: "2026-08-15T10:05:00.000Z",
  created_at: "2026-08-15T10:00:00.000Z",
};

function msg(over: Partial<InboxMessage>): InboxMessage {
  return {
    id: "m",
    conversation_id: "c1",
    direction: "inbound",
    channel: "sms",
    from_addr: null,
    to_addr: null,
    body: null,
    status: null,
    failure_reason: null,
    provider_id: null,
    created_by: null,
    created_at: "2026-08-15T10:00:00.000Z",
    ...over,
  };
}

describe("orderMessages", () => {
  it("sorts by created_at then id, stably", () => {
    const a = msg({ id: "a", created_at: "2026-08-15T10:02:00.000Z" });
    const b = msg({ id: "b", created_at: "2026-08-15T10:01:00.000Z" });
    const c = msg({ id: "c", created_at: "2026-08-15T10:02:00.000Z" });
    const ordered = orderMessages([a, b, c]);
    expect(ordered.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const input = [msg({ id: "z", created_at: "2026-08-15T10:09:00.000Z" }), msg({ id: "y" })];
    const copy = [...input];
    orderMessages(input);
    expect(input).toEqual(copy);
  });
});

describe("assembleThread", () => {
  it("orders messages and flags awaitingReply when the customer spoke last", () => {
    const t = assembleThread(conv, [
      msg({ id: "1", direction: "outbound", created_at: "2026-08-15T10:00:00.000Z" }),
      msg({ id: "2", direction: "inbound", created_at: "2026-08-15T10:05:00.000Z" }),
    ]);
    expect(t.messageCount).toBe(2);
    expect(t.messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(t.lastMessage?.id).toBe("2");
    expect(t.awaitingReply).toBe(true);
  });

  it("is not awaitingReply when the operator replied last", () => {
    const t = assembleThread(conv, [
      msg({ id: "1", direction: "inbound", created_at: "2026-08-15T10:00:00.000Z" }),
      msg({ id: "2", direction: "outbound", created_at: "2026-08-15T10:05:00.000Z" }),
    ]);
    expect(t.awaitingReply).toBe(false);
  });

  it("handles an empty thread", () => {
    const t = assembleThread(conv, []);
    expect(t.messageCount).toBe(0);
    expect(t.lastMessage).toBeNull();
    expect(t.awaitingReply).toBe(false);
  });
});

describe("summariseConversation", () => {
  it("derives preview + direction + awaitingReply from the latest message", () => {
    const s = summariseConversation(conv, msg({ id: "x", direction: "inbound", body: "Hello there" }));
    expect(s.lastPreview).toBe("Hello there");
    expect(s.lastDirection).toBe("inbound");
    expect(s.awaitingReply).toBe(true);
  });

  it("falls back cleanly with no messages", () => {
    const s = summariseConversation(conv, null);
    expect(s.lastPreview).toBe("");
    expect(s.lastDirection).toBeNull();
    expect(s.awaitingReply).toBe(false);
  });
});

describe("previewBody / contactLabel", () => {
  it("collapses whitespace and truncates long bodies", () => {
    expect(previewBody("a\n\n  b   c")).toBe("a b c");
    expect(previewBody(null)).toBe("");
    const long = "x".repeat(200);
    const p = previewBody(long, 20);
    expect(p.length).toBe(20);
    expect(p.endsWith("…")).toBe(true);
  });

  it("prefers name, then ref, then a fallback", () => {
    expect(contactLabel(conv)).toBe("Jane Doe");
    expect(contactLabel({ ...conv, contact_name: null })).toBe("+447700900123");
    expect(contactLabel({ ...conv, contact_name: null, contact_ref: null })).toBe("Unknown contact");
  });
});

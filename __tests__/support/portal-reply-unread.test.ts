import { describe, it, expect } from "vitest";
import {
  isAwaitingOrgReply,
  hasUnreadOrgReplyForCustomer,
  countAwaitingOrgReply,
  countUnreadOrgRepliesForCustomer,
} from "@/lib/support/unread";

/**
 * Derived unread signals for portal support threads (Train F).
 *
 * The badge reads "who spoke last" off support_tickets.last_reply_kind (stamped
 * by the after-insert trigger) — no new column, no read-marker write. These pure
 * predicates are the whole of that logic.
 */

describe("isAwaitingOrgReply — TENANT view", () => {
  it("true only when a portal customer spoke last", () => {
    expect(
      isAwaitingOrgReply({ customer_id: "c1", last_reply_kind: "customer" }),
    ).toBe(true);
  });

  it("false once the org has replied", () => {
    expect(
      isAwaitingOrgReply({ customer_id: "c1", last_reply_kind: "org" }),
    ).toBe(false);
  });

  it("false for a CrewFlow helpdesk thread (no customer_id) even if a customer spoke last", () => {
    // customer_id null = the org↔CrewFlow conversation; 'customer' there means
    // the tenant org, not an end-customer, so this is not a portal reply.
    expect(
      isAwaitingOrgReply({ customer_id: null, last_reply_kind: "customer" }),
    ).toBe(false);
  });

  it("false for an 'hq' last reply on a portal thread", () => {
    expect(isAwaitingOrgReply({ customer_id: "c1", last_reply_kind: "hq" })).toBe(
      false,
    );
  });

  it("false when nobody has replied yet (null)", () => {
    expect(
      isAwaitingOrgReply({ customer_id: "c1", last_reply_kind: null }),
    ).toBe(false);
  });
});

describe("hasUnreadOrgReplyForCustomer — PORTAL view", () => {
  it("true when the org spoke last", () => {
    expect(hasUnreadOrgReplyForCustomer({ last_reply_kind: "org" })).toBe(true);
  });

  it("false when the customer spoke last", () => {
    expect(hasUnreadOrgReplyForCustomer({ last_reply_kind: "customer" })).toBe(
      false,
    );
  });

  it("false for 'hq' (never addressed to the customer) and null", () => {
    expect(hasUnreadOrgReplyForCustomer({ last_reply_kind: "hq" })).toBe(false);
    expect(hasUnreadOrgReplyForCustomer({ last_reply_kind: null })).toBe(false);
  });
});

describe("counts", () => {
  it("counts only tenant-awaiting portal threads", () => {
    expect(
      countAwaitingOrgReply([
        { customer_id: "c1", last_reply_kind: "customer" }, // yes
        { customer_id: "c2", last_reply_kind: "org" }, // no — org answered
        { customer_id: null, last_reply_kind: "customer" }, // no — helpdesk
        { customer_id: "c3", last_reply_kind: "customer" }, // yes
      ]),
    ).toBe(2);
  });

  it("counts only unanswered staff replies for the customer", () => {
    expect(
      countUnreadOrgRepliesForCustomer([
        { last_reply_kind: "org" }, // yes
        { last_reply_kind: "customer" }, // no
        { last_reply_kind: "org" }, // yes
        { last_reply_kind: null }, // no
      ]),
    ).toBe(2);
  });

  it("empty list ⇒ 0 for both", () => {
    expect(countAwaitingOrgReply([])).toBe(0);
    expect(countUnreadOrgRepliesForCustomer([])).toBe(0);
  });
});

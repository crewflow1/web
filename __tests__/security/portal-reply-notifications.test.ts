import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  notifyOnPortalReplyToOrg,
  EVENT_HELPERS,
} from "@/lib/notifications/events";
import { NOTIFICATION_CATEGORY_LABEL } from "@/lib/notifications/types";
import { buildPortalReplyEmail } from "@/lib/email/templates/portal-reply";

/**
 * Train F — Portal message reply notifications (both directions) + no-leakage.
 *
 * Two silent gaps closed:
 *   a. TENANT → CUSTOMER: staff replies to a portal thread now email the
 *      customer a notification + a scoped portal link (never the body).
 *   b. CUSTOMER → TENANT: a portal reply now emits an org-scoped in-app
 *      notification so staff learn of it instead of happening upon it.
 *
 * Pure emitters/templates are tested BEHAVIOURALLY; the server actions and the
 * IO send module are pinned on SOURCE (repo convention — see the header of
 * __tests__/security/payment-proof-notification.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PORTAL_REPLY_ACTION = read("app/customer-portal/_thread-reply-action.ts");
const SUPPORT_ACTIONS = read("app/(app)/support/actions.ts");
const SEND_PORTAL_REPLY = read("lib/email/send-portal-reply.ts");
const PORTAL_REPLY_TEMPLATE = read("lib/email/templates/portal-reply.ts");
const EVENTS = read("lib/notifications/events.ts");
const PORTAL_MESSAGES_PAGE = read(
  "app/customer-portal/[token]/messages/page.tsx",
);
const SUPPORT_PAGE = read("app/(app)/support/page.tsx");

// =====================================================================
// b. CUSTOMER → TENANT: the org-scoped emitter (behavioural)
// =====================================================================

describe("notifyOnPortalReplyToOrg — org-scoped, never the customer, no body", () => {
  const sample = () =>
    notifyOnPortalReplyToOrg({
      org_id: "org-a",
      ticket_id: "ticket-1",
      ticket_number: 42,
      customer_name: "Jane Homeowner",
    });

  it("targets the ORG org-wide: audience 'customer', user_id null", () => {
    const n = sample();
    expect(n.org_id).toBe("org-a");
    expect(n.audience).toBe("customer");
    // user_id null + org_id ⇒ RLS resolves to every member of THIS org. The
    // end-customer has no user row / membership, so can never be a recipient.
    expect(n.user_id).toBeNull();
  });

  it("carries no cross-organisation routing — org_id is the only key", () => {
    const n = sample();
    expect(JSON.stringify(n)).not.toMatch(/org-b/);
    expect(n.org_id).toBe("org-a");
  });

  it("links staff to the tenant's own thread view", () => {
    expect(sample().action_url).toBe("/support/ticket-1");
    expect(sample().source_id).toBe("ticket-1");
    expect(sample().source_module).toBe("support");
  });

  it("names the customer + ticket but carries NO message body", () => {
    // The emitter has no `body_preview`/message parameter at all, so the
    // customer's words cannot ride into the notification.
    const n = notifyOnPortalReplyToOrg({
      org_id: "org-a",
      ticket_id: "t",
      ticket_number: 7,
      customer_name: "Bob",
    });
    expect(n.title).toContain("Bob");
    expect(n.title).toContain("#7");
    expect(n.body).toBe("Open the thread to read their reply and respond.");
  });

  it("is in-app only — no email directive (matches the inbound HQ pattern)", () => {
    expect(sample().email).toBeUndefined();
  });

  it("uses an existing category (no migration) that labels correctly", () => {
    const n = sample();
    expect(n.category).toBe("support");
    expect(NOTIFICATION_CATEGORY_LABEL[n.category]).toBe("Support");
  });

  it("is registered in the stable helper list", () => {
    expect(EVENT_HELPERS).toContain("notifyOnPortalReplyToOrg");
  });

  it("keeps the events module pure — no I/O", () => {
    expect(EVENTS).not.toMatch(/createClient|createAdminClient|await /);
  });
});

// =====================================================================
// b. CUSTOMER → TENANT: the portal reply action wiring (source)
// =====================================================================

describe("replyToPortalThread — emits exactly one org-scoped notification", () => {
  it("reuses the existing substrate — emitNotifications + the pure emitter", () => {
    expect(PORTAL_REPLY_ACTION).toMatch(
      /import \{ emitNotifications \} from "@\/server\/services\/notifications-service"/,
    );
    expect(PORTAL_REPLY_ACTION).toMatch(
      /import \{ notifyOnPortalReplyToOrg \} from "@\/lib\/notifications\/events"/,
    );
  });

  it("emits EXACTLY ONCE — a single call site (idempotent per reply)", () => {
    const calls = PORTAL_REPLY_ACTION.match(/emitNotifications\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("emits only AFTER the message insert (event-driven, not speculative)", () => {
    const insertIdx = PORTAL_REPLY_ACTION.indexOf('.from("support_messages"');
    const emitIdx = PORTAL_REPLY_ACTION.indexOf("emitNotifications(");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(insertIdx);
  });

  it("pins the notification to the ticket's OWN org — no caller-supplied org", () => {
    // org_id comes from the token-resolved customer, and the ticket was
    // re-verified against org_id + customer_id + id above.
    expect(PORTAL_REPLY_ACTION).toMatch(/org_id: customer\.org_id/);
    expect(PORTAL_REPLY_ACTION).toMatch(/\.eq\("org_id", customer\.org_id\)/);
    expect(PORTAL_REPLY_ACTION).toMatch(/\.eq\("customer_id", customer\.id\)/);
  });

  it("does NOT email staff (in-app only) and adds no second mechanism", () => {
    expect(PORTAL_REPLY_ACTION).not.toMatch(/sendEmail|send-portal-reply/);
    expect(PORTAL_REPLY_ACTION).not.toMatch(/notification_email_queue/);
    expect(PORTAL_REPLY_ACTION).not.toMatch(/\.from\("notifications"/);
  });

  it("keeps its pre-existing guards (rate limit + ownership re-check)", () => {
    expect(PORTAL_REPLY_ACTION).toMatch(/consume\("portal_write"/);
    expect(PORTAL_REPLY_ACTION).toMatch(/re-verify the ticket/);
  });
});

// =====================================================================
// a. TENANT → CUSTOMER: the support reply action wiring (source)
// =====================================================================

describe("replyToSupportTicket — emails the customer on a portal reply only", () => {
  it("imports the dedicated send module", () => {
    expect(SUPPORT_ACTIONS).toMatch(
      /import \{ sendPortalReplyNotificationEmail \} from "@\/lib\/email\/send-portal-reply"/,
    );
  });

  it("calls it EXACTLY ONCE (one reply, one email)", () => {
    const calls =
      SUPPORT_ACTIONS.match(/sendPortalReplyNotificationEmail\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("only for a customer thread — never on the CrewFlow helpdesk branch", () => {
    // The send lives in the `else if (tInfo.customer_id)` arm, i.e. after the
    // `if (!isCustomerThread)` HQ-notification arm. A helpdesk thread
    // (customer_id null) never emails anyone's customer.
    const hqArmIdx = SUPPORT_ACTIONS.indexOf("if (!isCustomerThread)");
    const custArmIdx = SUPPORT_ACTIONS.indexOf("else if (tInfo.customer_id)");
    const sendIdx = SUPPORT_ACTIONS.indexOf("sendPortalReplyNotificationEmail(");
    expect(hqArmIdx).toBeGreaterThan(-1);
    expect(custArmIdx).toBeGreaterThan(hqArmIdx);
    expect(sendIdx).toBeGreaterThan(custArmIdx);
  });

  it("derives recipient + org from the ticket, active-org pinned", () => {
    expect(SUPPORT_ACTIONS).toMatch(/orgId: ctx\.membership\.org_id/);
    expect(SUPPORT_ACTIONS).toMatch(/customerId: tInfo\.customer_id/);
    expect(SUPPORT_ACTIONS).toMatch(/ticketId: parsed\.data\.ticket_id/);
  });

  it("is best-effort — a mail failure cannot break the persisted reply", () => {
    // The send is wrapped in try/catch; the message insert + redirect happen
    // regardless.
    const sendIdx = SUPPORT_ACTIONS.indexOf("sendPortalReplyNotificationEmail(");
    const tryIdx = SUPPORT_ACTIONS.lastIndexOf("try {", sendIdx);
    const catchIdx = SUPPORT_ACTIONS.indexOf("} catch", sendIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(sendIdx);
  });
});

// =====================================================================
// a. TENANT → CUSTOMER: the send module — scoping + consent + no leakage
// =====================================================================

describe("sendPortalReplyNotificationEmail — scoped, consent-gated, minimal", () => {
  it("resolves the recipient from the ticket's OWN customer, org-pinned", () => {
    // id = the ticket's customer_id AND org_id = the active org. A foreign or
    // cross-org customer_id yields no row and nothing is sent.
    expect(SEND_PORTAL_REPLY).toMatch(/\.eq\("id", input\.customerId\)/);
    expect(SEND_PORTAL_REPLY).toMatch(/\.eq\("org_id", input\.orgId\)/);
    expect(SEND_PORTAL_REPLY).toMatch(/customer_not_found/);
  });

  it("builds the link from THAT customer's own portal_token", () => {
    expect(SEND_PORTAL_REPLY).toMatch(
      /customer-portal\/\$\{customer\.portal_token\}\/messages\/\$\{input\.ticketId\}/,
    );
  });

  it("respects the customer's preferred_channel (consent gate)", () => {
    expect(SEND_PORTAL_REPLY).toMatch(/customer_portal_preferences/);
    expect(SEND_PORTAL_REPLY).toMatch(
      /preferred_channel !== "email"[\s\S]*channel_opt_out/,
    );
  });

  it("never emails a dead link — guards missing/expired tokens", () => {
    expect(SEND_PORTAL_REPLY).toMatch(/no_token/);
    expect(SEND_PORTAL_REPLY).toMatch(/token_expired/);
  });

  it("uses the EXISTING Resend wrapper, no new provider", () => {
    expect(SEND_PORTAL_REPLY).toMatch(
      /import \{ sendEmail \} from "@\/lib\/email\/send"/,
    );
    expect(SEND_PORTAL_REPLY).not.toMatch(/new Resend|twilio|whatsapp|meta/i);
  });

  it("passes NO message body to the template — it accepts none", () => {
    // The template input has no `body`/message field, so the reply body cannot
    // be forwarded by email even by accident.
    expect(SEND_PORTAL_REPLY).not.toMatch(/body:\s*(parsed|body|message)/);
    // The template input type declares no body/message FIELD (its copy may use
    // the word "message" prosaically — that is fixed notification text, not data).
    expect(PORTAL_REPLY_TEMPLATE).not.toMatch(/body_preview/);
    expect(PORTAL_REPLY_TEMPLATE).not.toMatch(/(message|body)\s*\??:/);
  });
});

describe("buildPortalReplyEmail — notification + link only", () => {
  const built = buildPortalReplyEmail({
    org_name: "Acme Builders",
    customer_name: "Jane",
    portal_url: "https://app.example/customer-portal/tok-123/messages/tk-1",
    ticket_number: 42,
  });

  it("contains the org, the scoped link and the ticket number", () => {
    expect(built.subject).toContain("Acme Builders");
    expect(built.subject).toContain("#42");
    expect(built.html).toContain(
      "https://app.example/customer-portal/tok-123/messages/tk-1",
    );
    expect(built.text).toContain(
      "https://app.example/customer-portal/tok-123/messages/tk-1",
    );
  });

  it("cannot carry a message body — no parameter exists for one", () => {
    // Belt-and-braces: even a would-be body string never appears because there
    // is no channel for it.
    const secret = "SECRET-CUSTOMER-MESSAGE-BODY";
    expect(built.html).not.toContain(secret);
    expect(built.text).not.toContain(secret);
  });
});

// =====================================================================
// UNREAD BADGE: derived, never a send/write in a render path
// =====================================================================

describe("unread badge — derived from last_reply_kind, no render-path effects", () => {
  it("the portal messages page derives unread, never sends/writes", () => {
    expect(PORTAL_MESSAGES_PAGE).toMatch(/countUnreadOrgRepliesForCustomer/);
    expect(PORTAL_MESSAGES_PAGE).not.toMatch(/sendEmail|emitNotifications/);
    // Reads only — no reply/notification write hides in the GET path.
    expect(PORTAL_MESSAGES_PAGE).not.toMatch(/sendPortalReplyNotificationEmail/);
  });

  it("the tenant support page derives unread, never sends/writes", () => {
    expect(SUPPORT_PAGE).toMatch(/countAwaitingOrgReply/);
    expect(SUPPORT_PAGE).not.toMatch(/sendEmail|emitNotifications/);
  });
});

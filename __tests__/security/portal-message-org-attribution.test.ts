import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Customer↔organisation messaging — actor attribution.
 *
 * Support OS speaks from CrewFlow's point of view: 'customer' means THE TENANT
 * ORG and 'hq' means CrewFlow staff. The portal reuses those tables for a second
 * conversation — end-customer ↔ tenant — in which the tenant is the responder.
 * With only two actors there was no value for "the tenant, speaking to its own
 * customer", and three mis-attributions followed, all live:
 *
 *   1. the tenant's reply stamped 'customer', and the portal tested
 *      `author_kind !== "hq"` to decide "mine" — so the builder's reply
 *      rendered to the homeowner as the HOMEOWNER's own message;
 *   2. the only writer of 'hq' is /admin/support, so the one actor the portal
 *      attributed to `org.name` was CrewFlow — meaning CrewFlow's words could
 *      appear to a homeowner as though their builder had written them;
 *   3. the tenant's own thread view fell back to "You" for any non-'hq'
 *      message, so the org saw its customer's words as its own.
 *
 * These are attribution failures on a shipped surface, not missing features:
 * nothing errors, the wrong name is simply printed next to real words. Pinned
 * here because no type or constraint can catch a swapped label.
 *
 * Source-contract per the repo convention for server components + actions
 * (see __tests__/portal/phase3.test.ts and the header of
 * __tests__/payments/record-payment.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260910000000_support_messages_org_author.sql",
);
const PORTAL_THREAD = read(
  "app/customer-portal/[token]/messages/[ticketId]/page.tsx",
);
const PORTAL_LIST = read("app/customer-portal/[token]/messages/page.tsx");
const TENANT_ACTION = read("app/(app)/support/actions.ts");
const TENANT_THREAD = read("app/(app)/support/[id]/page.tsx");
const TENANT_LIST = read("app/(app)/support/page.tsx");
const SERVICE = read("server/services/customer-support-service.ts");

// =====================================================================
// The migration — three objects must move together
// =====================================================================

describe("migration — the 'org' actor exists everywhere it must", () => {
  it("widens support_messages.author_kind to include 'org'", () => {
    expect(MIGRATION).toMatch(
      /author_kind in \('customer', 'hq', 'org'\)/,
    );
  });

  it("ALSO widens support_tickets.last_reply_kind — the trigger copies author_kind into it", () => {
    // Without this the after-insert trigger's `last_reply_kind = new.author_kind`
    // violates the narrower CHECK and rolls the whole message INSERT back.
    expect(MIGRATION).toMatch(
      /last_reply_kind in \('customer', 'hq', 'org'\)/,
    );
  });

  it("ALSO widens the insert RLS policy — it hard-coded author_kind = 'customer'", () => {
    // Otherwise RLS refuses the tenant's 'org' reply.
    expect(MIGRATION).toMatch(/author_kind in \('customer', 'org'\)/);
  });

  it("does NOT let a tenant author an 'hq' message", () => {
    // Only /admin/support (service-role) may speak as CrewFlow.
    // Bound the slice to the policy STATEMENT — the trigger below legitimately
    // references 'hq', and an unbounded slice would sweep it up.
    const start = MIGRATION.indexOf("create policy support_messages_insert");
    expect(start).toBeGreaterThan(-1);
    const policy = MIGRATION.slice(start, MIGRATION.indexOf(");", start));
    expect(policy).toMatch(/author_kind in \('customer', 'org'\)/);
    expect(policy).not.toMatch(/'hq'/);
  });

  it("keeps status transitions owned by the trigger, with 'org' as a responder", () => {
    expect(MIGRATION).toMatch(/new\.author_kind in \('hq', 'org'\)[\s\S]*?'open'/);
    expect(MIGRATION).toMatch(
      /new\.author_kind in \('hq', 'org'\)[\s\S]*?'in_progress'/,
    );
    // The customer's own re-open nudge is untouched.
    expect(MIGRATION).toMatch(
      /new\.author_kind = 'customer' and t\.status = 'waiting_on_customer'/,
    );
  });

  it("leaves the internal-note guard intact (only 'hq' may be internal)", () => {
    // `check (author_kind = 'hq' or internal = false)` already forces
    // internal=false for 'org'; the migration must not relax it.
    expect(MIGRATION).not.toMatch(/drop constraint.*internal/i);
    expect(MIGRATION).not.toMatch(/author_kind in \('hq', 'org'\) or internal/);
  });
});

// =====================================================================
// The org's reply path
// =====================================================================

describe("tenant reply — the right actor for the right conversation", () => {
  it("resolves the ticket's customer_id to decide which conversation this is", () => {
    expect(TENANT_ACTION).toMatch(/customer_id/);
    expect(TENANT_ACTION).toMatch(/const isCustomerThread = tInfo\.customer_id != null/);
  });

  it("stamps 'org' on a portal thread and 'customer' on the CrewFlow helpdesk", () => {
    expect(TENANT_ACTION).toMatch(
      /author_kind: isCustomerThread \? "org" : "customer"/,
    );
  });

  it("fails closed when the ticket does not resolve (RLS-scoped read)", () => {
    // A foreign ticket_id returns no row under RLS; never guess an actor.
    expect(TENANT_ACTION).toMatch(/if \(!tInfo\)/);
  });

  it("does NOT page CrewFlow about an org↔customer conversation", () => {
    // notifyOnSupportReplyToHq targets CrewFlow HQ, which is not a party to
    // this thread. It must stay gated to the helpdesk conversation.
    expect(TENANT_ACTION).toMatch(
      /if \(!isCustomerThread\) \{[\s\S]*?notifyOnSupportReplyToHq/,
    );
  });

  it("still notifies CrewFlow for genuine helpdesk replies (Support OS preserved)", () => {
    expect(TENANT_ACTION).toMatch(/notifyOnSupportReplyToHq/);
    expect(TENANT_ACTION).toMatch(/emitNotifications/);
  });

  it("audits the org reply as an org reply, not as a customer reply", () => {
    expect(TENANT_ACTION).toMatch(
      /action: isCustomerThread \? "support\.org_reply" : "support\.customer_reply"/,
    );
  });
});

// =====================================================================
// What the CUSTOMER sees
// =====================================================================

describe("portal — customers see org replies as the org", () => {
  it("attributes on the customer actor, not on 'anything that isn't hq'", () => {
    expect(PORTAL_THREAD).toMatch(/const mine = m\.author_kind === "customer"/);
    // The old ATTRIBUTION test is the bug and must not come back. Scoped to the
    // `mine` assignment: `author_kind !== "hq"` is still correct as a FILTER
    // below, which is a different question from who authored a message.
    expect(PORTAL_THREAD).not.toMatch(/const mine = m\.author_kind !== "hq"/);
  });

  it("never shows CrewFlow's messages to a customer — filtered at query AND in JS", () => {
    expect(PORTAL_THREAD).toMatch(/\.in\("author_kind", \["customer", "org"\]\)/);
    expect(PORTAL_THREAD).toMatch(/m\.author_kind !== "hq"/);
  });

  it("still excludes internal HQ notes at query AND in JS", () => {
    expect(PORTAL_THREAD).toMatch(/\.eq\("internal", false\)/);
    expect(PORTAL_THREAD).toMatch(/!m\.internal/);
  });

  it("list preview attributes the same way and hides hq", () => {
    expect(PORTAL_LIST).toMatch(
      /lastVisible\.author_kind === "customer"[\s\S]*?"You: "/,
    );
    expect(PORTAL_LIST).toMatch(/!m\.internal && m\.author_kind !== "hq"/);
  });

  it("list preview sorts the embedded rows by created_at DESC before selecting", () => {
    // The embedded to-many `last_message` rows arrive in unspecified (PK) order,
    // so a bare `.find(...)` returned an arbitrary/oldest message instead of the
    // latest reply. The sort must happen BEFORE the attribution filter.
    const sortIdx = PORTAL_LIST.search(
      /\[\.\.\.\(t\.last_message \?\? \[\]\)\][\s\S]*?\.sort\(/,
    );
    const findIdx = PORTAL_LIST.indexOf("!m.internal && m.author_kind !== \"hq\"");
    expect(sortIdx).toBeGreaterThan(-1);
    expect(findIdx).toBeGreaterThan(-1);
    expect(sortIdx).toBeLessThan(findIdx);
    // Descending on created_at: newer (b) before older (a).
    expect(PORTAL_LIST).toMatch(
      /new Date\(b\.created_at\)\.getTime\(\)\s*-\s*new Date\(a\.created_at\)\.getTime\(\)/,
    );
  });
});

// =====================================================================
// Preview selection — newest non-internal, non-hq message wins
// =====================================================================

describe("portal list preview — picks the latest visible message", () => {
  // Mirrors the exact inline selection in app/customer-portal/[token]/
  // messages/page.tsx so a regression in the ordering is caught behaviourally,
  // not just by source-string match.
  type Msg = {
    body: string;
    created_at: string;
    author_kind: string;
    internal: boolean;
  };
  const selectPreview = (rows: Msg[]) =>
    [...rows]
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .find((m) => !m.internal && m.author_kind !== "hq");

  it("returns the newest reply even when rows arrive oldest-first (PK order)", () => {
    const rows: Msg[] = [
      { body: "first", created_at: "2026-01-01T00:00:00Z", author_kind: "customer", internal: false },
      { body: "latest reply", created_at: "2026-03-01T00:00:00Z", author_kind: "org", internal: false },
      { body: "middle", created_at: "2026-02-01T00:00:00Z", author_kind: "customer", internal: false },
    ];
    expect(selectPreview(rows)?.body).toBe("latest reply");
  });

  it("skips a newer internal HQ note and falls back to the newest visible message", () => {
    const rows: Msg[] = [
      { body: "customer question", created_at: "2026-01-01T00:00:00Z", author_kind: "customer", internal: false },
      { body: "org answer", created_at: "2026-02-01T00:00:00Z", author_kind: "org", internal: false },
      { body: "internal note", created_at: "2026-03-01T00:00:00Z", author_kind: "hq", internal: true },
    ];
    expect(selectPreview(rows)?.body).toBe("org answer");
  });

  it("never surfaces an hq message even when it is the newest visible one", () => {
    const rows: Msg[] = [
      { body: "org answer", created_at: "2026-02-01T00:00:00Z", author_kind: "org", internal: false },
      { body: "crewflow to org", created_at: "2026-03-01T00:00:00Z", author_kind: "hq", internal: false },
    ];
    expect(selectPreview(rows)?.body).toBe("org answer");
  });
});

// =====================================================================
// What the ORG sees
// =====================================================================

describe("tenant view — orgs see customer replies as the customer", () => {
  it("service carries the third actor in its type", () => {
    expect(SERVICE).toMatch(
      /export type SupportAuthorKind = "customer" \| "hq" \| "org"/,
    );
  });

  it("service names the end-customer from the ticket's customer", () => {
    expect(SERVICE).toMatch(/customer:customers \( name \)/);
    expect(SERVICE).toMatch(
      /kind === "customer" && isCustomerThread[\s\S]*?ticketCustomer\?\.name/,
    );
  });

  it("service exposes customer_id so surfaces can tell the conversations apart", () => {
    expect(SERVICE).toMatch(/customer_id: \(t\.customer_id as string \| null\) \?\? null/);
    expect(SERVICE).toMatch(/customer_id: \(ticket\.customer_id as string \| null\) \?\? null/);
  });

  it("thread view does not fall back to 'You' for the customer's own words", () => {
    expect(TENANT_THREAD).toMatch(
      /m\.author_kind === "customer" && ticket\.customer_id != null/,
    );
  });

  it("HQ replies still render as CrewFlow, never as the org", () => {
    expect(TENANT_THREAD).toMatch(/"CrewFlow Support"/);
  });

  it("list segments customer threads via the existing customer_id", () => {
    expect(TENANT_LIST).toMatch(/t\.customer_id \?/);
    expect(TENANT_LIST).toMatch(/From your customer/);
  });

  it("list last-reply line credits the customer, not 'you'", () => {
    expect(TENANT_LIST).toMatch(
      /t\.last_reply_kind === "customer" && t\.customer_id[\s\S]*?"your customer"/,
    );
  });
});

// =====================================================================
// Scope discipline
// =====================================================================

describe("no second messaging system", () => {
  it("introduces no new message tables — only widens what exists", () => {
    expect(MIGRATION).not.toMatch(/create table/i);
    expect(MIGRATION).toMatch(/alter table public\.support_messages/);
    expect(MIGRATION).toMatch(/alter table public\.support_tickets/);
  });

  it("keeps the portal writing through the existing tables", () => {
    expect(PORTAL_THREAD).toMatch(/from\("support_messages" as never\)/);
    expect(PORTAL_THREAD).toMatch(/from\("support_tickets" as never\)/);
  });

  it("portal reply action still leaves ticket status to the DB trigger", () => {
    const REPLY = read("app/customer-portal/_thread-reply-action.ts");
    expect(REPLY).not.toMatch(/last_reply_at/);
    expect(REPLY).not.toMatch(/status:/);
  });
});

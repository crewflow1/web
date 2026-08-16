import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  readPortalChatMessages,
  resolveChatConversationId,
  toPortalChatMessage,
  chatContactRef,
  type PortalChatMessage,
} from "@/app/customer-portal/[token]/chat/_chat-reads";
import { DETERMINISTIC_CHAT_ACK } from "@/server/services/chat-auto-reply";
import { getTextProvider } from "@/lib/ai/text";
import { isTierActivated } from "@/lib/ai/governor";
import { isAnyTierBound, featureDefinition } from "@/lib/ai/governor/registry";

/**
 * MP Phase 8 "Live Chat" — customer-portal chat scope + AI-dark guarantees.
 *
 * The portal carries no Supabase JWT, so chat reads run on the RLS-bypassing
 * admin client and the QUERY FILTERS are the whole security boundary. This suite
 * proves, FUNCTIONALLY (a fake admin client that honours eq/gt/order filters)
 * and by SOURCE CONTRACT:
 *
 *   (a) cross-customer isolation — customer B never sees customer A's messages;
 *   (b) reads are org + customer pinned (both, not one);
 *   (c) the automated acknowledgement is deterministic + auto_generated, and NO
 *       model is reachable while the AI tier is dark;
 *   (d) the poll/read projection returns ONLY customer-safe fields.
 */

// ---------------------------------------------------------------------------
// A minimal fake admin client that honours the filters the read layer applies,
// so the isolation it claims is exercised, not just asserted on text.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeQuery(rows: Row[]) {
  const eqs: Array<[string, unknown]> = [];
  const gts: Array<[string, unknown]> = [];
  const apply = () =>
    rows
      .filter((r) => eqs.every(([k, v]) => r[k] === v))
      .filter((r) => gts.every(([k, v]) => String(r[k]) > String(v)))
      .sort((a, b) => {
        const ca = String(a.created_at);
        const cb = String(b.created_at);
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.id) < String(b.id) ? -1 : 1;
      });
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      eqs.push([k, v]);
      return q;
    },
    gt: (k: string, v: unknown) => {
      gts.push([k, v]);
      return q;
    },
    order: () => q,
    range: (from: number, to: number) =>
      Promise.resolve({ data: apply().slice(from, to + 1), error: null }),
    maybeSingle: () =>
      Promise.resolve({ data: apply()[0] ?? null, error: null }),
  };
  return q;
}

function makeFakeAdmin(store: { conversations: Row[]; messages: Row[] }) {
  return {
    from: (table: string) => {
      if (table === "conversations") return makeQuery(store.conversations);
      if (table === "messages") return makeQuery(store.messages);
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

// Two customers in the SAME org, plus a same-customer-id row in a DIFFERENT org
// (proves org pinning independently of customer pinning).
const ORG = "org-1";
const OTHER_ORG = "org-2";
const CUST_A = "cust-a";
const CUST_B = "cust-b";

function fixture() {
  return {
    conversations: [
      { id: "conv-a", org_id: ORG, customer_id: CUST_A, channel: "chat" },
      { id: "conv-b", org_id: ORG, customer_id: CUST_B, channel: "chat" },
      // Same customer_id as A, but a DIFFERENT org — must be invisible to A@ORG.
      { id: "conv-a-other", org_id: OTHER_ORG, customer_id: CUST_A, channel: "chat" },
    ],
    messages: [
      {
        id: "m-a1",
        org_id: ORG,
        conversation_id: "conv-a",
        direction: "inbound",
        body: "A: hello",
        created_at: "2026-08-16T10:00:00.000Z",
        auto_generated: false,
        created_by: "should-not-leak",
        provider_id: "prov-x",
        failure_reason: "internal",
        to_addr: "customer:cust-a",
        status: "received",
      },
      {
        id: "m-a2",
        org_id: ORG,
        conversation_id: "conv-a",
        direction: "outbound",
        body: "A: automated ack",
        created_at: "2026-08-16T10:00:01.000Z",
        auto_generated: true,
        created_by: null,
        provider_id: null,
        failure_reason: null,
        to_addr: "customer:cust-a",
        status: "sent",
      },
      {
        id: "m-b1",
        org_id: ORG,
        conversation_id: "conv-b",
        direction: "inbound",
        body: "B: secret message",
        created_at: "2026-08-16T10:00:02.000Z",
        auto_generated: false,
        created_by: "staff-b",
        provider_id: null,
        failure_reason: null,
        to_addr: "customer:cust-b",
        status: "received",
      },
    ],
  };
}

describe("(a) cross-customer isolation", () => {
  it("customer A's read never returns customer B's messages", async () => {
    const admin = makeFakeAdmin(fixture());
    const forA = await readPortalChatMessages(admin, {
      orgId: ORG,
      customerId: CUST_A,
    });
    const ids = forA.map((m) => m.id);
    expect(ids).toEqual(["m-a1", "m-a2"]);
    expect(ids).not.toContain("m-b1");
    expect(JSON.stringify(forA)).not.toContain("secret message");
  });

  it("customer B sees only their own thread", async () => {
    const admin = makeFakeAdmin(fixture());
    const forB = await readPortalChatMessages(admin, {
      orgId: ORG,
      customerId: CUST_B,
    });
    expect(forB.map((m) => m.id)).toEqual(["m-b1"]);
  });
});

describe("(b) reads are org + customer pinned", () => {
  it("resolves the conversation by BOTH org_id and customer_id", async () => {
    const admin = makeFakeAdmin(fixture());
    // Right customer, WRONG org → the same customer_id in another org is not theirs.
    const wrongOrg = await resolveChatConversationId(admin, {
      orgId: "org-does-not-exist",
      customerId: CUST_A,
    });
    expect(wrongOrg).toBeNull();

    // A@ORG resolves ONLY conv-a — never conv-a-other (same customer, other org).
    const right = await resolveChatConversationId(admin, {
      orgId: ORG,
      customerId: CUST_A,
    });
    expect(right).toBe("conv-a");
  });

  it("a customer with no thread yet reads an empty list (not another's)", async () => {
    const admin = makeFakeAdmin(fixture());
    const none = await readPortalChatMessages(admin, {
      orgId: ORG,
      customerId: "cust-with-no-thread",
    });
    expect(none).toEqual([]);
  });

  it("the one-thread-per-customer key is customer-derived", () => {
    expect(chatContactRef(CUST_A)).toBe("customer:cust-a");
    expect(chatContactRef(CUST_A)).not.toBe(chatContactRef(CUST_B));
  });
});

describe("(d) the projection returns only customer-safe fields", () => {
  it("drops created_by, provider_id, failure_reason, to_addr and status", () => {
    const safe = toPortalChatMessage({
      id: "x",
      direction: "outbound",
      body: "hi",
      created_at: "2026-08-16T10:00:00.000Z",
      auto_generated: true,
      // extra internal columns, as if selected by mistake:
      ...( {
        created_by: "leak",
        provider_id: "leak",
        failure_reason: "leak",
        to_addr: "leak",
        status: "leak",
      } as unknown as Record<string, never>),
    } as never);
    expect(Object.keys(safe).sort()).toEqual(
      ["auto_generated", "body", "created_at", "direction", "id"],
    );
    expect(JSON.stringify(safe)).not.toContain("leak");
  });

  it("every message that reaches the customer carries only the safe shape", async () => {
    const admin = makeFakeAdmin(fixture());
    const forA = await readPortalChatMessages(admin, {
      orgId: ORG,
      customerId: CUST_A,
    });
    const SAFE_KEYS = ["auto_generated", "body", "created_at", "direction", "id"];
    for (const m of forA as PortalChatMessage[]) {
      expect(Object.keys(m).sort()).toEqual(SAFE_KEYS);
    }
    // The internal columns present in the fixture rows never surface.
    const blob = JSON.stringify(forA);
    for (const leak of ["should-not-leak", "prov-x", "staff-b"]) {
      expect(blob).not.toContain(leak);
    }
  });
});

describe("(c) the auto-ack is deterministic and no model is reachable while dark", () => {
  it("the deterministic ack is a fixed, non-empty string", () => {
    expect(typeof DETERMINISTIC_CHAT_ACK).toBe("string");
    expect(DETERMINISTIC_CHAT_ACK.length).toBeGreaterThan(0);
    expect(DETERMINISTIC_CHAT_ACK).toBe(
      "Thanks — we've got your message and a team member will reply here shortly.",
    );
  });

  it("no generative tier is bound in this build (dark) — so no model can run", () => {
    expect(isAnyTierBound()).toBe(false);
    expect(isTierActivated("mid")).toBe(false);
    // The text door is closed while dark: the ack path resolves NO provider.
    expect(getTextProvider()).toBeNull();
  });

  it("chat.auto_reply is a registered drafting feature (the review point)", () => {
    const def = featureDefinition("chat.auto_reply");
    expect(def).not.toBeNull();
    expect(def!.taskClass).toBe("drafting");
  });
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACTS — lock the write-side invariants that a live DB test can't
// reach in CI (no database), matching the repo convention for server actions.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const readRaw = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SERVICE = strip(readRaw("server/services/chat-auto-reply.ts"));
const ACTION = strip(readRaw("app/customer-portal/[token]/chat/_chat-action.ts"));
const POLL = strip(readRaw("app/customer-portal/[token]/chat/poll/route.ts"));
const READS = strip(readRaw("app/customer-portal/[token]/chat/_chat-reads.ts"));

describe("(c) source contract — the automated ack write", () => {
  it("stamps auto_generated true, status sent, created_by null", () => {
    expect(SERVICE).toMatch(/auto_generated:\s*true/);
    expect(SERVICE).toMatch(/status:\s*"sent"/);
    expect(SERVICE).toMatch(/created_by:\s*null/);
  });

  it("gates on its own tier BEFORE resolving a provider (no model while dark)", () => {
    const gateIdx = SERVICE.indexOf('isTierActivated("mid")');
    const providerIdx = SERVICE.indexOf("getTextProvider()");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(providerIdx);
  });

  it("routes the (future) AI reply through the governor under chat.auto_reply", () => {
    expect(SERVICE).toMatch(/invokeWithGovernor\(\s*\n?\s*"chat\.auto_reply"/);
  });
});

describe("(b) source contract — the write + reads pin org and customer", () => {
  it("the send action stamps identity from the token-resolved customer only", () => {
    expect(ACTION).toMatch(/org_id:\s*customer\.org_id/);
    expect(ACTION).toMatch(/customer_id:\s*customer\.id/);
    expect(ACTION).toMatch(/contact_ref:\s*contactRef/);
    // Inbound message is a real customer message, never automated.
    expect(ACTION).toMatch(/direction:\s*"inbound"/);
    expect(ACTION).toMatch(/auto_generated:\s*false/);
  });

  it("the read layer resolves the conversation by org_id AND customer_id AND chat", () => {
    expect(READS).toMatch(/\.eq\("org_id",\s*input\.orgId\)/);
    expect(READS).toMatch(/\.eq\("customer_id",\s*input\.customerId\)/);
    expect(READS).toMatch(/\.eq\("channel",\s*"chat"\)/);
    // Uses the admin client → the filters are the barrier; and reads are paged.
    expect(READS).toMatch(/fetchAllRows/);
    // Loud reads — a failure throws, never a silent empty thread.
    expect(READS).toMatch(/readFailure/);
  });

  it("the read select carries no internal/PII columns", () => {
    const selects = [...READS.matchAll(/\.select\("([^"]*)"\)/g)].map((m) => m[1] ?? "");
    const joined = selects.join(" | ");
    expect(joined).not.toMatch(/created_by/);
    expect(joined).not.toMatch(/provider_id/);
    expect(joined).not.toMatch(/failure_reason/);
    expect(joined).not.toMatch(/to_addr/);
  });
});

describe("(a/d) source contract — the poll endpoint", () => {
  it("validates the token and resolves it through the ONE authority", () => {
    expect(POLL).toMatch(/TOKEN_RE\.test\(token\)/);
    expect(POLL).toMatch(/loadCustomerByPortalToken\(token\)/);
  });

  it("scopes the read by the token-resolved customer, never client input", () => {
    expect(POLL).toMatch(/orgId:\s*customer\.org_id/);
    expect(POLL).toMatch(/customerId:\s*customer\.id/);
  });

  it("is private + uncached and hands back through the shared safe read layer", () => {
    expect(POLL).toMatch(/private,\s*no-store/);
    expect(POLL).toMatch(/readPortalChatMessages/);
    expect(POLL).toMatch(/force-dynamic/);
  });
});

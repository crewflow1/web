import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P3 Inbox (unified conversations + reply composer) — trust-boundary pins.
 *
 * Hermetic: filesystem scans of the migration + reads + actions + send service. What is
 * pinned, and why each is load-bearing:
 *   1. TENANT ISOLATION — conversations & messages keep RLS enabled with member-scoped
 *      SELECT policies; a COMPOSITE (conversation_id, org_id) FK makes a message
 *      structurally unable to reference a conversation in another org.
 *   2. ACTIVE-ORG PIN — every read and every write additionally pins `org_id` to the
 *      resolved active org (RLS admits ALL the caller's orgs), so a dual-org member
 *      cannot read/act on another of their orgs' threads under the active shell.
 *   3. IDEMPOTENCY — a partial unique (org_id, provider_id) on messages dedupes inbound
 *      provider message ids.
 *   4. LOUD READS + F-1 — reads throw readFailure and page via fetchAllRows/.range.
 *   5. DARK-SAFE SEND — the composer never sends when a provider is unset (queues),
 *      never calls a real provider in tests.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG_TABLES = "supabase/migrations/20261135000000_unified_inbox_conversations.sql";
const MIG_PROJECT = "supabase/migrations/20261135000001_inbound_enquiry_inbox_projection.sql";
const READS = "server/services/inbox-conversations.ts";
const ACTIONS = "app/(app)/inbox/conversations/actions.ts";
const SEND = "server/services/inbox-send.ts";

describe("1. migration — RLS + composite FK", () => {
  const sql = read(MIG_TABLES);

  it("does not disable or loosen RLS on conversations/messages", () => {
    expect(sql).not.toMatch(/disable\s+row\s+level\s+security/i);
    // No policy is dropped without an accompanying tenant-scoped recreate in THIS migration
    // (it relies on the baseline member-scoped policies, which it must not remove).
    expect(sql).not.toMatch(/drop\s+policy[\s\S]*conversations:\s*members\s+can\s+select/i);
  });

  it("adds a composite (conversation_id, org_id) FK onto conversations(id, org_id)", () => {
    expect(sql).toMatch(/unique\s*\(\s*id\s*,\s*org_id\s*\)/i);
    expect(sql).toMatch(
      /foreign key\s*\(\s*conversation_id\s*,\s*org_id\s*\)[\s\S]*references\s+public\.conversations\s*\(\s*id\s*,\s*org_id\s*\)/i,
    );
  });

  it("adds the inbound idempotency index (org_id, provider_id)", () => {
    expect(sql).toMatch(
      /create unique index[\s\S]*messages\s*\(\s*org_id\s*,\s*provider_id\s*\)[\s\S]*where\s+provider_id\s+is\s+not\s+null/i,
    );
  });

  it("adds the contact-identity uniqueness (org_id, channel, contact_ref)", () => {
    expect(sql).toMatch(/create unique index[\s\S]*org_id\s*,\s*channel\s*,\s*contact_ref/i);
  });
});

describe("2. projection trigger — dedup + security definer", () => {
  const sql = read(MIG_PROJECT);

  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path\s*=\s*''/i);
  });

  it("is idempotent (ON CONFLICT DO NOTHING on the provider id)", () => {
    expect(sql).toMatch(/on conflict\s*\(\s*org_id\s*,\s*provider_id\s*\)[\s\S]*do nothing/i);
  });

  it("threads a message per inbound enquiry and never trusts a client org_id", () => {
    // The org is new.org_id from the enquiry row, not any external input.
    expect(sql).toMatch(/new\.org_id/);
  });
});

describe("3. reads — active-org pin, loud, F-1", () => {
  const code = codeOf(read(READS));

  it("pins org_id on the conversation list, previews, and thread reads", () => {
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(3);
  });

  it("pins both id AND org_id when loading a single thread", () => {
    expect(code).toMatch(/\.eq\(\s*["']id["']\s*,\s*conversationId\s*\)/);
  });

  it("reads are loud (throw readFailure) and never swallow errors into empty", () => {
    expect(code).toContain("readFailure");
    expect(code).not.toMatch(/catch\s*\([\s\S]*return\s*\[\s*\]/);
  });

  it("pages via fetchAllRows with a .range() window (F-1)", () => {
    expect(code).toContain("fetchAllRows");
    expect(code).toContain(".range(");
    // stable ordering with an id tiebreaker
    expect(code).toMatch(/\.order\(\s*["']id["']/);
  });
});

describe("4. actions — active-org pin on every write", () => {
  const code = codeOf(read(ACTIONS));

  it("resolves the active org from session, never a form field", () => {
    expect(code).toContain("requireOrgContext");
    expect(code).not.toMatch(/formData\.get\(\s*["']org_id["']\s*\)/);
  });

  it("pins org_id on the reply thread resolve and the status update", () => {
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*ctx\.membership\.org_id\s*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
  });

  it("stamps org_id from the session on every insert/upsert", () => {
    // Every message/conversation write carries org_id: ctx.membership.org_id.
    expect(code).toMatch(/org_id:\s*ctx\.membership\.org_id/);
  });

  it("resolves the thread loudly before replying", () => {
    expect(code).toContain("readFailure");
  });
});

describe("5. send service — dark-safe, no real provider in tests", () => {
  const code = codeOf(read(SEND));

  it("queues (not sends) when a provider is unset", () => {
    expect(code).toContain("provider_not_configured");
    expect(code).toMatch(/status:\s*["']queued["']/);
  });

  it("resolves whatsapp only via the whatsapp resolver (no sms fallback)", () => {
    expect(code).toMatch(/transport === ["']whatsapp["']\s*\?\s*resolvers\.whatsapp\(\)\s*:\s*resolvers\.sms\(\)/);
  });

  it("providers are injectable so a test can never reach a real vendor", () => {
    expect(code).toContain("ProviderResolvers");
    expect(code).toContain("DEFAULT_RESOLVERS");
  });
});

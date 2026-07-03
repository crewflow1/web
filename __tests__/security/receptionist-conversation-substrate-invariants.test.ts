import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation & contact-identity SUBSTRATE invariants
 * (the AI Receptionist Programme, R10 — CONVERSATION & CONTACT-IDENTITY SUBSTRATE).
 *
 * R10 lays a persistent, org-scoped CONVERSATION keyed by a resolved contact identity plus
 * a threaded MESSAGE timeline, as shared infrastructure BENEATH the canonical pipeline. The
 * cardinal safety property is that it is FOUNDATION, NOT BEHAVIOUR: it composes no reply,
 * enforces no policy, contacts no provider, and opens NO new outbound path; it is provably
 * additive; and it can never disturb the durable ingestion contract or the append-only
 * ledgers. This suite proves that contract as a matter of SOURCE, not discipline — the house
 * bar of the reply-audit invariants suite:
 *
 *   • PROVABLY ADDITIVE — the migration only CREATEs two tables + two functions and makes
 *     ONE additive, nullable link column on inbound_enquiries. It drops nothing, retypes
 *     nothing, and renulls nothing.
 *   • RLS:hq — both tables are RLS-enabled with NO policies; the two write primitives are
 *     SECURITY DEFINER, search_path-pinned, EXECUTE revoked from public/anon/authenticated
 *     and granted only to service_role.
 *   • LEDGERS UNTOUCHED — the migration names no reply ledger table or writer; the message
 *     store REFERENCES its authoritative content (enquiry_id / audit_id) and copies none of
 *     it, so there is exactly one source of truth and no ledger is mutated.
 *   • NO NEW OUTBOUND PATH — the substrate service is pure threading: it imports no policy,
 *     no comms, no reply producer, names no transport/audit primitive, and calls no vendor;
 *     and the two substrate RPCs are named by EXACTLY ONE module across all source.
 *   • THREADING IS BEST-EFFORT — the canonical service wraps every substrate call so a
 *     failure is logged and swallowed (contrast the mandatory, throw-on-failure audit); and
 *     the contact fold is a copy of the DB rule, so the resolved identity can never drift.
 *
 * The substrate's runtime behaviour (repeat → same conversation; new → new; org isolation;
 * inbound + outbound threading; RLS deny-by-default; the DB's independent fold) is pinned
 * against real Postgres in __tests__/integration/receptionist/conversation-substrate.test.ts.
 * This tier is HERMETIC — a filesystem scan over comment-stripped source — so the prose
 * documenting the contract can neither satisfy a positive match nor trip a negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip block + `--` line comments so only executable SQL is matched (prose can't match). */
function sqlCodeOf(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (defensive; this file uses -- only)
    .replace(/--[^\n]*/g, ""); // line comments — where all the R10 prose lives
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Recursively collect every non-test .ts/.tsx source file under the given roots. */
function walkSources(roots: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // a root that does not exist is simply skipped
    }
    for (const entry of entries) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
        visit(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const SERVICE = "server/services/receptionist.ts";
const SUBSTRATE = "server/services/receptionist-conversations.ts";
const MIGRATION = "supabase/migrations/20260819000000_receptionist_conversation_substrate.sql";

/** The substrate's two write primitives — the functions an auditor would call to write it. */
const RESOLVE_FN = /\bresolve_receptionist_conversation\b/;
const APPEND_FN = /\bappend_receptionist_message\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The substrate ships — migration + service.
// =====================================================================

describe("receptionist conversation substrate — the substrate ships", () => {
  it(`ships the substrate migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the substrate service ${SUBSTRATE}`, () => {
    expect(existsSync(resolve(ROOT, SUBSTRATE)), SUBSTRATE).toBe(true);
  });

  it("the substrate service exports the resolve + append + fold seams", () => {
    const code = codeOf(read(SUBSTRATE));
    expect(code).toMatch(/export async function resolveConversation\(/);
    expect(code).toMatch(/export async function appendConversationMessage\(/);
    expect(code).toMatch(/export function normaliseContactRef\(/);
  });
});

// =====================================================================
// 1. PROVABLY ADDITIVE — the migration creates, it does not destroy.
// =====================================================================

describe("receptionist conversation substrate — the migration is provably additive", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the two new tables (container + timeline)", () => {
    expect(sql).toMatch(/create table if not exists public\.receptionist_conversations/i);
    expect(sql).toMatch(/create table if not exists public\.receptionist_messages/i);
  });

  it("makes the ONE change to an existing table additive + nullable (inbound_enquiries.conversation_id)", () => {
    expect(sql).toMatch(
      /alter table public\.inbound_enquiries\s+add column if not exists conversation_id uuid/i,
    );
    // The link is nullable and severs cleanly — it can disturb no existing row or code path.
    expect(sql).toMatch(/references public\.receptionist_conversations\(id\) on delete set null/i);
  });

  it("drops nothing, retypes nothing, renulls nothing — no destructive DDL anywhere", () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/alter\s+column/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("is a MUTABLE container, NOT an append-only ledger — counters advance in place", () => {
    // The ledgers are append-only (block-mutation triggers). The container is deliberately
    // NOT: the resolver folds on the identity key, and the append bumps message_count in
    // place, so the substrate carries no such trigger.
    expect(sql).not.toMatch(/block_mutation/i);
    expect(sql).not.toMatch(/restrict_violation/i);
    expect(sql).toMatch(/on conflict\s*\(org_id, channel, contact_ref\)\s*do update/i);
    expect(sql).toMatch(/update public\.receptionist_conversations[\s\S]*?message_count\s*=\s*message_count\s*\+\s*1/i);
  });
});

// =====================================================================
// 2. RLS:hq — both tables RLS-enabled + zero policies; writers service-role-only.
// =====================================================================

describe("receptionist conversation substrate — the store is service-role-only (RLS:hq)", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("enables RLS on BOTH tables with NO policies (deny-by-default to every JWT client)", () => {
    expect(sql).toMatch(/alter table public\.receptionist_conversations enable row level security/i);
    expect(sql).toMatch(/alter table public\.receptionist_messages enable row level security/i);
    // No policy opens either table to anon / authenticated.
    expect(sql).not.toMatch(/create policy/i);
  });

  it("writes only through SECURITY DEFINER primitives, search_path-pinned", () => {
    expect(sql).toMatch(/create or replace function public\.resolve_receptionist_conversation\(/i);
    expect(sql).toMatch(/create or replace function public\.append_receptionist_message\(/i);
    // Two SECURITY DEFINER blocks, each pinning an empty search_path.
    expect(sql.match(/security definer/gi) ?? []).toHaveLength(2);
    expect(sql.match(/set search_path = ''/gi) ?? []).toHaveLength(2);
  });

  it("revokes EXECUTE from public/anon/authenticated and grants only service_role — on BOTH", () => {
    const revokes = sql.match(/revoke all on function[\s\S]*?from public, anon, authenticated/gi) ?? [];
    const grants = sql.match(/grant execute on function[\s\S]*?to service_role/gi) ?? [];
    expect(revokes).toHaveLength(2);
    expect(grants).toHaveLength(2);
  });
});

// =====================================================================
// 3. LEDGERS UNTOUCHED — the migration names no ledger; the store references, never copies.
// =====================================================================

describe("receptionist conversation substrate — the reply ledgers are untouched", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("names no reply-ledger table and no ledger writer in executable SQL", () => {
    // The substrate links to an audit by a bare `audit_id uuid` (un-FK'd by design); it must
    // not create, alter, FK, or otherwise name the ledger tables or their write primitives.
    for (const token of [
      /\bai_reply_audits\b/i,
      /\bai_reply_transports\b/i,
      /\bai_reply_delivery_receipts\b/i,
      /\brecord_ai_reply_/i,
    ]) {
      expect(sql, `must not name ${token}`).not.toMatch(token);
    }
  });

  it("the timeline REFERENCES content — it carries pointers, never a copy of the message body", () => {
    // One source of truth: an entry points at its authoritative row and stores no content.
    expect(sql).toMatch(/enquiry_id\s+uuid\s+references public\.inbound_enquiries\(id\)/i);
    expect(sql).toMatch(/\baudit_id\s+uuid\b/i); // un-FK'd logical reference
    // The messages table must hold NO content column — no raw_text, draft, body, or content.
    for (const col of [/\braw_text\b/i, /\bdraft\b/i, /\bbody\b/i, /\bcontent\b/i]) {
      expect(sql, `the timeline must not copy content (${col})`).not.toMatch(col);
    }
  });
});

// =====================================================================
// 4. NO NEW OUTBOUND PATH — the substrate service is pure threading and the sole writer.
// =====================================================================

describe("receptionist conversation substrate — it opens no new outbound path", () => {
  const code = codeOf(read(SUBSTRATE));

  it("is a server-only module scoped to the admin client and the substrate RPCs only", () => {
    expect(importSpecifiers(code)).toContain("server-only");
    expect(code).toMatch(RESOLVE_FN);
    expect(code).toMatch(APPEND_FN);
  });

  it("imports no policy, no comms, no reply producer — it threads, it does not reply", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("@/lib/receptionist/policy");
    expect(imports).not.toContain("@/lib/receptionist/reply");
    expect(imports).not.toContain("@/lib/comms");
  });

  it("names no reply/transport primitive and calls no vendor — no door to a provider", () => {
    expect(code).not.toMatch(/record_ai_reply_audit|record_ai_reply_transport|record_ai_reply_delivery_receipt/);
    expect(code).not.toMatch(/\b(?:dispatchReply|dispatchReceptionistReply|transportReply)\b/);
    expect(code).not.toMatch(/\b(?:evaluateReply|composeReceptionistReply|getSmsProvider)\b/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });

  it("the two substrate RPCs are each named by EXACTLY ONE module — the substrate service", () => {
    const resolveWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => RESOLVE_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const appendWriters = walkSources(SOURCE_ROOTS)
      .filter((full) => APPEND_FN.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // If either list grows, a second write path (or a bypass) has appeared.
    expect(resolveWriters).toEqual([SUBSTRATE]);
    expect(appendWriters).toEqual([SUBSTRATE]);
  });
});

// =====================================================================
// 5. THREADING IS BEST-EFFORT — it can never disturb ingestion; the fold can't drift.
// =====================================================================

describe("receptionist conversation substrate — threading is best-effort and beneath the pipeline", () => {
  const service = codeOf(read(SERVICE));
  const substrate = codeOf(read(SUBSTRATE));
  const sql = sqlCodeOf(read(MIGRATION));

  it("the canonical service threads the substrate through the substrate service ONLY", () => {
    expect(importSpecifiers(service)).toContain("@/server/services/receptionist-conversations");
    expect(service).toMatch(/\bresolveConversation\s*\(/);
    expect(service).toMatch(/\bappendConversationMessage\s*\(/);
  });

  it("every substrate call in the ingestion path is BEST-EFFORT — logged and swallowed, never thrown", () => {
    // Contrast the mandatory audit (which THROWS). The substrate sits beneath the pipeline:
    // its three call sites each have a dedicated swallow handler, so a failure cannot break
    // ingestion or alter one byte of the deterministic reply behaviour.
    expect(service).toMatch(/console\.error\("\[receptionist\] conversation resolve failed"/);
    expect(service).toMatch(/console\.error\("\[receptionist\] inbound message append failed"/);
    expect(service).toMatch(/console\.error\("\[receptionist\] outbound message append failed"/);
  });

  it("the outbound is threaded ONLY when a reply was actually audited (no phantom entries)", () => {
    // The outbound append is gated on a real audit_id — a flag-off / unsupported-channel /
    // duplicate dispatch produces none, so the timeline records real attempts, never phantoms.
    expect(service).toMatch(/textback\.dispatch\.audit_id[\s\S]{0,400}appendConversationMessage/);
  });

  it("the TS contact fold is a COPY of the DB rule, so the resolved identity cannot drift", () => {
    // normaliseContactRef trims + casefolds; the resolver does the identical fold in Postgres.
    expect(substrate).toMatch(/\.trim\(\)\.toLowerCase\(\)/);
    expect(sql).toMatch(/lower\(btrim\(coalesce\(p_contact_ref/i);
  });
});

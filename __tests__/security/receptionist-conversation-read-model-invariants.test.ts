import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation timeline READ MODEL invariants
 * (the AI Receptionist Programme, R11 — CONVERSATION TIMELINE READ MODEL).
 *
 * R11 turns the write-only R10 substrate into the canonical READ layer: two `security_invoker`
 * projections (receptionist_conversation_timeline / _list) plus the org-scoped read service
 * that resolves each message's authoritative content at read time. The cardinal safety
 * property is that it is a PROJECTION, NOT BEHAVIOUR: it is provably additive, it is read-only,
 * it introduces no second source of truth, it reuses the R9 lifecycle resolution rather than
 * re-deriving it, and it is the SINGLE reconstruction path — no feature may reconstruct a
 * conversation any other way. This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R9/R10 invariant suites:
 *
 *   • PROVABLY ADDITIVE — the migration only CREATEs two VIEWS. It makes no table, no
 *     function, no column, no trigger; it drops, retypes and renulls nothing.
 *   • READ-ONLY PROJECTION (the R9 pattern) — both views are security_invoker, SELECT is the
 *     only privilege and it is granted to service_role ONLY; the migration grants no write
 *     verb, defines no policy, and installs no INSTEAD OF write path; the views are plain (not
 *     materialised), so they hold no rows and can drift from nothing.
 *   • REUSES R9, FORKS NOTHING — the timeline resolves the outbound side THROUGH
 *     ai_reply_lifecycle; the migration names that view but NOT the three reply ledgers or any
 *     ledger writer, so it re-implements no transport/receipt reconstruction.
 *   • SINGLE RECONSTRUCTION PATH — both views are read by EXACTLY ONE module across all source,
 *     the read service; if that list grows, a second reconstruction path has appeared.
 *   • THE READ SERVICE PERFORMS NO MUTATION — it is server-only, imports no policy/comms/reply
 *     producer, names no write primitive, calls no vendor, and uses no mutating query verb
 *     (.insert/.update/.delete/.upsert/.rpc) — it only SELECTs; and it reuses the ONE contact
 *     fold so read-side identity can never drift from the write side.
 *   • ONE CANONICAL ORDER — the deterministic order is defined once (compareTimelineEvents /
 *     orderTimeline), applied to every timeline read, and is non-mutating.
 *
 * The read model's runtime behaviour (deterministic reconstruction; correct inbound/outbound
 * resolution; no content duplication; transport + receipt references; org isolation; the views'
 * write-rejection and anon-deny) is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-read-model.test.ts. This tier is HERMETIC —
 * a filesystem scan over comment-stripped source — so the prose documenting the contract can
 * neither satisfy a positive match nor trip a negative.
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
    .replace(/--[^\n]*/g, ""); // line comments — where all the R11 prose lives
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

const READS = "server/services/receptionist-conversation-reads.ts";
const MIGRATION = "supabase/migrations/20260820000000_receptionist_conversation_read_model.sql";

/** The two read-model projections — the relations an auditor would query to reconstruct. */
const TIMELINE_VIEW = /\breceptionist_conversation_timeline\b/;
const LIST_VIEW = /\breceptionist_conversation_list\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The read model ships — migration + read service.
// =====================================================================

describe("receptionist conversation read model — the read model ships", () => {
  it(`ships the read-model migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the read service ${READS}`, () => {
    expect(existsSync(resolve(ROOT, READS)), READS).toBe(true);
  });

  it("the read service exports the timeline, list, contact + reconstruct read seams", () => {
    const code = codeOf(read(READS));
    expect(code).toMatch(/export async function getConversationTimeline\(/);
    expect(code).toMatch(/export async function listConversations\(/);
    expect(code).toMatch(/export async function getConversation\(/);
    expect(code).toMatch(/export async function getConversationByContact\(/);
    expect(code).toMatch(/export async function reconstructConversation\(/);
  });
});

// =====================================================================
// 1. PROVABLY ADDITIVE — the migration creates two views, and nothing else.
// =====================================================================

describe("receptionist conversation read model — the migration is provably additive", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the two projections (timeline + list)", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_timeline/i);
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_list/i);
  });

  it("creates NO table, function, column or trigger — it is views + grants only", () => {
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/create\s+(or replace\s+)?function/i);
    expect(sql).not.toMatch(/alter\s+table/i);
    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/create\s+materialized\s+view/i); // a plain view holds no rows
  });

  it("drops nothing, retypes nothing, renulls nothing — no destructive DDL anywhere", () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/alter\s+column/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
  });
});

// =====================================================================
// 2. READ-ONLY PROJECTION — security_invoker, SELECT-only, service_role-only (the R9 pattern).
// =====================================================================

describe("receptionist conversation read model — it is a read-only projection", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("declares BOTH views security_invoker — they inherit the caller's RLS, laundering nothing", () => {
    expect(sql.match(/with \(security_invoker = true\)/gi) ?? []).toHaveLength(2);
  });

  it("grants SELECT to service_role ONLY, on BOTH views, and no write verb to anyone", () => {
    // Each view: revoke everything from every JWT role (and service_role), then grant SELECT
    // back to service_role alone — exactly the R9 lifecycle projection's grant shape.
    const revokes = sql.match(/revoke all on public\.[a-z_]+\s+from public, anon, authenticated, service_role/gi) ?? [];
    const grants = sql.match(/grant select on public\.[a-z_]+ to service_role/gi) ?? [];
    expect(revokes).toHaveLength(2);
    expect(grants).toHaveLength(2);
    // No write privilege is granted through the projection, to anyone.
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)\b/i);
  });

  it("installs no policy and no INSTEAD OF write path — the views can never be written through", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/instead of/i);
    expect(sql).not.toMatch(/create\s+rule/i);
  });
});

// =====================================================================
// 3. REUSES R9, FORKS NOTHING — outbound resolves THROUGH ai_reply_lifecycle.
// =====================================================================

describe("receptionist conversation read model — it reuses the R9 resolution and forks none", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("resolves the outbound side through the ai_reply_lifecycle view", () => {
    expect(sql).toMatch(/\bai_reply_lifecycle\b/i);
  });

  it("projects over the substrate + the enquiries table it references", () => {
    expect(sql).toMatch(/\breceptionist_messages\b/i);
    expect(sql).toMatch(/\breceptionist_conversations\b/i);
    expect(sql).toMatch(/\binbound_enquiries\b/i);
  });

  it("re-implements NO ledger reconstruction — it names no reply ledger and no ledger writer", () => {
    // The transport + receipt references come from ai_reply_lifecycle (R9), so the read model
    // must not itself join the ledgers or call their write primitives. If any of these appear,
    // the read model has forked a second reconstruction of the outbound chain.
    for (const token of [
      /\bai_reply_audits\b/i,
      /\bai_reply_transports\b/i,
      /\bai_reply_delivery_receipts\b/i,
      /\brecord_ai_reply_/i,
    ]) {
      expect(sql, `must not name ${token}`).not.toMatch(token);
    }
  });
});

// =====================================================================
// 4. SINGLE RECONSTRUCTION PATH — the views are read by exactly one module.
// =====================================================================

describe("receptionist conversation read model — reconstruction lives in exactly one module", () => {
  it("both projections are queried by the read service ALONE across all source", () => {
    const timelineReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => TIMELINE_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    const listReaders = walkSources(SOURCE_ROOTS)
      .filter((full) => LIST_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // If either list grows beyond the read service, a feature has reconstructed a conversation
    // some other way — precisely what the repository principle forbids.
    expect(timelineReaders).toEqual([READS]);
    expect(listReaders).toEqual([READS]);
  });
});

// =====================================================================
// 5. THE READ SERVICE PERFORMS NO MUTATION — pure read, no outbound, no drift.
// =====================================================================

describe("receptionist conversation read model — the read service performs no mutation", () => {
  const code = codeOf(read(READS));

  it("is a server-only module that reads the two projections", () => {
    expect(importSpecifiers(code)).toContain("server-only");
    expect(code).toMatch(TIMELINE_VIEW);
    expect(code).toMatch(LIST_VIEW);
  });

  it("imports no policy, no comms, no reply producer — it reads, it does not reply", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("@/lib/receptionist/policy");
    expect(imports).not.toContain("@/lib/receptionist/reply");
    expect(imports).not.toContain("@/lib/comms");
  });

  it("names no write primitive and calls no vendor — no door to a provider or a ledger", () => {
    expect(code).not.toMatch(/record_ai_reply_audit|record_ai_reply_transport|record_ai_reply_delivery_receipt/);
    expect(code).not.toMatch(/\b(?:resolve_receptionist_conversation|append_receptionist_message)\b/);
    expect(code).not.toMatch(/\b(?:dispatchReply|dispatchReceptionistReply|getSmsProvider)\b/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });

  it("uses NO mutating query verb — only .select() (never insert/update/delete/upsert/rpc)", () => {
    // The read model can observe the substrate; it can never write it. A plain SELECT is the
    // only database verb the service is permitted to use.
    expect(code).not.toMatch(/\.insert\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
    expect(code).not.toMatch(/\.delete\s*\(/);
    expect(code).not.toMatch(/\.upsert\s*\(/);
    expect(code).not.toMatch(/\.rpc\b/);
    expect(code).toMatch(/\.select\s*\(/);
  });

  it("reuses the ONE contact fold, so read-side identity can never drift from the write side", () => {
    // getConversationByContact resolves through the SAME normaliseContactRef the writer uses —
    // it does not re-implement trim/casefold, so a contact resolves identically on read.
    expect(importSpecifiers(code)).toContain("@/server/services/receptionist-conversations");
    expect(code).toMatch(/\bnormaliseContactRef\s*\(/);
  });
});

// =====================================================================
// 6. ONE CANONICAL ORDER — defined once, applied to every read, non-mutating.
// =====================================================================

describe("receptionist conversation read model — the canonical order is defined once", () => {
  const code = codeOf(read(READS));

  it("defines the order as pure, exported functions (unit-pinned)", () => {
    expect(code).toMatch(/export function compareTimelineEvents\(/);
    expect(code).toMatch(/export function orderTimeline\(/);
  });

  it("applies that one order to the timeline read, and orders WITHOUT mutating its input", () => {
    expect(code).toMatch(/return orderTimeline\(/); // getConversationTimeline applies it
    expect(code).toMatch(/\[\.\.\.events\]\.sort\(/); // a copy is sorted, the input is not
  });
});

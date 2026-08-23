import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation coordination READ MODEL invariants
 * (the AI Receptionist Programme, R37 — CONVERSATION COORDINATION READ MODEL).
 *
 * R36 laid the Conversation Coordination Engine: a pure core that COORDINATES a routed R35
 * orchestration into a participation plan and a runtime that files ONE idempotent row into the
 * append-only `receptionist_conversation_coordinations` ledger. R37 turns that ledger into the
 * canonical READ layer: one `security_invoker` projection
 * (`public.receptionist_coordination_read_model`) plus the org-scoped read service that resolves
 * each coordination's linked per-engine context at read time. The cardinal safety property is that
 * it is a PROJECTION, NOT BEHAVIOUR: it is provably additive, it is read-only, it introduces no
 * second source of truth, it RE-DERIVES no coordination decision (the Coordination Engine stays
 * authoritative), it re-governs / re-resolves / re-recovers nothing (Lifecycle, Resolution and
 * Recovery stay authoritative), it is the SINGLE query surface for recorded coordinations, and it
 * introduces NO execution path. This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R9/R11/R36 invariant suites:
 *
 *   • PROVABLY ADDITIVE — the migration only CREATEs one VIEW. It makes no table, no function, no
 *     column, no trigger; it drops, retypes and renulls nothing.
 *   • READ-ONLY PROJECTION (the R9/R11 pattern) — the view is security_invoker, SELECT is the only
 *     privilege and it is granted to service_role ONLY; the migration grants no write verb, defines
 *     no policy, and installs no INSTEAD OF write path; the view is plain (not materialised), so it
 *     holds no rows and can drift from nothing.
 *   • RESOLVES CONTEXT BY REFERENCE, FORKS NOTHING — the view joins the coordination ledger to its
 *     six sibling ledgers (orchestration → lifecycle → resolution → recovery → verification →
 *     fulfilment) by reference, and surfaces the RECORDED decision from the ledger column verbatim;
 *     it names no ledger writer, so it re-implements no engine.
 *   • SINGLE READ PATH — the view is read by EXACTLY ONE module across all source, the read service;
 *     if that list grows, a second coordination-reconstruction path has appeared.
 *   • THE READ SERVICE PERFORMS NO MUTATION — it is server-only, imports no engine / policy / comms,
 *     names no write primitive, calls no vendor, and uses no mutating query verb
 *     (.insert/.update/.delete/.upsert/.rpc) — it only SELECTs, always org-scoped.
 *   • NO DUPLICATE COORDINATION LOGIC — the pure core reuses the R36/R35 vocabulary as TYPES only,
 *     names no resolver / fold, and reaches no I/O, no clock and no RNG: it RE-SHAPES the recorded
 *     decision, it never recomputes it.
 *   • ONE CANONICAL ORDER — the deterministic order is defined once (compareCoordinationRecords /
 *     orderCoordinationRecords), applied to every list read, and is non-mutating.
 *   • NO EXECUTION PATH — neither the migration, the reader nor the pure core names ANY engine write
 *     primitive (the coordination writer or any of the six sibling writers) or ANY engine runtime;
 *     there is provably no way to coordinate, orchestrate, govern, resolve, recover, verify or
 *     fulfil through the read model.
 *
 * The read model's runtime behaviour (verbatim decision surfacing; correct six-way context
 * resolution; the retained→NULL-fulfilment absence; deterministic newest-first order; org isolation;
 * the view's write-rejection and anon-deny) is pinned against real Postgres in
 * __tests__/integration/receptionist/coordination-read-model-pipeline.test.ts. This tier is
 * HERMETIC — a filesystem scan over comment-stripped source — so the prose documenting the contract
 * can neither satisfy a positive match nor trip a negative.
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
    .replace(/--[^\n]*/g, ""); // line comments — where all the R37 prose lives
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

const CORE = "lib/receptionist/conversation-coordination-view.ts";
const READER = "server/services/receptionist-coordination-view.ts";
const MIGRATION = "supabase/migrations/20260906000000_receptionist_coordination_read_model.sql";

/** The read-model projection — the relation an auditor would query to reconstruct a coordination. */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The coordination ledger and its six sibling ledgers — the seven relations the view resolves. */
const LEDGER_RELATIONS = [
  /\breceptionist_conversation_coordinations\b/i,
  /\breceptionist_conversation_orchestrations\b/i,
  /\breceptionist_conversation_lifecycles\b/i,
  /\breceptionist_conversation_resolutions\b/i,
  /\breceptionist_conversation_recoveries\b/i,
  /\breceptionist_conversation_verifications\b/i,
  /\breceptionist_conversation_fulfilments\b/i,
] as const;

/** Every engine write primitive + runtime writer + the coordination resolver — the execution path
 *  a read model must NEVER name. `record_receptionist_conversation_` covers all seven ledger writers. */
const EXECUTION_TOKENS = [
  /record_receptionist_conversation_/i, // every ledger's write RPC (coordination + six siblings)
  /\bresolveConversationCoordination\b/, // the R36 fold — re-deriving the decision
  /\bcoordinateConversationLifecycle\b/, // the R36 runtime writer
  /\borchestrateConversationLifecycle\b/, // the R35 runtime writer
  /\bgovernConversationLifecycle\b/, // the R34 runtime writer
  /\bresolveConversationCompletion\b/, // the R33 runtime writer
  /\brecoverVerifiedFulfilment\b/, // the R32 runtime writer
  /\bverifyApprovedFulfilment\b/, // the R31 runtime writer
  /\bfulfilApprovedBooking\b/, // the R30 runtime writer
] as const;

// =====================================================================
// 0. The read model ships — migration + reader + pure core.
// =====================================================================

describe("receptionist coordination read model — the read model ships", () => {
  it(`ships the read-model migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it(`ships the read service ${READER} and its pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, READER)), READER).toBe(true);
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it("the read service exports the four org-scoped read seams", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/export async function listCoordinations\(/);
    expect(code).toMatch(/export async function listCoordinationsForConversation\(/);
    expect(code).toMatch(/export async function getCoordinationById\(/);
    expect(code).toMatch(/export async function getCoordinationByOrchestration\(/);
  });

  it("the pure core exports the projection + the single canonical order", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function projectCoordinationRecord\(/);
    expect(code).toMatch(/export function compareCoordinationRecords\(/);
    expect(code).toMatch(/export function orderCoordinationRecords\(/);
  });
});

// =====================================================================
// 1. PROVABLY ADDITIVE — the migration creates one view, and nothing else.
// =====================================================================

describe("receptionist coordination read model — the migration is provably additive", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("creates the one projection", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_coordination_read_model/i);
    expect(sql.match(/create or replace view/gi) ?? []).toHaveLength(1);
  });

  it("creates NO table, function, column or trigger — it is one view + grants only", () => {
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
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
  });
});

// =====================================================================
// 2. READ-ONLY PROJECTION — security_invoker, SELECT-only, service_role-only (the R9/R11 pattern).
// =====================================================================

describe("receptionist coordination read model — it is a read-only projection", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("declares the view security_invoker — it inherits the caller's RLS, laundering nothing", () => {
    expect(sql.match(/with \(security_invoker = true\)/gi) ?? []).toHaveLength(1);
  });

  it("grants SELECT to service_role ONLY, and no write verb to anyone", () => {
    // Revoke everything from every JWT role (and service_role), then grant SELECT back to
    // service_role alone — exactly the R9/R11 projection's grant shape.
    const revokes = sql.match(/revoke all on public\.[a-z_]+\s+from public, anon, authenticated, service_role/gi) ?? [];
    const grants = sql.match(/grant select on public\.[a-z_]+ to service_role/gi) ?? [];
    expect(revokes).toHaveLength(1);
    expect(grants).toHaveLength(1);
    // No write privilege is granted through the projection, to anyone.
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)\b/i);
  });

  it("installs no policy and no INSTEAD OF write path — the view can never be written through", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/instead of/i);
    expect(sql).not.toMatch(/create\s+rule/i);
  });
});

// =====================================================================
// 3. RESOLVES CONTEXT BY REFERENCE, FORKS NOTHING — the seven-relation join, verbatim decision.
// =====================================================================

describe("receptionist coordination read model — it resolves context by reference and forks no engine", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("joins the coordination ledger to all SIX sibling ledgers (the linked context)", () => {
    for (const rel of LEDGER_RELATIONS) {
      expect(sql, `the view must resolve ${rel}`).toMatch(rel);
    }
    // Every sibling is joined LEFT (a coordination is never dropped if a sibling is absent).
    expect((sql.match(/left join/gi) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("surfaces the RECORDED decision from the coordination ledger column VERBATIM (the engine stays authoritative)", () => {
    // The mode / lead / plan / flags are SELECTed from the ledger alias `c` directly — never a CASE
    // fold that recomputes them. The Coordination Engine (R36) recorded them; the view only exposes.
    expect(sql).toMatch(/c\.coordination_mode/);
    expect(sql).toMatch(/c\.lead_participant/);
    expect(sql).toMatch(/c\.participant_count/);
    expect(sql).toMatch(/c\.requires_human/);
    expect(sql).toMatch(/c\.autonomous/);
  });

  it("names NO ledger writer — it re-implements no engine's reconstruction", () => {
    // The linked context is resolved by REFERENCE off the coordination ledger's own foreign keys, so
    // the view must never call a ledger write primitive. If any appears, the read model has forked an
    // engine.
    expect(sql).not.toMatch(/record_receptionist_conversation_/i);
  });
});

// =====================================================================
// 4. SINGLE READ PATH — the view is read by exactly one module.
// =====================================================================

describe("receptionist coordination read model — reading lives in exactly one module", () => {
  it("the projection is queried by the read service ALONE across all source", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // If this list grows beyond the read service, a feature has reconstructed a coordination some
    // other way — precisely what the repository principle forbids.
    expect(readers).toEqual([READER]);
  });
});

// =====================================================================
// 5. THE READ SERVICE PERFORMS NO MUTATION — pure read, org-scoped, no outbound.
// =====================================================================

describe("receptionist coordination read model — the read service performs no mutation", () => {
  const code = codeOf(read(READER));

  it("is a server-only module that reads the projection", () => {
    expect(importSpecifiers(code)).toContain("server-only");
    expect(code).toMatch(READ_MODEL_VIEW);
  });

  it("imports no engine, no policy, no comms — it reads, it does not coordinate", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("@/server/services/receptionist-coordination"); // the R36 runtime
    expect(imports).not.toContain("@/lib/receptionist/conversation-coordination"); // the R36 resolver core
    expect(imports).not.toContain("@/lib/receptionist/policy");
    expect(imports).not.toContain("@/lib/comms");
  });

  it("names no write primitive and calls no vendor — no door to an engine or a provider", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the reader must not name ${token}`).not.toMatch(token);
    }
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });

  it("uses NO mutating query verb — only .select() (never insert/update/delete/upsert/rpc)", () => {
    // The read model can observe the ledger; it can never write it. A plain SELECT is the only
    // database verb the service is permitted to use.
    expect(code).not.toMatch(/\.insert\s*\(/);
    expect(code).not.toMatch(/\.update\s*\(/);
    expect(code).not.toMatch(/\.delete\s*\(/);
    expect(code).not.toMatch(/\.upsert\s*\(/);
    expect(code).not.toMatch(/\.rpc\b/);
    expect(code).toMatch(/\.select\s*\(/);
  });

  it("is ORG-SCOPED on every read — each query filters org_id, so one org can never read another's", () => {
    // Four read seams, four mandatory org_id filters — organisation isolation by construction.
    const orgFilters = code.match(/\.eq\(\s*["']org_id["']/g) ?? [];
    expect(orgFilters.length).toBeGreaterThanOrEqual(4);
  });
});

// =====================================================================
// 6. NO DUPLICATE COORDINATION LOGIC — the pure core re-derives nothing.
// =====================================================================

describe("receptionist coordination read model — the pure core re-derives no decision", () => {
  const raw = read(CORE);
  const code = codeOf(raw);

  it("reuses the R36/R35 vocabulary as TYPES only — it forks no vocabulary of its own", () => {
    // The recorded decision's own vocabulary is imported type-only (erased at runtime), so the core
    // carries zero runtime dependency on the engine — it only SHAPES what the ledger recorded.
    expect(raw).toMatch(
      /import type \{[\s\S]*?\}\s*from\s*["']@\/lib\/receptionist\/conversation-coordination["']/,
    );
    const imports = importSpecifiers(code);
    expect(imports).toContain("@/lib/receptionist/conversation-coordination");
    expect(imports).toContain("@/lib/receptionist/conversation-orchestration");
  });

  it("names no resolver and no runtime writer — the recorded decision is re-shaped, never recomputed", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the pure core must not name ${token}`).not.toMatch(token);
    }
  });

  it("reaches no I/O, no clock and no RNG — it is a pure, deterministic shape transform", () => {
    expect(code).not.toMatch(/createAdminClient|createClient/);
    expect(code).not.toMatch(/\.select\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.rpc\b/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
  });
});

// =====================================================================
// 7. ONE CANONICAL ORDER — defined once, applied to every list read, non-mutating.
// =====================================================================

describe("receptionist coordination read model — the canonical order is defined once", () => {
  const coreCode = codeOf(read(CORE));
  const readerCode = codeOf(read(READER));

  it("defines the order as pure, exported functions (unit-pinned)", () => {
    expect(coreCode).toMatch(/export function compareCoordinationRecords\(/);
    expect(coreCode).toMatch(/export function orderCoordinationRecords\(/);
  });

  it("orders WITHOUT mutating its input — a copy is sorted, the input is not", () => {
    expect(coreCode).toMatch(/\[\.\.\.records\]\.sort\(/);
  });

  it("applies that one order to the list reads (the reader never rolls its own sort)", () => {
    expect(readerCode).toMatch(/orderCoordinationRecords\(/);
    // The reader imports the canonical order rather than re-implementing a comparator.
    expect(importSpecifiers(readerCode)).toContain("@/lib/receptionist/conversation-coordination-view");
    expect(readerCode).not.toMatch(/\.sort\s*\(/);
  });
});

// =====================================================================
// 8. NO EXECUTION PATH — no artefact names any engine write primitive or runtime.
// =====================================================================

describe("receptionist coordination read model — it introduces no execution path", () => {
  it("neither the migration, the reader nor the pure core names ANY engine writer or runtime", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: MIGRATION, text: sqlCodeOf(read(MIGRATION)) },
      { path: READER, text: codeOf(read(READER)) },
      { path: CORE, text: codeOf(read(CORE)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a read model executes nothing`).not.toMatch(token);
      }
    }
  });
});

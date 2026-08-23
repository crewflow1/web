import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation coordination WORKLIST ENGINE invariants
 * (the AI Receptionist Programme, R38 — CONVERSATION COORDINATION WORKLIST ENGINE).
 *
 * R37 laid the Conversation Coordination READ MODEL: one `security_invoker` projection
 * (`public.receptionist_coordination_read_model`) plus the org-scoped read service that is its SINGLE
 * consumer — the canonical, authorised query surface for recorded coordination decisions. R38 is the
 * next layer UP: a pure core (`lib/receptionist/conversation-coordination-worklist.ts`) that DERIVES
 * prioritised, read-only worklists from those records, and a server runtime
 * (`server/services/receptionist-coordination-worklist.ts`) that joins the R37 reader to the pure core.
 * The cardinal safety property is that it is a DERIVATION, NOT BEHAVIOUR: it adds no relation, it reads
 * ONLY through the R37 reader (never a ledger, never the view), it RE-DERIVES no coordination decision
 * (the Coordination Engine stays authoritative), the Read Model stays the single query surface, and it
 * introduces NO execution path — it assigns nobody, dispatches nothing, notifies no one, schedules
 * nothing and retries nothing. This suite proves that contract as a matter of SOURCE, not discipline —
 * the house bar of the R9/R11/R36/R37 invariant suites:
 *
 *   • ADDS NO RELATION — the Worklist Engine ships NO migration: no view, no table, no column. It
 *     derives entirely from the R37 records, so the Read Model stays the single query surface and there
 *     is provably no second coordination-reconstruction path in the database.
 *   • THE READ MODEL STAYS THE SINGLE QUERY SURFACE — the reader reads the coordination Read Model ONLY
 *     through the R37 read service's functions; it never names the projection view, and with R38 in the
 *     tree the view is STILL queried by exactly one module (R37's own single-read-path invariant holds).
 *   • THE READER PERFORMS NO MUTATION — it is server-only, imports the R37 reader + the pure core and
 *     nothing else, creates no database client, names no ledger, uses NO query verb at all
 *     (.select/.insert/.update/.delete/.upsert/.rpc/.from), calls no vendor and names no engine writer.
 *   • ORGANISATION ISOLATION IS INHERITED — every exported seam takes an `org_id` and forwards it
 *     straight to the R37 reader, whose every query carries the mandatory org filter; isolation is not
 *     re-implemented, it is inherited.
 *   • NO DUPLICATE COORDINATION LOGIC — the pure core reuses the R36/R37 vocabulary as TYPES only,
 *     REUSES the R37 canonical order (compareCoordinationRecords) rather than re-implementing recency,
 *     names no resolver / fold / runtime writer, and reaches no I/O, no clock and no RNG: it RE-SHAPES
 *     the recorded decisions into worklists, it never recomputes them — so the same records always
 *     derive the same worklists (deterministic by construction).
 *   • ONE CANONICAL ORDER — the worklist order is defined once (compareWorklistEntries /
 *     orderWorklistEntries): higher operational priority first, then the R37 recency order reused
 *     verbatim; it is non-mutating, and the reader never rolls its own sort.
 *   • NO EXECUTION PATH — neither the reader nor the pure core names ANY engine write primitive or
 *     runtime; there is provably no way to coordinate, orchestrate, govern, resolve, recover, verify,
 *     fulfil, assign, dispatch, notify or schedule through the Worklist Engine.
 *
 * The engine's runtime behaviour (correct grouping and overlap; the escalation on human-review AND
 * escalation; priority-driven cross-category ordering; determinism against live data; org isolation;
 * conversation scoping; the concluded-is-non-actionable absence; verbatim surfacing with the Read Model
 * authoritative) is pinned by the unit suite
 * (__tests__/receptionist/conversation-coordination-worklist.test.ts) and against real Postgres in
 * __tests__/integration/receptionist/coordination-worklist-pipeline.test.ts. This tier is HERMETIC — a
 * filesystem scan over comment-stripped source — so the prose documenting the contract can neither
 * satisfy a positive match nor trip a negative.
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
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (defensive)
    .replace(/--[^\n]*/g, ""); // line comments
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

// The R38 artefacts — the pure derivation core and the server runtime that joins R37 to it.
const CORE = "lib/receptionist/conversation-coordination-worklist.ts";
const READER = "server/services/receptionist-coordination-worklist.ts";

// The R37 read layer R38 reads THROUGH — never around. The reader consumes the R37 read SERVICE; the
// pure core consumes the R37 pure core (the record type + the canonical order) — no server dependency.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const R37_READER_MODULE = "@/server/services/receptionist-coordination-view";
const R37_CORE_MODULE = "@/lib/receptionist/conversation-coordination-view";

/** The R37 read-model projection — the relation R38 must NEVER name (it reads through the R37 reader). */
const READ_MODEL_VIEW = /\breceptionist_coordination_read_model\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;
const MIGRATIONS_DIR = "supabase/migrations";

/** The coordination ledger and its six sibling ledgers — the seven relations R38 must never name. */
const LEDGER_RELATIONS = [
  /\breceptionist_conversation_coordinations\b/i,
  /\breceptionist_conversation_orchestrations\b/i,
  /\breceptionist_conversation_lifecycles\b/i,
  /\breceptionist_conversation_resolutions\b/i,
  /\breceptionist_conversation_recoveries\b/i,
  /\breceptionist_conversation_verifications\b/i,
  /\breceptionist_conversation_fulfilments\b/i,
] as const;

/** Every engine write primitive + runtime writer + the coordination resolver — the execution path a
 *  worklist engine must NEVER name. `record_receptionist_conversation_` covers all seven ledger writers. */
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

/** Any database client constructor — the pure core and the reader must create none (the reader reads
 *  through the R37 service; the core touches no DB at all). */
const DB_CLIENT = /createAdminClient|createServiceRoleClient|createClient/;

/** Any database query verb — R38 names NONE (a read model over a read model touches no DB primitive). */
const QUERY_VERB = /\.(from|select|insert|update|delete|upsert|rpc)\b/;

// =====================================================================
// 0. The worklist engine ships — pure core + server reader.
// =====================================================================

describe("receptionist coordination worklist engine — the engine ships", () => {
  it(`ships the worklist runtime ${READER} and its pure core ${CORE}`, () => {
    expect(existsSync(resolve(ROOT, READER)), READER).toBe(true);
    expect(existsSync(resolve(ROOT, CORE)), CORE).toBe(true);
  });

  it("the runtime exports the org-scoped worklist seams (three directed + prioritised + set + per-conversation)", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/export async function getCoordinationWorklists\(/);
    expect(code).toMatch(/export async function getHumanReviewWorklist\(/);
    expect(code).toMatch(/export async function getRecoveryWorklist\(/);
    expect(code).toMatch(/export async function getEscalationWorklist\(/);
    expect(code).toMatch(/export async function getPrioritisedWorklist\(/);
    expect(code).toMatch(/export async function getCoordinationWorklistsForConversation\(/);
  });

  it("the pure core exports the derivation + the single canonical worklist order", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function deriveWorklists\(/);
    expect(code).toMatch(/export function deriveCoordinationPriority\(/);
    expect(code).toMatch(/export function belongsToWorklist\(/);
    expect(code).toMatch(/export function worklistCategoriesOf\(/);
    expect(code).toMatch(/export function toWorklistEntry\(/);
    expect(code).toMatch(/export function compareWorklistEntries\(/);
    expect(code).toMatch(/export function orderWorklistEntries\(/);
  });
});

// =====================================================================
// 1. ADDS NO RELATION — the worklist engine ships no migration; it derives from the R37 records alone.
// =====================================================================

describe("receptionist coordination worklist engine — it adds no relation", () => {
  it("ships NO migration that names a worklist relation — no view, no table, no column", () => {
    // The Worklist Engine derives entirely from the R37 records the read service returns; it introduces
    // no database object of its own. So no migration — in FILENAME or in executable SQL — mentions a
    // worklist. If one did, R38 would have forked a second query surface over the coordinations.
    const files = readdirSync(resolve(ROOT, MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
    const byName = files.filter((f) => /worklist/i.test(f));
    expect(byName, "no migration file is named for a worklist relation").toEqual([]);
    const byBody = files.filter((f) => /worklist/i.test(sqlCodeOf(read(`${MIGRATIONS_DIR}/${f}`))));
    expect(byBody, "no migration's executable SQL names a worklist relation").toEqual([]);
  });
});

// =====================================================================
// 2. THE READ MODEL STAYS THE SINGLE QUERY SURFACE — R38 reads only through the R37 reader.
// =====================================================================

describe("receptionist coordination worklist engine — the Read Model stays the single query surface", () => {
  it("reads the coordination Read Model ONLY through the R37 reader — it never names the view", () => {
    const readerCode = codeOf(read(READER));
    const coreCode = codeOf(read(CORE));
    // R38 goes through the R37 read service's functions…
    expect(importSpecifiers(readerCode)).toContain(R37_READER_MODULE);
    // …and never around them to the projection itself (which would be a second read path over it).
    expect(readerCode).not.toMatch(READ_MODEL_VIEW);
    expect(coreCode).not.toMatch(READ_MODEL_VIEW);
  });

  it("with R38 in the tree, the R37 view is STILL queried by exactly one module (R37's invariant holds)", () => {
    const readers = walkSources(SOURCE_ROOTS)
      .filter((full) => READ_MODEL_VIEW.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // R38 must NOT appear here — it reads through the R37 reader, not the view. If it did, R38 would be
    // a second coordination-reconstruction path over the projection, breaking R37's core invariant.
    expect(readers).toEqual([R37_READER]);
  });

  it("names NONE of the seven coordination ledgers — it reads records, never a relation", () => {
    const readerCode = codeOf(read(READER));
    const coreCode = codeOf(read(CORE));
    for (const ledger of LEDGER_RELATIONS) {
      expect(readerCode, `the reader must not name ${ledger}`).not.toMatch(ledger);
      expect(coreCode, `the pure core must not name ${ledger}`).not.toMatch(ledger);
    }
  });
});

// =====================================================================
// 3. THE READER PERFORMS NO MUTATION — pure read through R37, no client, no query verb, no outbound.
// =====================================================================

describe("receptionist coordination worklist engine — the runtime performs no mutation", () => {
  const code = codeOf(read(READER));

  it("is a server-only module that reads through the R37 reader and derives through the pure core", () => {
    const imports = importSpecifiers(code);
    expect(imports).toContain("server-only");
    expect(imports).toContain(R37_READER_MODULE); // reads coordinations through R37
    expect(imports).toContain("@/lib/receptionist/conversation-coordination-worklist"); // derives, purely
  });

  it("imports no engine, no policy, no comms — it reads and derives, it does not coordinate", () => {
    const imports = importSpecifiers(code);
    expect(imports).not.toContain("@/server/services/receptionist-coordination"); // the R36 runtime
    expect(imports).not.toContain("@/lib/receptionist/conversation-coordination"); // the R36 resolver core
    expect(imports).not.toContain("@/lib/receptionist/policy");
    expect(imports).not.toContain("@/lib/comms");
  });

  it("creates NO database client — its only data source is the R37 reader", () => {
    expect(code).not.toMatch(DB_CLIENT);
    expect(importSpecifiers(code)).not.toContain("@/lib/supabase/admin");
  });

  it("uses NO database query verb — a read model over a read model touches no DB primitive", () => {
    expect(code).not.toMatch(QUERY_VERB);
  });

  it("names no engine writer and calls no vendor — no door to an engine or a provider", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the reader must not name ${token}`).not.toMatch(token);
    }
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION IS INHERITED — every seam takes and forwards org_id to the R37 reader.
// =====================================================================

describe("receptionist coordination worklist engine — organisation isolation is inherited", () => {
  const code = codeOf(read(READER));

  it("every worklist seam is org-scoped — each takes an org_id (one per exported seam)", () => {
    // Six exported seams, each with an `org_id: string` in its input — organisation scope by signature.
    const orgInputs = code.match(/org_id:\s*string/g) ?? [];
    expect(orgInputs.length).toBeGreaterThanOrEqual(6);
  });

  it("forwards org_id straight to the R37 reader — isolation is inherited, not re-implemented", () => {
    // The set reader passes the caller's org_id into `listCoordinations`; the conversation reader passes
    // the whole org-scoped input into `listCoordinationsForConversation`. Every read is therefore scoped
    // by the R37 query's own mandatory org filter — R38 re-implements no isolation of its own.
    expect(code).toMatch(/listCoordinations\(\s*\{\s*org_id:\s*input\.org_id/);
    expect(code).toMatch(/listCoordinationsForConversation\(\s*input\s*\)/);
  });
});

// =====================================================================
// 5. NO DUPLICATE COORDINATION LOGIC — the pure core re-derives nothing (and is deterministic).
// =====================================================================

describe("receptionist coordination worklist engine — the pure core re-derives no decision", () => {
  const raw = read(CORE);
  const code = codeOf(raw);

  it("reuses the coordination vocabulary as TYPES only — it forks no vocabulary of its own", () => {
    // The recorded decision's own vocabulary (mode, participant) is imported type-only (erased at
    // runtime), so the core carries zero runtime dependency on the engine — it SHAPES what R37 recorded.
    expect(raw).toMatch(
      /import type \{[\s\S]*?\}\s*from\s*["']@\/lib\/receptionist\/conversation-coordination["']/,
    );
    expect(importSpecifiers(code)).toContain("@/lib/receptionist/conversation-coordination");
  });

  it("REUSES the R37 canonical order rather than re-implementing recency", () => {
    // The single legitimate VALUE import from R37: the recency comparator. The worklist order adds a
    // priority dimension on TOP of it (see §6) — it never re-implements the newest-first tiebreak.
    expect(importSpecifiers(code)).toContain(R37_CORE_MODULE);
    expect(code).toMatch(/\bcompareCoordinationRecords\b/);
  });

  it("depends on no server module and no database client — the core is a pure shape transform", () => {
    // The pure core consumes the R37 pure core (the record type + the order); it never reaches the R37
    // reader or any DB — WHICH org's coordinations are read is the runtime's job, through R37.
    expect(importSpecifiers(code)).not.toContain(R37_READER_MODULE);
    expect(code).not.toMatch(DB_CLIENT);
    expect(code).not.toMatch(QUERY_VERB);
  });

  it("names no resolver and no runtime writer — the recorded decision is re-shaped, never recomputed", () => {
    for (const token of EXECUTION_TOKENS) {
      expect(code, `the pure core must not name ${token}`).not.toMatch(token);
    }
  });

  it("reaches no I/O, no clock and no RNG — worklists are deterministic by construction", () => {
    // No clock and no RNG ⇒ the same set of records always derives the same worklists, in the same
    // order. Determinism is a property of the SOURCE, not merely of a passing test run.
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/Math\.random|Date\.now|crypto\./);
  });
});

// =====================================================================
// 6. ONE CANONICAL ORDER — priority on top of R37's recency, defined once, non-mutating.
// =====================================================================

describe("receptionist coordination worklist engine — the worklist order is defined once", () => {
  const coreCode = codeOf(read(CORE));
  const readerCode = codeOf(read(READER));

  it("defines the order as pure, exported functions (unit-pinned)", () => {
    expect(coreCode).toMatch(/export function compareWorklistEntries\(/);
    expect(coreCode).toMatch(/export function orderWorklistEntries\(/);
  });

  it("orders by PRIORITY first, then the R37 recency order reused verbatim", () => {
    // Higher operational priority (lower rank) first; within a priority, delegate to the R37 comparator.
    expect(coreCode).toMatch(/priority_rank/);
    expect(coreCode).toMatch(/return compareCoordinationRecords\(/);
  });

  it("orders WITHOUT mutating its input — a copy is sorted, the input is not", () => {
    expect(coreCode).toMatch(/\[\.\.\.entries\]\.sort\(/);
  });

  it("the runtime never rolls its own sort — all ordering lives in the pure core", () => {
    expect(readerCode).not.toMatch(/\.sort\s*\(/);
  });
});

// =====================================================================
// 7. NO EXECUTION PATH — neither artefact names any engine writer or runtime.
// =====================================================================

describe("receptionist coordination worklist engine — it introduces no execution path", () => {
  it("neither the reader nor the pure core names ANY engine writer or runtime", () => {
    const artefacts: Array<{ path: string; text: string }> = [
      { path: READER, text: codeOf(read(READER)) },
      { path: CORE, text: codeOf(read(CORE)) },
    ];
    for (const { path, text } of artefacts) {
      for (const token of EXECUTION_TOKENS) {
        expect(text, `${path} must not name ${token} — a worklist engine executes nothing`).not.toMatch(
          token,
        );
      }
      // It derives worklists; it opens no outbound path to assign, dispatch, notify or schedule.
      expect(text, `${path} must not reach a provider`).not.toMatch(/\bfetch\s*\(/);
      expect(text, `${path} must not send`).not.toMatch(/\.send\s*\(/);
    }
  });
});

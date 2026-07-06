import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK OWNERSHIP READ MODEL governance invariants
 * (the AI Receptionist Programme, R48 — CONVERSATION WORK OWNERSHIP READ MODEL).
 *
 * R46 shipped the claim capability (the `claimConversationWork` runtime + the append-only, conflict-guarded
 * `receptionist_conversation_claims` ledger); R47 shipped the first operator-facing surface. R48 establishes the
 * CANONICAL OWNERSHIP READ MODEL — the single authoritative projection of ownership state derived from the append-only
 * claim ledger. Its law is exact: "the ownership read model is authoritative; the claim runtime remains authoritative;
 * it consumes ONLY the append-only claim ledger; organisation isolation is preserved; the audit remains append-only;
 * and NO execution path is introduced." This suite proves that contract as a matter of SOURCE, not discipline — the
 * house bar of the R30→R47 invariant suites:
 *
 *   • THE READ MODEL IS AUTHORITATIVE — the canonical ownership reader exports the org-scoped ownership seams
 *     (per-coordination owner + status, org-wide history, org-wide summary); the pure core exports the projections, the
 *     canonical history order and the summary fold. Ownership derivation lives HERE and nowhere else.
 *   • THE CLAIM RUNTIME STAYS AUTHORITATIVE — R48 adds NO writer: the ledger write primitive
 *     (`record_receptionist_conversation_claim`) is still named by EXACTLY ONE module (the R46 runtime), and
 *     `claimConversationWork` is still DEFINED once. Neither the read-model core nor its reader records a claim, names
 *     the runtime writer, or re-derives a claim (`resolveClaim`).
 *   • IT CONSUMES ONLY THE APPEND-ONLY CLAIM LEDGER — the reader's only `.from(...)` target is
 *     `receptionist_conversation_claims`; it names no coordination table and no sibling engine. The pure core names no
 *     table at all — it consumes rows, not a database.
 *   • ORGANISATION ISOLATION IS PRESERVED — EVERY read is org-scoped: the reader's `org_id` filter count equals its
 *     `select` count, so no read can escape the org filter.
 *   • THE AUDIT STAYS APPEND-ONLY — the reader performs ONLY SELECTs (no insert/update/delete/upsert, no write
 *     primitive, no RPC); and across all source the claims ledger is READ through EXACTLY TWO read-only seams (the R47
 *     surface reader and this R48 read model) — R48 adds no writer and no migration.
 *   • NO EXECUTION PATH IS INTRODUCED — neither read-model file names any engine execution function, any other engine
 *     writer, or any R48 non-goal token (assign / reassign / release / dispatch / notify / schedule / … / close). The
 *     read model states ownership facts; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the reader is server-only, and the pure core is a shared, deterministic module
 *     (NOT server-only) importing only the R46 claim types, touching no I/O, no clock and no RNG.
 *
 * The read model's runtime behaviour (reader over real Postgres, reading back what the runtime recorded) is pinned in
 * __tests__/integration/receptionist/ownership-read-model-pipeline.test.ts, and the pure core exhaustively in
 * __tests__/receptionist/conversation-ownership-read-model.test.ts. This tier is HERMETIC — a filesystem scan over
 * comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip a
 * negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
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

/** Every `.from("table")` target named in the source — the tables a reader actually touches. */
function fromTargets(code: string): string[] {
  const targets: string[] = [];
  const re = /\.from\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) targets.push(m[1]);
  }
  return targets;
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

// The R46 capability (unchanged by R48) — the runtime that records a claim.
const RUNTIME = "server/services/receptionist-claim.ts";

// The R47 surface reader — the single-item, viewer-relative ownership reader over the same ledger.
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

// The R48 read model — the pure core and the canonical org-scoped ownership reader.
const CORE = "lib/receptionist/conversation-ownership-read-model.ts";
const READER = "server/services/receptionist-ownership-read-model.ts";

/** The read-model files whose EXECUTABLE source must name no execution path. */
const READ_MODEL_FILES = [CORE, READER] as const;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The claims ledger table + the R46 write primitive. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The R46 runtime entry point — the ONE governed mechanism that records an operator claim. */
const RUNTIME_ENTRY = /\bclaimConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function claimConversationWork\(/;

/** The R48 read-model entry points — the three org-scoped read seams. */
const OWNERSHIP_READ = /export async function getOwnership\(/;
const HISTORY_READ = /export async function getOwnershipHistory\(/;
const SUMMARY_READ = /export async function getOwnershipSummary\(/;

/** The R36 coordinations base table — the read model derives none. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the read model names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The R48 explicit non-goals as SOURCE tokens — the read model states ownership; it acts on nothing. */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // assignment / reassignment
  /\brelease\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no read-model module may name (the ledger is written ONLY through the R46 runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The read model ships, with its single entry points.
// =====================================================================

describe("receptionist ownership read model — the read model ships", () => {
  it("ships the pure core and the server reader", () => {
    for (const f of READ_MODEL_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the ownership projections, the canonical history order and the summary fold", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/export function projectOwner\(/);
    expect(code).toMatch(/export function projectOwnership\(/);
    expect(code).toMatch(/export function projectOwnershipEvent\(/);
    expect(code).toMatch(/export function orderOwnershipEvents\(/);
    expect(code).toMatch(/export function summariseOwnership\(/);
    expect(code).toMatch(/export const OWNERSHIP_STATES/);
  });

  it("the reader exports the three org-scoped ownership seams — owner, history and summary", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(OWNERSHIP_READ);
    expect(code).toMatch(HISTORY_READ);
    expect(code).toMatch(SUMMARY_READ);
  });
});

// =====================================================================
// 1. THE READ MODEL IS AUTHORITATIVE — ownership derivation lives here; the runtime still owns the write.
// =====================================================================

describe("receptionist ownership read model — the read model is authoritative", () => {
  it("neither the core nor the reader re-derives or records a claim (no runtime writer, entry or resolver)", () => {
    for (const f of READ_MODEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name the ledger write primitive`).not.toMatch(WRITE_FN);
      expect(code, `${f} must not name the runtime entry`).not.toMatch(RUNTIME_ENTRY);
      expect(code, `${f} must not re-derive a claim`).not.toMatch(/\bresolveClaim\b/);
    }
  });

  it("the pure core is the single home of the ownership projections + fold — it names no I/O", () => {
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
  });
});

// =====================================================================
// 2. THE CLAIM RUNTIME STAYS AUTHORITATIVE — R48 adds no writer; the runtime entry is defined once.
// =====================================================================

describe("receptionist ownership read model — the claim runtime remains authoritative", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RUNTIME_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("across all source, the ledger write primitive is still named by EXACTLY ONE module — the R46 runtime", () => {
    // R48 introduced NO writer: if this ever grows, an ownership-read module has started writing.
    expect(writers).toEqual([RUNTIME]);
  });

  it("claimConversationWork is DEFINED in exactly one module — the R46 runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("no read-model file records a claim directly — the runtime remains the sole write path", () => {
    for (const f of READ_MODEL_FILES) {
      const code = codeOf(read(f));
      expect(code.match(/record_receptionist_conversation_\w+/g), f).toBeNull();
    }
  });
});

// =====================================================================
// 3. IT CONSUMES ONLY THE APPEND-ONLY CLAIM LEDGER — one table, no coordination, no sibling engine.
// =====================================================================

describe("receptionist ownership read model — consumes only the append-only claim ledger", () => {
  it("the reader's only .from(...) target is the claims ledger — it derives no coordination", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
    expect([...new Set(fromTargets(code))]).toEqual(["receptionist_conversation_claims"]);
  });

  it("the pure core names no table at all — it consumes rows, not a database", () => {
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — every read is org-scoped; the filter can never be skipped.
// =====================================================================

describe("receptionist ownership read model — organisation isolation is preserved", () => {
  it("every read the reader performs is org-scoped — the org_id filter count equals the select count", () => {
    const code = codeOf(read(READER));
    const selects = (code.match(/\.select\(/g) ?? []).length;
    const orgFilters = (code.match(/\.eq\(\s*["']org_id["']/g) ?? []).length;
    expect(selects).toBeGreaterThan(0);
    expect(orgFilters).toBe(selects);
  });

  it("the per-coordination read is BOTH org- and coordination-scoped", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.eq\(\s*["']org_id["']/);
    expect(code).toMatch(/\.eq\(\s*["']coordination_id["']/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the reads are read-only; the ledger is read through exactly two seams.
// =====================================================================

describe("receptionist ownership read model — the append-only audit is preserved", () => {
  const ledgerReaders = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_LEDGER.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the reader performs ONLY SELECTs — no insert/update/delete/upsert, no write primitive, no RPC", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.select\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("the claims ledger is READ through EXACTLY TWO read-only seams — the R47 surface reader and the R48 read model", () => {
    // The runtime writes the ledger through the RPC (it never names the table); the two readers are the only table
    // readers. R48 adds the second, canonical read model alongside R47's viewer-relative surface reader.
    expect(ledgerReaders).toEqual([CLAIM_READER, READER].sort());
  });

  it("no read-model module directly mutates the ledger — the append-only R46 writer is the only write path", () => {
    for (const f of READ_MODEL_FILES) {
      expect(codeOf(read(f)), `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
    }
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the read model states ownership; it acts on nothing.
// =====================================================================

describe("receptionist ownership read model — no execution path is introduced", () => {
  it("no read-model file names any engine EXECUTION function", () => {
    for (const f of READ_MODEL_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no read-model file names any OTHER engine writer", () => {
    for (const f of READ_MODEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no read-model file names an R48 non-goal token (assign/reassign/release/dispatch/…/close)", () => {
    for (const f of READ_MODEL_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no read-model file reaches a transport / calendar / quote / generation path", () => {
    for (const f of READ_MODEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });
});

// =====================================================================
// 7. THE MODULE BOUNDARIES HOLD — server-only reader; shared, deterministic pure core.
// =====================================================================

describe("receptionist ownership read model — the module boundaries hold", () => {
  it("the reader is server-only — it is a canonical place the ledger is read back", () => {
    expect(importSpecifiers(codeOf(read(READER)))).toContain("server-only");
  });

  it("the pure core is a shared module (NOT server-only) importing only the R46 claim types", () => {
    const specs = importSpecifiers(codeOf(read(CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual(["./conversation-claim"]);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION OWNERSHIP STATE ENGINE governance invariants
 * (the AI Receptionist Programme, R51 — CONVERSATION OWNERSHIP STATE ENGINE).
 *
 * R46 shipped the CLAIM (an operator TAKES ownership of a coordinated Conversation Worklist item, recorded in the
 * append-only `receptionist_conversation_claims` ledger); R50 shipped the RELEASE (that operator RELINQUISHES it,
 * recorded in the append-only `receptionist_conversation_claim_releases` ledger). Those two ledgers are the append-only
 * OWNERSHIP EVENT STREAM. R48 established the canonical Ownership Read Model over them — but its reader FOLDED the two
 * ledgers itself, so ownership was derived in more than one place. R51 establishes the single canonical authority: the
 * OWNERSHIP STATE ENGINE. It is the ONE module that reads the event stream for ownership and DERIVES state
 * (`unclaimed` / `claimed` / `released`) from it, and every consumer — the Ownership Read Model above all — reads
 * ownership state THROUGH it. Its law is exact: "the Ownership State engine derives ownership state using ONLY the
 * append-only ownership events; it becomes the only authorised source of ownership state; no consumer may derive
 * ownership independently; the Claim runtime remains authoritative; the Release runtime remains authoritative; the
 * Ownership Read Model consumes only the Ownership State engine; organisation isolation is preserved; the audit remains
 * append-only; and NO execution path is introduced." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R30→R50 invariant suites:
 *
 *   • THE ENGINE IS AUTHORITATIVE — the pure derivation `deriveOwnershipState` and the folds
 *     `reconcileOwnershipStates` / `projectOwnershipState` are each DEFINED in exactly ONE module (the engine core); the
 *     runtime is the event-stream READER, and its `.from(...)` targets are EXACTLY the two append-only ledgers. The
 *     release ledger is READ through exactly ONE seam (the engine runtime); the claims ledger through exactly TWO (the
 *     engine runtime + the R47 claim affordance, out of R51 scope). No consumer re-implements the fold.
 *   • THE CLAIM RUNTIME REMAINS AUTHORITATIVE — R51 adds NO writer: `record_receptionist_conversation_claim` is still
 *     named by exactly the R46 runtime, `claimConversationWork` is still defined once, and neither engine file records
 *     or re-resolves a claim.
 *   • THE RELEASE RUNTIME REMAINS AUTHORITATIVE — `record_receptionist_conversation_claim_release` is still named by
 *     exactly the R50 runtime, `releaseConversationWork` is still defined once, and neither engine file records or
 *     re-resolves a release.
 *   • THE OWNERSHIP READ MODEL CONSUMES ONLY THE ENGINE — the R48 reader IMPORTS the engine's state seams, names NO
 *     ledger, issues NO `.from(...)` and opens no admin client; the R48 core DELEGATES its derivation to the engine.
 *   • ORGANISATION ISOLATION IS PRESERVED — EVERY read the runtime performs is org-scoped: its `org_id` filter count
 *     equals its `select` count, and the per-coordination read is BOTH org- and coordination-scoped.
 *   • THE AUDIT STAYS APPEND-ONLY — the runtime performs ONLY SELECTs (no insert/update/delete/upsert, no write
 *     primitive, no RPC), and the engine adds no table and no writer — it reads the existing ledgers.
 *   • NO EXECUTION PATH IS INTRODUCED — neither engine file names any engine execution function, any other engine
 *     writer, or any R51 non-goal token (assign / reassign / dispatch / notify / schedule / fulfil / promote / complete
 *     / close). `claim` and `release` are DELIBERATELY not non-goals — they are the two capabilities the engine derives
 *     over. The engine states WHERE a coordination sits in the lifecycle; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the runtime is server-only; the pure core is a shared, dependency-free module (it
 *     imports NOTHING), touching no I/O, no clock and no RNG.
 *
 * The engine's runtime behaviour (derivation over real Postgres, reading back what the runtimes recorded) is pinned in
 * __tests__/integration/receptionist/ownership-state-pipeline.test.ts, and the pure core exhaustively in
 * __tests__/receptionist/conversation-ownership-state.test.ts. This tier is HERMETIC — a filesystem scan over
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

/** Every `.from("table")` target a source names — the tables it reads directly. */
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

// The R51 engine — the pure derivation core and the server state runtime (the event-stream READER for ownership state).
const ENGINE_CORE = "lib/receptionist/conversation-ownership-state.ts";
const ENGINE_RUNTIME = "server/services/receptionist-ownership-state.ts";
const ENGINE_FILES = [ENGINE_CORE, ENGINE_RUNTIME] as const;

// The R48 Ownership Read Model — since R51 a pure CONSUMER of the engine (it reads no ledger of its own).
const OWNERSHIP_CORE = "lib/receptionist/conversation-ownership-read-model.ts";
const OWNERSHIP_READER = "server/services/receptionist-ownership-read-model.ts";

// The R46 claim spine + R50 release spine — both remain authoritative; the engine names neither writer.
const CLAIM_RUNTIME = "server/services/receptionist-claim.ts";
const RELEASE_RUNTIME = "server/services/receptionist-release.ts";
// The R47 claim surface reader — the OTHER legitimate reader of the claims ledger (the claim affordance, out of R51
// scope). The engine joins it as the SECOND claims-ledger reader; the R48 reader drops out.
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The two append-only ledger tables — the ownership event stream. */
const CLAIMS_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;

/** The two ledgers' write primitives — the engine names neither (it reads the stream, it never writes it). */
const CLAIM_WRITE_FN = /\brecord_receptionist_conversation_claim\b/;
const RELEASE_WRITE_FN = /\brecord_receptionist_conversation_claim_release\b/;

/** The R46 / R50 runtime entry points + resolvers — a state file records and re-resolves neither. */
const CLAIM_ENTRY = /\bclaimConversationWork\b/;
const CLAIM_ENTRY_DEF = /export async function claimConversationWork\(/;
const RELEASE_ENTRY = /\breleaseConversationWork\b/;
const RELEASE_ENTRY_DEF = /export async function releaseConversationWork\(/;
const RESOLVE_CLAIM = /\bresolveClaim\b/;
const RESOLVE_RELEASE = /\bresolveRelease\b/;

/** The engine's derivation surface — the single fold + the per-/multi-coordination projections, each defined once. */
const DERIVE_DEF = /export function deriveOwnershipState\(/;
const RECONCILE_DEF = /export function reconcileOwnershipStates\(/;
const PROJECT_STATE_DEF = /export function projectOwnershipState\(/;

/** The engine's runtime seams — the org-scoped per-coordination + org-wide state reads. */
const COORD_STATE_READ = /export async function getCoordinationOwnershipState\(/;
const LIST_STATES_READ = /export async function listCoordinationOwnershipStates\(/;

/** The R36 coordinations base table — the engine derives none (it reads only the two ownership ledgers). */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers of EVERY sibling engine) — the state
 *  engine names none of them; it DERIVES state and performs nothing. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveRelease|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R51 explicit non-goals as SOURCE tokens — the engine derives ownership STATE; it grants no affordance and moves
 * work to no one. `claim` and `release` are DELIBERATELY ABSENT: they are the two capabilities the engine derives over
 * (a claim event, a release event), not non-goals. `email` is absent too — the events carry an `operator_email`
 * attribution, which is not the email CHANNEL non-goal.
 */
const NON_GOAL_TOKENS = [
  /\breassign\w*/i, // reassignment
  /\bassign\w*/i, // automatic assignment
  /\bdispatch\w*/i, // work dispatch
  /\bnotif\w*/i, // user notification
  /\bschedul\w*/i, // scheduling
  /\bfulfil\w*/i, // quote fulfilment
  /\bpromot\w*/i, // customer promotion
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no engine module may name (the engine reads the stream; it never writes it). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The engine ships — the pure core and the server runtime, with their entry points.
// =====================================================================

describe("receptionist ownership state engine — the engine ships", () => {
  it("ships the pure derivation core and the server state runtime", () => {
    for (const f of ENGINE_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the derivation, the predicates, the owned projection and the record folds", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(code).toMatch(DERIVE_DEF);
    expect(code).toMatch(/export function isUnclaimed\(/);
    expect(code).toMatch(/export function isClaimed\(/);
    expect(code).toMatch(/export function isReleased\(/);
    expect(code).toMatch(/export function isOwnedState\(/);
    expect(code).toMatch(PROJECT_STATE_DEF);
    expect(code).toMatch(RECONCILE_DEF);
    expect(code).toMatch(/export const OWNERSHIP_LIFECYCLE/);
  });

  it("the runtime exports the two org-scoped state seams — per-coordination and org-wide", () => {
    const code = codeOf(read(ENGINE_RUNTIME));
    expect(code).toMatch(COORD_STATE_READ);
    expect(code).toMatch(LIST_STATES_READ);
  });
});

// =====================================================================
// 1. THE ENGINE IS AUTHORITATIVE — the derivation lives here and nowhere else; the runtime is the event-stream reader.
// =====================================================================

describe("receptionist ownership state engine — the engine is the single authoritative source of ownership state", () => {
  const deriveDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => DERIVE_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const reconcileDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RECONCILE_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const projectStateDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => PROJECT_STATE_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  const claimTableReaders = walkSources(SOURCE_ROOTS)
    .filter((full) => fromTargets(codeOf(read(rel(full)))).includes("receptionist_conversation_claims"))
    .map(rel)
    .sort();
  const releaseTableReaders = walkSources(SOURCE_ROOTS)
    .filter((full) =>
      fromTargets(codeOf(read(rel(full)))).includes("receptionist_conversation_claim_releases"),
    )
    .map(rel)
    .sort();

  it("the derivation deriveOwnershipState is DEFINED in exactly one module — the engine core", () => {
    // The single canonical fold. If this list ever grows, a consumer has started re-deriving ownership independently.
    expect(deriveDefiners).toEqual([ENGINE_CORE]);
  });

  it("the record folds reconcileOwnershipStates + projectOwnershipState are DEFINED in exactly the engine core", () => {
    expect(reconcileDefiners).toEqual([ENGINE_CORE]);
    expect(projectStateDefiners).toEqual([ENGINE_CORE]);
  });

  it("the runtime's .from(...) targets are EXACTLY the two append-only ownership ledgers — it derives no coordination", () => {
    const code = codeOf(read(ENGINE_RUNTIME));
    expect(code).not.toMatch(COORDINATIONS_TABLE);
    expect([...new Set(fromTargets(code))]).toEqual([
      "receptionist_conversation_claims",
      "receptionist_conversation_claim_releases",
    ]);
  });

  it("the RELEASE ledger is READ through exactly ONE seam — the engine runtime", () => {
    // The R50 runtime WRITES the release ledger through its RPC (it never `.from(...)`s it); since R51 the R48 reader
    // reads state THROUGH the engine, so the engine runtime is the SOLE `.from(...)` reader of the release ledger.
    expect(releaseTableReaders).toEqual([ENGINE_RUNTIME]);
  });

  it("the CLAIMS ledger is READ through exactly TWO seams — the engine runtime and the R47 claim affordance", () => {
    // The R48 read model no longer reads the claims ledger (it consumes the engine); the two remaining `.from(...)`
    // readers are the engine (for state) and the R47 surface reader (for the viewer-relative claim affordance).
    expect(claimTableReaders).toEqual([CLAIM_READER, ENGINE_RUNTIME].sort());
  });
});

// =====================================================================
// 2. THE CLAIM RUNTIME REMAINS AUTHORITATIVE — R51 adds no writer; the engine records + re-resolves no claim.
// =====================================================================

describe("receptionist ownership state engine — the Claim runtime remains authoritative", () => {
  const claimWriters = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const claimEntryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the claim write primitive is STILL named by exactly the R46 runtime", () => {
    // `record_receptionist_conversation_claim_release` does NOT match `\brecord_receptionist_conversation_claim\b`, so
    // the R50 runtime is provably absent — this stays the R46 runtime alone.
    expect(claimWriters).toEqual([CLAIM_RUNTIME]);
  });

  it("claimConversationWork is DEFINED in exactly one module — the R46 runtime", () => {
    expect(claimEntryDefiners).toEqual([CLAIM_RUNTIME]);
  });

  it("neither engine file records or re-resolves a CLAIM", () => {
    for (const f of ENGINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name the claim write primitive`).not.toMatch(CLAIM_WRITE_FN);
      expect(code, `${f} must not name the claim runtime entry`).not.toMatch(CLAIM_ENTRY);
      expect(code, `${f} must not re-resolve a claim`).not.toMatch(RESOLVE_CLAIM);
    }
  });
});

// =====================================================================
// 3. THE RELEASE RUNTIME REMAINS AUTHORITATIVE — the engine records + re-resolves no release.
// =====================================================================

describe("receptionist ownership state engine — the Release runtime remains authoritative", () => {
  const releaseWriters = walkSources(SOURCE_ROOTS)
    .filter((full) => RELEASE_WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
  const releaseEntryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RELEASE_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the release write primitive is STILL named by exactly the R50 runtime", () => {
    expect(releaseWriters).toEqual([RELEASE_RUNTIME]);
  });

  it("releaseConversationWork is DEFINED in exactly one module — the R50 runtime", () => {
    expect(releaseEntryDefiners).toEqual([RELEASE_RUNTIME]);
  });

  it("neither engine file records or re-resolves a RELEASE", () => {
    for (const f of ENGINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name the release write primitive`).not.toMatch(RELEASE_WRITE_FN);
      expect(code, `${f} must not name the release runtime entry`).not.toMatch(RELEASE_ENTRY);
      expect(code, `${f} must not re-resolve a release`).not.toMatch(RESOLVE_RELEASE);
    }
  });

  it("neither engine file names ANY conversation write primitive — it reads the stream, it never writes it", () => {
    for (const f of ENGINE_FILES) {
      expect(codeOf(read(f)).match(/record_receptionist_conversation_\w+/g), f).toBeNull();
    }
  });
});

// =====================================================================
// 4. THE OWNERSHIP READ MODEL CONSUMES ONLY THE ENGINE — the R48 reader reads state THROUGH the engine, no ledger.
// =====================================================================

describe("receptionist ownership state engine — the Ownership Read Model consumes only the engine", () => {
  it("the R48 read model spine ships (the consumer that reads ownership THROUGH the engine)", () => {
    expect(existsSync(resolve(ROOT, OWNERSHIP_CORE)), OWNERSHIP_CORE).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_READER)), OWNERSHIP_READER).toBe(true);
  });

  it("the R48 reader IMPORTS the engine's state runtime — it reads state through the engine's seams", () => {
    const specs = importSpecifiers(codeOf(read(OWNERSHIP_READER)));
    expect(specs).toContain("@/server/services/receptionist-ownership-state");
  });

  it("the R48 reader reads NO ledger of its own — it names neither ledger, issues no .from(...), opens no client", () => {
    const code = codeOf(read(OWNERSHIP_READER));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIMS_LEDGER);
    expect(code).not.toMatch(RELEASES_LEDGER);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("the R48 read-model core DELEGATES derivation to the engine — it imports the engine core, defines no fold", () => {
    const code = codeOf(read(OWNERSHIP_CORE));
    expect(importSpecifiers(code)).toContain("./conversation-ownership-state");
    // It consumes the engine's derivation; it does not define its own.
    expect(code).not.toMatch(DERIVE_DEF);
    expect(code).not.toMatch(RECONCILE_DEF);
  });
});

// =====================================================================
// 5. ORGANISATION ISOLATION — every read the runtime performs is org-scoped; the filter can never be skipped.
// =====================================================================

describe("receptionist ownership state engine — organisation isolation is preserved", () => {
  it("every read the runtime performs is org-scoped — the org_id filter count equals the select count", () => {
    const code = codeOf(read(ENGINE_RUNTIME));
    const selects = (code.match(/\.select\(/g) ?? []).length;
    const orgFilters = (code.match(/\.eq\(\s*["']org_id["']/g) ?? []).length;
    expect(selects).toBeGreaterThan(0);
    expect(orgFilters).toBe(selects);
  });

  it("the per-coordination read is BOTH org- and coordination-scoped", () => {
    const code = codeOf(read(ENGINE_RUNTIME));
    expect(code).toMatch(/\.eq\(\s*["']org_id["']/);
    expect(code).toMatch(/\.eq\(\s*["']coordination_id["']/);
  });
});

// =====================================================================
// 6. THE AUDIT STAYS APPEND-ONLY — the reads are read-only; the engine adds no table and no writer.
// =====================================================================

describe("receptionist ownership state engine — the append-only audit is preserved", () => {
  it("the runtime performs ONLY SELECTs — no insert/update/delete/upsert, no write primitive, no RPC", () => {
    const code = codeOf(read(ENGINE_RUNTIME));
    expect(code).toMatch(/\.select\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(code).not.toMatch(CLAIM_WRITE_FN);
    expect(code).not.toMatch(RELEASE_WRITE_FN);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("the engine adds NO writer — no engine file directly mutates a ledger (it reads the existing stream)", () => {
    for (const f of ENGINE_FILES) {
      expect(codeOf(read(f)), `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
    }
  });
});

// =====================================================================
// 7. NO EXECUTION PATH IS INTRODUCED — the engine states WHERE a coordination sits in the lifecycle; it acts on nothing.
// =====================================================================

describe("receptionist ownership state engine — no execution path is introduced", () => {
  it("neither engine file names any engine EXECUTION function", () => {
    for (const f of ENGINE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("neither engine file names any OTHER engine writer", () => {
    for (const f of ENGINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("neither engine file names an R51 non-goal token (assign/reassign/dispatch/…/close)", () => {
    for (const f of ENGINE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("neither engine file reaches a transport / calendar / quote / channel / generation path", () => {
    for (const f of ENGINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/\bvoice\b/i);
      expect(code, `${f}`).not.toMatch(/whatsapp/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });
});

// =====================================================================
// 8. THE MODULE BOUNDARIES HOLD — server-only runtime; shared, dependency-free, deterministic pure core.
// =====================================================================

describe("receptionist ownership state engine — the module boundaries hold", () => {
  it("the runtime is server-only — it is the ONE place the event stream is read for ownership state", () => {
    expect(importSpecifiers(codeOf(read(ENGINE_RUNTIME)))).toContain("server-only");
  });

  it("the pure core is a shared, dependency-free module (NOT server-only) — it imports NOTHING", () => {
    const specs = importSpecifiers(codeOf(read(ENGINE_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual([]);
  });

  it("the pure core names no table at all — it consumes events, not a database", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIMS_LEDGER);
    expect(code).not.toMatch(RELEASES_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });
});

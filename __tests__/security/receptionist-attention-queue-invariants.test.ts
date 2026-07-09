import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION ATTENTION QUEUE governance invariants
 * (the AI Receptionist Programme, R58 — CONVERSATION ATTENTION QUEUE).
 *
 * R38 shipped the Coordination WORKLIST ENGINE (it DERIVES the actionable worklists + the prioritised backlog from the
 * R37 Read Model), and R39 the WORKLIST READ SURFACE (the single authorised query a future capability reads a worklist
 * page from — its doc names "a queue" as the consumer it anticipates). R48/R51/R53 shipped the OWNERSHIP READ MODEL (the
 * authoritative "who owns this coordination now?"). R58 is the ATTENTION QUEUE — the authorised, read-only view that
 * JOINS those two authoritative reads: it takes the actionable, already-prioritised worklist entries (through R39) and
 * each entry's ownership (through R48), and GROUPS them by ownership — unowned first (waiting to be picked up), owned
 * next (in progress) — preserving the R38 canonical order within each group. It is a pure JOIN/GROUP CORE plus a
 * read-only server RUNTIME that composes the two seams for one organisation.
 *
 * Its law is exact: "the queue CONSUMES only existing authoritative conversation engines (R39's worklist page and R48's
 * ownership record) and NOTHING BELOW them; it DERIVES NO CONVERSATION STATE INDEPENDENTLY; the Lifecycle, Resolution,
 * Coordination, Human-Required and Ownership State engines each remain authoritative; organisation isolation is
 * preserved; the audit remains append-only; and NO execution path is introduced." This suite proves that contract as a
 * matter of SOURCE, not discipline — the house bar of the R30→R57 invariant suites:
 *
 *   • THE QUEUE SHIPS — the pure core exports the group vocabulary + the projection; the runtime exports the org-scoped
 *     entry point.
 *   • IT DERIVES NO CONVERSATION STATE — neither file names ANY worklist derivation (the R38 engine's `deriveWorklists`
 *     / `orderWorklistEntries` / … or its reader `getCoordinationWorklists`), ANY ownership-derivation fold (the engine's
 *     `deriveOwnershipState` / … or the read model's `projectOwnership` / …), ANY engine execution runtime or resolver,
 *     any canonical write runtime or any write primitive. The core imports only the R38 + R48 cores' TYPES, so it CANNOT
 *     call a read or a derivation — provably a projection over already-read facts.
 *   • THE RUNTIME READS ONLY THROUGH THE TWO AUTHORISED SEAMS — it imports EXACTLY the R39 read surface
 *     (`queryOrgWorklist`), the R48 ownership read model (`getOwnership`) and the pure core (plus `server-only`); it
 *     NAMES the R38 reader `getCoordinationWorklists` NOWHERE and `deriveWorklists` NOWHERE (so the Worklist Engine stays
 *     the SOLE derivation and R58 is provably not a read path around R39); and it reaches NO ledger, NO `.from(...)`, NO
 *     database client and issues NO RPC.
 *   • THE ENGINES STAY AUTHORITATIVE — R58 adds NO seam: `queryOrgWorklist` is DEFINED exactly once (the R39 runtime),
 *     `getOwnership` exactly once (the R48 runtime); the queue projection + the queue runtime are each DEFINED exactly
 *     once (this increment); and the R38 reader + derivation are named by NEITHER R58 file.
 *   • ORGANISATION ISOLATION IS PRESERVED — the runtime THREADS its single `org_id` into BOTH reads (into
 *     `queryOrgWorklist` AND into every `getOwnership`), and the pure core is ORG-AGNOSTIC (it names no org token), so
 *     the queue can only narrow to what the org-scoped seams feed it — isolation is the seams' concern, proven in the
 *     R39 + R48 suites.
 *   • THE AUDIT STAYS APPEND-ONLY — both files are read-only (no `.from`, no insert/update/delete/upsert, no write
 *     primitive, no RPC); and across ALL source the queue JOINS NO ledger-reader set — it reads no ownership ledger and
 *     no coordinations table, even transitively.
 *   • NO EXECUTION PATH IS INTRODUCED — neither file names any engine execution function, any other engine writer, any
 *     R58 non-goal token (assign / dispatch / notify / schedule / enqueue / retry / promote / complete / close) or any
 *     transport / calendar / quote / voice / WhatsApp / email / memory / generation path. It reads two views and shapes
 *     them; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the pure core is a shared, deterministic module (NOT server-only) over the two cores'
 *     TYPES, touching no I/O, no clock and no RNG; the runtime IS server-only, composing exactly the two seams + the core.
 *
 * The queue's projection behaviour is pinned exhaustively in __tests__/receptionist/conversation-attention-queue.test.ts,
 * and its runtime behaviour (the queue over real Postgres, reading back what the canonical runtimes recorded) in
 * __tests__/integration/receptionist/attention-queue-pipeline.test.ts. This tier is HERMETIC — a filesystem scan over
 * comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip a negative.
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

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The files across all source whose EXECUTABLE (comment-stripped) source matches a token. */
const namersOf = (re: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => re.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

/** The files across all source that IMPORT a given module specifier (in executable source). */
const importersOf = (specifier: string): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => importSpecifiers(codeOf(read(rel(full)))).includes(specifier))
    .map(rel)
    .sort();

/** The files across all source that NAME a given ledger table — the reader set the queue must not join. */
const readersOf = (ledger: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => ledger.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

// The R58 queue — the pure JOIN/GROUP CORE and the read-only, org-scoped server RUNTIME.
const QUEUE_CORE = "lib/receptionist/conversation-attention-queue.ts";
const QUEUE_RUNTIME = "server/services/receptionist-attention-queue.ts";

/** The R58 files whose EXECUTABLE source must name no derivation, no ledger, no writer and no execution path. */
const QUEUE_FILES = [QUEUE_CORE, QUEUE_RUNTIME] as const;

// The two seams BELOW the queue — the two authoritative reads the runtime composes. The R39 read surface folds the R38
// Worklist Engine (which folds the R37 Read Model); the R48 ownership read model folds the R51 State Engine and its
// ledgers. The queue touches NEITHER's internals directly.
const R39_RUNTIME = "server/services/receptionist-worklist-read-surface.ts";
const R48_RUNTIME = "server/services/receptionist-ownership-read-model.ts";

// The R38 engine BELOW R39 — its reader and its pure core. R58 names NEITHER: it reads the derived page through R39, so
// the Worklist Engine stays the SOLE derivation of worklists and R58 is provably not a read path around R39.
const R38_RUNTIME = "server/services/receptionist-coordination-worklist.ts";
const R38_CORE = "lib/receptionist/conversation-coordination-worklist.ts";

// Module specifiers.
const QUEUE_CORE_MODULE = "@/lib/receptionist/conversation-attention-queue";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";
const R48_RUNTIME_MODULE = "@/server/services/receptionist-ownership-read-model";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist"; // TYPE source of WorklistEntry
const R48_CORE_MODULE = "@/lib/receptionist/conversation-ownership-read-model"; // TYPE source of OwnershipRecord

/** The three append-only ownership ledgers + the R36 coordinations base table — the queue names none of them. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Any ledger WRITE primitive — the queue records nothing, so it names none. */
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The canonical ownership WRITE runtimes + their pure resolvers — the queue consumes NONE (it only presents state). */
const CANONICAL_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|reassignConversationWork|resolveClaim|resolveRelease|resolveReassignment)\b/;

/**
 * Every WORKLIST-DERIVATION fold — the R38 engine's derivation + ordering AND its reader. The queue DERIVES NO WORKLIST:
 * it consumes R39's already-derived, already-ordered page. NOTE `\bgetCoordinationWorklists\b` never matches the longer
 * `getCoordinationWorklistsForConversation` (no word boundary between the two), so both are listed explicitly.
 */
const WORKLIST_DERIVATION_FNS =
  /\b(?:deriveWorklists|orderWorklistEntries|compareWorklistEntries|deriveCoordinationPriority|belongsToWorklist|toWorklistEntry|getCoordinationWorklists|getCoordinationWorklistsForConversation)\b/;

/**
 * Every OWNERSHIP-DERIVATION fold — the R51 engine's state + current-owner derivation AND the R48 read model's ownership
 * projections. The queue DERIVES OWNERSHIP NOWHERE: it reads each entry's already-derived `OwnershipRecord`. NOTE
 * `\bprojectOwnership\b` never matches `projectOwnershipState`/`projectOwnershipEvent` (listed explicitly), and
 * `\bprojectOwner\b` never matches `projectOwnership` (a word boundary separates them). `getOwnership` — the R48 RUNTIME
 * seam the queue legitimately reads through — is NOT a derivation and is asserted PRESENT in the runtime below.
 */
const OWNERSHIP_DERIVATION_FNS =
  /\b(?:deriveOwnershipState|isOwnedState|isUnclaimed|isClaimed|isReleased|resolveCurrentOwner|latestReassignmentFor|projectOwnershipState|reconcileOwnershipStates|projectOwnership|projectOwnershipEvent|projectOwner|selectActiveClaims|summariseOwnership)\b/;

/** The two seam entry points + the two R58 entry points. */
const QUERY_ORG_WORKLIST_DEF = /export async function queryOrgWorklist\(/;
const GET_OWNERSHIP_DEF = /export async function getOwnership\(/;
const QUEUE_PROJECT_DEF = /export function projectAttentionQueue\(/;
const QUEUE_RUNTIME_DEF = /export async function getConversationAttentionQueue\(/;

/**
 * Every engine EXECUTION function (deriving/performing runtimes + resolvers across lifecycle / resolution / recovery /
 * verification / fulfilment / orchestration / coordination) — the queue names none of them: it reads two composed views,
 * it re-decides nothing.
 */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R58 explicit non-goals as SOURCE tokens — the queue presents state; it acts on nothing. NOTE `\bassign\w*` NEVER
 * matches "reassign"/"reassigned"/"reassignment" (no word boundary between "re" and "assign"), so the ownership model's
 * genuine reassignment vocabulary is not a false positive; `\bclos(?:e|ing|ed|ure)\b` and `\bcomplet\w*` match no
 * executable token in either R58 file (the queue names neither a closed lifecycle nor completion in its source).
 */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // automatic assignment (NEVER matches "reassign")
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work / business completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no queue module may name (the ledgers are written ONLY through the canonical runtimes). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The queue ships, with its group vocabulary and its two entry points.
// =====================================================================

describe("receptionist attention queue — the queue ships", () => {
  it("ships the pure core and the server runtime", () => {
    for (const f of QUEUE_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the group vocabulary and the projection", () => {
    const code = codeOf(read(QUEUE_CORE));
    expect(code).toMatch(/export const ATTENTION_GROUPS\s*=/);
    expect(code).toMatch(QUEUE_PROJECT_DEF);
  });

  it("the server runtime exports the org-scoped entry point", () => {
    expect(codeOf(read(QUEUE_RUNTIME))).toMatch(QUEUE_RUNTIME_DEF);
  });
});

// =====================================================================
// 1. IT DERIVES NO CONVERSATION STATE — every fact is read from one of the two views; no fold, no runtime, no writer.
// =====================================================================

describe("receptionist attention queue — it derives no conversation state independently", () => {
  it("neither file names ANY worklist-derivation fold or the R38 reader (it consumes R39's derived page)", () => {
    for (const f of QUEUE_FILES) {
      expect(codeOf(read(f)), `${f} must name no worklist-derivation fold`).not.toMatch(
        WORKLIST_DERIVATION_FNS,
      );
    }
  });

  it("neither file names ANY ownership-derivation fold (engine or read model)", () => {
    for (const f of QUEUE_FILES) {
      expect(codeOf(read(f)), `${f} must name no ownership-derivation fold`).not.toMatch(
        OWNERSHIP_DERIVATION_FNS,
      );
    }
  });

  it("neither file names ANY engine execution/derivation runtime or resolver", () => {
    for (const f of QUEUE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution/derivation fn`).not.toMatch(
        ENGINE_EXECUTION_FNS,
      );
    }
  });

  it("neither re-derives or records a claim/release/reassignment (no runtime, no resolver, no writer)", () => {
    for (const f of QUEUE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name a canonical write runtime or resolver`).not.toMatch(
        CANONICAL_WRITE_RUNTIMES,
      );
      expect(code, `${f} must not name a ledger write primitive`).not.toMatch(WRITE_PRIMITIVE);
    }
  });

  it("the pure core names no I/O — it consumes two composed views, not a database", () => {
    const code = codeOf(read(QUEUE_CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
    // The core NAMES NEITHER seam — it receives already-composed inputs.
    expect(code, "core must not name the R39 worklist seam").not.toMatch(/\bqueryOrgWorklist\b/);
    expect(code, "core must not name the R48 ownership seam").not.toMatch(/\bgetOwnership\b/);
  });
});

// =====================================================================
// 2. THE RUNTIME READS ONLY THROUGH THE TWO AUTHORISED SEAMS — R39 + R48, never the R38 reader, never a ledger.
// =====================================================================

describe("receptionist attention queue — the runtime reads only through the two authorised seams", () => {
  it("the runtime imports EXACTLY the R39 seam, the R48 seam, the pure core and server-only", () => {
    const specs = importSpecifiers(codeOf(read(QUEUE_RUNTIME)));
    expect([...specs].sort()).toEqual(
      [R39_RUNTIME_MODULE, R48_RUNTIME_MODULE, QUEUE_CORE_MODULE, "server-only"].sort(),
    );
  });

  it("the runtime READS THROUGH R39 and R48 — it names both seam functions", () => {
    const code = codeOf(read(QUEUE_RUNTIME));
    expect(code, "runtime reads the worklist through R39").toMatch(/\bqueryOrgWorklist\b/);
    expect(code, "runtime reads ownership through R48").toMatch(/\bgetOwnership\b/);
  });

  it("the runtime NAMES the R38 reader NOWHERE — it does not read around R39", () => {
    const code = codeOf(read(QUEUE_RUNTIME));
    expect(code, "must not name the R38 reader").not.toMatch(/\bgetCoordinationWorklists\b/);
    expect(code, "must not name the R38 derivation").not.toMatch(/\bderiveWorklists\b/);
    // It imports neither the R38 reader runtime nor the R38 core.
    const specs = importSpecifiers(code);
    expect(specs).not.toContain("@/server/services/receptionist-coordination-worklist");
    expect(specs).not.toContain(R38_CORE_MODULE);
  });

  it("the runtime reaches no ledger, no coordinations table, no client and no .from(...)", () => {
    const code = codeOf(read(QUEUE_RUNTIME));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(RELEASES_LEDGER);
    expect(code).not.toMatch(REASSIGNMENTS_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });

  it("R58 is a NEW authorised consumer of the R39 read surface — the queue runtime imports it", () => {
    // R39's doc anticipates "a queue" as its consumer; R58 IS that queue. The full consumer set is pinned by the R39
    // worklist-surface suites; here we assert the queue runtime is among them.
    expect(importersOf(R39_RUNTIME_MODULE)).toContain(QUEUE_RUNTIME);
    expect(importersOf(R48_RUNTIME_MODULE)).toContain(QUEUE_RUNTIME);
  });
});

// =====================================================================
// 3. THE ENGINES STAY AUTHORITATIVE — R58 adds no seam; each seam is defined once; the R38 engine is named nowhere.
// =====================================================================

describe("receptionist attention queue — the read authorities remain authoritative", () => {
  it("queryOrgWorklist is DEFINED in exactly one module — the R39 read surface (R58 adds no worklist seam)", () => {
    expect(namersOf(QUERY_ORG_WORKLIST_DEF)).toEqual([R39_RUNTIME]);
  });

  it("getOwnership is DEFINED in exactly one module — the R48 read model (R58 adds no ownership seam)", () => {
    expect(namersOf(GET_OWNERSHIP_DEF)).toEqual([R48_RUNTIME]);
  });

  it("the queue projection is DEFINED in exactly one module — this pure core", () => {
    expect(namersOf(QUEUE_PROJECT_DEF)).toEqual([QUEUE_CORE]);
  });

  it("the queue runtime is DEFINED in exactly one module — this server runtime", () => {
    expect(namersOf(QUEUE_RUNTIME_DEF)).toEqual([QUEUE_RUNTIME]);
  });

  it("neither R58 file appears in the R38 worklist engine's namer set — the engine stays the sole derivation", () => {
    const reader = namersOf(/\bgetCoordinationWorklists\b/);
    const derive = namersOf(/\bderiveWorklists\b/);
    for (const f of QUEUE_FILES) {
      expect(reader, `${f} must not name the R38 reader`).not.toContain(f);
      expect(derive, `${f} must not name the R38 derivation`).not.toContain(f);
    }
    // The engine is still owned where it always was — its reader in the R38 runtime, its derivation in the R38 core.
    expect(reader).toContain(R38_RUNTIME);
    expect(derive).toContain(R38_CORE);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — the runtime threads org into BOTH reads; the pure core is org-agnostic.
// =====================================================================

describe("receptionist attention queue — organisation isolation is preserved", () => {
  it("the runtime threads its single org_id into BOTH seam reads", () => {
    const code = codeOf(read(QUEUE_RUNTIME));
    // The worklist read is org-scoped through R39…
    expect(code).toMatch(/queryOrgWorklist\(\{[\s\S]*?org_id:\s*input\.org_id[\s\S]*?\}\)/);
    // …and every ownership read is org-scoped through R48 with the SAME org.
    expect(code).toMatch(/getOwnership\(\{\s*org_id:\s*input\.org_id,\s*coordination_id:[\s\S]*?\}\)/);
  });

  it("the pure core is ORG-AGNOSTIC — it names no org token, so it cannot widen the scope the seams fixed", () => {
    // Isolation is the seams' concern (proven in the R39 + R48 suites): both reads the runtime performs are org-scoped.
    // The core projects only the entries + ownership records it is handed, so it names no organisation at all.
    const code = codeOf(read(QUEUE_CORE));
    expect(code, "core must name no org_id").not.toMatch(/\borg_id\b/);
    expect(code, "core must name no ctx.org").not.toMatch(/ctx\.org/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the queue is read-only; it joins no ledger-reader set.
// =====================================================================

describe("receptionist attention queue — the append-only audit is preserved", () => {
  it("both files are read-only — no .from, no insert/update/delete/upsert, no write primitive, no RPC", () => {
    for (const f of QUEUE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/\.from\(/);
      expect(code, `${f}`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f}`).not.toMatch(WRITE_PRIMITIVE);
      expect(code, `${f}`).not.toMatch(/\.rpc\(/);
    }
  });

  it("the queue JOINS NO ledger-reader set — it reads no ownership ledger, even transitively", () => {
    for (const ledger of [CLAIM_LEDGER, RELEASES_LEDGER, REASSIGNMENTS_LEDGER, COORDINATIONS_TABLE]) {
      const readers = readersOf(ledger);
      expect(readers, "queue core must read no ledger table").not.toContain(QUEUE_CORE);
      expect(readers, "queue runtime must read no ledger table").not.toContain(QUEUE_RUNTIME);
    }
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the queue reads two views and shapes them; it acts on nothing.
// =====================================================================

describe("receptionist attention queue — no execution path is introduced", () => {
  it("no queue file names any engine EXECUTION function", () => {
    for (const f of QUEUE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no queue file names any OTHER engine writer", () => {
    for (const f of QUEUE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no queue file names an R58 non-goal token (assign/dispatch/notify/schedule/…/close)", () => {
    for (const f of QUEUE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no queue file reaches a transport / calendar / quote / voice / whatsapp / email / memory / generation path", () => {
    for (const f of QUEUE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/\bvoice\b/i);
      expect(code, `${f}`).not.toMatch(/whatsapp/i);
      expect(code, `${f}`).not.toMatch(/\bemail\b/i);
      expect(code, `${f}`).not.toMatch(/\bmemory\b/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });
});

// =====================================================================
// 7. THE MODULE BOUNDARIES HOLD — shared deterministic core over TYPES; a server-only runtime over the two seams.
// =====================================================================

describe("receptionist attention queue — the module boundaries hold", () => {
  it("the pure core is a shared module (NOT server-only) importing ONLY the R38 + R48 cores' modules", () => {
    const specs = importSpecifiers(codeOf(read(QUEUE_CORE)));
    expect(specs).not.toContain("server-only");
    expect([...specs].sort()).toEqual([R38_CORE_MODULE, R48_CORE_MODULE].sort());
  });

  it("the core imports BOTH modules as TYPE-ONLY — it CANNOT call a read or a derivation, so it derives nothing", () => {
    const code = codeOf(read(QUEUE_CORE));
    expect(code).toMatch(/import type \{[\s\S]*?\} from "@\/lib\/receptionist\/conversation-coordination-worklist"/);
    expect(code).toMatch(/import type \{[\s\S]*?\} from "@\/lib\/receptionist\/conversation-ownership-read-model"/);
    // No @/server import at all — the core sits above both runtimes.
    expect(code.includes("@/server/")).toBe(false);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(QUEUE_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("the runtime IS server-only and is the SOLE importer of the pure core (no UI consumes it)", () => {
    expect(importSpecifiers(codeOf(read(QUEUE_RUNTIME)))).toContain("server-only");
    expect(importersOf(QUEUE_CORE_MODULE)).toEqual([QUEUE_RUNTIME]);
  });
});

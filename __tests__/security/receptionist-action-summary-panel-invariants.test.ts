import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION ACTION SUMMARY PANEL governance invariants
 * (the AI Receptionist Programme, R57 — CONVERSATION ACTION SUMMARY PANEL).
 *
 * The Conversation Detail experience answers many questions across many surfaces: R45's detail view spells out the recorded
 * coordination decision in full; R47's Claim Panel offers the single write affordance; R56's Ownership Timeline Panel narrates
 * who has held the conversation. R57 adds the surface's canonical AT-A-GLANCE READ: the CONVERSATION ACTION SUMMARY PANEL — a
 * single, compact, read-only digest of WHERE this coordinated conversation stands right now (its current lifecycle, resolution,
 * coordination mode, human-required status, current owner and ownership-history summary), so an operator sees the state without
 * reading every panel below it. It is a pure presentation CORE that re-shapes TWO already-composed authoritative views into a
 * display model, plus a read-only server COMPONENT that paints it, wired into the detail page above the R47 claim panel.
 *
 * Its law is exact: "the panel CONSUMES only two existing authoritative seams — the R37 Coordination Read Model's record
 * (transitively, through the page) and the R55 Ownership Timeline view — and NOTHING BELOW them; it DERIVES NO CONVERSATION
 * STATE INDEPENDENTLY; the Lifecycle Engine, the Resolution Engine, the Coordination Engine and the Ownership State Engine each
 * remain authoritative; organisation isolation is preserved; the audit remains append-only; and NO execution path is
 * introduced." This suite proves that contract as a matter of SOURCE, not discipline — the house bar of the R30→R56 invariant
 * suites:
 *
 *   • THE PANEL SHIPS — the pure core exports the summary projection; the server component exports the panel; and the
 *     Conversation Detail page projects the summary view (from the two views it already read) and renders the component.
 *   • IT DERIVES NO CONVERSATION STATE — neither the core nor the component names ANY ownership-derivation fold (the engine's
 *     `deriveOwnershipState` / `resolveCurrentOwner` / … or the read model's `projectOwnership` / `selectActiveClaims`), ANY
 *     engine execution/derivation runtime or resolver (lifecycle / resolution / coordination / …), any canonical write runtime
 *     or any write primitive. Every fact is COPIED from one of the two views: the lifecycle, resolution, mode and human-required
 *     flag from the R37 record; the current owner + history from the R55 view. The core imports only the two views' TYPES, so it
 *     CANNOT call a read or a derivation — provably a projection over already-read facts, a second reader of nothing.
 *   • BOTH AUTHORITIES STAY AUTHORITATIVE — R57 adds NO seam: `getCoordinationById` is DEFINED exactly once (the R37 reader) and
 *     `getOwnershipTimeline` exactly once (the R55 runtime); each is NAMED only where defined and where consumed; and the
 *     summary projection is DEFINED exactly once (this core). The panel NAMES neither seam — it receives two composed views.
 *   • IT CONSUMES ONLY THE TWO VIEWS — the core imports ONLY the R37 + R55 cores' TYPES; the component imports ONLY the core's
 *     TYPES; neither reaches a ledger, the coordinations table, a `.from(...)`, a database client or ANY `@/server` module. The
 *     panel sits ABOVE both runtimes and reads only what they already composed.
 *   • ORGANISATION ISOLATION IS PRESERVED — the page THREADS the caller's `org_id` (and the coordination id) into BOTH seam
 *     reads, and projects the summary from the two ALREADY-READ views; the panel layer is ORG-AGNOSTIC (it names no org token),
 *     so it cannot widen a scope the runtimes already fixed. Isolation is the runtimes' concern, proven in the R37 + R55 suites;
 *     the panel can only narrow to what it is fed.
 *   • THE AUDIT STAYS APPEND-ONLY — the core + component are read-only (no `.from`, no insert/update/delete/upsert, no write
 *     primitive, no RPC); and across ALL source the panel JOINS NO ledger-reader set — the claims ledger is STILL read through
 *     exactly the two pre-R55 seams, so R57 added no reader.
 *   • NO EXECUTION PATH IS INTRODUCED — neither file names any engine execution function, any other engine writer, any R57
 *     non-goal token (assign / dispatch / notify / schedule / … / close) or any transport / calendar / quote / voice / WhatsApp
 *     / email / memory / generation path. "transfer" is the READ history the panel narrates (the view's `reassigned` flag), not
 *     a non-goal. It paints pixels; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the pure core is a shared, deterministic module (NOT server-only) over the two views' TYPES,
 *     touching no I/O, no clock and no RNG; the component is a PRESENTATIONAL server component — NOT a client component,
 *     declaring no server action, holding no state and offering no affordance (`use client` / `use server` / `onClick` /
 *     `useState` / `useTransition` / `<button` / `<form` all absent).
 *
 * The panel's projection behaviour is pinned exhaustively in __tests__/receptionist/conversation-action-summary-panel.test.ts,
 * and its runtime behaviour (panel over real Postgres, reading back what the canonical runtimes recorded) in
 * __tests__/integration/receptionist/action-summary-panel-pipeline.test.ts. This tier is HERMETIC — a filesystem scan over
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
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

/** The files across all source that NAME a given ledger table — the reader set the panel must not join. */
const readersOf = (ledger: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => ledger.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

// The R57 panel — the pure presentation CORE (projection + humanise + instant formatter) and the read-only server COMPONENT.
const SUMMARY_CORE = "lib/receptionist/conversation-action-summary-panel.ts";
const SUMMARY_COMPONENT = "app/admin/ai-receptionist/worklist/[coordinationId]/action-summary-panel.tsx";

/** The R57 files whose EXECUTABLE source must name no seam, no ledger, no writer and no execution path. */
const SUMMARY_FILES = [SUMMARY_CORE, SUMMARY_COMPONENT] as const;

// The Conversation Detail surface — the ONE page that reads BOTH seams and renders the R57 panel.
const PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/page.tsx";

// The R54 reassignment surface — the OTHER page that reads the R37 coordination seam (existence + isolation). R57 adds no
// namer to it: the summary reuses the record the detail page already read, opening no new coordination read.
const REASSIGN_PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/reassign/page.tsx";

// The two seams BELOW the panel — the two authoritative reads the page performs, whose already-composed views the panel
// consumes. The R37 Coordination Read Model's single-item seam folds the R36 Coordination Engine (and Lifecycle / Resolution /
// Recovery / Verification / Fulfilment / Orchestration); the R55 Ownership Timeline Runtime folds the R48/R53 Read Model and the
// R51 State Engine. The panel touches NEITHER's internals directly.
const R37_READER = "server/services/receptionist-coordination-view.ts";
const TIMELINE_RUNTIME = "server/services/receptionist-ownership-timeline.ts";

// Deeper authorities the panel reaches through NEITHER seam directly: the R51 State Engine (sole reader of the three ledgers,
// folded inside the timeline runtime) and the R47 surface reader (the other pre-existing claims-ledger reader).
const STATE_ENGINE = "server/services/receptionist-ownership-state.ts";
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

// Module specifiers.
const SUMMARY_CORE_MODULE = "@/lib/receptionist/conversation-action-summary-panel";
const SUMMARY_COMPONENT_MODULE = "./action-summary-panel";
const COORD_CORE_RELATIVE = "./conversation-coordination-view"; // R37 core — the TYPE source of CoordinationRecord
const TIMELINE_CORE_RELATIVE = "./conversation-ownership-timeline"; // R55 core — the TYPE source of OwnershipTimelineView

/** The three append-only ownership ledgers + the R36 coordinations base table — the panel names none of them. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Any ledger WRITE primitive — the panel records nothing, so it names none. */
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The canonical ownership WRITE runtimes + their pure resolvers — the panel consumes NONE (it only presents state). */
const CANONICAL_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|reassignConversationWork|resolveClaim|resolveRelease|resolveReassignment)\b/;

/**
 * Every OWNERSHIP-DERIVATION fold — the engine's state + current-owner derivation AND the read model's ownership projections.
 * The panel DERIVES OWNERSHIP NOWHERE: it copies the R55 view's already-derived header. NOTE `\bprojectOwnership\b` never
 * matches the core's OWN helper `projectOwnershipSummary` (no word boundary between "projectOwnership" and "Summary"), so the
 * summary's own projection is not a false positive.
 */
const OWNERSHIP_DERIVATION_FNS =
  /\b(?:deriveOwnershipState|isOwnedState|isUnclaimed|isClaimed|isReleased|resolveCurrentOwner|latestReassignmentFor|projectOwnershipState|reconcileOwnershipStates|projectOwnership|projectOwnershipEvent|selectActiveClaims|summariseOwnership)\b/;

/** The R37 coordination seam + the R55 timeline seam + the R57 summary entry points. */
const COORD_READ_DEF = /export async function getCoordinationById\(/;
const TIMELINE_READ_DEF = /export async function getOwnershipTimeline\(/;
const SUMMARY_PROJECT_DEF = /export function projectConversationActionSummary\(/;
const SUMMARY_COMPONENT_DEF = /export function ConversationActionSummaryPanel\(/;

/**
 * Every engine EXECUTION function (deriving/performing runtimes + resolvers across lifecycle / resolution / recovery /
 * verification / fulfilment / orchestration / coordination) — the panel names none of them: it COPIES the recorded lifecycle,
 * resolution, mode and human-required flag from the R37 record, it re-decides nothing.
 */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R57 explicit non-goals as SOURCE tokens — the panel presents state; it acts on nothing. NOTE `\bassign\w*` NEVER matches
 * "reassign"/"reassigned"/"reassignment" (no word boundary between "re" and "assign"), so the view's genuine reassignment
 * vocabulary is not a false positive; and `\bclos(?:e|ing|ed|ure)\b` matches no executable token — the panel HUMANISES the
 * recorded lifecycle at runtime, its source names no literal "closed". "transfer" is the READ history it narrates, not a
 * non-goal, and is scanned nowhere here.
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
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing (executed — not the humanised lifecycle label)
] as const;

/** Direct-write / bypass tokens no panel module may name (the ledgers are written ONLY through the canonical runtimes). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The panel ships, with its single entry points and its page wiring.
// =====================================================================

describe("receptionist action summary panel — the panel ships", () => {
  it("ships the pure core and the server component", () => {
    for (const f of SUMMARY_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the summary projection", () => {
    expect(codeOf(read(SUMMARY_CORE))).toMatch(SUMMARY_PROJECT_DEF);
  });

  it("the server component exports the panel", () => {
    expect(codeOf(read(SUMMARY_COMPONENT))).toMatch(SUMMARY_COMPONENT_DEF);
  });

  it("the Conversation Detail page projects the summary view (from the two views it already read) and renders the component", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/projectConversationActionSummary\s*\(/);
    expect(code).toMatch(/<ConversationActionSummaryPanel\b/);
  });
});

// =====================================================================
// 1. IT DERIVES NO CONVERSATION STATE — every fact is copied from one of the two views; no fold, no runtime, no writer.
// =====================================================================

describe("receptionist action summary panel — it derives no conversation state independently", () => {
  it("neither the core nor the component names ANY ownership-derivation fold (engine or read model)", () => {
    for (const f of SUMMARY_FILES) {
      expect(codeOf(read(f)), `${f} must name no ownership-derivation fold`).not.toMatch(
        OWNERSHIP_DERIVATION_FNS,
      );
    }
  });

  it("neither the core nor the component names ANY engine execution/derivation runtime or resolver", () => {
    for (const f of SUMMARY_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution/derivation fn`).not.toMatch(
        ENGINE_EXECUTION_FNS,
      );
    }
  });

  it("neither re-derives or records a claim/release/reassignment (no runtime, no resolver, no writer)", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name a canonical write runtime or resolver`).not.toMatch(
        CANONICAL_WRITE_RUNTIMES,
      );
      expect(code, `${f} must not name a ledger write primitive`).not.toMatch(WRITE_PRIMITIVE);
    }
  });

  it("the pure core names no I/O — it consumes two composed views, not a database", () => {
    const code = codeOf(read(SUMMARY_CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
  });
});

// =====================================================================
// 2. BOTH AUTHORITIES STAY AUTHORITATIVE — R57 adds no seam; each seam is defined + consumed exactly where it was.
// =====================================================================

describe("receptionist action summary panel — the read authorities remain authoritative", () => {
  it("getCoordinationById is DEFINED in exactly one module — the R37 read model (R57 adds no coordination seam)", () => {
    expect(namersOf(COORD_READ_DEF)).toEqual([R37_READER]);
  });

  it("getOwnershipTimeline is DEFINED in exactly one module — the R55 runtime (R57 adds no ownership seam)", () => {
    expect(namersOf(TIMELINE_READ_DEF)).toEqual([TIMELINE_RUNTIME]);
  });

  it("the R37 coordination seam is NAMED only where defined + consumed — the reader, the detail page and the reassign page", () => {
    // The panel NAMES the seam nowhere (its core references only the record's TYPE): it receives an already-composed record.
    // The seam is named in executable source in exactly three places — its definition and its two consumers — so R57 opened no
    // new coordination read.
    expect(namersOf(/\bgetCoordinationById\b/)).toEqual([PAGE, REASSIGN_PAGE, R37_READER].sort());
  });

  it("the R55 timeline seam is NAMED only where defined + consumed — the runtime and the ONE detail page", () => {
    // The panel NAMES the seam nowhere (its core references only the view's TYPE): it receives an already-composed view. R57
    // reuses the timeline the detail page already read, so it opened no new ownership read.
    expect(namersOf(/\bgetOwnershipTimeline\b/)).toEqual([PAGE, TIMELINE_RUNTIME].sort());
  });

  it("the summary projection is DEFINED in exactly one module — this pure core", () => {
    expect(namersOf(SUMMARY_PROJECT_DEF)).toEqual([SUMMARY_CORE]);
  });

  it("no summary file records anything directly — it names no write primitive and issues no RPC", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code.match(WRITE_PRIMITIVE), f).toBeNull();
      expect(code, `${f} must issue no RPC`).not.toMatch(/\.rpc\(/);
    }
  });
});

// =====================================================================
// 3. IT CONSUMES ONLY THE TWO VIEWS — the core over the R37 + R55 cores' TYPES, the component over the core's TYPES.
// =====================================================================

describe("receptionist action summary panel — it consumes only the two authoritative views", () => {
  it("the panel NAMES neither seam — it receives two already-composed views", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name the coordination seam`).not.toMatch(/\bgetCoordinationById\b/);
      expect(code, `${f} must not name the timeline seam`).not.toMatch(/\bgetOwnershipTimeline\b/);
    }
  });

  it("the pure core imports ONLY the R37 + R55 cores' TYPES — no runtime, no engine, no read model, no server module", () => {
    const code = codeOf(read(SUMMARY_CORE));
    const specs = importSpecifiers(code);
    expect([...specs].sort()).toEqual([COORD_CORE_RELATIVE, TIMELINE_CORE_RELATIVE].sort());
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-coordination-view"/);
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-ownership-timeline"/);
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
  });

  it("the component imports ONLY the summary core's TYPES — no seam, no engine, no server module", () => {
    const code = codeOf(read(SUMMARY_COMPONENT));
    const specs = importSpecifiers(code);
    expect(specs).toEqual([SUMMARY_CORE_MODULE]);
    expect(code).toMatch(
      /import type \{[\s\S]*?\} from "@\/lib\/receptionist\/conversation-action-summary-panel"/,
    );
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
  });

  it("the wiring flows one way — the page imports the summary core + component; the component imports only the core", () => {
    expect(importersOf(SUMMARY_CORE_MODULE)).toEqual([PAGE, SUMMARY_COMPONENT].sort());
    expect(importersOf(SUMMARY_COMPONENT_MODULE)).toEqual([PAGE]);
  });

  it("neither summary file reaches a ledger, the coordinations table, a client or a .from(...)", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/\.from\(/);
      expect(code, `${f}`).not.toMatch(CLAIM_LEDGER);
      expect(code, `${f}`).not.toMatch(RELEASES_LEDGER);
      expect(code, `${f}`).not.toMatch(REASSIGNMENTS_LEDGER);
      expect(code, `${f}`).not.toMatch(COORDINATIONS_TABLE);
      expect(code, `${f}`).not.toMatch(/createAdminClient/);
    }
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — the page threads org into BOTH seam reads; the panel layer is org-agnostic.
// =====================================================================

describe("receptionist action summary panel — organisation isolation is preserved", () => {
  it("the page threads the caller's org and the coordination id into BOTH seam reads", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(
      /getCoordinationById\(\{\s*org_id:\s*ctx\.org\.id,\s*coordination_id:\s*coordinationId,\s*\}\)/,
    );
    expect(code).toMatch(
      /getOwnershipTimeline\(\{\s*org_id:\s*ctx\.org\.id,\s*coordination_id:\s*coordinationId,\s*\}\)/,
    );
  });

  it("the summary is projected from the two ALREADY-READ views — it opens no new read", () => {
    // The digest is composed from `record` (the R37 read) + `timeline` (the R55 read) the page already performed above; it
    // issues no read of its own, so it cannot widen a scope those org-scoped reads fixed.
    const code = codeOf(read(PAGE));
    expect(code).toMatch(
      /projectConversationActionSummary\(\{\s*coordination:\s*record,\s*ownership:\s*timeline,?\s*\}\)/,
    );
  });

  it("the panel layer is ORG-AGNOSTIC — it names no org token, so it cannot widen the scope the runtimes fixed", () => {
    // Isolation is the runtimes' concern (proven in the R37 + R55 suites): every seam the page reads is org-scoped. The panel
    // projects only the two views it is handed, so it names no organisation at all — it can only narrow to what it is fed.
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must name no org_id`).not.toMatch(/\borg_id\b/);
      expect(code, `${f} must name no ctx.org`).not.toMatch(/ctx\.org/);
    }
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the panel is read-only; it joins no ledger-reader set.
// =====================================================================

describe("receptionist action summary panel — the append-only audit is preserved", () => {
  it("the core + component are read-only — no .from, no insert/update/delete/upsert, no write primitive, no RPC", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/\.from\(/);
      expect(code, `${f}`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f}`).not.toMatch(WRITE_PRIMITIVE);
      expect(code, `${f}`).not.toMatch(/\.rpc\(/);
    }
  });

  it("the panel JOINS NO ledger-reader set — it reads no ledger, even transitively", () => {
    for (const ledger of [CLAIM_LEDGER, RELEASES_LEDGER, REASSIGNMENTS_LEDGER]) {
      const readers = readersOf(ledger);
      expect(readers, "summary core must read no ledger table").not.toContain(SUMMARY_CORE);
      expect(readers, "summary component must read no ledger table").not.toContain(SUMMARY_COMPONENT);
    }
  });

  it("the claims ledger is STILL read through exactly the two pre-R55 seams — R57 added no ledger reader", () => {
    // The two readers remain the R47 surface reader and the R51 state engine. R57 presents ownership through the R55 view,
    // which folds the engine; it never joins this set.
    expect(readersOf(CLAIM_LEDGER)).toEqual([CLAIM_READER, STATE_ENGINE].sort());
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the panel presents state; it acts on nothing.
// =====================================================================

describe("receptionist action summary panel — no execution path is introduced", () => {
  it("no summary file names any engine EXECUTION function", () => {
    for (const f of SUMMARY_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no summary file names any OTHER engine writer", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no summary file names an R57 non-goal token (assign/dispatch/notify/schedule/…/close)", () => {
    for (const f of SUMMARY_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no summary file reaches a transport / calendar / quote / voice / whatsapp / email / memory / generation path", () => {
    for (const f of SUMMARY_FILES) {
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
// 7. THE MODULE BOUNDARIES HOLD — shared deterministic core over TYPES; a presentational, affordance-free server component.
// =====================================================================

describe("receptionist action summary panel — the module boundaries hold", () => {
  it("the pure core is a shared module (NOT server-only) importing ONLY the R37 + R55 cores' modules", () => {
    const specs = importSpecifiers(codeOf(read(SUMMARY_CORE)));
    expect(specs).not.toContain("server-only");
    expect([...specs].sort()).toEqual([COORD_CORE_RELATIVE, TIMELINE_CORE_RELATIVE].sort());
  });

  it("the core imports BOTH modules as TYPE-ONLY — it CANNOT call a read or a derivation, so it derives nothing", () => {
    const code = codeOf(read(SUMMARY_CORE));
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-coordination-view"/);
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-ownership-timeline"/);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(SUMMARY_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("the component is a PRESENTATIONAL server component — NOT a client component, and declares no server action", () => {
    const code = codeOf(read(SUMMARY_COMPONENT));
    expect(code, "must not be a client component").not.toMatch(/["']use client["']/);
    expect(code, "must declare no server action").not.toMatch(/["']use server["']/);
  });

  it("the component holds no state and offers no affordance — it is inspection only", () => {
    const code = codeOf(read(SUMMARY_COMPONENT));
    expect(code, "no click handler").not.toMatch(/onClick/);
    expect(code, "no local state").not.toMatch(/\buseState\b/);
    expect(code, "no transition").not.toMatch(/\buseTransition\b/);
    expect(code, "no button").not.toMatch(/<button\b/);
    expect(code, "no form").not.toMatch(/<form\b/);
  });
});

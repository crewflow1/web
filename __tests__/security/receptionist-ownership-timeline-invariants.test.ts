import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION OWNERSHIP TIMELINE governance invariants
 * (the AI Receptionist Programme, R55 — CONVERSATION OWNERSHIP TIMELINE).
 *
 * R46 shipped the CLAIM capability + its append-only ledger; R50 the RELEASE + its ledger; R52 the REASSIGNMENT + its
 * ledger. R51 made the Ownership STATE ENGINE the SOLE reader of that three-ledger event stream; R48/R53 made the Ownership
 * READ MODEL the authoritative VIEW of the PRESENT owner over the engine. R55 adds the canonical HISTORICAL projection ON
 * TOP of both: the OWNERSHIP TIMELINE — a coordination's append-only ownership history, presented chronologically. Its law
 * is exact: "the timeline consumes ONLY the authorised ownership seams (the R51 State Engine + the R48/R53 Read Model); it
 * DERIVES OWNERSHIP NOWHERE; the State Engine remains authoritative; the Read Model remains authoritative; organisation
 * isolation is preserved; the audit remains append-only; and NO execution path is introduced." This suite proves that
 * contract as a matter of SOURCE, not discipline — the house bar of the R30→R54 invariant suites:
 *
 *   • THE TIMELINE SHIPS — the pure core exports the projection + the rendering model (the transition entries, the closed
 *     event-kind vocabulary, the entry-headline describer); the runtime exports the ONE org-scoped timeline seam.
 *   • IT DERIVES OWNERSHIP NOWHERE — neither the core nor the runtime names ANY ownership-derivation fold (the engine's
 *     `deriveOwnershipState` / `isOwnedState` / `resolveCurrentOwner` / … or the read model's `projectOwnership` /
 *     `selectActiveClaims`). The header is COPIED from the Read Model's record; the entries are a RELABELLING of the raw
 *     events. The core imports only TYPES, so it CANNOT call a derivation — provably a projection, not a second reader.
 *   • THE CANONICAL RUNTIMES STAY AUTHORITATIVE — R55 adds NO writer: neither file names a ledger write primitive, a
 *     canonical write runtime (`claimConversationWork` / `releaseConversationWork` / `reassignConversationWork`) or a
 *     resolver; and the timeline seam `getOwnershipTimeline` is DEFINED exactly once.
 *   • IT CONSUMES ONLY THE AUTHORISED SEAMS — the runtime issues NO `.from(...)`, names NONE of the three ledgers nor the
 *     coordinations table, opens no client; it IMPORTS the R51 state engine AND the R48/R53 read model. The pure core names
 *     no table at all — it consumes a record + events, not a database.
 *   • ORGANISATION ISOLATION IS PRESERVED — EVERY seam read is org-scoped: the runtime THREADS the caller's `org_id` into
 *     every seam call (the org-threaded-call count equals the seam-call count), so no read can escape the org.
 *   • THE AUDIT STAYS APPEND-ONLY — the runtime + core are read-only (no `.from`, no insert/update/delete/upsert, no write
 *     primitive, no RPC); and across ALL source the timeline JOINS NO ledger-reader set — it reads the ledgers only
 *     TRANSITIVELY through the engine, so the pre-R55 reader sets are unchanged.
 *   • NO EXECUTION PATH IS INTRODUCED — neither file names any engine execution function, any other engine writer, any R55
 *     non-goal token (assign / dispatch / notify / schedule / … / close) or any transport / calendar / quote / generation
 *     path. `claim`, `release` and `reassign` are the READ history the timeline projects, not non-goals. It states history;
 *     it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the runtime is server-only; the pure core is a shared, deterministic module (NOT
 *     server-only) importing ONLY the engine's + read model's TYPES, touching no I/O, no clock and no RNG.
 *
 * The timeline's runtime behaviour (runtime over real Postgres, reading back what the canonical runtimes recorded) is
 * pinned in __tests__/integration/receptionist/ownership-timeline-pipeline.test.ts, and the pure core exhaustively in
 * __tests__/receptionist/conversation-ownership-timeline.test.ts. This tier is HERMETIC — a filesystem scan over
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

// The R55 timeline — the pure core (projection + rendering model) and the org-scoped server runtime.
const CORE = "lib/receptionist/conversation-ownership-timeline.ts";
const RUNTIME = "server/services/receptionist-ownership-timeline.ts";

// The R51 State Engine — the sole authorised reader of the three ledgers, and one of the two seams the timeline consumes
// (for the RAW events; the R48/R53 Read Model supplies the header, proven imported by specifier in §3). It reads the
// ledgers ONLY transitively, through this engine.
const STATE_ENGINE = "server/services/receptionist-ownership-state.ts";

// The R47 surface reader — one of the two pre-existing claims-ledger readers (with the state engine). The timeline joins
// NEITHER's set: it names no ledger table.
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

/** The R55 files whose EXECUTABLE source must name no ledger, no writer and no execution path. */
const TIMELINE_FILES = [CORE, RUNTIME] as const;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The three append-only ownership ledgers + the R36 coordinations base table — the timeline names none of them. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Any ledger WRITE primitive — the timeline records nothing, so it names none. */
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The canonical ownership WRITE runtimes + their pure resolvers — the timeline consumes NONE (it only reads history). */
const CANONICAL_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|reassignConversationWork|resolveClaim|resolveRelease|resolveReassignment)\b/;

/**
 * Every OWNERSHIP-DERIVATION fold — the engine's state + current-owner derivation AND the read model's ownership
 * projections. The timeline DERIVES OWNERSHIP NOWHERE: it copies the Read Model's already-derived record and relabels the
 * engine's already-read events, so it names NONE of these. NOTE `\bprojectOwnership\b` never matches `projectOwnershipTimeline`
 * (no word boundary between "projectOwnership" and "Timeline"), so the timeline's OWN projection is not a false positive.
 */
const OWNERSHIP_DERIVATION_FNS =
  /\b(?:deriveOwnershipState|isOwnedState|isUnclaimed|isClaimed|isReleased|resolveCurrentOwner|latestReassignmentFor|projectOwnershipState|reconcileOwnershipStates|projectOwnership|projectOwnershipEvent|selectActiveClaims|summariseOwnership)\b/;

/** The R55 timeline entry points — the pure projection + rendering model, and the ONE org-scoped runtime seam. */
const PROJECT_DEF = /export function projectOwnershipTimeline\(/;
const DESCRIBE_DEF = /export function describeTimelineEntry\(/;
const KINDS_DEF = /export const TIMELINE_EVENT_KINDS\b/;
const TIMELINE_READ = /export async function getOwnershipTimeline\(/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the timeline names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R55 explicit non-goals as SOURCE tokens — the timeline states history; it acts on nothing. NOTE `\bassign\w*` NEVER
 * matches "reassign"/"reassigned"/"reassignment" (no word boundary between "re" and "assign"), so the timeline's genuine
 * reassignment vocabulary is not a false positive; and "claim"/"release" are the READ history it projects, not non-goals.
 */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // automatic assignment (NEVER matches "reassign")
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no timeline module may name (the ledgers are written ONLY through the canonical runtimes). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

/** The files across all source that NAME a given ledger table — the reader set the timeline must not join. */
const readersOf = (ledger: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => ledger.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

// =====================================================================
// 0. The timeline ships, with its single entry points.
// =====================================================================

describe("receptionist ownership timeline — the timeline ships", () => {
  it("ships the pure core and the server runtime", () => {
    for (const f of TIMELINE_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the projection, the closed event-kind vocabulary and the entry describer", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(PROJECT_DEF);
    expect(code).toMatch(DESCRIBE_DEF);
    expect(code).toMatch(KINDS_DEF);
  });

  it("the runtime exports the ONE org-scoped timeline seam", () => {
    expect(codeOf(read(RUNTIME))).toMatch(TIMELINE_READ);
  });
});

// =====================================================================
// 1. IT DERIVES OWNERSHIP NOWHERE — the header is copied, the entries relabelled; no fold is named.
// =====================================================================

describe("receptionist ownership timeline — it derives ownership nowhere", () => {
  it("neither the core nor the runtime names ANY ownership-derivation fold (engine or read model)", () => {
    for (const f of TIMELINE_FILES) {
      expect(codeOf(read(f)), `${f} must name no ownership-derivation fold`).not.toMatch(
        OWNERSHIP_DERIVATION_FNS,
      );
    }
  });

  it("neither the core nor the runtime re-derives or records a claim/release/reassignment (no runtime, no resolver, no writer)", () => {
    for (const f of TIMELINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name a canonical write runtime or resolver`).not.toMatch(
        CANONICAL_WRITE_RUNTIMES,
      );
      expect(code, `${f} must not name a ledger write primitive`).not.toMatch(WRITE_PRIMITIVE);
    }
  });

  it("the pure core names no I/O — it consumes a record + events, not a database", () => {
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
  });
});

// =====================================================================
// 2. THE CANONICAL RUNTIMES STAY AUTHORITATIVE — R55 adds no writer; the timeline seam is defined once.
// =====================================================================

describe("receptionist ownership timeline — the canonical runtimes remain authoritative", () => {
  const timelineDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => TIMELINE_READ.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("getOwnershipTimeline is DEFINED in exactly one module — the R55 runtime", () => {
    expect(timelineDefiners).toEqual([RUNTIME]);
  });

  it("no timeline file records anything directly — it names no write primitive and issues no RPC", () => {
    for (const f of TIMELINE_FILES) {
      const code = codeOf(read(f));
      expect(code.match(WRITE_PRIMITIVE), f).toBeNull();
      expect(code, `${f} must issue no RPC`).not.toMatch(/\.rpc\(/);
    }
  });
});

// =====================================================================
// 3. IT CONSUMES ONLY THE AUTHORISED SEAMS — the state engine + the read model, no ledger, no .from(...).
// =====================================================================

describe("receptionist ownership timeline — it consumes only the authorised ownership seams", () => {
  it("the runtime reads NO ledger — it names none of the three ledgers nor the coordinations table, issues no .from(...), opens no client", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(RELEASES_LEDGER);
    expect(code).not.toMatch(REASSIGNMENTS_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
    expect(code).not.toMatch(/createAdminClient/);
  });

  it("the runtime IMPORTS BOTH authorised seams — the R51 state engine (events) and the R48/R53 read model (header)", () => {
    const specs = importSpecifiers(codeOf(read(RUNTIME)));
    expect(specs).toContain("@/server/services/receptionist-ownership-state");
    expect(specs).toContain("@/server/services/receptionist-ownership-read-model");
  });

  it("the pure core names no table at all — it consumes a record + events, not a database", () => {
    const code = codeOf(read(CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(RELEASES_LEDGER);
    expect(code).not.toMatch(REASSIGNMENTS_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — every seam read is org-scoped; the filter can never be skipped.
// =====================================================================

describe("receptionist ownership timeline — organisation isolation is preserved", () => {
  it("every seam read is org-scoped — every seam call threads the caller's org_id", () => {
    // The runtime performs no query itself; it delegates to the two seams. Isolation is preserved by THREADING the
    // caller's org into EVERY seam call: the count of org-threaded calls equals the count of seam calls, so no read can
    // escape the org scope. (Each seam's own select==org-filter proof lives in its invariant suite.)
    const code = codeOf(read(RUNTIME));
    const seamCalls = (code.match(/\b(?:getCoordinationOwnershipState|getOwnership)\(/g) ?? []).length;
    const orgThreads = (code.match(/org_id:\s*input\.org_id/g) ?? []).length;
    expect(seamCalls).toBeGreaterThan(0);
    expect(orgThreads).toBe(seamCalls);
  });

  it("the per-coordination read threads BOTH the org and the coordination id into each seam", () => {
    const code = codeOf(read(RUNTIME));
    expect(code).toMatch(/getCoordinationOwnershipState\(/);
    expect(code).toMatch(/getOwnership\(/);
    expect(code).toMatch(/org_id:\s*input\.org_id/);
    expect(code).toMatch(/coordination_id:\s*input\.coordination_id/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the reads are read-only; the timeline joins no ledger-reader set.
// =====================================================================

describe("receptionist ownership timeline — the append-only audit is preserved", () => {
  it("the runtime + core are read-only — no .from, no insert/update/delete/upsert, no write primitive, no RPC", () => {
    for (const f of TIMELINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/\.from\(/);
      expect(code, `${f}`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f}`).not.toMatch(WRITE_PRIMITIVE);
      expect(code, `${f}`).not.toMatch(/\.rpc\(/);
    }
  });

  it("the timeline JOINS NO ledger-reader set — it reads the ledgers ONLY transitively, through the engine", () => {
    for (const ledger of [CLAIM_LEDGER, RELEASES_LEDGER, REASSIGNMENTS_LEDGER]) {
      const readers = readersOf(ledger);
      expect(readers, "timeline core must read no ledger table").not.toContain(CORE);
      expect(readers, "timeline runtime must read no ledger table").not.toContain(RUNTIME);
    }
  });

  it("the claims ledger is STILL read through exactly the two pre-R55 seams — R55 added no ledger reader", () => {
    // The runtime writes the ledger through the RPC (it never names the table); the two readers are the surface reader and
    // the state engine. R55 reads ownership state THROUGH the engine, so it does not join this set.
    expect(readersOf(CLAIM_LEDGER)).toEqual([CLAIM_READER, STATE_ENGINE].sort());
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the timeline states history; it acts on nothing.
// =====================================================================

describe("receptionist ownership timeline — no execution path is introduced", () => {
  it("no timeline file names any engine EXECUTION function", () => {
    for (const f of TIMELINE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no timeline file names any OTHER engine writer", () => {
    for (const f of TIMELINE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no timeline file names an R55 non-goal token (assign/dispatch/…/close)", () => {
    for (const f of TIMELINE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no timeline file reaches a transport / calendar / quote / channel / generation path", () => {
    for (const f of TIMELINE_FILES) {
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
// 7. THE MODULE BOUNDARIES HOLD — server-only runtime; shared, deterministic pure core over TYPES only.
// =====================================================================

describe("receptionist ownership timeline — the module boundaries hold", () => {
  it("the runtime is server-only — it is a canonical place ownership history is projected", () => {
    expect(importSpecifiers(codeOf(read(RUNTIME)))).toContain("server-only");
  });

  it("the pure core is a shared module (NOT server-only) importing ONLY the engine's + read model's modules", () => {
    const specs = importSpecifiers(codeOf(read(CORE)));
    expect(specs).not.toContain("server-only");
    expect([...specs].sort()).toEqual(
      ["./conversation-ownership-read-model", "./conversation-ownership-state"].sort(),
    );
  });

  it("the pure core imports those modules as TYPE-ONLY — it CANNOT call a derivation, so it derives ownership nowhere", () => {
    const code = codeOf(read(CORE));
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-ownership-state"/);
    expect(code).toMatch(/import type \{[\s\S]*?\} from "\.\/conversation-ownership-read-model"/);
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

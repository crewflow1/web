import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION OWNERSHIP TIMELINE PANEL governance invariants
 * (the AI Receptionist Programme, R56 — CONVERSATION OWNERSHIP TIMELINE PANEL).
 *
 * R55 shipped the canonical HISTORICAL projection of a coordination's ownership — the OWNERSHIP TIMELINE: its
 * present-ownership HEADER (from the R48/R53 Read Model) plus its append-only list of ownership TRANSITIONS (relabelled from
 * the R51 State Engine's raw claim / release / reassignment events), composed by the R55 Ownership Timeline RUNTIME
 * (`getOwnershipTimeline`, org-scoped). R56 is the FIRST operator-facing use of that projection: the CONVERSATION OWNERSHIP
 * TIMELINE PANEL on the Conversation Detail surface — a pure presentation CORE that re-shapes the R55 view into a display
 * model, plus a read-only server COMPONENT that paints it, wired into the detail page beside the R47 claim panel. Its law is
 * exact: "the panel CONSUMES the R55 Timeline Runtime (transitively, through the page) and NOTHING BELOW it — it does not
 * touch the Read Model or the State Engine; it DERIVES OWNERSHIP NOWHERE; the Timeline Runtime remains authoritative; the
 * State Engine remains authoritative; the Read Model remains authoritative; organisation isolation is preserved; the audit
 * remains append-only; and NO execution path is introduced." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R30→R55 invariant suites:
 *
 *   • THE PANEL SHIPS — the pure core exports the panel projection + the instant formatter; the server component exports the
 *     panel; and the Conversation Detail page reads the R55 seam, projects the panel view and renders the component.
 *   • IT DERIVES OWNERSHIP NOWHERE — neither the core nor the component names ANY ownership-derivation fold (the engine's
 *     `deriveOwnershipState` / `resolveCurrentOwner` / … or the read model's `projectOwnership` / `selectActiveClaims`), any
 *     canonical write runtime or any write primitive. The header is COPIED from the R55 view; the rows are a RELABELLING of
 *     the R55 entries. The core imports only the R55 view's TYPES, so it CANNOT call a derivation — provably a projection.
 *   • THE RUNTIME STAYS AUTHORITATIVE — R56 adds NO seam: `getOwnershipTimeline` is DEFINED exactly once (the R55 runtime),
 *     the timeline runtime module is IMPORTED by exactly one surface (the detail page), and the panel projection is DEFINED
 *     exactly once (this core). The panel NAMES the runtime seam nowhere — it receives an already-composed view.
 *   • IT CONSUMES ONLY THE R55 VIEW — the core imports ONLY the R55 timeline core's TYPES; the component imports ONLY the
 *     core's TYPES; neither reaches a ledger, the coordinations table, a `.from(...)`, a database client or ANY `@/server`
 *     module. The panel sits ABOVE the runtime and reads only what the runtime already composed.
 *   • ORGANISATION ISOLATION IS PRESERVED — the page THREADS the caller's `org_id` (and the coordination id) into the R55
 *     seam read; and the panel layer is ORG-AGNOSTIC (it names no org token at all), so it cannot widen a scope the runtime
 *     already fixed. Isolation is the runtime's concern, proven in the R55 suite; the panel can only narrow to what it is fed.
 *   • THE AUDIT STAYS APPEND-ONLY — the core + component are read-only (no `.from`, no insert/update/delete/upsert, no write
 *     primitive, no RPC); and across ALL source the panel JOINS NO ledger-reader set — the claims ledger is STILL read through
 *     exactly the two pre-R55 seams, so R56 added no reader.
 *   • NO EXECUTION PATH IS INTRODUCED — neither file names any engine execution function, any other engine writer, any R56
 *     non-goal token (assign / dispatch / notify / schedule / … / close) or any transport / calendar / quote / channel /
 *     generation path. `claim`, `release` and `reassign` are the READ history the panel presents, not non-goals. It paints
 *     pixels; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the pure core is a shared, deterministic module (NOT server-only) over the R55 view's
 *     TYPES, touching no I/O, no clock and no RNG; the component is a PRESENTATIONAL server component — NOT a client
 *     component, declaring no server action, holding no state and offering no affordance (`use client` / `use server` /
 *     `onClick` / `useState` / `useTransition` / `<button` / `<form` all absent).
 *
 * The panel's projection behaviour is pinned exhaustively in __tests__/receptionist/conversation-ownership-timeline-panel.test.ts,
 * and its runtime behaviour (panel over real Postgres, reading back what the canonical runtimes recorded) in
 * __tests__/integration/receptionist/ownership-timeline-panel-pipeline.test.ts. This tier is HERMETIC — a filesystem scan over
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

// The R56 panel — the pure presentation CORE (projection + instant formatter) and the read-only server COMPONENT.
const PANEL_CORE = "lib/receptionist/conversation-ownership-timeline-panel.ts";
const PANEL_COMPONENT = "app/admin/ai-receptionist/worklist/[coordinationId]/ownership-timeline-panel.tsx";

/** The R56 files whose EXECUTABLE source must name no seam, no ledger, no writer and no execution path. */
const PANEL_FILES = [PANEL_CORE, PANEL_COMPONENT] as const;

// The Conversation Detail surface — the ONE page that reads the R55 timeline runtime and renders the R56 panel.
const PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/page.tsx";

// The seam BELOW the panel: the R55 Timeline Runtime — the ONE org-scoped seam the panel consumes, transitively through the
// page. It folds the R51 State Engine (events) and the R48/R53 Read Model (header); the panel touches NEITHER directly.
const TIMELINE_RUNTIME = "server/services/receptionist-ownership-timeline.ts";

// The R51 State Engine — the sole authorised reader of the three ledgers, folded INSIDE the runtime; and the R47 surface
// reader — the other pre-existing claims-ledger reader. The panel joins NEITHER's set: it names no ledger table.
const STATE_ENGINE = "server/services/receptionist-ownership-state.ts";
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

// Module specifiers.
const TIMELINE_RUNTIME_MODULE = "@/server/services/receptionist-ownership-timeline";
const PANEL_CORE_MODULE = "@/lib/receptionist/conversation-ownership-timeline-panel";
const PANEL_COMPONENT_MODULE = "./ownership-timeline-panel";
const TIMELINE_CORE_RELATIVE = "./conversation-ownership-timeline";

/** The three append-only ownership ledgers + the R36 coordinations base table — the panel names none of them. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Any ledger WRITE primitive — the panel records nothing, so it names none. */
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The canonical ownership WRITE runtimes + their pure resolvers — the panel consumes NONE (it only presents history). */
const CANONICAL_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|reassignConversationWork|resolveClaim|resolveRelease|resolveReassignment)\b/;

/**
 * Every OWNERSHIP-DERIVATION fold — the engine's state + current-owner derivation AND the read model's ownership
 * projections. The panel DERIVES OWNERSHIP NOWHERE: it copies the R55 view's already-derived header and relabels its
 * already-read entries, so it names NONE of these. NOTE `\bprojectOwnership\b` never matches `projectOwnershipTimelinePanel`
 * (no word boundary between "projectOwnership" and "Timeline"), so the panel's OWN projection is not a false positive.
 */
const OWNERSHIP_DERIVATION_FNS =
  /\b(?:deriveOwnershipState|isOwnedState|isUnclaimed|isClaimed|isReleased|resolveCurrentOwner|latestReassignmentFor|projectOwnershipState|reconcileOwnershipStates|projectOwnership|projectOwnershipEvent|selectActiveClaims|summariseOwnership)\b/;

/** The R55 timeline seam + the R56 panel entry points. */
const TIMELINE_READ_DEF = /export async function getOwnershipTimeline\(/;
const PANEL_PROJECT_DEF = /export function projectOwnershipTimelinePanel\(/;
const PANEL_COMPONENT_DEF = /export function OwnershipTimelinePanel\(/;
const FORMAT_DEF = /export function formatTimelineInstant\(/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the panel names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R56 explicit non-goals as SOURCE tokens — the panel presents history; it acts on nothing. NOTE `\bassign\w*` NEVER
 * matches "reassign"/"reassigned"/"reassignment" (no word boundary between "re" and "assign"), so the panel's genuine
 * reassignment vocabulary is not a false positive; and "claim"/"release" are the READ history it presents, not non-goals.
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

/** Direct-write / bypass tokens no panel module may name (the ledgers are written ONLY through the canonical runtimes). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The panel ships, with its single entry points and its page wiring.
// =====================================================================

describe("receptionist ownership timeline panel — the panel ships", () => {
  it("ships the pure core and the server component", () => {
    for (const f of PANEL_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the panel projection and the instant formatter", () => {
    const code = codeOf(read(PANEL_CORE));
    expect(code).toMatch(PANEL_PROJECT_DEF);
    expect(code).toMatch(FORMAT_DEF);
  });

  it("the server component exports the panel", () => {
    expect(codeOf(read(PANEL_COMPONENT))).toMatch(PANEL_COMPONENT_DEF);
  });

  it("the Conversation Detail page reads the R55 seam, projects the panel view and renders the component", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/getOwnershipTimeline\s*\(/);
    expect(code).toMatch(/projectOwnershipTimelinePanel\s*\(/);
    expect(code).toMatch(/<OwnershipTimelinePanel\b/);
  });
});

// =====================================================================
// 1. IT DERIVES OWNERSHIP NOWHERE — the header is copied, the rows relabelled; no fold, no writer is named.
// =====================================================================

describe("receptionist ownership timeline panel — it derives ownership nowhere", () => {
  it("neither the core nor the component names ANY ownership-derivation fold (engine or read model)", () => {
    for (const f of PANEL_FILES) {
      expect(codeOf(read(f)), `${f} must name no ownership-derivation fold`).not.toMatch(
        OWNERSHIP_DERIVATION_FNS,
      );
    }
  });

  it("neither the core nor the component re-derives or records a claim/release/reassignment (no runtime, no resolver, no writer)", () => {
    for (const f of PANEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name a canonical write runtime or resolver`).not.toMatch(
        CANONICAL_WRITE_RUNTIMES,
      );
      expect(code, `${f} must not name a ledger write primitive`).not.toMatch(WRITE_PRIMITIVE);
    }
  });

  it("the pure core names no I/O — it consumes a composed view, not a database", () => {
    const code = codeOf(read(PANEL_CORE));
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
  });
});

// =====================================================================
// 2. THE RUNTIME STAYS AUTHORITATIVE — R56 adds no seam; the runtime seam is defined + consumed exactly once each.
// =====================================================================

describe("receptionist ownership timeline panel — the timeline runtime remains authoritative", () => {
  it("getOwnershipTimeline is DEFINED in exactly one module — the R55 runtime (R56 adds no seam)", () => {
    expect(namersOf(TIMELINE_READ_DEF)).toEqual([TIMELINE_RUNTIME]);
  });

  it("the timeline runtime seam is NAMED only where defined and where consumed — the runtime + the ONE detail page", () => {
    // The panel NAMES the seam nowhere (its core mentions it only in a comment, stripped here): it receives an
    // already-composed view. The seam is named in executable source in exactly two places — its definition and its single
    // consumer — so no surface derives the timeline independently.
    expect(namersOf(/\bgetOwnershipTimeline\b/)).toEqual([PAGE, TIMELINE_RUNTIME].sort());
  });

  it("the timeline runtime module is IMPORTED by exactly one surface — the Conversation Detail page", () => {
    expect(importersOf(TIMELINE_RUNTIME_MODULE)).toEqual([PAGE]);
  });

  it("the panel projection is DEFINED in exactly one module — this pure core", () => {
    expect(namersOf(PANEL_PROJECT_DEF)).toEqual([PANEL_CORE]);
  });

  it("no panel file records anything directly — it names no write primitive and issues no RPC", () => {
    for (const f of PANEL_FILES) {
      const code = codeOf(read(f));
      expect(code.match(WRITE_PRIMITIVE), f).toBeNull();
      expect(code, `${f} must issue no RPC`).not.toMatch(/\.rpc\(/);
    }
  });
});

// =====================================================================
// 3. IT CONSUMES ONLY THE R55 VIEW — the core over the R55 core's TYPES, the component over the core's TYPES; no seam below.
// =====================================================================

describe("receptionist ownership timeline panel — it consumes only the R55 view", () => {
  it("the panel NAMES the runtime seam nowhere — it receives an already-composed view", () => {
    for (const f of PANEL_FILES) {
      expect(codeOf(read(f)), `${f} must not name the timeline seam`).not.toMatch(
        /\bgetOwnershipTimeline\b/,
      );
    }
  });

  it("the pure core imports ONLY the R55 timeline core's TYPES — no runtime, no engine, no read model, no server module", () => {
    const specs = importSpecifiers(codeOf(read(PANEL_CORE)));
    expect(specs).toEqual([TIMELINE_CORE_RELATIVE]);
    expect(codeOf(read(PANEL_CORE))).toMatch(
      /import type \{[\s\S]*?\} from "\.\/conversation-ownership-timeline"/,
    );
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
  });

  it("the component imports ONLY the panel core's TYPES — no seam, no engine, no server module", () => {
    const specs = importSpecifiers(codeOf(read(PANEL_COMPONENT)));
    expect(specs).toEqual([PANEL_CORE_MODULE]);
    expect(codeOf(read(PANEL_COMPONENT))).toMatch(
      /import type \{[\s\S]*?\} from "@\/lib\/receptionist\/conversation-ownership-timeline-panel"/,
    );
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
  });

  it("the wiring flows one way — the page imports both the runtime seam and the panel; the component imports only the core", () => {
    expect(importersOf(PANEL_CORE_MODULE)).toEqual([PAGE, PANEL_COMPONENT].sort());
    expect(importersOf(PANEL_COMPONENT_MODULE)).toEqual([PAGE]);
  });

  it("neither panel file reaches a ledger, the coordinations table, a client or a .from(...)", () => {
    for (const f of PANEL_FILES) {
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
// 4. ORGANISATION ISOLATION — the page threads org into the seam read; the panel layer is org-agnostic.
// =====================================================================

describe("receptionist ownership timeline panel — organisation isolation is preserved", () => {
  it("the page threads the caller's org and the coordination id into the R55 seam read", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(
      /getOwnershipTimeline\(\{\s*org_id:\s*ctx\.org\.id,\s*coordination_id:\s*coordinationId,\s*\}\)/,
    );
  });

  it("the panel layer is ORG-AGNOSTIC — it names no org token, so it cannot widen the scope the runtime fixed", () => {
    // Isolation is the runtime's concern (proven in the R55 suite): every seam it reads is org-scoped. The panel projects
    // only the view it is handed, so it names no organisation at all — it can only narrow to what it is fed, never widen.
    for (const f of PANEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must name no org_id`).not.toMatch(/\borg_id\b/);
      expect(code, `${f} must name no ctx.org`).not.toMatch(/ctx\.org/);
    }
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the panel is read-only; it joins no ledger-reader set.
// =====================================================================

describe("receptionist ownership timeline panel — the append-only audit is preserved", () => {
  it("the core + component are read-only — no .from, no insert/update/delete/upsert, no write primitive, no RPC", () => {
    for (const f of PANEL_FILES) {
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
      expect(readers, "panel core must read no ledger table").not.toContain(PANEL_CORE);
      expect(readers, "panel component must read no ledger table").not.toContain(PANEL_COMPONENT);
    }
  });

  it("the claims ledger is STILL read through exactly the two pre-R55 seams — R56 added no ledger reader", () => {
    // The two readers remain the R47 surface reader and the R51 state engine. R56 presents ownership through the R55 view,
    // which folds the engine; it never joins this set.
    expect(readersOf(CLAIM_LEDGER)).toEqual([CLAIM_READER, STATE_ENGINE].sort());
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the panel presents history; it acts on nothing.
// =====================================================================

describe("receptionist ownership timeline panel — no execution path is introduced", () => {
  it("no panel file names any engine EXECUTION function", () => {
    for (const f of PANEL_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no panel file names any OTHER engine writer", () => {
    for (const f of PANEL_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no panel file names an R56 non-goal token (assign/dispatch/…/close)", () => {
    for (const f of PANEL_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no panel file reaches a transport / calendar / quote / channel / generation path", () => {
    for (const f of PANEL_FILES) {
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
// 7. THE MODULE BOUNDARIES HOLD — shared deterministic core over TYPES; a presentational, affordance-free server component.
// =====================================================================

describe("receptionist ownership timeline panel — the module boundaries hold", () => {
  it("the pure core is a shared module (NOT server-only) importing ONLY the R55 timeline core's module", () => {
    const specs = importSpecifiers(codeOf(read(PANEL_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual([TIMELINE_CORE_RELATIVE]);
  });

  it("the core imports that module as TYPE-ONLY — it CANNOT call a derivation, so it derives ownership nowhere", () => {
    expect(codeOf(read(PANEL_CORE))).toMatch(
      /import type \{[\s\S]*?\} from "\.\/conversation-ownership-timeline"/,
    );
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(PANEL_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });

  it("the component is a PRESENTATIONAL server component — NOT a client component, and declares no server action", () => {
    const code = codeOf(read(PANEL_COMPONENT));
    expect(code, "must not be a client component").not.toMatch(/["']use client["']/);
    expect(code, "must declare no server action").not.toMatch(/["']use server["']/);
  });

  it("the component holds no state and offers no affordance — it is inspection only", () => {
    const code = codeOf(read(PANEL_COMPONENT));
    expect(code, "no click handler").not.toMatch(/onClick/);
    expect(code, "no local state").not.toMatch(/\buseState\b/);
    expect(code, "no transition").not.toMatch(/\buseTransition\b/);
    expect(code, "no button").not.toMatch(/<button\b/);
    expect(code, "no form").not.toMatch(/<form\b/);
  });
});

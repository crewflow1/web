import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION ATTENTION QUEUE SURFACE governance invariants
 * (the AI Receptionist Programme, R59 — CONVERSATION ATTENTION QUEUE SURFACE).
 *
 * R58 shipped the ATTENTION QUEUE: a pure JOIN/GROUP core plus an org-scoped, read-only server RUNTIME
 * (`getConversationAttentionQueue`) that composes the R39 worklist page and the R48 ownership records into a grouped
 * view. R59 is the FIRST operator-facing SURFACE built on that runtime: a read-only page that reads the org's attention
 * queue THROUGH the R58 runtime and projects the operator display model with a pure VIEW core. Its law is exact: "the
 * surface CONSUMES only existing authoritative seams (the R58 runtime, itself over R39 + R48); it DERIVES NO
 * CONVERSATION STATE INDEPENDENTLY; the Attention Queue runtime, the Worklist Read Surface and the Ownership Read Model
 * each remain authoritative; organisation isolation is preserved; the audit remains append-only; and NO execution path
 * is introduced." This suite proves that contract as a matter of SOURCE, not discipline — the house bar of the R30→R58
 * invariant suites:
 *
 *   • THE SURFACE SHIPS — the pure view core exports the surface projection; the page default-exports the surface, fed
 *     by the R58 runtime; the client refresh button exports its read-only re-read control.
 *   • IT CONSUMES ONLY THE R58 RUNTIME — the page's ONLY server-service import is the R58 attention-queue runtime; it
 *     reaches NO seam below it (not the R39 read surface, not the R48 read model, not the R38 reader/core, not a
 *     database client), names neither `queryOrgWorklist` nor `getOwnership` nor `getCoordinationWorklists`, opens no
 *     client and issues no query — it has NO read path around the runtime. The page's whole import surface is pinned.
 *   • THE RUNTIME + ENGINES STAY AUTHORITATIVE — R59 adds NO seam: `getConversationAttentionQueue` is DEFINED exactly
 *     once (the R58 runtime), the surface projection exactly once (this pure core); and no R59 file names a worklist or
 *     ownership derivation, a canonical write runtime or a write primitive. The pure core imports the R58 core's TYPES
 *     only, so it CANNOT call a read or a derivation — provably a projection over an already-composed view.
 *   • ORGANISATION ISOLATION IS PRESERVED — the page is HQ-gated; the org is resolved from the SESSION
 *     (`requireOrgContext` → `ctx.org.id`), never the client; the single runtime read is org-scoped by that id; and the
 *     page takes NO parameter, so it can never be pointed at another org. The pure core + refresh button are org-agnostic.
 *   • THE AUDIT STAYS APPEND-ONLY — every R59 file is read-only (no `.from`, no insert/update/delete/upsert, no write
 *     primitive, no RPC); and the R59 files join NO ledger-reader set.
 *   • NO EXECUTION PATH IS INTRODUCED — no R59 file names any engine execution function, any other engine writer, any
 *     R59 non-goal token (dispatch / notify / schedule / promote / complete / …) or any transport / calendar / quote /
 *     voice / whatsapp / email / memory / generation path. The refresh button's ONLY effect is `router.refresh()` — a
 *     re-read of the same page, never a write, an action or a fetch.
 *   • THE MODULE BOUNDARIES HOLD — the page is a SERVER component; the refresh button is a CLIENT component that imports
 *     only React + the Next router (no server import at all); the pure view core is a shared, deterministic module (NOT
 *     server-only) over the R58 core's TYPES, touching no I/O, no clock and no RNG.
 *
 * The surface's pure view core is pinned exhaustively in __tests__/receptionist/conversation-attention-queue-view.test.ts,
 * and its runtime behaviour (the R58 runtime projected for the operator over real Postgres) in
 * __tests__/integration/receptionist/attention-queue-surface-pipeline.test.ts. This tier is HERMETIC — a filesystem scan
 * over comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip a
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

/** The files across all source that NAME a given ledger table — the reader set the surface must not join. */
const readersOf = (ledger: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => ledger.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

// The R59 surface — the pure VIEW core, the read-only PAGE and the client REFRESH BUTTON.
const SURFACE_CORE = "lib/receptionist/conversation-attention-queue-view.ts";
const PAGE = "app/admin/ai-receptionist/worklist/attention/page.tsx";
const REFRESH_BUTTON = "app/admin/ai-receptionist/worklist/attention/refresh-button.tsx";

/** All three R59 files whose EXECUTABLE source must name no derivation, no ledger, no writer and no execution path. */
const SURFACE_FILES = [SURFACE_CORE, PAGE, REFRESH_BUTTON] as const;

// The R58 runtime BELOW the surface — the ONE seam the page reads through.
const QUEUE_RUNTIME = "server/services/receptionist-attention-queue.ts";

// Module specifiers. The R58 core + the two read models below the runtime name the seams R59 must NOT reach directly.

const QUEUE_RUNTIME_MODULE = "@/server/services/receptionist-attention-queue";
const QUEUE_CORE_MODULE = "@/lib/receptionist/conversation-attention-queue";
const SURFACE_CORE_MODULE = "@/lib/receptionist/conversation-attention-queue-view";
const R39_RUNTIME_MODULE = "@/server/services/receptionist-worklist-read-surface";
const R48_RUNTIME_MODULE = "@/server/services/receptionist-ownership-read-model";
const R38_RUNTIME_MODULE = "@/server/services/receptionist-coordination-worklist";
const R38_CORE_MODULE = "@/lib/receptionist/conversation-coordination-worklist";
const HQ_AUTH_MODULE = "@/server/auth/hq";
const SESSION_AUTH_MODULE = "@/server/auth/session";

// R62 adds two READ dependencies to the page: the org-scoped operator roster READER (a peer read model) and the R54
// reassignment view core (the pure `toReassignmentCandidates` projection). The page composes the reassignment destination
// candidates ONCE (the roster minus the viewer, who owns every reassignable row) and hands the SAME list to each owned
// row's reassign button. Both are read-only — the roster reader is a SELECT, the view core a pure fold — so neither is a
// write path, and neither is a seam BELOW the queue runtime (the roster is a peer read model, not part of the R58 compose).
const ROSTER_MODULE = "@/server/services/receptionist-operators";
const REASSIGN_VIEW_MODULE = "@/lib/receptionist/conversation-reassignment-view";

/** The EXACT import surface the page is authorised to have — the R58 runtime, the R59 view core, the HQ + session gates,
 *  the navigation helper (for the R45 detail link), the client refresh button, the R60 client claim button, the R61
 *  client release button, the R62 client reassign button, `next/link` — and, NEW at R62, the org roster READER + the R54
 *  reassignment view core (to compose the reassign destination candidates once). Nothing else. Each ownership button is a
 *  LEAF affordance: the page hands it one coordination id (and, for reassign, the shared candidate list) and the button
 *  owns its own path (claim → the R46 runtime; release → the R50 runtime; reassign → the R52 runtime) through its own
 *  action, so the page still consumes no write runtime itself. */
const ALLOWED_PAGE_IMPORTS = [
  "next/link",
  HQ_AUTH_MODULE,
  SESSION_AUTH_MODULE,
  QUEUE_RUNTIME_MODULE,
  SURFACE_CORE_MODULE,
  ROSTER_MODULE,
  REASSIGN_VIEW_MODULE,
  "../navigation",
  "./refresh-button",
  "./claim-button",
  "./release-button",
  "./reassign-button",
].sort();

/** The EXACT import surface the client refresh button is authorised to have — React + the Next router, nothing more. */
const ALLOWED_REFRESH_IMPORTS = ["react", "next/navigation"].sort();

/** The two seam entry points the page must NOT name — it reads through the runtime, not around it. */
const QUERY_ORG_WORKLIST = /\bqueryOrgWorklist\b/;
const GET_OWNERSHIP = /\bgetOwnership\b/;

/** The two R58 entry points + the R59 projection. */
const QUEUE_RUNTIME_ENTRY = /\bgetConversationAttentionQueue\b/;
const QUEUE_RUNTIME_DEF = /export async function getConversationAttentionQueue\(/;
const SURFACE_PROJECT_DEF = /export function projectAttentionQueueSurface\(/;

/** The three append-only ownership ledgers + the R36 coordinations base table — the surface names none of them. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const RELEASES_LEDGER = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Any ledger WRITE primitive — the surface records nothing, so it names none. */
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The canonical ownership WRITE runtimes + their pure resolvers — the surface consumes NONE. */
const CANONICAL_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|reassignConversationWork|resolveClaim|resolveRelease|resolveReassignment)\b/;

/** Every WORKLIST-DERIVATION fold — the R38 engine's derivation + ordering AND its reader. The surface DERIVES NO
 *  WORKLIST: it consumes the R58 runtime's already-composed view. */
const WORKLIST_DERIVATION_FNS =
  /\b(?:deriveWorklists|orderWorklistEntries|compareWorklistEntries|deriveCoordinationPriority|belongsToWorklist|toWorklistEntry|getCoordinationWorklists|getCoordinationWorklistsForConversation)\b/;

/** Every OWNERSHIP-DERIVATION fold — the R51 engine's + the R48 read model's ownership projections. The surface DERIVES
 *  OWNERSHIP NOWHERE. NOTE `\bprojectOwnership\b` never matches `projectOwnershipState`/`projectOwnershipEvent` (listed),
 *  and `\bsummariseOwnership\b` never matches the surface's own `ownershipSummaryOf` (a different token). */
const OWNERSHIP_DERIVATION_FNS =
  /\b(?:deriveOwnershipState|isOwnedState|isUnclaimed|isClaimed|isReleased|resolveCurrentOwner|latestReassignmentFor|projectOwnershipState|reconcileOwnershipStates|projectOwnership|projectOwnershipEvent|projectOwner|selectActiveClaims|summariseOwnership)\b/;

/** Every engine EXECUTION function — the surface names none of them: it presents a composed view. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/**
 * The R59 explicit non-goals as SOURCE tokens — the surface presents state; it acts on nothing. NOTE `\bassign\w*`
 * NEVER matches "reassign"/"reassigned" (no word boundary between "re" and "assign"), so the surface's genuine
 * reassignment display is not a false positive; `\bemail\b` NEVER matches the identity field `operatorEmail` (the
 * owner's login email the surface labels a row with) — the token forbids the email CHANNEL, not the operator identity.
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

/** Direct-write / bypass tokens no surface module may name. */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The surface ships — the pure view core, the page, the client refresh button.
// =====================================================================

describe("receptionist attention queue surface — the surface ships", () => {
  it("ships the pure view core, the read-only page and the client refresh button", () => {
    for (const f of SURFACE_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the surface projection", () => {
    expect(codeOf(read(SURFACE_CORE))).toMatch(SURFACE_PROJECT_DEF);
  });

  it("the page default-exports the surface, fed by the R58 runtime", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/export default async function HqReceptionistAttentionQueuePage\(/);
    expect(code).toMatch(QUEUE_RUNTIME_ENTRY);
    expect(code).toMatch(/\bprojectAttentionQueueSurface\b/);
  });

  it("the refresh button exports the read-only re-read control", () => {
    const code = codeOf(read(REFRESH_BUTTON));
    expect(code).toMatch(/export function AttentionQueueRefreshButton\(/);
  });
});

// =====================================================================
// 1. IT CONSUMES ONLY THE R58 RUNTIME — one server-service dependency; no read path around it.
// =====================================================================

describe("receptionist attention queue surface — consumes only the R58 runtime", () => {
  it("the page's server-service imports are EXACTLY the R58 queue runtime + the org roster READER — two read models, no write runtime, no seam below the runtime", () => {
    const specs = importSpecifiers(codeOf(read(PAGE)));
    // R62 adds the org roster reader (a peer READ model, used only to compose the reassign destination candidates). It is
    // NOT a seam below the queue runtime and NOT a write runtime — the page still reaches no R39/R48/R38 seam and no writer.
    expect(specs.filter((s) => s.startsWith("@/server/services/")).sort()).toEqual(
      [QUEUE_RUNTIME_MODULE, ROSTER_MODULE].sort(),
    );
  });

  it("the page's whole import surface is EXACTLY the authorised set — runtime, view core, gates, nav, refresh, link", () => {
    expect([...importSpecifiers(codeOf(read(PAGE)))].sort()).toEqual(ALLOWED_PAGE_IMPORTS);
  });

  it("the page reaches NO seam below the runtime — not R39, not R48, not the R38 reader/core, not a client", () => {
    const specs = importSpecifiers(codeOf(read(PAGE)));
    expect(specs).not.toContain(R39_RUNTIME_MODULE);
    expect(specs).not.toContain(R48_RUNTIME_MODULE);
    expect(specs).not.toContain(R38_RUNTIME_MODULE);
    expect(specs).not.toContain(R38_CORE_MODULE);
    expect(specs).not.toContain(QUEUE_CORE_MODULE); // it reads the composed view, not the R58 core directly
    expect(specs).not.toContain("@/lib/supabase/admin");
  });

  it("the page names NEITHER seam function and NO R38 reader/derivation — it reads through the runtime", () => {
    const code = codeOf(read(PAGE));
    expect(code, "must not name the R39 worklist seam").not.toMatch(QUERY_ORG_WORKLIST);
    expect(code, "must not name the R48 ownership seam").not.toMatch(GET_OWNERSHIP);
    expect(code, "must not name the R38 reader").not.toMatch(/\bgetCoordinationWorklists\b/);
    expect(code, "must not name the R38 derivation").not.toMatch(/\bderiveWorklists\b/);
  });

  it("the page opens no database client and issues no query of its own — no read path around the runtime", () => {
    const code = codeOf(read(PAGE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.select\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });

  it("the pure view core consumes ONLY the R58 core module — it names no seam, no table and opens no client", () => {
    const code = codeOf(read(SURFACE_CORE));
    expect(importSpecifiers(code)).toEqual([QUEUE_CORE_MODULE]);
    expect(code, "core must not name the R39 seam").not.toMatch(QUERY_ORG_WORKLIST);
    expect(code, "core must not name the R48 seam").not.toMatch(GET_OWNERSHIP);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });

  it("R59 is the page consumer of the R58 runtime the R58 doc anticipated — the runtime is imported by the page", () => {
    expect(importersOf(QUEUE_RUNTIME_MODULE)).toContain(PAGE);
    // And the R59 view core is consumed ONLY by the page (no other UI or server module reads it).
    expect(importersOf(SURFACE_CORE_MODULE)).toEqual([PAGE]);
  });
});

// =====================================================================
// 2. THE RUNTIME + ENGINES STAY AUTHORITATIVE — R59 adds no seam; each entry is defined once; the core is type-only.
// =====================================================================

describe("receptionist attention queue surface — the runtime and engines remain authoritative", () => {
  it("getConversationAttentionQueue is DEFINED in exactly one module — the R58 runtime (R59 adds no queue runtime)", () => {
    expect(namersOf(QUEUE_RUNTIME_DEF)).toEqual([QUEUE_RUNTIME]);
  });

  it("the surface projection is DEFINED in exactly one module — this pure view core", () => {
    expect(namersOf(SURFACE_PROJECT_DEF)).toEqual([SURFACE_CORE]);
  });

  it("no R59 file names a worklist- or ownership-derivation fold", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must name no worklist-derivation fold`).not.toMatch(WORKLIST_DERIVATION_FNS);
      expect(codeOf(read(f)), `${f} must name no ownership-derivation fold`).not.toMatch(OWNERSHIP_DERIVATION_FNS);
    }
  });

  it("no R59 file re-derives or records a claim/release/reassignment (no runtime, no resolver, no writer)", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name a canonical write runtime or resolver`).not.toMatch(CANONICAL_WRITE_RUNTIMES);
      expect(code, `${f} must not name a ledger write primitive`).not.toMatch(WRITE_PRIMITIVE);
    }
  });

  it("the view core imports the R58 core as TYPE-ONLY — it CANNOT call a read or a derivation, so it derives nothing", () => {
    const code = codeOf(read(SURFACE_CORE));
    expect(code).toMatch(/import type \{[\s\S]*?\} from "@\/lib\/receptionist\/conversation-attention-queue"/);
    // No @/server import at all — the core sits above the runtime.
    expect(code.includes("@/server/")).toBe(false);
  });
});

// =====================================================================
// 3. ORGANISATION ISOLATION — HQ-gated, org from the session (never a parameter), threaded into the runtime.
// =====================================================================

describe("receptionist attention queue surface — organisation isolation is preserved", () => {
  it("the page is HQ-gated and resolves the org from the SESSION, never from the client", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
  });

  it("every runtime read is org-scoped by ctx.org.id — the queue read AND the R62 roster read are both filtered by the session org", () => {
    const code = codeOf(read(PAGE));
    // TWO org-scoped reads now — the R58 queue runtime and the R62 operator roster reader — each filtered by the SESSION
    // org id, never a client value. There is no third: exactly two `org_id: ctx.org.id` filters, both on a READ.
    expect(code.match(/org_id:\s*ctx\.org\.id/g) ?? []).toHaveLength(2);
    expect(code).toMatch(/getConversationAttentionQueue\(\{[\s\S]*?org_id:\s*ctx\.org\.id/);
    expect(code).toMatch(/listOrgOperators\(\s*\{\s*org_id:\s*ctx\.org\.id/);
  });

  it("the surface takes NO parameter — it cannot be pointed at another org", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/export default async function HqReceptionistAttentionQueuePage\(\s*\)/);
    // All THREE ownership affordances are DELEGATED to their client buttons (the page renders each on eligible rows and
    // hands it one coordination id — plus, for reassign, the shared candidate list): the page itself still names NO write
    // runtime, NO write primitive, and NO ownership action — not the R47/R60 claim actions
    // `claimWorkItemAction`/`claimFromQueueAction`, not the R61 release action `releaseFromQueueAction`, and not the R62
    // reassign action `reassignFromQueueAction`. Each path lives in its button + that button's own action, so the page
    // derives nothing and executes nothing.
    expect(code).not.toMatch(CANONICAL_WRITE_RUNTIMES);
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(/\bclaimWorkItemAction\b/);
    expect(code).not.toMatch(/\bclaimFromQueueAction\b/);
    expect(code).not.toMatch(/\breleaseFromQueueAction\b/);
    expect(code).not.toMatch(/\breassignFromQueueAction\b/);
  });

  it("the pure core + refresh button are ORG-AGNOSTIC — they name no org token", () => {
    for (const f of [SURFACE_CORE, REFRESH_BUTTON]) {
      const code = codeOf(read(f));
      expect(code, `${f} must name no org_id`).not.toMatch(/\borg_id\b/);
      expect(code, `${f} must name no ctx.org`).not.toMatch(/ctx\.org/);
    }
  });
});

// =====================================================================
// 4. THE AUDIT STAYS APPEND-ONLY — the surface is read-only; it joins no ledger-reader set.
// =====================================================================

describe("receptionist attention queue surface — the append-only audit is preserved", () => {
  it("every R59 file is read-only — no .from, no insert/update/delete/upsert, no write primitive, no RPC", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/\.from\(/);
      expect(code, `${f}`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f}`).not.toMatch(WRITE_PRIMITIVE);
      expect(code, `${f}`).not.toMatch(/\.rpc\(/);
    }
  });

  it("the surface JOINS NO ledger-reader set — it reads no ownership ledger and no coordinations table", () => {
    for (const ledger of [CLAIM_LEDGER, RELEASES_LEDGER, REASSIGNMENTS_LEDGER, COORDINATIONS_TABLE]) {
      const readers = readersOf(ledger);
      for (const f of SURFACE_FILES) {
        expect(readers, `${f} must read no ledger table`).not.toContain(f);
      }
    }
  });
});

// =====================================================================
// 5. NO EXECUTION PATH IS INTRODUCED — the surface presents a view and re-reads it; it acts on nothing.
// =====================================================================

describe("receptionist attention queue surface — no execution path is introduced", () => {
  it("no R59 file names any engine EXECUTION function", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no R59 file names any OTHER engine writer", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no R59 file names an R59 non-goal token (dispatch/notify/schedule/promote/complete/…)", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no R59 file reaches a transport / calendar / quote / voice / whatsapp / email / memory / generation path", () => {
    for (const f of SURFACE_FILES) {
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

  it("the refresh button's ONLY effect is a re-read — router.refresh(), never a write, an action or a fetch", () => {
    const code = codeOf(read(REFRESH_BUTTON));
    expect(code, "refresh button re-reads the page").toMatch(/router\.refresh\(\)/);
    // It navigates nowhere else, issues no fetch, and imports no server module or action.
    expect(code).not.toMatch(/router\.(?:push|replace)\(/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/"use server"/);
    expect(importSpecifiers(code).filter((s) => s.startsWith("@/server/"))).toEqual([]);
    expect(importSpecifiers(code).some((s) => s.includes("action"))).toBe(false);
  });
});

// =====================================================================
// 6. THE MODULE BOUNDARIES HOLD — server-component page; client refresh button; shared deterministic view core.
// =====================================================================

describe("receptionist attention queue surface — the module boundaries hold", () => {
  it("the page is a SERVER COMPONENT — neither a client component nor a server action", () => {
    const head = read(PAGE).trimStart();
    expect(head.startsWith('"use client"')).toBe(false);
    expect(head.startsWith('"use server"')).toBe(false);
  });

  it("the refresh button IS a client component importing ONLY React + the Next router", () => {
    const head = read(REFRESH_BUTTON).trimStart();
    expect(head.startsWith('"use client"')).toBe(true);
    expect([...importSpecifiers(codeOf(read(REFRESH_BUTTON)))].sort()).toEqual(ALLOWED_REFRESH_IMPORTS);
  });

  it("the pure view core is a shared module (NOT server-only) importing only the R58 attention-queue core", () => {
    const specs = importSpecifiers(codeOf(read(SURFACE_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual([QUEUE_CORE_MODULE]);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(SURFACE_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });
});

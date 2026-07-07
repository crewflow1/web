import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK CLAIM SURFACE governance invariants
 * (the AI Receptionist Programme, R47 — CONVERSATION WORK CLAIM SURFACE).
 *
 * R46 shipped the claim capability: the pure `resolveClaim`, the `claimConversationWork` runtime, and the append-only,
 * conflict-guarded `receptionist_conversation_claims` ledger. R47 is its FIRST operator-facing use — the single
 * authorised UI entry point for a human operator to claim ownership of a Conversation Worklist item. Its law is exact:
 * "the surface consumes ONLY the authorised runtime and never bypasses it; the claim runtime remains authoritative; the
 * Coordination Engine remains authoritative; organisation isolation is preserved; the audit remains append-only; and NO
 * execution path is introduced." This suite proves that contract as a matter of SOURCE, not discipline — the house bar
 * of the R30→R46 invariant suites:
 *
 *   • THE SURFACE CONSUMES ONLY THE RUNTIME — the ONE claim path is the server action `claimWorkItemAction`, which calls
 *     the R46 runtime `claimConversationWork` AND ONLY that. Across all non-test source the ledger write primitive
 *     (`record_receptionist_conversation_claim`) is named by EXACTLY ONE module — the R46 runtime — so R47 added no
 *     second write path. The action opens no database client, names no write primitive, issues no RPC and no
 *     insert/update/delete: it cannot bypass the runtime because its only claim mechanism IS the runtime.
 *   • THE CLAIM RUNTIME STAYS AUTHORITATIVE — `claimConversationWork` is DEFINED once (the R46 runtime); the action
 *     consumes it and re-implements no claim recording; the pure view core records nothing and resolves no claim.
 *   • THE COORDINATION ENGINE STAYS AUTHORITATIVE — the page reads the coordination through the R37 single-item seam
 *     `getCoordinationById`; neither the ownership reader nor the action derives a coordination (they name no engine
 *     execution function and no coordinations table); the claim still guards against a REAL coordination via the R46
 *     runtime's storage primitive, unchanged.
 *   • ORGANISATION ISOLATION IS PRESERVED — the action is HQ-gated (`requireHqPage`) and scopes the claim to the org
 *     resolved from the SESSION (`requireOrgContext` → `ctx.org.id`), NEVER from a parameter; the page resolves the org
 *     the same way for BOTH reads; and the ownership reader's `org_id` filter is MANDATORY on the query.
 *   • THE AUDIT STAYS APPEND-ONLY — the ownership reader performs ONLY a SELECT (no insert/update/delete/upsert, no
 *     write primitive), and the claims ledger is read through READ-ONLY seams only (this surface reader and the R48
 *     ownership read model — both SELECT-only projections); R47 adds no writer and no migration, so the R46 append-only
 *     ledger is the sole, untouched record.
 *   • NO EXECUTION PATH IS INTRODUCED — none of the claim-specific surface files (view core, reader, action, panel)
 *     names any engine execution function, any other engine writer, or any R46/R47 non-goal token (assign / dispatch /
 *     notify / schedule / enqueue / retry / promote / complete / close). The surface displays ownership and records a
 *     claim through the runtime; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the action is a server action ("use server"), the panel is a client component
 *     ("use client") whose only claim path is the action, the reader is server-only, and the view core is a shared pure
 *     module importing only the R46 claim types.
 *
 * The surface's runtime behaviour (reader + runtime composition) is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-claim-surface-pipeline.test.ts, and the pure view core exhaustively
 * in __tests__/receptionist/conversation-claim-view.test.ts. This tier is HERMETIC — a filesystem scan over
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

// The R46 capability (unchanged by R47) — the runtime that records a claim.
const RUNTIME = "server/services/receptionist-claim.ts";

// The R47 surface — the pure view core, the ownership reader, the server action, the client panel, the wired page.
const VIEW_CORE = "lib/receptionist/conversation-claim-view.ts";
const READER = "server/services/receptionist-claim-view.ts";
const ACTION = "app/admin/ai-receptionist/worklist/[coordinationId]/claim-actions.ts";
const PANEL = "app/admin/ai-receptionist/worklist/[coordinationId]/claim-panel.tsx";
const PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/page.tsx";

// The R51 Ownership State Engine runtime — since R51 the SECOND read-only reader over the append-only claims ledger.
// (The R48 read model reads the ledger no more; it consumes this engine, which is now the engine-side ledger reader.)
const OWNERSHIP_STATE_RUNTIME = "server/services/receptionist-ownership-state.ts";

/** The claim-specific surface files whose EXECUTABLE source must name no execution path. Excludes the page, which
 *  legitimately renders R45's read-only engine display (fulfilment/lifecycle/etc.). */
const CLAIM_SURFACE_FILES = [VIEW_CORE, READER, ACTION, PANEL] as const;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The claim ledger's write primitive — the function an auditor would call to file a claim. */
const WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The R46 runtime entry point — the ONE governed mechanism that records an operator claim. */
const RUNTIME_ENTRY = /\bclaimConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function claimConversationWork\(/;

/** The R47 surface entry points — the server action, the ownership reader, the pure projections. */
const ACTION_ENTRY_DEF = /export async function claimWorkItemAction\(/;
const READER_ENTRY_DEF = /export async function getClaimForCoordination\(/;

/** The claims ledger table + the R47 read seams. */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const COORDINATION_READ = /\bgetCoordinationById\b/;
const OWNERSHIP_READ = /\bgetClaimForCoordination\b/;

/** The R36 coordinations base table — a claim reader/action must derive none. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the surface names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The R46/R47 explicit non-goals as SOURCE tokens — the surface records ownership; it acts on nothing. */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i,
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing / release
] as const;

/** Direct-write / bypass tokens no claim-surface module may name (the ledger is written ONLY through the runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The surface ships, with its single entry points.
// =====================================================================

describe("receptionist claim surface — the surface ships", () => {
  it("ships the pure view core, the ownership reader, the server action and the client panel", () => {
    for (const f of [VIEW_CORE, READER, ACTION, PANEL]) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure view core exports the ownership + outcome projections", () => {
    const code = codeOf(read(VIEW_CORE));
    expect(code).toMatch(/export function projectClaimOwner\(/);
    expect(code).toMatch(/export function projectClaimOwnership\(/);
    expect(code).toMatch(/export function describeClaimOutcome\(/);
  });

  it("the ownership reader exports the single org-scoped read seam", () => {
    expect(codeOf(read(READER))).toMatch(READER_ENTRY_DEF);
  });

  it("the server action exports the single claim action", () => {
    expect(codeOf(read(ACTION))).toMatch(ACTION_ENTRY_DEF);
  });

  it("the detail page renders the claim panel, fed by the org-scoped ownership reader", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/<ClaimPanel\b/);
    expect(code).toMatch(OWNERSHIP_READ);
  });
});

// =====================================================================
// 1. THE SURFACE CONSUMES ONLY THE RUNTIME — one claim path, the runtime; no bypass, no second writer.
// =====================================================================

describe("receptionist claim surface — consumes only the authorised runtime, never bypasses it", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("across all source, the ledger write primitive is named by EXACTLY ONE module — the R46 runtime", () => {
    // R47 introduced NO new writer: if this ever grows, a surface bypass has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("no app/ file records a claim directly — the surface writes through the runtime, not the ledger", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("the server action's ONE claim path is the runtime entry claimConversationWork", () => {
    const code = codeOf(read(ACTION));
    expect(code).toMatch(RUNTIME_ENTRY);
    expect(importSpecifiers(code)).toContain("@/server/services/receptionist-claim");
  });

  it("the server action opens no database client, names no write primitive, issues no RPC and no direct write", () => {
    const code = codeOf(read(ACTION));
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(importSpecifiers(code)).not.toContain("@/lib/supabase/admin");
  });

  it("the client panel's ONLY claim path is the server action — it reaches no runtime, reader or client itself", () => {
    const code = codeOf(read(PANEL));
    const specs = importSpecifiers(code);
    expect(specs).toContain("./claim-actions");
    expect(code).toMatch(/\bclaimWorkItemAction\b/);
    // No server module, no database client, no write primitive, no direct query.
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
    expect(specs).not.toContain("@/lib/supabase/admin");
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/\.rpc\(/);
  });
});

// =====================================================================
// 2. THE CLAIM RUNTIME STAYS AUTHORITATIVE — defined once; the surface consumes it and records nothing itself.
// =====================================================================

describe("receptionist claim surface — the claim runtime remains authoritative", () => {
  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RUNTIME_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("claimConversationWork is DEFINED in exactly one module — the R46 runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("the pure view core records nothing and resolves no claim — it is display only", () => {
    const code = codeOf(read(VIEW_CORE));
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(/\bresolveClaim\b/);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\(/);
  });

  it("the action re-implements no claim recording — it names no other engine writer", () => {
    const code = codeOf(read(ACTION));
    expect(code.match(/record_receptionist_conversation_\w+/g)).toBeNull();
  });
});

// =====================================================================
// 3. THE COORDINATION ENGINE STAYS AUTHORITATIVE — the page reads it via R37; the surface derives none.
// =====================================================================

describe("receptionist claim surface — the Coordination Engine stays authoritative", () => {
  it("the page reads the coordination through the R37 authoritative single-item seam getCoordinationById", () => {
    expect(codeOf(read(PAGE))).toMatch(COORDINATION_READ);
  });

  it("neither the ownership reader nor the action derives a coordination (no engine fn, no coordinations table)", () => {
    for (const f of [READER, ACTION]) {
      const code = codeOf(read(f));
      expect(code, `${f} must derive no coordination`).not.toMatch(ENGINE_EXECUTION_FNS);
      expect(code, `${f} must not read the coordinations ledger`).not.toMatch(COORDINATIONS_TABLE);
    }
  });

  it("the claim still guards against a REAL coordination via the R46 runtime → its storage primitive (unchanged)", () => {
    // The runtime routes every claim through the SECURITY DEFINER writer, whose coordination-authority guard is pinned
    // by the R46 suite. Here we assert the seam is intact: the runtime still names the write primitive.
    expect(codeOf(read(RUNTIME))).toMatch(WRITE_FN);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — HQ-gated, org from the session (never a parameter), the read filter is mandatory.
// =====================================================================

describe("receptionist claim surface — organisation isolation is preserved", () => {
  it("the action is HQ-gated and scopes the claim to the org from the SESSION, never from a parameter", () => {
    const code = codeOf(read(ACTION));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    expect(code).toMatch(/org_id:\s*ctx\.org\.id/);
    // The action's only parameter is the coordination id — the org is NEVER a parameter.
    expect(code).toMatch(/claimWorkItemAction\(\s*coordinationId:\s*string\s*\)/);
  });

  it("the page is HQ-gated and resolves the org from the session for BOTH reads", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    // Both the coordination read and the ownership read are org-scoped by ctx.org.id.
    expect(code.match(/org_id:\s*ctx\.org\.id/g) ?? []).toHaveLength(2);
  });

  it("the viewer identity comes from the authenticated HQ gate, not the client", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/const user = await requireHqPage\(\)/);
    expect(code).toMatch(/viewerOperatorId:\s*user\.id/);
  });

  it("the ownership reader org-scopes EVERY read — the org_id filter is mandatory", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.eq\(\s*["']org_id["']/);
    expect(code).toMatch(/\.eq\(\s*["']coordination_id["']/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — the read is read-only; the ledger is read through one seam; R47 adds no writer.
// =====================================================================

describe("receptionist claim surface — the append-only audit is preserved", () => {
  const ledgerReaders = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_LEDGER.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the ownership reader performs ONLY a SELECT — no insert/update/delete/upsert, no write primitive, no RPC", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.select\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("the claims ledger is READ through READ-ONLY seams only — this surface reader and the R51 ownership state engine", () => {
    // The runtime writes the ledger through the RPC (it never names the table); the readers are the only table readers.
    // R51 moved ownership derivation into the state engine, whose runtime is now the SECOND read-only seam over the
    // claims ledger (the R48 read model reads the ledger no more — it consumes the engine). Both are SELECT-only
    // projections, so a growth in this set beyond the two known readers would mean a new, un-vetted ledger reader appeared.
    expect(ledgerReaders).toEqual([READER, OWNERSHIP_STATE_RUNTIME].sort());
  });

  it("no claim-surface module directly mutates the ledger — the append-only R46 writer is the only path", () => {
    for (const f of CLAIM_SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
    }
  });
});

// =====================================================================
// 6. NO EXECUTION PATH IS INTRODUCED — the surface displays ownership and records a claim; it acts on nothing.
// =====================================================================

describe("receptionist claim surface — no execution path is introduced", () => {
  it("no claim-specific surface file names any engine EXECUTION function", () => {
    for (const f of CLAIM_SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no claim-specific surface file names any OTHER engine writer", () => {
    for (const f of CLAIM_SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code.match(/record_receptionist_conversation_\w+/g), `${f}`).toBeNull();
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no claim-specific surface file names an R46/R47 non-goal token (assign/dispatch/notify/…/close)", () => {
    for (const f of CLAIM_SURFACE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no claim-specific surface file reaches a transport / calendar / quote / generation path", () => {
    for (const f of CLAIM_SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });

  it("the action refreshes the surface after a claim, so the ownership display re-reads the recorded fact", () => {
    expect(codeOf(read(ACTION))).toMatch(/revalidatePath\(/);
    expect(codeOf(read(PANEL))).toMatch(/router\.refresh\(/);
  });
});

// =====================================================================
// 7. THE MODULE BOUNDARIES HOLD — server action, client panel, server-only reader, shared pure view core.
// =====================================================================

describe("receptionist claim surface — the module boundaries hold", () => {
  it("the action is a SERVER ACTION — its first directive is \"use server\"", () => {
    expect(read(ACTION).trimStart().startsWith('"use server"')).toBe(true);
  });

  it("the panel is a CLIENT COMPONENT — its first directive is \"use client\"", () => {
    expect(read(PANEL).trimStart().startsWith('"use client"')).toBe(true);
  });

  it("the ownership reader is server-only — it is the one place the ledger is read back", () => {
    expect(importSpecifiers(codeOf(read(READER)))).toContain("server-only");
  });

  it("the pure view core is a shared module (NOT server-only) importing only the R46 claim types", () => {
    const specs = importSpecifiers(codeOf(read(VIEW_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual(["./conversation-claim"]);
  });

  it("the view core touches no I/O — no client, no fetch, no clock, no RNG", () => {
    const code = codeOf(read(VIEW_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });
});

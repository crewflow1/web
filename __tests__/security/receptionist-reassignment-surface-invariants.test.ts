import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CONVERSATION WORK REASSIGNMENT SURFACE governance invariants
 * (the AI Receptionist Programme, R54 — CONVERSATION WORK REASSIGNMENT SURFACE).
 *
 * R52 shipped the canonical TRANSFER capability: the pure `resolveReassignment`, the `reassignConversationWork` runtime,
 * and the append-only, ownership-guarded `receptionist_conversation_claim_reassignments` ledger. R53 taught the Ownership
 * State Engine (and the R48 Ownership Read Model above it) to FOLD the transfer chain into the CURRENT owner. R54 is the
 * FIRST operator-facing use of that capability — the single authorised UI entry point for a human operator to transfer
 * ownership of a Conversation Worklist item to ANOTHER authorised operator. Its law is exact: "the surface consumes ONLY
 * the authorised runtime and never bypasses it; the Reassignment Runtime remains authoritative; the Ownership State
 * Engine and Ownership Read Model remain authoritative; organisation isolation is preserved; the audit remains
 * append-only; and NO execution path is introduced." This suite proves that contract as a matter of SOURCE, not
 * discipline — the house bar of the R30→R52 invariant suites:
 *
 *   • THE SURFACE CONSUMES ONLY THE RUNTIME — the ONE reassignment path is the server action `reassignWorkItemAction`,
 *     which calls the R52 runtime `reassignConversationWork` AND ONLY that. Across all non-test source the reassignment
 *     ledger write primitive (`record_receptionist_conversation_claim_reassignment`) is named by EXACTLY ONE module — the
 *     R52 runtime — so R54 added no second write path. The action opens no database client, names no write primitive,
 *     issues no RPC and no insert/update/delete: it cannot bypass the runtime because its only transfer mechanism IS the
 *     runtime.
 *   • THE REASSIGNMENT RUNTIME STAYS AUTHORITATIVE — `reassignConversationWork` is DEFINED once (the R52 runtime); the
 *     action consumes it and re-implements no transfer recording; the pure view core records nothing and decides no
 *     reassignment (it names neither the runtime nor the pure resolver `resolveReassignment`).
 *   • THE OWNERSHIP READ MODEL / STATE ENGINE STAY AUTHORITATIVE — the surface reads the CURRENT owner ONLY through the
 *     R48 read model seam `getOwnership` (page + action); it re-implements no ownership derivation, names no state-engine
 *     fold function, and reads the reassignments/claims/releases ledgers through NO direct table access. The source
 *     operator the action transfers FROM is the RECORDED current owner (read from the read model), never a client value.
 *   • THE COORDINATION ENGINE STAYS AUTHORITATIVE — the page reads the coordination through the R37 single-item seam
 *     `getCoordinationById` (existence + isolation); neither the roster reader nor the action derives a coordination.
 *   • ORGANISATION ISOLATION IS PRESERVED — the action + page are HQ-gated (`requireHqPage`) and scope EVERY read/write to
 *     the org resolved from the SESSION (`requireOrgContext` → `ctx.org.id`), NEVER from a parameter; the roster reader's
 *     `org_id` filter is MANDATORY on the query, so a transfer can only ever be offered to an operator of the viewer's own
 *     organisation and recorded within it.
 *   • THE AUDIT STAYS APPEND-ONLY — the roster reader performs ONLY a SELECT (over `memberships`/`users`, never a ledger),
 *     no surface module issues a direct write, and R54 adds no writer and no migration, so the R52 append-only ledger is
 *     the sole, untouched record of a transfer.
 *   • NO EXECUTION PATH IS INTRODUCED — none of the reassignment surface files (view core, roster reader, action, panel,
 *     page) names any engine execution function, any other engine writer, or any R54 non-goal token (assign / automate /
 *     dispatch / notify / schedule / fulfil / promote / enqueue / retry / complete / close). The surface displays
 *     ownership and records a transfer through the runtime; it acts on nothing.
 *   • THE MODULE BOUNDARIES HOLD — the action is a server action ("use server"), the panel is a client component
 *     ("use client") whose only transfer path is the action, the roster reader is server-only, and the view core is a
 *     shared pure module importing only the R52 + R48 types.
 *
 * The surface's runtime behaviour (roster + read model + runtime composition) is pinned against real Postgres in
 * __tests__/integration/receptionist/conversation-reassignment-surface-pipeline.test.ts, and the pure view core
 * exhaustively in __tests__/receptionist/conversation-reassignment-view.test.ts. This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive match nor trip
 * a negative.
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
        if (!full.endsWith("/lib/supabase/types.ts")) out.push(full);
      }
    }
  };
  for (const r of roots) visit(resolve(ROOT, r));
  return out;
}

/** A repo-relative, POSIX-style path for stable assertions across platforms. */
const rel = (full: string) => relative(ROOT, full).split(sep).join("/");

// The R52 capability (unchanged by R54) — the runtime that records a transfer.
const RUNTIME = "server/services/receptionist-reassignment.ts";

// The R54 surface — the pure view core, the roster reader, the server action, the client panel, the wired page.
const VIEW_CORE = "lib/receptionist/conversation-reassignment-view.ts";
const READER = "server/services/receptionist-operators.ts";
const ACTION = "app/admin/ai-receptionist/worklist/[coordinationId]/reassign/reassign-actions.ts";
const PANEL = "app/admin/ai-receptionist/worklist/[coordinationId]/reassign/reassign-panel.tsx";
const PAGE = "app/admin/ai-receptionist/worklist/[coordinationId]/reassign/page.tsx";

// The R48 Ownership Read Model seam — the surface reads the CURRENT owner through it (never a ledger directly).
const OWNERSHIP_READER = "server/services/receptionist-ownership-read-model.ts";
// The R51 Ownership State Engine runtime — since R53 the SOLE TS seam that folds the reassignments ledger.
const OWNERSHIP_STATE_RUNTIME = "server/services/receptionist-ownership-state.ts";

/** The reassignment-specific surface files whose EXECUTABLE source must name no execution path — including the page,
 *  which is a NEW dedicated route (unlike R47's shared detail page) that renders only the ownership + transfer panel. */
const SURFACE_FILES = [VIEW_CORE, READER, ACTION, PANEL, PAGE] as const;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The reassignment ledger's write primitive — the function an auditor would call to file a transfer. */
const WRITE_FN = /\brecord_receptionist_conversation_claim_reassignment\b/;

/** The R52 runtime entry point — the ONE governed mechanism that records an operator-to-operator transfer. */
const RUNTIME_ENTRY = /\breassignConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function reassignConversationWork\(/;
/** The R52 pure resolver — the surface consumes the runtime, never re-decides a transfer itself. */
const RESOLVE_REASSIGNMENT = /\bresolveReassignment\b/;

/** The R54 surface entry points — the server action, the roster reader, the pure projections. */
const ACTION_ENTRY_DEF = /export async function reassignWorkItemAction\(/;
const READER_ENTRY_DEF = /export async function listOrgOperators\(/;

/** The R48 ownership read seam + the R37 coordination read seam + the R54 roster read seam. */
const OWNERSHIP_READ = /\bgetOwnership\b/;
const COORDINATION_READ = /\bgetCoordinationById\b/;
const ROSTER_READ = /\blistOrgOperators\b/;

/** The R36 coordinations base table — a reassignment reader/action must derive none. */
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;
/** The R46/R50/R52 ledger tables — no surface file reads any of them directly (ownership comes THROUGH the read model). */
const CLAIMS_TABLE = /\breceptionist_conversation_claims\b/;
const RELEASES_TABLE = /\breceptionist_conversation_claim_releases\b/;
const REASSIGNMENTS_TABLE = /\breceptionist_conversation_claim_reassignments\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the surface names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveRelease|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The R51 Ownership State engine fold functions — the surface re-implements none (it consumes getOwnership). */
const STATE_ENGINE_FNS =
  /\b(?:projectOwnershipState|reconcileOwnershipStates|deriveOwnershipState|getCoordinationOwnershipState|listCoordinationOwnershipStates)\b/;

/** The R54 explicit non-goals as SOURCE tokens — the surface records a HANDING-ON of ownership; it acts on nothing.
 *  `reassign` is DELIBERATELY ABSENT: it is R54's CAPABILITY, not a non-goal. Crucially `\bassign\w*` NEVER matches
 *  "reassign" (no word boundary between "re" and "assign"), so the surface's own capability tokens can never trip it. */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // automatic assignment (NEVER matches "reassign")
  /\bautomat\w*/i, // automatically assign work
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

/** Direct-write / bypass tokens no surface module may name (the ledger is written ONLY through the runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The surface ships, with its single entry points.
// =====================================================================

describe("receptionist reassignment surface — the surface ships", () => {
  it("ships the pure view core, the roster reader, the server action, the client panel and the page", () => {
    for (const f of SURFACE_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure view core exports the transfer view + outcome projections", () => {
    const code = codeOf(read(VIEW_CORE));
    expect(code).toMatch(/export function projectReassignmentView\(/);
    expect(code).toMatch(/export function describeReassignmentOutcome\(/);
  });

  it("the roster reader exports the single org-scoped read seam", () => {
    expect(codeOf(read(READER))).toMatch(READER_ENTRY_DEF);
  });

  it("the server action exports the single reassignment action", () => {
    expect(codeOf(read(ACTION))).toMatch(ACTION_ENTRY_DEF);
  });

  it("the page renders the reassign panel, fed by the org-scoped ownership + roster reads", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/<ReassignPanel\b/);
    expect(code).toMatch(OWNERSHIP_READ);
    expect(code).toMatch(ROSTER_READ);
  });
});

// =====================================================================
// 1. THE SURFACE CONSUMES ONLY THE RUNTIME — one transfer path, the runtime; no bypass, no second writer.
// =====================================================================

describe("receptionist reassignment surface — consumes only the authorised runtime, never bypasses it", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("across all source, the reassignment write primitive is named by EXACTLY ONE module — the R52 runtime", () => {
    // R54 introduced NO new writer: if this ever grows, a surface bypass has appeared.
    expect(writers).toEqual([RUNTIME]);
  });

  it("no app/ file records a reassignment directly — the surface writes through the runtime, not the ledger", () => {
    expect(writers.filter((p) => p.startsWith("app/"))).toEqual([]);
  });

  it("the server action's ONE transfer path is the runtime entry reassignConversationWork", () => {
    const code = codeOf(read(ACTION));
    expect(code).toMatch(RUNTIME_ENTRY);
    expect(importSpecifiers(code)).toContain("@/server/services/receptionist-reassignment");
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

  it("the client panel's ONLY transfer path is the server action — it reaches no runtime, reader or client itself", () => {
    const code = codeOf(read(PANEL));
    const specs = importSpecifiers(code);
    expect(specs).toContain("./reassign-actions");
    expect(code).toMatch(/\breassignWorkItemAction\b/);
    // No server module, no database client, no write primitive, no direct query.
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
    expect(specs).not.toContain("@/lib/supabase/admin");
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/\.rpc\(/);
  });
});

// =====================================================================
// 2. THE REASSIGNMENT RUNTIME STAYS AUTHORITATIVE — defined once; the surface consumes it and records/decides nothing.
// =====================================================================

describe("receptionist reassignment surface — the reassignment runtime remains authoritative", () => {
  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RUNTIME_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("reassignConversationWork is DEFINED in exactly one module — the R52 runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("the pure view core records nothing and decides no reassignment — it is display only", () => {
    const code = codeOf(read(VIEW_CORE));
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(RESOLVE_REASSIGNMENT);
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\(/);
  });

  it("no surface file re-decides a transfer — none names the pure resolver resolveReassignment", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must not re-decide a reassignment`).not.toMatch(RESOLVE_REASSIGNMENT);
    }
  });

  it("the action re-implements no transfer recording — it names no engine writer primitive", () => {
    const code = codeOf(read(ACTION));
    expect(code.match(/record_receptionist_conversation_\w+/g)).toBeNull();
  });
});

// =====================================================================
// 3. THE OWNERSHIP READ MODEL / STATE ENGINE STAY AUTHORITATIVE — the surface reads the current owner THROUGH the read
//    model; it derives no ownership and reads no ledger directly.
// =====================================================================

describe("receptionist reassignment surface — the Ownership Read Model + State Engine stay authoritative", () => {
  it("the R48 read model + R51 state engine spines ship (the authority the surface reads ownership through)", () => {
    expect(existsSync(resolve(ROOT, OWNERSHIP_READER)), OWNERSHIP_READER).toBe(true);
    expect(existsSync(resolve(ROOT, OWNERSHIP_STATE_RUNTIME)), OWNERSHIP_STATE_RUNTIME).toBe(true);
  });

  it("the page + action read the CURRENT owner ONLY through the read model seam getOwnership", () => {
    for (const f of [PAGE, ACTION]) {
      const code = codeOf(read(f));
      expect(code, `${f} must read ownership through getOwnership`).toMatch(OWNERSHIP_READ);
      expect(importSpecifiers(code)).toContain("@/server/services/receptionist-ownership-read-model");
    }
  });

  it("the action transfers FROM the recorded current owner — the source is read from ownership, never a client value", () => {
    // The `from_operator` id is the ownership read model's owner, not an action parameter: the client supplies only WHICH
    // coordination and WHICH destination. This is what keeps a client from forging the source of a transfer.
    const code = codeOf(read(ACTION));
    expect(code).toMatch(/from_operator:\s*\{\s*id:\s*ownership\.owner\.operatorId/);
    expect(code).not.toMatch(/from_operator:\s*\{[^}]*input\./);
  });

  it("no surface file re-implements ownership derivation — none names a state-engine fold function", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must name no state-engine fold fn`).not.toMatch(STATE_ENGINE_FNS);
    }
  });

  it("no surface file reads the claims / releases / reassignments ledgers directly — ownership comes through the seam", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not read the claims ledger`).not.toMatch(CLAIMS_TABLE);
      expect(code, `${f} must not read the releases ledger`).not.toMatch(RELEASES_TABLE);
      expect(code, `${f} must not read the reassignments ledger`).not.toMatch(REASSIGNMENTS_TABLE);
    }
  });
});

// =====================================================================
// 4. THE COORDINATION ENGINE STAYS AUTHORITATIVE — the page reads it via R37; the surface derives none.
// =====================================================================

describe("receptionist reassignment surface — the Coordination Engine stays authoritative", () => {
  it("the page reads the coordination through the R37 authoritative single-item seam getCoordinationById", () => {
    expect(codeOf(read(PAGE))).toMatch(COORDINATION_READ);
  });

  it("neither the roster reader nor the action derives a coordination (no engine fn, no coordinations table)", () => {
    for (const f of [READER, ACTION]) {
      const code = codeOf(read(f));
      expect(code, `${f} must derive no coordination`).not.toMatch(ENGINE_EXECUTION_FNS);
      expect(code, `${f} must not read the coordinations ledger`).not.toMatch(COORDINATIONS_TABLE);
    }
  });

  it("the transfer still guards against a REAL claimed coordination via the R52 runtime → its storage primitive", () => {
    // The runtime routes every transfer through the SECURITY DEFINER writer, whose coordination-authority + ownership
    // guards are pinned by the R52 suite. Here we assert the seam is intact: the runtime still names the write primitive.
    expect(codeOf(read(RUNTIME))).toMatch(WRITE_FN);
  });
});

// =====================================================================
// 5. ORGANISATION ISOLATION — HQ-gated, org from the session (never a parameter), the roster read filter is mandatory.
// =====================================================================

describe("receptionist reassignment surface — organisation isolation is preserved", () => {
  it("the action is HQ-gated and scopes EVERY read/write to the org from the SESSION, never from a parameter", () => {
    const code = codeOf(read(ACTION));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    // The ownership read, the roster read and the runtime write are all scoped to ctx.org.id.
    expect(code.match(/org_id:\s*ctx\.org\.id/g) ?? []).toHaveLength(3);
    // The org is NEVER a client parameter — the action's input is the coordination + the destination only.
    expect(code).not.toMatch(/org_id:\s*input\./);
    expect(code).not.toMatch(/\borgId\b/);
  });

  it("the page is HQ-gated and resolves the org from the session for ALL THREE reads", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    // The coordination read, the ownership read and the roster read are each org-scoped by ctx.org.id.
    expect(code.match(/org_id:\s*ctx\.org\.id/g) ?? []).toHaveLength(3);
  });

  it("the viewer identity comes from the authenticated HQ gate, not the client", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/const user = await requireHqPage\(\)/);
    expect(code).toMatch(/viewerOperatorId:\s*user\.id/);
  });

  it("the roster reader org-scopes its read — the org_id filter is mandatory, and org is a required input", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.eq\(\s*["']org_id["']/);
    expect(code).toMatch(/listOrgOperators\(input:\s*\{\s*org_id:\s*string/);
  });
});

// =====================================================================
// 6. THE AUDIT STAYS APPEND-ONLY — the roster read is read-only over memberships; R54 adds no writer.
// =====================================================================

describe("receptionist reassignment surface — the append-only audit is preserved", () => {
  it("the roster reader performs ONLY a SELECT over the membership roster — no write, no RPC, no ledger", () => {
    const code = codeOf(read(READER));
    expect(code).toMatch(/\.select\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(code).not.toMatch(WRITE_FN);
    expect(code).not.toMatch(/\.rpc\(/);
    // It reads the org's operator roster (memberships → users), and NO ledger.
    expect(fromTargets(code)).toContain("memberships");
  });

  it("no reassignment-surface module directly mutates any ledger — the append-only R52 writer is the only path", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
    }
  });
});

// =====================================================================
// 7. NO EXECUTION PATH IS INTRODUCED — the surface displays ownership and records a transfer; it acts on nothing.
// =====================================================================

describe("receptionist reassignment surface — no execution path is introduced", () => {
  it("no reassignment-surface file names any engine EXECUTION function", () => {
    for (const f of SURFACE_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no reassignment-surface file names any OTHER engine writer", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      // The surface names NO record_* primitive at all — it consumes the runtime, which owns the one writer.
      expect(code.match(/record_receptionist_conversation_\w+/g), `${f}`).toBeNull();
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no reassignment-surface file names an R54 non-goal token (assign/automate/dispatch/…/close)", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no reassignment-surface file reaches a transport / calendar / quote / generation path", () => {
    for (const f of SURFACE_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });

  it("the action refreshes the surfaces after a transfer, so the ownership display re-reads the recorded fact", () => {
    expect(codeOf(read(ACTION))).toMatch(/revalidatePath\(/);
    expect(codeOf(read(PANEL))).toMatch(/router\.refresh\(/);
  });
});

// =====================================================================
// 8. THE MODULE BOUNDARIES HOLD — server action, client panel, server-only reader, shared pure view core.
// =====================================================================

describe("receptionist reassignment surface — the module boundaries hold", () => {
  it('the action is a SERVER ACTION — its first directive is "use server"', () => {
    expect(read(ACTION).trimStart().startsWith('"use server"')).toBe(true);
  });

  it('the panel is a CLIENT COMPONENT — its first directive is "use client"', () => {
    expect(read(PANEL).trimStart().startsWith('"use client"')).toBe(true);
  });

  it("the roster reader is server-only — it is the one place the operator roster is read back", () => {
    expect(importSpecifiers(codeOf(read(READER)))).toContain("server-only");
  });

  it("the pure view core is a shared module (NOT server-only) importing only the R52 + R48 types", () => {
    const specs = importSpecifiers(codeOf(read(VIEW_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual(["./conversation-reassignment", "./conversation-ownership-read-model"]);
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

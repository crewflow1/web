import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — MY CLAIMS LIST governance invariants
 * (the AI Receptionist Programme, R49 — MY CLAIMS LIST).
 *
 * R48 established the CANONICAL Conversation Work Ownership Read Model — the single authoritative projection of
 * ownership state over the append-only claim ledger. R49 is the FIRST operator-facing surface built ON that read
 * model: a READ-ONLY list of the conversation worklist items the signed-in operator has claimed and now owns. Its law
 * is exact: "My Claims consumes ONLY the Ownership Read Model; the claim runtime remains authoritative; organisation
 * isolation is preserved; the audit remains append-only; and NO execution path is introduced." This suite proves that
 * contract as a matter of SOURCE, not discipline — the house bar of the R30→R48 invariant suites:
 *
 *   • MY CLAIMS CONSUMES ONLY THE OWNERSHIP READ MODEL — the page's ONLY server-service dependency is the R48
 *     ownership read model (`getOwnershipHistory` + `getOwnershipSummary`). It imports no other ledger reader (not the
 *     R47 claim-surface reader, not the R46 runtime), opens no database client, and names no table, `.from`, `.rpc`
 *     or `.select` — it has NO read path around the read model. The pure core consumes ONLY the R48 read-model core.
 *   • THE CLAIM RUNTIME STAYS AUTHORITATIVE — R49 adds NO writer: the ledger write primitive
 *     (`record_receptionist_conversation_claim`) is still named by EXACTLY ONE module (the R46 runtime), and
 *     `claimConversationWork` is still DEFINED once. No My Claims file records, re-derives or names a claim write.
 *   • ORGANISATION ISOLATION IS PRESERVED — auth is the EXISTING HQ gate (`requireHqPage`); the org is resolved from
 *     the SESSION (`requireOrgContext` → `ctx.org.id`) for BOTH reads; the VIEWER is the authenticated operator
 *     (`user.id`); and the surface takes NO parameter, so it can never be pointed at another operator or another org.
 *   • THE AUDIT STAYS APPEND-ONLY — the claims ledger is READ through the SAME two read-only seams as before (the R47
 *     surface reader and the R48 read model); My Claims joins NEITHER — it reads ownership through the read model's
 *     seams, not the table. No My Claims file mutates the ledger (no write primitive, no direct write, no RPC).
 *   • NO EXECUTION PATH IS INTRODUCED — neither My Claims file names any engine execution function, any other engine
 *     writer, or any R49 non-goal token (assign / reassign / release / dispatch / notify / schedule / … / close). It
 *     lists claims the operator already holds; it assigns nothing, releases nothing, dispatches nothing.
 *   • THE MODULE BOUNDARIES HOLD — the page is a server component (NOT a client component), and the view core is a
 *     shared, deterministic module (NOT server-only) importing only the R48 read-model core, touching no I/O, clock or
 *     RNG.
 *
 * The surface's pure view core is pinned exhaustively in __tests__/receptionist/my-claims-view.test.ts, and its
 * runtime behaviour (the R48 seams read back through the projection over real Postgres) in
 * __tests__/integration/receptionist/my-claims-pipeline.test.ts. This tier is HERMETIC — a filesystem scan over
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

// The R46 capability (unchanged by R49) — the runtime that records a claim.
const RUNTIME = "server/services/receptionist-claim.ts";

// The R47 surface reader — the single-item, viewer-relative ownership reader over the claims ledger.
const CLAIM_READER = "server/services/receptionist-claim-view.ts";

// The R48 canonical ownership read model — the org-scoped reader whose seams R49 consumes.
const OWNERSHIP_READ_MODEL = "server/services/receptionist-ownership-read-model.ts";

// The R49 surface — the pure view core and the read-only page. There is NO action and NO client panel.
const MY_CLAIMS_CORE = "lib/receptionist/my-claims-view.ts";
const PAGE = "app/admin/ai-receptionist/worklist/my-claims/page.tsx";

/** The R49 surface files whose EXECUTABLE source must name no execution path (the whole surface — it renders no engine
 *  display, so both files are in scope). */
const MY_CLAIMS_FILES = [MY_CLAIMS_CORE, PAGE] as const;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** The claim ledger's write primitive — the function an auditor would call to file a claim. */
const WRITE_FN = /\brecord_receptionist_conversation_claim\b/;

/** The R46 runtime entry point — the ONE governed mechanism that records an operator claim. */
const RUNTIME_ENTRY = /\bclaimConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function claimConversationWork\(/;

/** The R48 read-model seams the surface consumes — the org's history and its summary. */
const HISTORY_READ = /\bgetOwnershipHistory\b/;
const SUMMARY_READ = /\bgetOwnershipSummary\b/;

/** Sibling read seams the surface must NOT reach — the R47 claim reader and the R37 coordination reader. */
const CLAIM_VIEW_READ = /\bgetClaimForCoordination\b/;
const COORDINATION_READ = /\bgetCoordinationById\b/;

/** The claims ledger table + the R36 coordinations base table — the surface names neither (it reads via the seams). */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the surface names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The R49 explicit non-goals as SOURCE tokens — My Claims lists ownership; it acts on nothing. */
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

/** Direct-write / bypass tokens no My Claims module may name (the ledger is written ONLY through the R46 runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. The surface ships, with its projections and its single data path.
// =====================================================================

describe("receptionist my claims — the surface ships", () => {
  it("ships the pure view core and the read-only page", () => {
    for (const f of MY_CLAIMS_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the pure core exports the operator-event selector and the row + view projections", () => {
    const code = codeOf(read(MY_CLAIMS_CORE));
    expect(code).toMatch(/export function selectOperatorEvents\(/);
    expect(code).toMatch(/export function projectMyClaimRow\(/);
    expect(code).toMatch(/export function projectMyClaims\(/);
  });

  it("the page default-exports the My Claims surface, fed by the R48 org-scoped seams", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/export default async function HqReceptionistMyClaimsPage\(/);
    expect(code).toMatch(HISTORY_READ);
    expect(code).toMatch(SUMMARY_READ);
  });
});

// =====================================================================
// 1. MY CLAIMS CONSUMES ONLY THE OWNERSHIP READ MODEL — one data path, the read model; no ledger, no second reader.
// =====================================================================

describe("receptionist my claims — consumes only the ownership read model", () => {
  it("the page's ONLY server-service import is the R48 ownership read model", () => {
    const specs = importSpecifiers(codeOf(read(PAGE)));
    expect(specs.filter((s) => s.startsWith("@/server/services/"))).toEqual([
      "@/server/services/receptionist-ownership-read-model",
    ]);
  });

  it("the page reaches NO other ledger reader — not the R47 claim reader, the R46 runtime, nor a database client", () => {
    const specs = importSpecifiers(codeOf(read(PAGE)));
    expect(specs).not.toContain("@/server/services/receptionist-claim-view");
    expect(specs).not.toContain("@/server/services/receptionist-claim");
    expect(specs).not.toContain("@/lib/supabase/admin");
    const code = codeOf(read(PAGE));
    expect(code).not.toMatch(CLAIM_VIEW_READ); // getClaimForCoordination (R47)
    expect(code).not.toMatch(COORDINATION_READ); // getCoordinationById (R37)
  });

  it("the page consumes the read model's org-scoped seams — history + summary — and projects them for the viewer", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(HISTORY_READ);
    expect(code).toMatch(SUMMARY_READ);
    expect(code).toMatch(/\bprojectMyClaims\b/);
  });

  it("the page opens no database client and issues no query of its own — no read path around the read model", () => {
    const code = codeOf(read(PAGE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.select\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
  });

  it("the pure core consumes ONLY the R48 read-model core — it names no table and opens no client", () => {
    const code = codeOf(read(MY_CLAIMS_CORE));
    expect(importSpecifiers(code)).toEqual(["./conversation-ownership-read-model"]);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(CLAIM_LEDGER);
    expect(code).not.toMatch(COORDINATIONS_TABLE);
    expect(code).not.toMatch(/createAdminClient/);
  });
});

// =====================================================================
// 2. THE CLAIM RUNTIME STAYS AUTHORITATIVE — R49 adds no writer; the runtime entry is defined once.
// =====================================================================

describe("receptionist my claims — the claim runtime remains authoritative", () => {
  const writers = walkSources(SOURCE_ROOTS)
    .filter((full) => WRITE_FN.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  const entryDefiners = walkSources(SOURCE_ROOTS)
    .filter((full) => RUNTIME_ENTRY_DEF.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("across all source, the ledger write primitive is still named by EXACTLY ONE module — the R46 runtime", () => {
    // R49 introduced NO writer: if this ever grows, the read-only surface has started writing.
    expect(writers).toEqual([RUNTIME]);
  });

  it("claimConversationWork is DEFINED in exactly one module — the R46 runtime", () => {
    expect(entryDefiners).toEqual([RUNTIME]);
  });

  it("no My Claims file records, re-derives or names a claim write — it is read-only", () => {
    for (const f of MY_CLAIMS_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must not name the ledger write primitive`).not.toMatch(WRITE_FN);
      expect(code, `${f} must not name the runtime entry`).not.toMatch(RUNTIME_ENTRY);
      expect(code, `${f} must not re-derive a claim`).not.toMatch(/\bresolveClaim\b/);
      expect(code.match(/record_receptionist_conversation_\w+/g), f).toBeNull();
      expect(code, `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
    }
  });
});

// =====================================================================
// 3. ORGANISATION ISOLATION — HQ-gated, org from the session (never a parameter), the viewer from the gate.
// =====================================================================

describe("receptionist my claims — organisation isolation is preserved", () => {
  it("the page is HQ-gated and resolves the org from the SESSION, never from the client", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
  });

  it("BOTH read-model reads are org-scoped by ctx.org.id — the org filter is on every read", () => {
    const code = codeOf(read(PAGE));
    expect(code.match(/org_id:\s*ctx\.org\.id/g) ?? []).toHaveLength(2);
  });

  it("the VIEWER is the authenticated operator from the gate — user.id, never a client value", () => {
    const code = codeOf(read(PAGE));
    expect(code).toMatch(/const user = await requireHqPage\(\)/);
    expect(code).toMatch(/operatorId:\s*user\.id/);
  });

  it("the surface takes NO parameter — it cannot be pointed at another operator or another org", () => {
    const code = codeOf(read(PAGE));
    // The page component's signature is empty — no params, no searchParams that could name another operator/org.
    expect(code).toMatch(/export default async function HqReceptionistMyClaimsPage\(\s*\)/);
    // And it offers no claim affordance — it names neither the runtime entry nor the R47 claim action.
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(/\bclaimWorkItemAction\b/);
  });
});

// =====================================================================
// 4. THE AUDIT STAYS APPEND-ONLY — R49 reads through the seams, not the table; it adds no ledger reader and no writer.
// =====================================================================

describe("receptionist my claims — the append-only audit is preserved", () => {
  const ledgerReaders = walkSources(SOURCE_ROOTS)
    .filter((full) => CLAIM_LEDGER.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

  it("the claims ledger is READ through the SAME two read-only seams as before — R49 adds no ledger reader", () => {
    // R49 reads ownership through the R48 read model's seams, NOT the ledger table: so the set of modules naming the
    // ledger is UNCHANGED — the R47 surface reader and the R48 ownership read model. My Claims is in neither.
    expect(ledgerReaders).toEqual([CLAIM_READER, OWNERSHIP_READ_MODEL].sort());
    expect(ledgerReaders).not.toContain(PAGE);
    expect(ledgerReaders).not.toContain(MY_CLAIMS_CORE);
  });

  it("no My Claims file mutates the ledger — no direct write, no write primitive, no RPC", () => {
    for (const f of MY_CLAIMS_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f}`).not.toMatch(WRITE_FN);
      expect(code, `${f}`).not.toMatch(/\.rpc\(/);
    }
  });
});

// =====================================================================
// 5. NO EXECUTION PATH IS INTRODUCED — My Claims lists ownership; it acts on nothing.
// =====================================================================

describe("receptionist my claims — no execution path is introduced", () => {
  it("no My Claims file names any engine EXECUTION function", () => {
    for (const f of MY_CLAIMS_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("no My Claims file names any OTHER engine writer", () => {
    for (const f of MY_CLAIMS_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("no My Claims file names an R49 non-goal token (assign/reassign/release/dispatch/…/close)", () => {
    for (const f of MY_CLAIMS_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("no My Claims file reaches a transport / calendar / quote / generation path", () => {
    for (const f of MY_CLAIMS_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });
});

// =====================================================================
// 6. THE MODULE BOUNDARIES HOLD — server-component page; shared, deterministic pure view core.
// =====================================================================

describe("receptionist my claims — the module boundaries hold", () => {
  it("the page is a SERVER COMPONENT — neither a client component nor a server action", () => {
    const head = read(PAGE).trimStart();
    expect(head.startsWith('"use client"')).toBe(false);
    expect(head.startsWith('"use server"')).toBe(false);
  });

  it("the pure core is a shared module (NOT server-only) importing only the R48 ownership read-model core", () => {
    const specs = importSpecifiers(codeOf(read(MY_CLAIMS_CORE)));
    expect(specs).not.toContain("server-only");
    expect(specs).toEqual(["./conversation-ownership-read-model"]);
  });

  it("the core touches no I/O and no clock/RNG — it is deterministic", () => {
    const code = codeOf(read(MY_CLAIMS_CORE));
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/new Date\(/);
  });
});

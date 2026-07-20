import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — REASSIGN FROM QUEUE governance invariants
 * (the AI Receptionist Programme, R62 — REASSIGN FROM QUEUE, over R59's ATTENTION QUEUE SURFACE + R52's REASSIGNMENT capability).
 *
 * R59 shipped the READ-ONLY Attention Queue; R60 added the ONE affordance to CLAIM an unowned row, and R61 the mirror on
 * the other side of ownership — RELEASE a row you own. R62 completes the trio on the SAME side as release: it lets an
 * operator TRANSFER a row THEY OWN to another authorised operator without leaving the queue — and it does so by REUSING
 * THE EXISTING Conversation Work Reassignment capability (R52), not by inventing a second one. Unlike release (first
 * surfaced by R61), reassignment was ALREADY surfaced by R54's detail control; R62 is its SECOND surface, driving the
 * SAME runtime and projecting through the SAME pure outcome view. Its law is exact: "the queue reassignment reuses the
 * existing reassignment runtime and creates NO new reassignment mechanism; the R52 reassignment runtime remains
 * authoritative; the R46 claim runtime remains authoritative; the R50 release runtime remains authoritative; the R58
 * attention-queue runtime remains authoritative; the ownership read model remains authoritative; organisation isolation is
 * preserved; the audit remains append-only; and NO execution path beyond the reassignment is introduced." This suite
 * proves that contract as a matter of SOURCE, not discipline — the house bar of the R30→R61 invariant suites:
 *
 *   • R62 SHIPS, AND ONLY AS AN AFFORDANCE — the queue action exports the single `reassignFromQueueAction`; the client
 *     button exports `AttentionQueueReassignButton`; the R59 pure core gains ONE eligibility field (`canReassign` — the
 *     VIEWER-scoped "the row is owned AND the viewer is its owner", the SAME rule as `canRelease`); the page renders the
 *     button ONLY on `canReassign` rows and DELEGATES the transfer to it — the page names no runtime, no write primitive
 *     and no reassignment action itself.
 *   • IT CREATES NO NEW REASSIGNMENT MECHANISM — across all non-test source the reassignment ledger write primitive
 *     (`record_receptionist_conversation_claim_reassignment`) is named by EXACTLY ONE module (the R52 runtime);
 *     `reassignConversationWork` is DEFINED exactly once (the R52 runtime); the outcome projection
 *     `describeReassignmentOutcome` is DEFINED exactly once (the R54 reassignment view core — the SAME projection R54's
 *     detail reassign surface uses) and consumed; the queue action `reassignFromQueueAction` and the button are each
 *     defined once.
 *   • THE ACTION CONSUMES ONLY THE RUNTIME (+ THE ORG ROSTER READER) — its ONE reassignment path is
 *     `reassignConversationWork`; its whole import surface is the runtime, the reassignment outcome projection, the
 *     org-scoped roster READER (`listOrgOperators` — how it validates the destination) and the HQ + session gates, nothing
 *     else. It opens no database client, names no write primitive, names no pure resolver, issues no RPC and no direct
 *     write — it cannot bypass the runtime because its only reassignment mechanism IS the runtime.
 *   • THE BUTTON CONSUMES ONLY ITS ACTION — its ONLY reassignment path is `reassignFromQueueAction`; it imports React, the
 *     Next router, its action and the reassignment view TYPES, nothing else. It reaches no server module, no database
 *     client, no write primitive; and it does NOT import the queue's own view core, so the R59 invariant "the queue core
 *     is consumed by the page alone" holds.
 *   • ORGANISATION ISOLATION IS PRESERVED — the action is HQ-gated (`requireHqPage`) and scopes the transfer to the org
 *     resolved from the SESSION (`requireOrgContext` → `ctx.org.id`), NEVER a parameter; the SOURCE operator is the
 *     authenticated user (`user.id`), never a client value; the DESTINATION is validated against the org-scoped roster
 *     (`listOrgOperators` → an off-roster target is refused `unavailable` without touching the runtime); the only client
 *     inputs are which coordination to transfer and which operator receives it.
 *   • THE AUDIT STAYS APPEND-ONLY — neither R62 file names the reassignment ledger table, issues a direct write or an RPC,
 *     or joins the ledger-reader set; the transfer's sole record is the R52 runtime's append-only ledger row.
 *   • NO EXECUTION PATH BEYOND THE REASSIGNMENT — neither R62 file names any engine execution function, any OTHER ownership
 *     write runtime (claim / release), any other engine writer, or any R62 non-goal token (assign-to-others automatically /
 *     release / claim / dispatch / notify / schedule / promote / complete / …) or transport / calendar / quote / voice /
 *     whatsapp / email / memory / generation path. The action's ONLY effect beyond the transfer is
 *     `revalidatePath(<queue>)`; the button's is `router.refresh()`. NOTE `reassign` is R62's CAPABILITY, so — exactly as
 *     R50's and R61's own suites omit theirs — it is absent from the non-goal set; `release` and `claim` take its place
 *     (the queue reassignment never releases and never claims). `\bassign\w*` NEVER matches "reassign" (no boundary
 *     between "re" and "assign"), so it stays in the set to forbid bare AUTOMATIC assignment-to-others.
 *   • THE MODULE BOUNDARIES HOLD — the action is a server action ("use server"); the button is a client component
 *     ("use client") whose only reassignment path is the action.
 *
 * The reassign-from-queue runtime behaviour (eligibility, conflict, org isolation over real Postgres) is pinned in
 * __tests__/integration/receptionist/attention-queue-reassign-from-queue-pipeline.test.ts; the pure `canReassign`
 * eligibility exhaustively in __tests__/receptionist/conversation-attention-queue-view.test.ts; and both
 * `describeReassignmentOutcome` and the shared `toReassignmentCandidates` roster-minus-owner projection in
 * __tests__/receptionist/conversation-reassignment-view.test.ts. This tier is HERMETIC — a filesystem scan over
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

// The R52 capability — the runtime that records a reassignment (UNCHANGED by R62).
const RUNTIME = "server/services/receptionist-reassignment.ts";

// The reassignment reuse surface — the pure view core that projects a runtime resolution (`describeReassignmentOutcome`)
// and derives the destination candidates (`toReassignmentCandidates`). This predates R62 (R54's detail surface defines it);
// R62 REUSES it — the queue reassignment is reassignment's SECOND surface, not a new projection.
const REASSIGN_VIEW_CORE = "lib/receptionist/conversation-reassignment-view.ts";

// The R59 attention-queue surface the R62 reassignment is added to — the pure view core (now with `canReassign`) and the page.
const SURFACE_CORE = "lib/receptionist/conversation-attention-queue-view.ts";
const PAGE = "app/admin/ai-receptionist/worklist/attention/page.tsx";

// The R62 additions — the queue-level reassignment ACTION and the client reassignment BUTTON.
const QUEUE_ACTION = "app/admin/ai-receptionist/worklist/attention/reassign-actions.ts";
const QUEUE_BUTTON = "app/admin/ai-receptionist/worklist/attention/reassign-button.tsx";

/** The two R62 files whose EXECUTABLE source must add a reassignment THROUGH the runtime and NOTHING else. */
const R62_FILES = [QUEUE_ACTION, QUEUE_BUTTON] as const;

// Module specifiers.
const RUNTIME_MODULE = "@/server/services/receptionist-reassignment";
const ROSTER_MODULE = "@/server/services/receptionist-operators";
const REASSIGN_VIEW_MODULE = "@/lib/receptionist/conversation-reassignment-view";
const QUEUE_SURFACE_CORE_MODULE = "@/lib/receptionist/conversation-attention-queue-view";
const HQ_AUTH_MODULE = "@/server/auth/hq";
const SESSION_AUTH_MODULE = "@/server/auth/session";

/** The EXACT import surface the queue ACTION is authorised to have — the revalidate hook, the HQ + session gates, the
 *  org-scoped roster READER, the R52 runtime and the reassignment outcome projection. Nothing else — no client, no other
 *  server service. The roster reader is the ONE import R61's release action did not need: R62 validates the DESTINATION. */
const ALLOWED_ACTION_IMPORTS = [
  "next/cache",
  HQ_AUTH_MODULE,
  SESSION_AUTH_MODULE,
  ROSTER_MODULE,
  RUNTIME_MODULE,
  REASSIGN_VIEW_MODULE,
].sort();

/** The EXACT import surface the client BUTTON is authorised to have — React, the Next router, its own action and the
 *  reassignment view TYPES. It does NOT import the queue's view core (that stays the page's alone). */
const ALLOWED_BUTTON_IMPORTS = ["react", "next/navigation", "./reassign-actions", REASSIGN_VIEW_MODULE].sort();

/** The reassignment ledger's write primitive — the ONE function that files a reassignment; and the family of ownership writers. */
const WRITE_FN = /\brecord_receptionist_conversation_claim_reassignment\b/;
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The R52 runtime entry — the ONE governed mechanism that records a reassignment — and its single definition. */
const RUNTIME_ENTRY = /\breassignConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function reassignConversationWork\(/;

/** The reassignment ACTION (defined once) + the reassignment outcome projection + the R62 button (each defined once). */
const QUEUE_ACTION_ENTRY_DEF = /export async function reassignFromQueueAction\(/;
const OUTCOME_DEF = /export function describeReassignmentOutcome\(/;
const BUTTON_ENTRY_DEF = /export function AttentionQueueReassignButton\(/;

/** The org-scoped roster READER — how the action validates the destination is an authorised operator of THIS org. */
const ROSTER_READER = /\blistOrgOperators\b/;

/** The R62 eligibility rule the pure core added — the VIEWER-scoped `canReassign`, decided by the `viewerHoldsRow` helper. */
const CANREASSIGN_RULE = /canReassign:\s*viewerHoldsRow\(/;

/** The reassignment ledger table + the R36 coordinations base table — the queue reassignment names neither (it goes through the runtime). */
const REASSIGN_LEDGER = /\breceptionist_conversation_claim_reassignments\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/**
 * Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the queue reassignment names none of them.
 * This list carries the reassignment RESOLVER `resolveReassignment`: the queue reassignment consumes the RUNTIME, never
 * the pure resolver.
 */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveReassignment|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The OTHER ownership write runtimes + their resolvers — the queue REASSIGNS ONLY; it never claims or releases. */
const OTHER_WRITE_RUNTIMES =
  /\b(?:claimConversationWork|releaseConversationWork|resolveClaim|resolveRelease)\b/;

/**
 * The R62 explicit non-goals as SOURCE tokens — the queue reassignment REASSIGNS; it does nothing else. `reassign` is
 * R62's CAPABILITY, so — exactly as R50's and R61's own suites deliberately omit theirs — it is ABSENT here; `release` and
 * `claim` take its place (the queue reassignment never releases and never claims). `\bassign\w*` NEVER matches "reassign"
 * (no boundary between "re" and "assign"), so it stays to forbid bare AUTOMATIC assignment-to-others. `\bemail\b` is NOT
 * in this shared set because the action legitimately reads the operator's login `user.email` and the destination's
 * `target.operatorEmail` (both identities, not the email CHANNEL) — the email channel is forbidden on the BUTTON only, below.
 */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // AUTOMATIC assignment to others (NEVER matches "reassign")
  /\brelease\w*/i, // release (R50/R61's capability; a non-goal for the queue REASSIGNMENT)
  /\bclaim\w*/i, // claim (R46/R60's capability; a non-goal for the queue REASSIGNMENT)
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no R62 module may name (the ledger is written ONLY through the runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. R62 ships — the queue action, the client button, the core's eligibility field, the page's delegated affordance.
// =====================================================================

describe("receptionist reassign-from-queue — R62 ships as an affordance only", () => {
  it("ships the queue reassignment action and the client reassignment button", () => {
    for (const f of R62_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the queue action exports the single reassignment action; the button exports the single reassignment control", () => {
    expect(codeOf(read(QUEUE_ACTION))).toMatch(QUEUE_ACTION_ENTRY_DEF);
    expect(codeOf(read(QUEUE_BUTTON))).toMatch(BUTTON_ENTRY_DEF);
  });

  it("the R59 pure core gains ONE eligibility field — canReassign, viewer-scoped — and stays a pure projection", () => {
    const code = codeOf(read(SURFACE_CORE));
    expect(code, "the core surfaces reassignment eligibility as the viewer-scoped viewerHoldsRow rule").toMatch(
      CANREASSIGN_RULE,
    );
    // The eligibility is derived, never a reassignment: the core still names no runtime, no write primitive and no ledger.
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(REASSIGN_LEDGER);
  });

  it("the page renders the button on eligible rows and DELEGATES the transfer — it names no runtime, primitive or action", () => {
    const code = codeOf(read(PAGE));
    expect(code, "renders the reassignment button").toMatch(/<AttentionQueueReassignButton\b/);
    expect(code, "guards the affordance on the pure eligibility flag").toMatch(/row\.canReassign/);
    expect(importSpecifiers(code), "imports the client button").toContain("./reassign-button");
    // Delegation, not execution: the page itself names no reassignment mechanism.
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(/\breassignFromQueueAction\b/);
  });
});

// =====================================================================
// 1. IT CREATES NO NEW REASSIGNMENT MECHANISM — one writer, one runtime, one projection (reused from R54).
// =====================================================================

describe("receptionist reassign-from-queue — creates no new reassignment mechanism", () => {
  it("across all source, the reassignment write primitive is named by EXACTLY ONE module — the R52 runtime (R62 adds no writer)", () => {
    expect(namersOf(WRITE_FN)).toEqual([RUNTIME]);
  });

  it("reassignConversationWork is DEFINED in exactly one module — the R52 runtime (the queue action calls, never defines)", () => {
    expect(namersOf(RUNTIME_ENTRY_DEF)).toEqual([RUNTIME]);
  });

  it("the outcome projection describeReassignmentOutcome is DEFINED in exactly one module — the R54 reassignment view core", () => {
    expect(namersOf(OUTCOME_DEF)).toEqual([REASSIGN_VIEW_CORE]);
  });

  it("the reassignment action is DEFINED exactly once — the queue reassignment action module", () => {
    expect(namersOf(QUEUE_ACTION_ENTRY_DEF)).toEqual([QUEUE_ACTION]);
  });

  it("the client button is DEFINED exactly once — the R62 button module", () => {
    expect(namersOf(BUTTON_ENTRY_DEF)).toEqual([QUEUE_BUTTON]);
  });

  it("the queue action drives the R52 runtime and the reassignment projection, and revalidates the QUEUE", () => {
    const queue = codeOf(read(QUEUE_ACTION));
    // It consumes the SAME reassignment runtime R52 defines and the SAME outcome projection R54 defines — no new mechanism.
    expect(queue).toMatch(RUNTIME_ENTRY);
    expect(queue).toMatch(/\bdescribeReassignmentOutcome\b/);
    expect(queue).toMatch(/requireHqPage\(/);
    // It revalidates the QUEUE path (its only effect beyond the transfer).
    expect(queue).toMatch(/revalidatePath\(\s*["']\/admin\/ai-receptionist\/worklist\/attention["']\s*\)/);
  });
});

// =====================================================================
// 2. THE ACTION CONSUMES ONLY THE RUNTIME (+ THE ORG ROSTER READER) — one reassignment path; a pinned import surface; no bypass.
// =====================================================================

describe("receptionist reassign-from-queue — the action consumes only the R52 runtime (and the roster reader)", () => {
  it("the action's ONE reassignment path is the runtime entry reassignConversationWork, imported from the R52 runtime", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(RUNTIME_ENTRY);
    expect(importSpecifiers(code)).toContain(RUNTIME_MODULE);
  });

  it("the action's WHOLE import surface is EXACTLY the authorised set — revalidate, gates, roster reader, runtime, projection", () => {
    expect([...importSpecifiers(codeOf(read(QUEUE_ACTION)))].sort()).toEqual(ALLOWED_ACTION_IMPORTS);
  });

  it("the action's ONLY server-service imports are the R52 runtime and the org roster READER — it reaches no other service", () => {
    const specs = importSpecifiers(codeOf(read(QUEUE_ACTION)));
    expect(specs.filter((s) => s.startsWith("@/server/services/")).sort()).toEqual([ROSTER_MODULE, RUNTIME_MODULE].sort());
  });

  it("the action opens no database client, names no write primitive or pure resolver, issues no RPC and no direct write", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(/\bresolveReassignment\b/); // it consumes the runtime, not the pure resolver
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(importSpecifiers(code)).not.toContain("@/lib/supabase/admin");
  });
});

// =====================================================================
// 3. THE BUTTON CONSUMES ONLY ITS ACTION — one reassignment path; it never touches the server or the queue core.
// =====================================================================

describe("receptionist reassign-from-queue — the button consumes only its action", () => {
  it("the button's ONLY reassignment path is the queue server action reassignFromQueueAction", () => {
    const code = codeOf(read(QUEUE_BUTTON));
    expect(importSpecifiers(code)).toContain("./reassign-actions");
    expect(code).toMatch(/\breassignFromQueueAction\b/);
  });

  it("the button's WHOLE import surface is EXACTLY the authorised set — React, the router, its action, the reassignment view types", () => {
    expect([...importSpecifiers(codeOf(read(QUEUE_BUTTON)))].sort()).toEqual(ALLOWED_BUTTON_IMPORTS);
  });

  it("the button reaches no server module, no database client, no write primitive and no direct query", () => {
    const code = codeOf(read(QUEUE_BUTTON));
    const specs = importSpecifiers(code);
    expect(specs.some((s) => s.startsWith("@/server/"))).toBe(false);
    expect(specs).not.toContain("@/lib/supabase/admin");
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(/\.rpc\(/);
  });

  it("the button does NOT import the queue's view core — that core stays consumed by the page ALONE (R59 invariant held)", () => {
    expect(importSpecifiers(codeOf(read(QUEUE_BUTTON)))).not.toContain(QUEUE_SURFACE_CORE_MODULE);
    expect(importersOf(QUEUE_SURFACE_CORE_MODULE)).toEqual([PAGE]);
  });
});

// =====================================================================
// 4. ORGANISATION ISOLATION — HQ-gated, org + source operator from the session, destination validated against the org roster.
// =====================================================================

describe("receptionist reassign-from-queue — organisation isolation is preserved", () => {
  it("the action is HQ-gated and scopes the transfer to the org from the SESSION, never from a parameter", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    expect(code).toMatch(/org_id:\s*ctx\.org\.id/);
    // The action's client input is EXACTLY the coordination id + the target operator id — the org is NEVER a parameter.
    expect(code).toMatch(
      /reassignFromQueueAction\(\s*input:\s*\{\s*coordinationId:\s*string;\s*toOperatorId:\s*string;\s*\}\s*\)/,
    );
  });

  it("the SOURCE operator identity comes from the authenticated HQ gate, not the client", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(/const user = await requireHqPage\(\)/);
    expect(code).toMatch(/from_operator:\s*\{\s*id:\s*user\.id/);
  });

  it("the DESTINATION is validated against the ORG-SCOPED roster — an off-roster target is refused unavailable, no runtime", () => {
    const code = codeOf(read(QUEUE_ACTION));
    // The candidate destinations come from the org roster READER (scoped to the SESSION org), never a client-supplied list.
    expect(code).toMatch(ROSTER_READER);
    expect(code).toMatch(/listOrgOperators\(\s*\{\s*org_id:\s*ctx\.org\.id\s*\}\s*\)/);
    expect(code).toMatch(/operators\.find\(/);
    // A target the roster does not contain names no authorised operator of THIS org — reported unavailable, runtime untouched.
    expect(code).toMatch(/if\s*\(\s*!target\s*\)/);
    expect(code).toMatch(/describeReassignmentOutcome\(\s*["']unavailable["']\s*\)/);
    // The transfer hands the item to the VALIDATED roster member — never a raw client id.
    expect(code).toMatch(/to_operator:\s*\{\s*id:\s*target\.operatorId/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — neither R62 file writes, names the ledger, or joins the ledger-reader set.
// =====================================================================

describe("receptionist reassign-from-queue — the append-only audit is preserved", () => {
  const ledgerReaders = namersOf(REASSIGN_LEDGER);

  it("neither R62 file mutates or reads a base table directly — no direct write, no write primitive, no RPC, no table name", () => {
    for (const f of R62_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f} must name no write primitive`).not.toMatch(WRITE_FN);
      expect(code, `${f} must issue no RPC`).not.toMatch(/\.rpc\(/);
      expect(code, `${f} must not name the reassignment ledger`).not.toMatch(REASSIGN_LEDGER);
      expect(code, `${f} must not name the coordinations base table`).not.toMatch(COORDINATIONS_TABLE);
    }
  });

  it("neither R62 file joins the ledger-reader set — the append-only R52 ledger row is the transfer's only record", () => {
    for (const f of R62_FILES) {
      expect(ledgerReaders, `${f} must not read the reassignment ledger`).not.toContain(f);
    }
  });
});

// =====================================================================
// 6. NO EXECUTION PATH BEYOND THE REASSIGNMENT — the queue transfers and refreshes; it claims, releases and dispatches nothing.
// =====================================================================

describe("receptionist reassign-from-queue — no execution path beyond the reassignment", () => {
  it("neither R62 file names any engine EXECUTION function", () => {
    for (const f of R62_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("neither R62 file names any OTHER ownership write runtime — the queue reassigns only; it never claims or releases", () => {
    for (const f of R62_FILES) {
      expect(codeOf(read(f)), `${f} must name no claim/release runtime`).not.toMatch(OTHER_WRITE_RUNTIMES);
    }
  });

  it("neither R62 file names any OTHER engine writer", () => {
    for (const f of R62_FILES) {
      const code = codeOf(read(f));
      // The queue action names the R52 runtime ENTRY, not the write primitive — so no `record_receptionist_*` appears.
      expect(code.match(WRITE_PRIMITIVE), `${f}`).toBeNull();
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("neither R62 file names an R62 non-goal token (auto-assign/release/claim/dispatch/notify/…/close)", () => {
    for (const f of R62_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("neither R62 file reaches a transport / calendar / quote / generation path", () => {
    for (const f of R62_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });

  it("the client button reaches no voice / whatsapp / email / memory channel (the action legitimately reads operator identities)", () => {
    // The channel tokens are asserted on the BUTTON only — the action reads the operator's login `user.email` and the
    // destination's `target.operatorEmail` (identities, not the email CHANNEL), exactly as the R60 claim action does.
    const code = codeOf(read(QUEUE_BUTTON));
    expect(code).not.toMatch(/\bvoice\b/i);
    expect(code).not.toMatch(/whatsapp/i);
    expect(code).not.toMatch(/\bemail\b/i);
    expect(code).not.toMatch(/\bmemory\b/i);
  });

  it("the ONLY effect beyond the reassignment is a re-read — the action revalidates the queue, the button refreshes the router", () => {
    expect(codeOf(read(QUEUE_ACTION))).toMatch(/revalidatePath\(/);
    const button = codeOf(read(QUEUE_BUTTON));
    expect(button).toMatch(/router\.refresh\(\)/);
    expect(button, "the button navigates nowhere and fetches nothing").not.toMatch(/router\.(?:push|replace)\(/);
    expect(button).not.toMatch(/\bfetch\(/);
  });
});

// =====================================================================
// 7. THE MODULE BOUNDARIES HOLD — a server action; a client button whose only reassignment path is that action.
// =====================================================================

describe("receptionist reassign-from-queue — the module boundaries hold", () => {
  it('the queue action is a SERVER ACTION — its first directive is "use server"', () => {
    expect(read(QUEUE_ACTION).trimStart().startsWith('"use server"')).toBe(true);
  });

  it('the reassignment button is a CLIENT COMPONENT — its first directive is "use client"', () => {
    expect(read(QUEUE_BUTTON).trimStart().startsWith('"use client"')).toBe(true);
  });
});

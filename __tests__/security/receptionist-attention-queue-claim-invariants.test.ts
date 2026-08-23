import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — CLAIM FROM QUEUE governance invariants
 * (the AI Receptionist Programme, R60 — CLAIM FROM QUEUE, over R59's ATTENTION QUEUE SURFACE + R46's CLAIM capability).
 *
 * R59 shipped the READ-ONLY Attention Queue: the operator sees, grouped by ownership, the work that needs attention. R60
 * adds the ONE affordance to take ownership of an UNOWNED row WITHOUT leaving the queue — and it does so by REUSING THE
 * EXISTING Conversation Work Claim capability (R46), not by inventing a second one. Its law is exact: "the queue claim
 * reuses the existing claim runtime and creates NO new claim mechanism; the R46 claim runtime remains authoritative; the
 * R58 attention-queue runtime remains authoritative; the ownership read model remains authoritative; organisation
 * isolation is preserved; the audit remains append-only; and NO execution path beyond the claim is introduced." This
 * suite proves that contract as a matter of SOURCE, not discipline — the house bar of the R30→R59 invariant suites:
 *
 *   • R60 SHIPS, AND ONLY AS AN AFFORDANCE — the queue action exports the single `claimFromQueueAction`; the client
 *     button exports `AttentionQueueClaimButton`; the R59 pure core gains ONE eligibility field (`canClaim = !owned`, a
 *     `!owned` mirror of the R47 detail surface); the page renders the button ONLY on `canClaim` rows and DELEGATES the
 *     claim to it — the page names no runtime, no write primitive and neither claim action itself.
 *   • IT CREATES NO NEW CLAIM MECHANISM — across all non-test source the ledger write primitive
 *     (`record_receptionist_conversation_claim`) is named by EXACTLY ONE module (the R46 runtime); `claimConversationWork`
 *     is DEFINED exactly once (the R46 runtime); the outcome projection `describeClaimOutcome` is DEFINED exactly once
 *     (the R47 view core) and REUSED; the queue action `claimFromQueueAction` and the button are each defined once. The
 *     queue action is the R47 detail action's SIBLING: byte-for-byte the same claim path (runtime + projection),
 *     differing ONLY in which surface it revalidates.
 *   • THE ACTION CONSUMES ONLY THE RUNTIME — its ONE claim path is `claimConversationWork`; its whole import surface is
 *     the runtime, the reused R47 projection and the HQ + session gates, nothing else. It opens no database client, names
 *     no write primitive, names no pure resolver, issues no RPC and no direct write — it cannot bypass the runtime
 *     because its only claim mechanism IS the runtime.
 *   • THE BUTTON CONSUMES ONLY ITS ACTION — its ONLY claim path is `claimFromQueueAction`; it imports React, the Next
 *     router, its action and the R47 view TYPE, nothing else. It reaches no server module, no database client, no write
 *     primitive; and it does NOT import the queue's own view core, so the R59 invariant "the queue core is consumed by
 *     the page alone" holds.
 *   • ORGANISATION ISOLATION IS PRESERVED — the action is HQ-gated (`requireHqPage`) and scopes the claim to the org
 *     resolved from the SESSION (`requireOrgContext` → `ctx.org.id`), NEVER a parameter; the operator identity is the
 *     authenticated user (`user.id`), never a client value; the only client input is which coordination to claim.
 *   • THE AUDIT STAYS APPEND-ONLY — neither R60 file names the claims ledger table, issues a direct write or an RPC, or
 *     joins the ledger-reader set; the claim's sole record is the R46 runtime's append-only ledger row.
 *   • NO EXECUTION PATH BEYOND THE CLAIM — neither R60 file names any engine execution function, any OTHER ownership
 *     write runtime (release / reassign), any other engine writer, or any R60 non-goal token (assign to others /
 *     reassign / release / dispatch / notify / schedule / promote / complete / …) or transport / calendar / quote /
 *     voice / whatsapp / email / memory / generation path. The action's ONLY effect beyond the claim is
 *     `revalidatePath(<queue>)`; the button's is `router.refresh()`.
 *   • THE MODULE BOUNDARIES HOLD — the action is a server action ("use server"); the button is a client component
 *     ("use client") whose only claim path is the action.
 *
 * The claim-from-queue runtime behaviour (eligibility, conflict, org isolation over real Postgres) is pinned in
 * __tests__/integration/receptionist/attention-queue-claim-from-queue-pipeline.test.ts, and the pure `canClaim`
 * eligibility exhaustively in __tests__/receptionist/conversation-attention-queue-view.test.ts. This tier is HERMETIC —
 * a filesystem scan over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
 * match nor trip a negative.
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

// The R46 capability — the runtime that records a claim (UNCHANGED by R60).
const RUNTIME = "server/services/receptionist-claim.ts";

// The R47 reuse surface — the pure view core (`describeClaimOutcome`) and the detail-surface action (the queue action's
// byte-for-byte SIBLING, differing only in the revalidate target).
const CLAIM_VIEW_CORE = "lib/receptionist/conversation-claim-view.ts";
const DETAIL_ACTION = "app/admin/ai-receptionist/worklist/[coordinationId]/claim-actions.ts";

// The R59 attention-queue surface the R60 claim is added to — the pure view core (now with `canClaim`) and the page.
const SURFACE_CORE = "lib/receptionist/conversation-attention-queue-view.ts";
const PAGE = "app/admin/ai-receptionist/worklist/attention/page.tsx";

// The R60 additions — the queue-level claim ACTION and the client claim BUTTON.
const QUEUE_ACTION = "app/admin/ai-receptionist/worklist/attention/claim-actions.ts";
const QUEUE_BUTTON = "app/admin/ai-receptionist/worklist/attention/claim-button.tsx";

/** The two R60 files whose EXECUTABLE source must add a claim THROUGH the runtime and NOTHING else. */
const R60_FILES = [QUEUE_ACTION, QUEUE_BUTTON] as const;

// Module specifiers.
const RUNTIME_MODULE = "@/server/services/receptionist-claim";
const CLAIM_VIEW_MODULE = "@/lib/receptionist/conversation-claim-view";
const QUEUE_SURFACE_CORE_MODULE = "@/lib/receptionist/conversation-attention-queue-view";
const HQ_AUTH_MODULE = "@/server/auth/hq";
const SESSION_AUTH_MODULE = "@/server/auth/session";

/** The EXACT import surface the queue ACTION is authorised to have — the revalidate hook, the HQ + session gates, the
 *  R46 runtime and the reused R47 outcome projection. Nothing else — no client, no other server service. */
const ALLOWED_ACTION_IMPORTS = ["next/cache", HQ_AUTH_MODULE, SESSION_AUTH_MODULE, RUNTIME_MODULE, CLAIM_VIEW_MODULE].sort();

/** The EXACT import surface the client BUTTON is authorised to have — React, the Next router, its own action and the
 *  reused R47 view TYPE. It does NOT import the queue's view core (that stays the page's alone). */
const ALLOWED_BUTTON_IMPORTS = ["react", "next/navigation", "./claim-actions", CLAIM_VIEW_MODULE].sort();

/** The claim ledger's write primitive — the ONE function that files a claim; and the family of ownership writers. */
const WRITE_FN = /\brecord_receptionist_conversation_claim\b/;
const WRITE_PRIMITIVE = /record_receptionist_conversation_\w+/;

/** The R46 runtime entry — the ONE governed mechanism that records a claim — and its single definition. */
const RUNTIME_ENTRY = /\bclaimConversationWork\b/;
const RUNTIME_ENTRY_DEF = /export async function claimConversationWork\(/;

/** The two claim ACTIONS (each defined once) + the reused R47 outcome projection + the R60 button. */
const QUEUE_ACTION_ENTRY_DEF = /export async function claimFromQueueAction\(/;
const DETAIL_ACTION_ENTRY_DEF = /export async function claimWorkItemAction\(/;
const OUTCOME_DEF = /export function describeClaimOutcome\(/;
const BUTTON_ENTRY_DEF = /export function AttentionQueueClaimButton\(/;

/** The R60 eligibility rule the pure core added — a `!owned` mirror of the R47 detail surface's `canClaim`. */
const CANCLAIM_RULE = /canClaim:\s*!ownership\.owned/;

/** The claims ledger table + the R36 coordinations base table — the queue claim names neither (it goes through the runtime). */
const CLAIM_LEDGER = /\breceptionist_conversation_claims\b/;
const COORDINATIONS_TABLE = /\breceptionist_conversation_coordinations\b/;

/** Every engine EXECUTION function (deriving/performing runtimes + resolvers) — the queue claim names none of them. */
const ENGINE_EXECUTION_FNS =
  /\b(?:fulfilApprovedBooking|verifyApprovedFulfilment|recoverVerifiedFulfilment|resolveConversationCompletion|governConversationLifecycle|orchestrateConversationLifecycle|coordinateConversationLifecycle|resolveConversationCoordination|resolveClaim|resolveFulfilment|resolveVerification|resolveRecovery|resolveResolution|resolveLifecycle|resolveOrchestration|resolveCoordination)\b/;

/** The OTHER ownership write runtimes + their resolvers — the queue CLAIMS ONLY; it never releases or reassigns. */
const OTHER_WRITE_RUNTIMES =
  /\b(?:releaseConversationWork|reassignConversationWork|resolveRelease|resolveReassignment)\b/;

/**
 * The R60 explicit non-goals as SOURCE tokens — the queue claim CLAIMS; it does nothing else. Beyond R46/R47's set this
 * adds `reassign` and `release` (both explicit R60 non-goals). NOTE `\bassign\w*` NEVER matches "reassign" (no boundary
 * between "re" and "assign"), so `reassign` is pinned separately; `\bemail\b` is NOT in this shared set because the
 * action legitimately reads the operator's login `user.email` — the email CHANNEL is forbidden on the BUTTON only, below.
 */
const NON_GOAL_TOKENS = [
  /\bassign\w*/i, // assignment to others (NEVER matches "reassign")
  /\breassign\w*/i, // reassignment
  /\brelease\w*/i, // release
  /\bdispatch\w*/i,
  /\bnotif\w*/i, // notify / notification
  /\bschedul\w*/i, // schedule / scheduling
  /\benqueue\w*/i,
  /\bretr(?:y|ies)\b/i,
  /\bpromot\w*/i, // customer promotion
  /\bcomplet\w*/i, // work completion
  /\bclos(?:e|ing|ed|ure)\b/i, // conversation closing
] as const;

/** Direct-write / bypass tokens no R60 module may name (the ledger is written ONLY through the runtime). */
const DIRECT_WRITE = /\.(?:insert|update|delete|upsert)\(/;

// =====================================================================
// 0. R60 ships — the queue action, the client button, the core's eligibility field, the page's delegated affordance.
// =====================================================================

describe("receptionist claim-from-queue — R60 ships as an affordance only", () => {
  it("ships the queue claim action and the client claim button", () => {
    for (const f of R60_FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
  });

  it("the queue action exports the single claim action; the button exports the single claim control", () => {
    expect(codeOf(read(QUEUE_ACTION))).toMatch(QUEUE_ACTION_ENTRY_DEF);
    expect(codeOf(read(QUEUE_BUTTON))).toMatch(BUTTON_ENTRY_DEF);
  });

  it("the R59 pure core gains ONE eligibility field — canClaim = !owned — and stays a pure projection", () => {
    const code = codeOf(read(SURFACE_CORE));
    expect(code, "the core surfaces claim eligibility as a pure !owned mirror").toMatch(CANCLAIM_RULE);
    // The eligibility is derived, never a claim: the core still names no runtime, no write primitive and no ledger.
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(CLAIM_LEDGER);
  });

  it("the page renders the button on eligible rows and DELEGATES the claim — it names no runtime, primitive or action", () => {
    const code = codeOf(read(PAGE));
    expect(code, "renders the claim button").toMatch(/<AttentionQueueClaimButton\b/);
    expect(code, "guards the affordance on the pure eligibility flag").toMatch(/row\.canClaim/);
    expect(importSpecifiers(code), "imports the client button").toContain("./claim-button");
    // Delegation, not execution: the page itself names no claim mechanism.
    expect(code).not.toMatch(RUNTIME_ENTRY);
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(/\bclaimFromQueueAction\b/);
    expect(code).not.toMatch(/\bclaimWorkItemAction\b/);
  });
});

// =====================================================================
// 1. IT CREATES NO NEW CLAIM MECHANISM — one writer, one runtime, one reused projection; the sibling of the R47 action.
// =====================================================================

describe("receptionist claim-from-queue — creates no new claim mechanism", () => {
  it("across all source, the ledger write primitive is named by EXACTLY ONE module — the R46 runtime (R60 adds no writer)", () => {
    expect(namersOf(WRITE_FN)).toEqual([RUNTIME]);
  });

  it("claimConversationWork is DEFINED in exactly one module — the R46 runtime (the queue action calls, never defines)", () => {
    expect(namersOf(RUNTIME_ENTRY_DEF)).toEqual([RUNTIME]);
  });

  it("the outcome projection describeClaimOutcome is DEFINED in exactly one module — the R47 view core (REUSED, not re-made)", () => {
    expect(namersOf(OUTCOME_DEF)).toEqual([CLAIM_VIEW_CORE]);
  });

  it("each claim action is DEFINED exactly once — the queue action and its R47 detail sibling are distinct, single modules", () => {
    expect(namersOf(QUEUE_ACTION_ENTRY_DEF)).toEqual([QUEUE_ACTION]);
    expect(namersOf(DETAIL_ACTION_ENTRY_DEF)).toEqual([DETAIL_ACTION]);
  });

  it("the client button is DEFINED exactly once — the R60 button module", () => {
    expect(namersOf(BUTTON_ENTRY_DEF)).toEqual([QUEUE_BUTTON]);
  });

  it("the queue action is the R47 detail action's SIBLING — same runtime + projection, differing only in what it revalidates", () => {
    const queue = codeOf(read(QUEUE_ACTION));
    const detail = codeOf(read(DETAIL_ACTION));
    // Both consume the SAME claim runtime and the SAME outcome projection — no new mechanism.
    for (const code of [queue, detail]) {
      expect(code).toMatch(RUNTIME_ENTRY);
      expect(code).toMatch(/\bdescribeClaimOutcome\b/);
      expect(code).toMatch(/requireHqPage\(/);
    }
    // The ONE difference: the queue action revalidates the QUEUE path (the detail action revalidates the detail page).
    expect(queue).toMatch(/revalidatePath\(\s*["']\/admin\/ai-receptionist\/worklist\/attention["']\s*\)/);
  });
});

// =====================================================================
// 2. THE ACTION CONSUMES ONLY THE RUNTIME — one claim path; a pinned import surface; no bypass.
// =====================================================================

describe("receptionist claim-from-queue — the action consumes only the R46 runtime", () => {
  it("the action's ONE claim path is the runtime entry claimConversationWork, imported from the R46 runtime", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(RUNTIME_ENTRY);
    expect(importSpecifiers(code)).toContain(RUNTIME_MODULE);
  });

  it("the action's WHOLE import surface is EXACTLY the authorised set — revalidate, gates, runtime, reused projection", () => {
    expect([...importSpecifiers(codeOf(read(QUEUE_ACTION)))].sort()).toEqual(ALLOWED_ACTION_IMPORTS);
  });

  it("the action's only server-service import is the R46 runtime — it reaches no other service", () => {
    const specs = importSpecifiers(codeOf(read(QUEUE_ACTION)));
    expect(specs.filter((s) => s.startsWith("@/server/services/"))).toEqual([RUNTIME_MODULE]);
  });

  it("the action opens no database client, names no write primitive or pure resolver, issues no RPC and no direct write", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).not.toMatch(WRITE_PRIMITIVE);
    expect(code).not.toMatch(/\bresolveClaim\b/); // it consumes the runtime, not the pure resolver
    expect(code).not.toMatch(/createAdminClient/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.from\(/);
    expect(code).not.toMatch(DIRECT_WRITE);
    expect(importSpecifiers(code)).not.toContain("@/lib/supabase/admin");
  });
});

// =====================================================================
// 3. THE BUTTON CONSUMES ONLY ITS ACTION — one claim path; it never touches the server or the queue core.
// =====================================================================

describe("receptionist claim-from-queue — the button consumes only its action", () => {
  it("the button's ONLY claim path is the queue server action claimFromQueueAction", () => {
    const code = codeOf(read(QUEUE_BUTTON));
    expect(importSpecifiers(code)).toContain("./claim-actions");
    expect(code).toMatch(/\bclaimFromQueueAction\b/);
  });

  it("the button's WHOLE import surface is EXACTLY the authorised set — React, the router, its action, the R47 view type", () => {
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
// 4. ORGANISATION ISOLATION — HQ-gated, org + operator from the session, only the coordination id from the client.
// =====================================================================

describe("receptionist claim-from-queue — organisation isolation is preserved", () => {
  it("the action is HQ-gated and scopes the claim to the org from the SESSION, never from a parameter", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(/requireHqPage\(/);
    expect(code).toMatch(/requireOrgContext\(/);
    expect(code).toMatch(/org_id:\s*ctx\.org\.id/);
    // The action's only parameter is the coordination id — the org is NEVER a parameter.
    expect(code).toMatch(/claimFromQueueAction\(\s*coordinationId:\s*string\s*\)/);
  });

  it("the operator identity comes from the authenticated HQ gate, not the client", () => {
    const code = codeOf(read(QUEUE_ACTION));
    expect(code).toMatch(/const user = await requireHqPage\(\)/);
    expect(code).toMatch(/id:\s*user\.id/);
  });
});

// =====================================================================
// 5. THE AUDIT STAYS APPEND-ONLY — neither R60 file writes, names the ledger, or joins the ledger-reader set.
// =====================================================================

describe("receptionist claim-from-queue — the append-only audit is preserved", () => {
  const ledgerReaders = namersOf(CLAIM_LEDGER);

  it("neither R60 file mutates or reads a base table directly — no direct write, no write primitive, no RPC, no table name", () => {
    for (const f of R60_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f} must issue no direct write`).not.toMatch(DIRECT_WRITE);
      expect(code, `${f} must name no write primitive`).not.toMatch(WRITE_FN);
      expect(code, `${f} must issue no RPC`).not.toMatch(/\.rpc\(/);
      expect(code, `${f} must not name the claims ledger`).not.toMatch(CLAIM_LEDGER);
      expect(code, `${f} must not name the coordinations base table`).not.toMatch(COORDINATIONS_TABLE);
    }
  });

  it("neither R60 file joins the ledger-reader set — the append-only R46 ledger row is the claim's only record", () => {
    for (const f of R60_FILES) {
      expect(ledgerReaders, `${f} must not read the claims ledger`).not.toContain(f);
    }
  });
});

// =====================================================================
// 6. NO EXECUTION PATH BEYOND THE CLAIM — the queue claims and refreshes; it releases, reassigns and dispatches nothing.
// =====================================================================

describe("receptionist claim-from-queue — no execution path beyond the claim", () => {
  it("neither R60 file names any engine EXECUTION function", () => {
    for (const f of R60_FILES) {
      expect(codeOf(read(f)), `${f} must name no engine execution fn`).not.toMatch(ENGINE_EXECUTION_FNS);
    }
  });

  it("neither R60 file names any OTHER ownership write runtime — the queue claims only; it never releases or reassigns", () => {
    for (const f of R60_FILES) {
      expect(codeOf(read(f)), `${f} must name no release/reassign runtime`).not.toMatch(OTHER_WRITE_RUNTIMES);
    }
  });

  it("neither R60 file names any OTHER engine writer", () => {
    for (const f of R60_FILES) {
      const code = codeOf(read(f));
      // The queue action names the R46 runtime ENTRY, not the write primitive — so no `record_receptionist_*` appears.
      expect(code.match(WRITE_PRIMITIVE), `${f}`).toBeNull();
      expect(code, `${f}`).not.toMatch(/record_receptionist_review_resolution/);
      expect(code, `${f}`).not.toMatch(/record_ai_reply_/);
    }
  });

  it("neither R60 file names an R60 non-goal token (assign-to-others/reassign/release/dispatch/notify/…/close)", () => {
    for (const f of R60_FILES) {
      const code = codeOf(read(f));
      for (const token of NON_GOAL_TOKENS) {
        expect(code, `${f} must not name ${token}`).not.toMatch(token);
      }
    }
  });

  it("neither R60 file reaches a transport / calendar / quote / generation path", () => {
    for (const f of R60_FILES) {
      const code = codeOf(read(f));
      expect(code, `${f}`).not.toMatch(/calendar/i);
      expect(code, `${f}`).not.toMatch(/\bquote\b/i);
      expect(code, `${f}`).not.toMatch(/transport/i);
      expect(code, `${f}`).not.toMatch(/generateConversationResponse/);
    }
  });

  it("the client button reaches no voice / whatsapp / email / memory channel (the action legitimately reads user.email)", () => {
    // The channel tokens are asserted on the BUTTON only — the action reads the operator's login `user.email` (an
    // identity, not the email CHANNEL), exactly as the R47 detail action does.
    const code = codeOf(read(QUEUE_BUTTON));
    expect(code).not.toMatch(/\bvoice\b/i);
    expect(code).not.toMatch(/whatsapp/i);
    expect(code).not.toMatch(/\bemail\b/i);
    expect(code).not.toMatch(/\bmemory\b/i);
  });

  it("the ONLY effect beyond the claim is a re-read — the action revalidates the queue, the button refreshes the router", () => {
    expect(codeOf(read(QUEUE_ACTION))).toMatch(/revalidatePath\(/);
    const button = codeOf(read(QUEUE_BUTTON));
    expect(button).toMatch(/router\.refresh\(\)/);
    expect(button, "the button navigates nowhere and fetches nothing").not.toMatch(/router\.(?:push|replace)\(/);
    expect(button).not.toMatch(/\bfetch\(/);
  });
});

// =====================================================================
// 7. THE MODULE BOUNDARIES HOLD — a server action; a client button whose only claim path is that action.
// =====================================================================

describe("receptionist claim-from-queue — the module boundaries hold", () => {
  it("the queue action is a SERVER ACTION — its first directive is \"use server\"", () => {
    expect(read(QUEUE_ACTION).trimStart().startsWith('"use server"')).toBe(true);
  });

  it("the claim button is a CLIENT COMPONENT — its first directive is \"use client\"", () => {
    expect(read(QUEUE_BUTTON).trimStart().startsWith('"use client"')).toBe(true);
  });
});

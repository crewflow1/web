import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — MULTI-TURN CONVERSATION RUNTIME + FORMAL STATE MACHINE + INTENT ENGINE +
 * GOAL ENGINE invariants (the AI Receptionist Programme, R15 — MULTI-TURN CONVERSATION RUNTIME; R17 —
 * FORMAL STATE MACHINE; R18 — CONVERSATION INTENT ENGINE; R19 — CONVERSATION GOAL ENGINE).
 *
 * R1–R14 built a one-shot responder and welded three absolute boundaries: exactly ONE enforcement
 * path, exactly ONE transport-write path, exactly ONE provider door — all captive to the canonical
 * service. R15 turns the receptionist into a CONVERSATION RUNTIME: `runConversationTurn` in
 * server/services/receptionist.ts orchestrates the nine canonical steps (resolve → timeline →
 * context → state → generate → policy → audit → route → advance). The directive's law is that this
 * runtime becomes "the single orchestration layer for every future AI conversation" and that it adds
 * "no alternative execution path" — it REUSES every existing layer and RECREATES none.
 *
 * This suite proves that law as a matter of SOURCE, not discipline:
 *
 *   • THE PURE CORE REACHES NOTHING — lib/receptionist/runtime.ts (the deterministic calculus) imports
 *     NOTHING: it names no policy decision surface, no provider factory, no transport / state write
 *     primitive, no DB client. It cannot be a second enforcement, generation or transport path.
 *   • ADDING R15 INTRODUCED NO NEW REACHER — the policy reacher set and the transport-write set are
 *     STILL exactly the canonical service; the pure core is in neither.
 *   • THE RUNTIME IS THE SINGLE ORCHESTRATION LAYER — the canonical dispatch
 *     (`dispatchReceptionistReply`), the draft generator (`generateReplyDraft`) and the turn entry
 *     (`runConversationTurn`) are each reached by EXACTLY the one blessed service; no feature composes,
 *     enforces, audits, transports or advances a conversation outside it.
 *   • THE ORCHESTRATION FOLDS THE CANONICAL PIPELINE, IN ORDER — `runConversationTurn` resolves →
 *     assembles context → delegates GENERATE→POLICY→AUDIT→ROUTE WHOLE to `dispatchReceptionistReply`
 *     → classifies → PLANS+advances; the dispatch consumes the caller's input UNCHANGED — the R17 state
 *     machine GOVERNS the progression, it does not GATE the turn.
 *   • ONLY THE RUNTIME ADVANCES STATE, AND ONLY UNDER A VALIDATED EDGE — the state writer is named by
 *     exactly one module, org-scoped in the migration, the vocabulary is defined ONCE in the pure core
 *     and mirrored by the CHECK, and (R17) every persisted advance passes the pure core's formal state
 *     machine (`planConversationTransition`), single-sourced beside the vocabulary it governs.
 *   • (R18) A SECOND PURE ENGINE GOVERNS CONVERSATIONAL INTENT — lib/receptionist/conversation-intent.ts
 *     resolves intent DETERMINISTICALLY from the canonical context (reusing the R2 booking detector and
 *     the R12 context type, nothing else) and governs its progression with the SAME advance / unchanged /
 *     rejected discipline as the state machine. It is single-sourced, has EXACTLY ONE consumer (the
 *     service), persists ONLY under a machine-validated advance through its OWN org-scoped SECURITY
 *     DEFINER writer, and NEVER touches the ownership marker — so intent progression, a distinct
 *     observation, can never bypass the state machine.
 *   • (R19) A THIRD PURE ENGINE GOVERNS THE CONVERSATIONAL GOAL — lib/receptionist/conversation-goal.ts
 *     sits ON TOP of the intent engine: it ELEVATES the resolved intent (its SOLE import — it reaches no
 *     context, no detector, no policy, no provider, no DB, no model) into the conversation's OBJECTIVE and
 *     governs its progression with the SAME advance / unchanged / rejected discipline under a MONOTONIC
 *     OBJECTIVE law. It is single-sourced, has EXACTLY ONE consumer (the service), persists ONLY under a
 *     machine-validated advance through its OWN org-scoped SECURITY DEFINER writer, DUPLICATES no intent
 *     resolution (it never names the intent resolver), and NEVER moves the ownership OR intent marker — so
 *     goal progression, a THIRD distinct observation, can never bypass the state machine or the intent engine.
 *
 * The runtime's PURE calculus is pinned exhaustively in the unit tier
 * (__tests__/receptionist/runtime.test.ts); its end-to-end REACHING behaviour over real Postgres
 * (resolve → advance, repeat-reply continuation, duplicate no-op) is pinned in the integration tier
 * (__tests__/integration/receptionist/runtime-pipeline.test.ts). This tier is HERMETIC — a filesystem
 * scan over comment-stripped source — so the prose documenting the contract can neither satisfy a
 * positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable TS source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Strip `--` line comments so only executable SQL is matched. */
function sqlCodeOf(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
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

const SERVICE = "server/services/receptionist.ts";
const RUNTIME_CORE = "lib/receptionist/runtime.ts";
const INTENT_CORE = "lib/receptionist/conversation-intent.ts";
const DRAFT = "server/services/receptionist-draft.ts";
const CONTEXT_SEAM = "server/services/receptionist-conversation-context.ts";
const POLICY = "lib/receptionist/policy.ts";
const COMMS_INDEX = "lib/comms/index.ts";
const MIGRATION = "supabase/migrations/20260822000000_receptionist_conversation_runtime.sql";
const INTENT_MIGRATION = "supabase/migrations/20260823000000_receptionist_conversation_intent.sql";

/** The harvested policy's decision surface. */
const DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply)\b/;
const POLICY_SPEC = "@/lib/receptionist/policy";
/** The provider factory — the only door to a vendor adapter. */
const PROVIDER_FACTORY = /\bgetSmsProvider\b/;
/** The transport ledger's write primitive. */
const TRANSPORT_WRITE_FN = /\brecord_ai_reply_transport\b/;
/** The runtime state's write primitive — the only door that advances a conversation's state. */
const RUNTIME_STATE_WRITE_FN = /\bset_receptionist_conversation_runtime_state\b/;
/** The intent engine's write primitive — the only door that advances a conversation's intent (R18). */
const INTENT_WRITE_FN = /\bset_receptionist_conversation_intent\b/;
const GOAL_CORE = "lib/receptionist/conversation-goal.ts";
const GOAL_MIGRATION = "supabase/migrations/20260824000000_receptionist_conversation_goal.sql";
/** The goal engine's write primitive — the only door that advances a conversation's goal (R19). */
const GOAL_WRITE_FN = /\bset_receptionist_conversation_goal\b/;
const INFORMATION_CORE = "lib/receptionist/conversation-information.ts";
const INFORMATION_MIGRATION =
  "supabase/migrations/20260825000000_receptionist_conversation_information.sql";
/** The information engine's write primitive — the only door that persists a conversation's information (R20). */
const INFORMATION_WRITE_FN = /\bset_receptionist_conversation_information\b/;

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

/** Every non-test module whose EXECUTABLE source NAMES the given token. */
const namersOf = (re: RegExp): string[] =>
  walkSources(SOURCE_ROOTS)
    .filter((full) => re.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();

// =====================================================================
// 0. The runtime ships — the pure core, the migration, and the orchestration entry.
// =====================================================================

describe("receptionist runtime — the multi-turn runtime ships", () => {
  it(`ships the pure core ${RUNTIME_CORE}`, () => {
    expect(existsSync(resolve(ROOT, RUNTIME_CORE)), RUNTIME_CORE).toBe(true);
  });

  it(`ships the runtime-state migration ${MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION)), MIGRATION).toBe(true);
  });

  it("the pure core exports the deterministic state calculus", () => {
    const core = codeOf(read(RUNTIME_CORE));
    expect(core).toMatch(/export function classifyTurn\(/);
    expect(core).toMatch(/export function nextConversationState\(/);
    expect(core).toMatch(/export function advanceConversationState\(/);
    expect(core).toMatch(/export const CONVERSATION_STATES/);
  });

  it("the canonical service exports the orchestration entry and its result type", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/export async function runConversationTurn\(/);
    expect(code).toMatch(/export type ConversationTurnResult = \{/);
  });
});

// =====================================================================
// 1. THE PURE CORE REACHES NOTHING — it cannot be a second enforcement /
//    generation / transport / state path.
// =====================================================================

describe("receptionist runtime — the pure core is a leaf that reaches nothing", () => {
  const core = codeOf(read(RUNTIME_CORE));

  it("imports NOTHING — the calculus is a pure leaf (no policy, no provider, no DB, no I/O)", () => {
    expect(importSpecifiers(core)).toEqual([]);
  });

  it("names no policy decision surface", () => {
    expect(importSpecifiers(core)).not.toContain(POLICY_SPEC);
    expect(DECISION_FNS.test(core)).toBe(false);
  });

  it("names no provider factory, no transport write, no state write primitive", () => {
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
  });

  it("is NOT server-only — it holds no secret and touches no environment (usable in any tier)", () => {
    // The leaf is pure state calculus; it must not depend on the server boundary to be safe.
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });
});

// =====================================================================
// 2. ADDING R15 INTRODUCED NO NEW REACHER — the enforcement + transport
//    boundaries are STILL exactly the canonical service.
// =====================================================================

describe("receptionist runtime — R15 added no new enforcement or transport path", () => {
  const policyReachers = walkSources(SOURCE_ROOTS)
    .filter((full) => rel(full) !== POLICY) // the policy DEFINES the surface; it is not a reacher
    .filter((full) => {
      const code = codeOf(read(rel(full)));
      return importSpecifiers(code).includes(POLICY_SPEC) || DECISION_FNS.test(code);
    })
    .map(rel)
    .sort();

  it("the policy is STILL reached by exactly the canonical service — the pure core is not a reacher", () => {
    expect(policyReachers).toEqual([SERVICE]);
    expect(policyReachers).not.toContain(RUNTIME_CORE);
  });

  it("the transport ledger is STILL written by exactly the canonical service", () => {
    expect(namersOf(TRANSPORT_WRITE_FN)).toEqual([SERVICE]);
  });

  it("the provider factory is STILL captive to the canonical service", () => {
    const providerReachers = walkSources(SOURCE_ROOTS)
      .filter((full) => rel(full) !== COMMS_INDEX) // exclude the factory home
      .filter((full) => PROVIDER_FACTORY.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(providerReachers).toEqual([SERVICE]);
  });
});

// =====================================================================
// 3. THE RUNTIME IS THE SINGLE ORCHESTRATION LAYER — dispatch, generation,
//    and the turn entry are each captive to the one blessed service.
// =====================================================================

describe("receptionist runtime — the single orchestration layer", () => {
  it("the canonical dispatch is named by EXACTLY ONE module — the service (no feature dispatches directly)", () => {
    expect(namersOf(/\bdispatchReceptionistReply\b/)).toEqual([SERVICE]);
  });

  it("the draft generator is reached by EXACTLY ONE consumer — the service (no feature drafts outside the pipeline)", () => {
    const draftReachers = namersOf(/\bgenerateReplyDraft\b/).filter((p) => p !== DRAFT);
    expect(draftReachers).toEqual([SERVICE]);
  });

  it("the turn entry is named by EXACTLY ONE module — the service (the orchestration lives in one place)", () => {
    expect(namersOf(/\brunConversationTurn\b/)).toEqual([SERVICE]);
  });

  it("the pure core has EXACTLY ONE server consumer — the orchestrating service", () => {
    const coreImporters = walkSources(SOURCE_ROOTS)
      .filter((full) => importSpecifiers(codeOf(read(rel(full)))).includes("@/lib/receptionist/runtime"))
      .map(rel)
      .sort();
    expect(coreImporters).toEqual([SERVICE]);
  });
});

// =====================================================================
// 4. THE ORCHESTRATION FOLDS THE CANONICAL PIPELINE, IN ORDER — resolve →
//    context → dispatch(generate+policy+audit+route) → classify → advance.
// =====================================================================

describe("receptionist runtime — the nine canonical steps, in order, delegating the pipeline whole", () => {
  const code = codeOf(read(SERVICE));

  it("runConversationTurn RESOLVES → RECONSTRUCTS+ASSEMBLES ONCE → DISPATCHES → CLASSIFIES → PLANS → ADVANCES, in that order", () => {
    // Steps 2–4 go THROUGH the R12 seam `getConversationTurnContext` — the single server-side
    // reconstruct-and-assemble path (R16), which yields BOTH the assembled context AND the summary
    // (carrying `runtime_state`) from ONE reconstruction, so state is determined WITHOUT a separate
    // read. The runtime never calls the pure `assembleConversationContext` directly (that would be a
    // second assembly path, forbidden by the R12 invariant). Then the pipeline is delegated whole, the
    // turn is classified from its outcome, and — R17 — the progression is PLANNED through the formal
    // state machine (`planConversationTransition`) BEFORE the writer runs, so every persisted advance
    // passes the machine's validation. The classify → plan → persist order is fixed here in source.
    expect(code).toMatch(
      /export async function runConversationTurn\([\s\S]*?getConversationTurnContext\([\s\S]*?dispatchReceptionistReply\(\s*input,[\s\S]*?classifyTurn\([\s\S]*?planConversationTransition\([\s\S]*?setConversationRuntimeState\(/,
    );
  });

  it("delegates GENERATE→POLICY→AUDIT→ROUTE WHOLE to the canonical dispatch — the input is UNCHANGED (governed, not gated)", () => {
    // The dispatch receives the caller's `input` VERBATIM as its first argument. The second argument is
    // the already-assembled canonical context threaded down (R16) — a performance consolidation that
    // spares the generator a duplicate reconstruction, NOT a prior-state gate. R17 adds a formal state
    // machine, but it GOVERNS the state's PROGRESSION (post-dispatch); it does NOT GATE the turn on the
    // prior state — no prior-state branch re-shapes the dispatch, so intent progression and slot filling
    // stay non-goals the runtime encodes none of.
    expect(code).toMatch(
      /const dispatch = await dispatchReceptionistReply\(\s*input,\s*assembledContext\s*\)/,
    );
  });

  it("the missed-call wiring delegates to the runtime — not to the dispatch directly", () => {
    expect(code).toMatch(/maybeTextBackMissedCall\([\s\S]*?runConversationTurn\(/);
  });

  it("invokes the runtime exactly once, and the dispatch exactly once (no parallel loop)", () => {
    expect((code.match(/await runConversationTurn\s*\(/g) ?? []).length).toBe(1);
    expect((code.match(/await dispatchReceptionistReply\s*\(/g) ?? []).length).toBe(1);
  });

  it("classifies the turn from DISPATCH FACTS only — verdict, duplicate, audit-produced (not from state)", () => {
    expect(code).toMatch(
      /classifyTurn\(\{[\s\S]*?verdict:[\s\S]*?duplicate:[\s\S]*?auditProduced:[\s\S]*?\}\)/,
    );
  });
});

// =====================================================================
// 5. ONLY THE RUNTIME ADVANCES STATE — the single, validated, throw-on-failure
//    state-write path.
// =====================================================================

describe("receptionist runtime — exactly one module advances the conversation state", () => {
  const code = codeOf(read(SERVICE));

  it("the state writer is named by EXACTLY ONE module — the canonical service", () => {
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
  });

  it("the state advance is MANDATORY-on-attempt — a failed write THROWS (never silently corrupts the marker)", () => {
    // Anchored at the writer helper: it calls the SECURITY DEFINER RPC and throws on error.
    expect(code).toMatch(
      /async function setConversationRuntimeState\([\s\S]*?set_receptionist_conversation_runtime_state[\s\S]*?throw new Error/,
    );
  });

  it("advances only through the SECURITY DEFINER writer — the state helper reaches the RPC, not a raw table update", () => {
    // The only mutation of runtime_state is via the validated writer RPC; the helper never
    // `.update(...)`s the conversations table inline.
    expect(code).toMatch(
      /async function setConversationRuntimeState\([\s\S]*?rpc\(\s*["']set_receptionist_conversation_runtime_state["']/,
    );
  });
});

// =====================================================================
// 6. THE MIGRATION SHIPS THE MINIMAL STATE — additive, CHECK-bounded, backfilled,
//    surfaced on the list view, advanced only through an org-scoped SECURITY DEFINER writer.
// =====================================================================

describe("receptionist runtime — the migration is additive, bounded and org-scoped", () => {
  const sql = sqlCodeOf(read(MIGRATION));

  it("adds ONE nullable-defaulted, CHECK-bounded column (provably additive)", () => {
    expect(sql).toMatch(
      /add column if not exists runtime_state text not null default 'awaiting_ai'/i,
    );
    expect(sql).toMatch(
      /check\s*\(\s*runtime_state in \('awaiting_ai',\s*'awaiting_customer',\s*'awaiting_human'\)\s*\)/i,
    );
  });

  it("backfills pre-runtime conversations to the conservative post-service value", () => {
    expect(sql).toMatch(
      /update public\.receptionist_conversations[\s\S]*?set runtime_state = 'awaiting_customer'[\s\S]*?where runtime_state = 'awaiting_ai'[\s\S]*?message_count > 0/i,
    );
  });

  it("recreates the list view to EXPOSE runtime_state (the R11 read model stays the single reader)", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_list/i);
    expect(sql).toMatch(/c\.runtime_state/i);
  });

  it("advances state ONLY through a validated, org-scoped SECURITY DEFINER writer", () => {
    expect(sql).toMatch(
      /create or replace function public\.set_receptionist_conversation_runtime_state\(/i,
    );
    expect(sql).toMatch(/returns void/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    // Validated in-DDL against the same three values (never persist an out-of-vocabulary state).
    expect(sql).toMatch(/raise exception/i);
    // Org-scoped: a caller advances only its OWN conversation.
    expect(sql).toMatch(
      /update public\.receptionist_conversations[\s\S]*?where id = p_conversation_id[\s\S]*?and org_id = p_org_id/i,
    );
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

// =====================================================================
// 7. THE STATE VOCABULARY IS DEFINED ONCE — the pure core, mirrored by the CHECK.
// =====================================================================

describe("receptionist runtime — the state vocabulary is single-sourced and mirrored", () => {
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines the state vocabulary in exactly one file — the pure core", () => {
    expect(definersOf(/export const CONVERSATION_STATES/)).toEqual([RUNTIME_CORE]);
  });

  it("defines the turn classifier and the fold in exactly one file — the pure core", () => {
    expect(definersOf(/export function classifyTurn\(/)).toEqual([RUNTIME_CORE]);
    expect(definersOf(/export function advanceConversationState\(/)).toEqual([RUNTIME_CORE]);
  });

  it("the pure core and the migration name the IDENTICAL three-value vocabulary (lock-step)", () => {
    const core = codeOf(read(RUNTIME_CORE));
    const sql = sqlCodeOf(read(MIGRATION));
    for (const state of ["awaiting_ai", "awaiting_customer", "awaiting_human"]) {
      expect(core, `core names ${state}`).toContain(`"${state}"`);
      expect(sql, `migration names ${state}`).toContain(`'${state}'`);
    }
  });
});

// =====================================================================
// 8. R16 — RUNTIME CONTEXT CONSOLIDATION: an autonomous turn reconstructs and
//    assembles the canonical context EXACTLY ONCE, then threads that ONE object
//    through the pipeline (no duplicate reconstruction path remains).
// =====================================================================

describe("receptionist runtime — R16: a turn reconstructs and assembles context exactly once", () => {
  it("the runtime acquires context through the SINGLE reconstruct-and-assemble seam, and no other way", () => {
    const code = codeOf(read(SERVICE));
    // The turn's ONE context acquisition is getConversationTurnContext — called exactly once.
    expect((code.match(/getConversationTurnContext\s*\(/g) ?? []).length).toBe(1);
    // And it acquires context NO OTHER way: it never reconstructs, never assembles directly, never
    // takes a separate list read for state, and never issues a second context-only fetch. Any of
    // these reappearing would be a duplicate reconstruction — exactly what R16 removed.
    expect(code, "no direct reconstruction").not.toMatch(/\breconstructConversation\s*\(/);
    expect(code, "no direct pure assembly").not.toMatch(/\bassembleConversationContext\s*\(/);
    expect(code, "no separate list read for runtime_state").not.toMatch(/\bgetConversation\s*\(/);
    expect(code, "no second context-only fetch").not.toMatch(/\bgetConversationContext\s*\(/);
  });

  it("the single-reconstruction seam reconstructs ONCE and assembles ONCE; the context-only fetch delegates to it", () => {
    const code = codeOf(read(CONTEXT_SEAM));
    // getConversationTurnContext is the one reconstruct-and-assemble site; getConversationContext is
    // now defined in terms of it, so the WHOLE seam has exactly one reconstruct/assemble call site.
    expect(code).toMatch(/export async function getConversationTurnContext\(/);
    expect((code.match(/\breconstructConversation\s*\(/g) ?? []).length).toBe(1);
    expect((code.match(/\bassembleConversationContext\s*\(/g) ?? []).length).toBe(1);
    expect(code, "getConversationContext delegates, never re-reconstructs").toMatch(
      /export async function getConversationContext\([\s\S]*?getConversationTurnContext\(/,
    );
  });

  it("the R13 generator REUSES a threaded context, its own fetch retained ONLY as the fallback", () => {
    const code = codeOf(read(DRAFT));
    // A caller-threaded context (input.context) is consumed verbatim; the seam's own org-scoped fetch
    // is the coalesced fallback — so an ORCHESTRATED turn never triggers a second reconstruction here,
    // while a STANDALONE caller (no context threaded) keeps the pre-R16 fetch behaviour, unchanged.
    expect(code, "consumes the threaded context first").toMatch(/input\.context\s*\?\?/);
    expect(code, "the fallback fetch is retained").toMatch(/\bgetConversationContext\s*\(/);
  });

  it("the dispatch accepts the pre-assembled context and threads it to the generator (input passed verbatim)", () => {
    const code = codeOf(read(SERVICE));
    // dispatchReceptionistReply takes the already-assembled context as an optional second argument…
    expect(code).toMatch(
      /export async function dispatchReceptionistReply\(\s*input:[\s\S]*?context\?:\s*ConversationContext[\s\S]*?\)/,
    );
    // …and hands it to the generator, so the draft is built from the runtime's ONE assembly.
    expect(code).toMatch(
      /export async function dispatchReceptionistReply\([\s\S]*?generateReplyDraft\(\{[\s\S]*?context,[\s\S]*?\}\)/,
    );
  });
});

// =====================================================================
// 9. R17 — THE FORMAL CONVERSATION STATE MACHINE: the transition graph, its
//    validator, and its planners are single-sourced in the pure core; the
//    turn-driven planner has EXACTLY ONE consumer (the service); and a
//    progression is PERSISTED ONLY under a machine-validated `advance`.
// =====================================================================

describe("receptionist runtime — R17: the formal state machine governs every persisted progression", () => {
  const core = codeOf(read(RUNTIME_CORE));
  const service = codeOf(read(SERVICE));

  // The whole state-machine surface: the legal-edge relation, the total validator, and the two planners
  // (the raw-endpoint `planStateTransition` and the turn-driven `planConversationTransition`).
  const FSM_SYMBOLS: readonly RegExp[] = [
    /export const CONVERSATION_TRANSITIONS\b/,
    /export function isValidConversationTransition\(/,
    /export function planStateTransition\(/,
    /export function planConversationTransition\(/,
  ];

  it("defines the whole state-machine surface in the pure core — the relation, the validator, and both planners", () => {
    for (const re of FSM_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("single-sources the state machine in the pure core — no other module DEFINES any of its members", () => {
    // Each member is declared (export const/function) in EXACTLY the pure core and nowhere else, so the
    // transition graph, its validator, and its planners cannot fork into a second, divergent authority.
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of FSM_SYMBOLS) expect(definersOf(re), re.source).toEqual([RUNTIME_CORE]);
  });

  it("the turn-driven planner has EXACTLY ONE consumer — the canonical service (no feature plans its own progression)", () => {
    // planConversationTransition is named by the core (its definition) and the service (its sole
    // consumer) and NOTHING else: no feature computes a conversation's next state outside the runtime.
    const consumers = namersOf(/\bplanConversationTransition\b/).filter((p) => p !== RUNTIME_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("the state machine lives in the leaf that reaches nothing — governance that can never enforce, transport, or generate", () => {
    // The planners sit in the pure core, whose import list is empty (§1). Re-asserted here as an R17
    // fact: the progression authority reaches no side-effecting door and names no decision surface.
    expect(importSpecifiers(core)).toEqual([]);
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
  });

  it("persists a progression ONLY under a machine-validated `advance` — the writer is guarded by the plan kind", () => {
    // The single state-write call site runs inside the `transition.kind === "advance"` branch and
    // persists the machine's validated target `transition.to`. An `unchanged` self-loop writes nothing,
    // and a `rejected` illegal edge never reaches the writer.
    expect(service).toMatch(
      /transition\.kind === "advance"[\s\S]*?setConversationRuntimeState\(\{[\s\S]*?runtime_state:\s*transition\.to/,
    );
  });

  it("REFUSES an illegal edge as a governance event — the `rejected` arm carries a reason, is logged, and is never persisted", () => {
    // The plan type carries a `rejected` arm with an explanatory `reason`; the runtime records that
    // governance event and does NOT write. (Unreachable for a real turn — δ's image is the legal
    // relation — but the arm and the guard make the refusal an explicit, testable law.)
    expect(core).toMatch(/kind:\s*"rejected"[\s\S]*?reason:\s*string/);
    expect(service).toMatch(/transition\.kind === "rejected"[\s\S]*?REJECTED/);
  });

  it("derives the transition from the coarse (prior state, turn OUTCOME) ALONE — never from message content", () => {
    // The planner's only inputs are the prior state and the routing (itself classified from dispatch
    // FACTS — verdict / duplicate / audit-produced, §4). No message text is threaded into the
    // progression decision, so the machine encodes no intent progression / slot filling (R17 non-goals).
    expect(service).toMatch(/planConversationTransition\(\s*priorState,\s*routing\s*\)/);
  });
});

// =====================================================================
// 10. R18 — THE CONVERSATION INTENT ENGINE: a SECOND pure leaf that resolves
//     conversational intent DETERMINISTICALLY from the canonical context and governs
//     its progression with the same advance / unchanged / rejected discipline as the
//     state machine — single-sourced, single-consumer, persisting ONLY under a validated
//     advance through its OWN org-scoped writer, and NEVER touching the ownership marker
//     (so intent progression, a distinct observation, can never bypass the state machine).
// =====================================================================

describe("receptionist runtime — R18: the conversation intent engine is a governed, single-sourced pure leaf", () => {
  const core = codeOf(read(INTENT_CORE));
  const service = codeOf(read(SERVICE));

  // The whole intent-engine surface: the vocabulary, the legal-edge relation, the deterministic resolver,
  // the total validator, and the three progression functions (the raw-endpoint planner, the turn fold,
  // and the turn-driven planner). The exact analogue of §9's FSM_SYMBOLS, for the intent layer.
  const INTENT_SYMBOLS: readonly RegExp[] = [
    /export const CONVERSATION_INTENTS\b/,
    /export const INTENT_TRANSITIONS\b/,
    /export function resolveIntent\(/,
    /export function isValidIntentTransition\(/,
    /export function planIntentTransition\(/,
    /export function advanceIntent\(/,
    /export function planIntentProgression\(/,
  ];

  it(`ships the pure intent engine ${INTENT_CORE}, exporting the whole deterministic surface`, () => {
    expect(existsSync(resolve(ROOT, INTENT_CORE)), INTENT_CORE).toBe(true);
    for (const re of INTENT_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly two pure layers and NOTHING else — the R2 booking detector and the R12 context type", () => {
    // The engine's ENTIRE import surface is the canonical booking DETECTOR (its single booking-recognition
    // authority) and the R12 conversation-context TYPE (its sole input contract). It reaches no third
    // module — no policy, no provider, no ledger, no DB, no clock, no model — so it cannot fork a second
    // enforcement, generation or transport path any more than the runtime's own pure core (§1) can.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/receptionist/conversation-context",
      "@/lib/receptionist/intent",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
  });

  it("is NOT server-only and touches no admin client — model-free intent calculus usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole intent surface in the pure engine — no other module DEFINES any member", () => {
    // Each member is declared (export const/function) in EXACTLY the pure engine and nowhere else, so the
    // vocabulary, the transition graph, the resolver and the planners cannot fork into a second authority.
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of INTENT_SYMBOLS) expect(definersOf(re), re.source).toEqual([INTENT_CORE]);
  });

  it("the resolver has EXACTLY ONE consumer — the canonical service (no feature resolves intent independently)", () => {
    // resolveIntent is named by the engine (its definition) and the service (its sole consumer) and
    // NOTHING else: no feature classifies conversational intent outside the single authority.
    const consumers = namersOf(/\bresolveIntent\b/).filter((p) => p !== INTENT_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("the turn-driven progression planner has EXACTLY ONE consumer — the canonical service", () => {
    const consumers = namersOf(/\bplanIntentProgression\b/).filter((p) => p !== INTENT_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("has EXACTLY TWO server importers — the orchestrating service and the R19 goal engine (type-only)", () => {
    // R18 shipped with a SINGLE importer (the service). R19's goal engine sits ON TOP of the intent engine,
    // so it imports the intent module — but ONLY for the `ConversationIntent` TYPE it elevates FROM (a
    // type-only import), NEVER for a runtime value. The intent engine's AUTHORITY is therefore undiminished:
    // its resolver and its turn-driven planner STILL have exactly the one consumer each (the service,
    // asserted just above), and the goal engine names neither. The module-import set is EXACTLY these two
    // and nothing more — no third module reaches into the intent engine.
    const importers = walkSources(SOURCE_ROOTS)
      .filter((full) =>
        importSpecifiers(codeOf(read(rel(full)))).includes("@/lib/receptionist/conversation-intent"),
      )
      .map(rel)
      .sort();
    expect(importers).toEqual([GOAL_CORE, SERVICE]);
    // The second importer is TYPE-ONLY: it consumes the intent VOCABULARY type, not the resolver or planner.
    const goalCore = codeOf(read(GOAL_CORE));
    expect(/\bresolveIntent\b/.test(goalCore), "goal engine does not consume the intent resolver").toBe(
      false,
    );
    expect(
      /\bplanIntentProgression\b/.test(goalCore),
      "goal engine does not consume the intent planner",
    ).toBe(false);
  });

  it("the intent writer is named by EXACTLY ONE module — the canonical service", () => {
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
  });

  it("advances intent ONLY through the SECURITY DEFINER writer — the helper reaches the RPC and throws on failure", () => {
    // The only mutation of `intent` is via the validated writer RPC; the helper never `.update(...)`s the
    // conversations table inline, and a failed write THROWS (the caller then swallows it — a bookkeeping
    // write never gates the turn).
    expect(service).toMatch(
      /async function setConversationIntent\([\s\S]*?rpc\(\s*["']set_receptionist_conversation_intent["']/,
    );
    expect(service).toMatch(
      /async function setConversationIntent\([\s\S]*?set_receptionist_conversation_intent[\s\S]*?throw new Error/,
    );
  });

  it("RESOLVES from the ONE assembled context and PLANS from (prior intent, resolved intent) alone", () => {
    // The engine resolves intent from `assembledContext` — the runtime's single R16 assembly, NOT a second
    // read and NOT a model call — then plans the progression from the prior persisted intent and that
    // resolved intent. Determinism is inherited: the same context always resolves the same intent.
    expect(service).toMatch(/resolveIntent\(\s*assembledContext\s*\)/);
    expect(service).toMatch(/planIntentProgression\(\s*priorIntent,\s*resolvedIntent\s*\)/);
  });

  it("persists a progression ONLY under a validated `advance` — the intent writer is guarded by the plan kind", () => {
    // The single intent-write call site runs inside the `intentTransition.kind === "advance"` branch and
    // persists the engine's validated target `intentTransition.to`. An `unchanged` self-loop writes
    // nothing, and a `rejected` illegal edge never reaches the writer.
    expect(service).toMatch(
      /intentTransition\.kind === "advance"[\s\S]*?setConversationIntent\(\{[\s\S]*?intent:\s*intentTransition\.to/,
    );
  });

  it("REFUSES an illegal intent edge as a governance event — the `rejected` arm carries a reason, is logged, and is never persisted", () => {
    // The plan type carries a `rejected` arm with an explanatory `reason`; the runtime records that
    // governance event and does NOT write. (Unreachable for a real turn — the fold's image is the legal
    // relation — but the arm and the guard make the refusal an explicit, testable law, exactly as §9.)
    expect(core).toMatch(/kind:\s*"rejected"[\s\S]*?reason:\s*string/);
    expect(service).toMatch(/intentTransition\.kind === "rejected"[\s\S]*?REJECTED/);
  });

  it("NEVER moves the ownership marker — intent progression cannot bypass the state machine", () => {
    // The engine writes only the `intent` column, through its OWN writer; in executable source it names
    // neither the runtime-state write primitive nor the state machine's planner. And the R17 state machine
    // is UNDISTURBED: its writer is STILL named by exactly the service and STILL guarded by a validated
    // `advance`, and its turn-driven planner STILL has exactly the one service consumer. So `intent` and
    // `runtime_state` are independent observations written by two distinct, separately-guarded doors —
    // advancing intent can never advance (or bypass the governance of) the ownership state.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "engine never names the state writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "engine never reaches the state machine").toBe(
      false,
    );
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(/\bplanConversationTransition\b/).filter((p) => p !== RUNTIME_CORE)).toEqual([
      SERVICE,
    ]);
    expect(service).toMatch(
      /transition\.kind === "advance"[\s\S]*?setConversationRuntimeState\(\{[\s\S]*?runtime_state:\s*transition\.to/,
    );
  });
});

// =====================================================================
// 11. R18 — THE INTENT MIGRATION SHIPS THE MINIMAL STATE — additive, CHECK-bounded,
//     surfaced on the list view, advanced only through an org-scoped SECURITY DEFINER
//     writer. NO backfill: 'unknown' is the honest initial value for every pre-R18 row.
// =====================================================================

describe("receptionist runtime — R18: the intent migration is additive, bounded and org-scoped", () => {
  it(`ships the intent migration ${INTENT_MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, INTENT_MIGRATION)), INTENT_MIGRATION).toBe(true);
  });

  const sql = sqlCodeOf(read(INTENT_MIGRATION));

  it("adds ONE nullable-defaulted, CHECK-bounded column (provably additive), and NEEDS no backfill", () => {
    expect(sql).toMatch(/add column if not exists intent text not null default 'unknown'/i);
    expect(sql).toMatch(
      /check\s*\(\s*intent in \(\s*'unknown',\s*'general_enquiry',\s*'booking_interest',\s*'callback_request',\s*'quote_request',\s*'human_handoff'\s*\)\s*\)/i,
    );
    // 'unknown' is the honest initial value for every pre-R18 row, so — unlike the R15 runtime_state
    // migration (§6) — this migration performs NO backfill UPDATE that sets intent to a literal value.
    expect(sql, "no backfill of the intent column").not.toMatch(/set intent\s*=\s*'/i);
  });

  it("recreates the list view to EXPOSE intent (the R11 read model stays the single reader)", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_list/i);
    expect(sql).toMatch(/c\.intent/i);
  });

  it("advances intent ONLY through a validated, org-scoped SECURITY DEFINER writer", () => {
    expect(sql).toMatch(/create or replace function public\.set_receptionist_conversation_intent\(/i);
    expect(sql).toMatch(/returns void/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    // Validated in-DDL against the same six values (never persist an out-of-vocabulary intent).
    expect(sql).toMatch(/raise exception/i);
    // Org-scoped: a caller advances only its OWN conversation.
    expect(sql).toMatch(
      /update public\.receptionist_conversations[\s\S]*?where id = p_conversation_id[\s\S]*?and org_id = p_org_id/i,
    );
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

// =====================================================================
// 12. R18 — THE INTENT VOCABULARY IS DEFINED ONCE — the pure engine, mirrored by the CHECK.
// =====================================================================

describe("receptionist runtime — R18: the intent vocabulary is single-sourced and mirrored", () => {
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines the intent vocabulary in exactly one file — the pure engine", () => {
    expect(definersOf(/export const CONVERSATION_INTENTS/)).toEqual([INTENT_CORE]);
  });

  it("defines the resolver, the fold, and the legal-edge relation in exactly one file — the pure engine", () => {
    expect(definersOf(/export function resolveIntent\(/)).toEqual([INTENT_CORE]);
    expect(definersOf(/export function advanceIntent\(/)).toEqual([INTENT_CORE]);
    expect(definersOf(/export const INTENT_TRANSITIONS/)).toEqual([INTENT_CORE]);
  });

  it("the pure engine and the migration name the IDENTICAL six-value vocabulary (lock-step)", () => {
    const core = codeOf(read(INTENT_CORE));
    const sql = sqlCodeOf(read(INTENT_MIGRATION));
    for (const intent of [
      "unknown",
      "general_enquiry",
      "booking_interest",
      "callback_request",
      "quote_request",
      "human_handoff",
    ]) {
      expect(core, `engine names ${intent}`).toContain(`"${intent}"`);
      expect(sql, `migration names ${intent}`).toContain(`'${intent}'`);
    }
  });
});

// =====================================================================
// 13. R19 — THE CONVERSATION GOAL ENGINE: a THIRD pure leaf that sits ON TOP of the R18
//     intent engine — it ELEVATES the resolved INTENT into the conversation's OBJECTIVE and
//     governs its progression with the same advance / unchanged / rejected discipline as the
//     state machine and the intent engine. Single-sourced, single-consumer, persisting ONLY
//     under a validated advance through its OWN org-scoped writer, DUPLICATING no intent
//     resolution (it never names the intent resolver), and NEVER moving the ownership OR intent
//     marker — so goal progression, a THIRD distinct observation, can never bypass the state
//     machine or the intent engine.
// =====================================================================

describe("receptionist runtime — R19: the conversation goal engine is a governed, single-sourced pure leaf", () => {
  const core = codeOf(read(GOAL_CORE));
  const service = codeOf(read(SERVICE));

  // The whole goal-engine surface: the vocabulary, the legal-edge relation, the deterministic resolver,
  // the total validator, and the three progression functions (the raw-endpoint planner, the turn fold,
  // and the turn-driven planner). The exact analogue of §10's INTENT_SYMBOLS, for the goal layer.
  const GOAL_SYMBOLS: readonly RegExp[] = [
    /export const CONVERSATION_GOALS\b/,
    /export const GOAL_TRANSITIONS\b/,
    /export function resolveGoal\(/,
    /export function isValidGoalTransition\(/,
    /export function planGoalTransition\(/,
    /export function advanceGoal\(/,
    /export function planGoalProgression\(/,
  ];

  it(`ships the pure goal engine ${GOAL_CORE}, exporting the whole deterministic surface`, () => {
    expect(existsSync(resolve(ROOT, GOAL_CORE)), GOAL_CORE).toBe(true);
    for (const re of GOAL_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly ONE pure layer and NOTHING else — the R18 intent engine (its sole input contract)", () => {
    // The engine's ENTIRE import surface is the R18 intent engine — the type it ELEVATES FROM. It sits ON
    // TOP of the intent engine and reaches no second module: no context, no booking detector, no policy, no
    // provider, no ledger, no DB, no clock, no model. So — like the runtime's own pure core (§1) and the
    // intent engine (§10) — it cannot fork a second enforcement, generation or transport path.
    expect(importSpecifiers(core).sort()).toEqual(["@/lib/receptionist/conversation-intent"]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no intent resolution and no context assembly — it never names the intent resolver", () => {
    // The cardinal R19 boundary: the goal engine consumes an ALREADY-resolved intent and elevates it; it
    // never RE-resolves intent and never reads the R12 context. In executable source it names neither the
    // intent resolver nor the intent progression planner — so it re-implements no layer beneath it, exactly
    // as the directive requires ("must NOT duplicate ... intent resolution"). (The context is consumed
    // transitively, at the runtime seam: Context → Intent → Goal.)
    expect(/\bresolveIntent\b/.test(core), "goal engine never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "goal engine never names the intent planner").toBe(
      false,
    );
    expect(importSpecifiers(core), "goal engine never imports the R12 context").not.toContain(
      "@/lib/receptionist/conversation-context",
    );
  });

  it("is NOT server-only and touches no admin client — model-free goal calculus usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole goal surface in the pure engine — no other module DEFINES any member", () => {
    // Each member is declared (export const/function) in EXACTLY the pure engine and nowhere else, so the
    // vocabulary, the transition graph, the resolver and the planners cannot fork into a second authority.
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of GOAL_SYMBOLS) expect(definersOf(re), re.source).toEqual([GOAL_CORE]);
  });

  it("the resolver has EXACTLY ONE consumer — the canonical service (no feature resolves a goal independently)", () => {
    // resolveGoal is named by the engine (its definition) and the service (its sole consumer) and NOTHING
    // else: no feature elevates an intent to an objective outside the single authority.
    const consumers = namersOf(/\bresolveGoal\b/).filter((p) => p !== GOAL_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("the turn-driven progression planner has EXACTLY ONE consumer — the canonical service", () => {
    const consumers = namersOf(/\bplanGoalProgression\b/).filter((p) => p !== GOAL_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("has EXACTLY TWO importers — the orchestrating service and the R20 information engine (type-only)", () => {
    // R19 shipped with a SINGLE importer (the service). R20's information engine sits ON TOP of the goal
    // engine, so it imports the goal module — but ONLY for the `ConversationGoal` TYPE it keys its slot
    // schema on (a type-only import), NEVER for a runtime value. The goal engine's AUTHORITY is therefore
    // undiminished: its resolver and its turn-driven planner STILL have exactly the one consumer each (the
    // service, asserted just above), and the information engine names neither. The module-import set is
    // EXACTLY these two and nothing more — no third module reaches into the goal engine.
    const importers = walkSources(SOURCE_ROOTS)
      .filter((full) =>
        importSpecifiers(codeOf(read(rel(full)))).includes("@/lib/receptionist/conversation-goal"),
      )
      .map(rel)
      .sort();
    expect(importers).toEqual([INFORMATION_CORE, SERVICE]);
    // The second importer is TYPE-ONLY: it consumes the goal VOCABULARY type, not the resolver or planner.
    const infoCore = codeOf(read(INFORMATION_CORE));
    expect(/\bresolveGoal\b/.test(infoCore), "information engine does not consume the goal resolver").toBe(
      false,
    );
    expect(
      /\bplanGoalProgression\b/.test(infoCore),
      "information engine does not consume the goal planner",
    ).toBe(false);
  });

  it("the goal writer is named by EXACTLY ONE module — the canonical service", () => {
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
  });

  it("advances goal ONLY through the SECURITY DEFINER writer — the helper reaches the RPC and throws on failure", () => {
    // The only mutation of `goal` is via the validated writer RPC; the helper never `.update(...)`s the
    // conversations table inline, and a failed write THROWS (the caller then swallows it — a bookkeeping
    // write never gates the turn), exactly like the runtime-state (§9) and intent (§10) writers.
    expect(service).toMatch(
      /async function setConversationGoal\([\s\S]*?rpc\(\s*["']set_receptionist_conversation_goal["']/,
    );
    expect(service).toMatch(
      /async function setConversationGoal\([\s\S]*?set_receptionist_conversation_goal[\s\S]*?throw new Error/,
    );
  });

  it("RESOLVES from the resolved intent and PLANS from (prior goal, resolved goal) alone", () => {
    // The engine elevates the intent the R18 engine JUST resolved (`resolvedIntent`) — NOT a second read,
    // NOT the context, NOT a model call — then plans the progression from the prior persisted goal and that
    // resolved goal. Determinism is inherited: the same intent always resolves the same goal. This is the
    // seam that proves the linear stack Context → Intent → Goal.
    expect(service).toMatch(/resolveGoal\(\s*resolvedIntent\s*\)/);
    expect(service).toMatch(/planGoalProgression\(\s*priorGoal,\s*resolvedGoal\s*\)/);
  });

  it("persists a progression ONLY under a validated `advance` — the goal writer is guarded by the plan kind", () => {
    // The single goal-write call site runs inside the `goalTransition.kind === "advance"` branch and
    // persists the engine's validated target `goalTransition.to`. An `unchanged` self-loop writes nothing,
    // and a `rejected` illegal edge never reaches the writer.
    expect(service).toMatch(
      /goalTransition\.kind === "advance"[\s\S]*?setConversationGoal\(\{[\s\S]*?goal:\s*goalTransition\.to/,
    );
  });

  it("REFUSES an illegal goal edge as a governance event — the `rejected` arm carries a reason, is logged, and is never persisted", () => {
    // The plan type carries a `rejected` arm with an explanatory `reason`; the runtime records that
    // governance event and does NOT write. (Unreachable for a real turn — the fold's image is the legal
    // relation — but the arm and the guard make the refusal an explicit, testable law, exactly as §9/§10.)
    expect(core).toMatch(/kind:\s*"rejected"[\s\S]*?reason:\s*string/);
    expect(service).toMatch(/goalTransition\.kind === "rejected"[\s\S]*?REJECTED/);
  });

  it("NEVER moves the ownership marker OR the intent marker — goal progression cannot bypass the state machine or the intent engine", () => {
    // The engine writes only the `goal` column, through its OWN writer; in executable source it names none
    // of: the runtime-state write primitive, the intent write primitive, the state machine's planner, or the
    // intent engine's planner. And the layers beneath it are UNDISTURBED: the R17 state writer and the R18
    // intent writer are STILL each named by exactly the service, and the runtime STILL persists each only
    // under its own validated `advance`. So `runtime_state`, `intent` and `goal` are three independent
    // observations written by three distinct, separately-guarded doors — advancing the goal can never
    // advance (or bypass the governance of) the ownership state or the intent.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "goal engine never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "goal engine never names the intent writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "goal engine never reaches the state machine").toBe(
      false,
    );
    expect(/\bplanIntentProgression\b/.test(core), "goal engine never reaches the intent planner").toBe(
      false,
    );
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(service).toMatch(
      /intentTransition\.kind === "advance"[\s\S]*?setConversationIntent\(\{[\s\S]*?intent:\s*intentTransition\.to/,
    );
  });
});

// =====================================================================
// 14. R19 — THE GOAL MIGRATION SHIPS THE MINIMAL STATE — additive, CHECK-bounded,
//     surfaced on the list view, advanced only through an org-scoped SECURITY DEFINER
//     writer. NO backfill: 'undetermined' is the honest initial value for every pre-R19 row.
// =====================================================================

describe("receptionist runtime — R19: the goal migration is additive, bounded and org-scoped", () => {
  it(`ships the goal migration ${GOAL_MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, GOAL_MIGRATION)), GOAL_MIGRATION).toBe(true);
  });

  const sql = sqlCodeOf(read(GOAL_MIGRATION));

  it("adds ONE nullable-defaulted, CHECK-bounded column (provably additive), and NEEDS no backfill", () => {
    expect(sql).toMatch(/add column if not exists goal text not null default 'undetermined'/i);
    expect(sql).toMatch(
      /check\s*\(\s*goal in \(\s*'undetermined',\s*'answer_enquiry',\s*'arrange_booking',\s*'arrange_callback',\s*'provide_quote',\s*'handoff_to_human'\s*\)\s*\)/i,
    );
    // 'undetermined' is the honest initial value for every pre-R19 row, so — like the R18 intent migration
    // (§11) and unlike the R15 runtime_state migration (§6) — this migration performs NO backfill UPDATE
    // that sets goal to a literal value.
    expect(sql, "no backfill of the goal column").not.toMatch(/set goal\s*=\s*'/i);
  });

  it("recreates the list view to EXPOSE goal (the R11 read model stays the single reader)", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_list/i);
    expect(sql).toMatch(/c\.goal/i);
  });

  it("advances goal ONLY through a validated, org-scoped SECURITY DEFINER writer", () => {
    expect(sql).toMatch(/create or replace function public\.set_receptionist_conversation_goal\(/i);
    expect(sql).toMatch(/returns void/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    // Validated in-DDL against the same six values (never persist an out-of-vocabulary goal).
    expect(sql).toMatch(/raise exception/i);
    // Org-scoped: a caller advances only its OWN conversation.
    expect(sql).toMatch(
      /update public\.receptionist_conversations[\s\S]*?where id = p_conversation_id[\s\S]*?and org_id = p_org_id/i,
    );
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

// =====================================================================
// 15. R19 — THE GOAL VOCABULARY IS DEFINED ONCE — the pure engine, mirrored by the CHECK.
// =====================================================================

describe("receptionist runtime — R19: the goal vocabulary is single-sourced and mirrored", () => {
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines the goal vocabulary in exactly one file — the pure engine", () => {
    expect(definersOf(/export const CONVERSATION_GOALS/)).toEqual([GOAL_CORE]);
  });

  it("defines the resolver, the fold, and the legal-edge relation in exactly one file — the pure engine", () => {
    expect(definersOf(/export function resolveGoal\(/)).toEqual([GOAL_CORE]);
    expect(definersOf(/export function advanceGoal\(/)).toEqual([GOAL_CORE]);
    expect(definersOf(/export const GOAL_TRANSITIONS/)).toEqual([GOAL_CORE]);
  });

  it("the pure engine and the migration name the IDENTICAL six-value vocabulary (lock-step)", () => {
    const core = codeOf(read(GOAL_CORE));
    const sql = sqlCodeOf(read(GOAL_MIGRATION));
    for (const goal of [
      "undetermined",
      "answer_enquiry",
      "arrange_booking",
      "arrange_callback",
      "provide_quote",
      "handoff_to_human",
    ]) {
      expect(core, `engine names ${goal}`).toContain(`"${goal}"`);
      expect(sql, `migration names ${goal}`).toContain(`'${goal}'`);
    }
  });
});

// =====================================================================
// 16. R20 — THE CONVERSATION INFORMATION ENGINE: a FOURTH pure leaf that sits ON TOP of the
//     R19 goal engine — it EXTRACTS the STRUCTURED INFORMATION the current goal needs from the
//     canonical context, validates it on the way in (extraction IS validation), and accumulates
//     it MONOTONICALLY. Single-sourced, single-consumer, persisting ONLY under a validated
//     `updated` through its OWN org-scoped writer, DUPLICATING no context assembly, no intent
//     resolution and no goal resolution (it names none of their resolvers/planners), and NEVER
//     moving the ownership, intent OR goal marker — so information extraction, a FOURTH distinct
//     observation, can never bypass any layer beneath it. It EXTRACTS; it never ACTS.
// =====================================================================

describe("receptionist runtime — R20: the conversation information engine is a governed, single-sourced pure leaf", () => {
  const core = codeOf(read(INFORMATION_CORE));
  const service = codeOf(read(SERVICE));

  // The whole information-engine surface: the field vocabulary, the job-type vocabulary, the goal→slots
  // schema, the deterministic extractor, the accumulation fold, the turn-driven update planner, the
  // deny-unknown coercer, the exposed validator, and the two slot-surface readers. The analogue of §13's
  // GOAL_SYMBOLS, for the information layer.
  const INFORMATION_SYMBOLS: readonly RegExp[] = [
    /export const INFORMATION_FIELDS\b/,
    /export const JOB_TYPES\b/,
    /export const GOAL_SLOTS\b/,
    /export function extractInformation\(/,
    /export function advanceInformation\(/,
    /export function planInformationUpdate\(/,
    /export function coerceConversationInformation\(/,
    /export function isValidFieldValue\(/,
    /export function outstandingSlots\(/,
    /export function isInformationComplete\(/,
  ];

  it(`ships the pure information engine ${INFORMATION_CORE}, exporting the whole deterministic surface`, () => {
    expect(existsSync(resolve(ROOT, INFORMATION_CORE)), INFORMATION_CORE).toBe(true);
    for (const re of INFORMATION_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly THREE pure layers and NOTHING else — the UK phone normaliser, the R12 context type, the R19 goal type", () => {
    // The engine's ENTIRE import surface is the canonical UK phone normaliser (`toE164`, the SAME primitive
    // the SMS transport dials — so an extracted phone is stored in the ONE canonical form), the R12
    // conversation-context TYPE (the facts it READS FROM), and the R19 goal TYPE (which SELECTS the fields).
    // It reaches no fourth module — no policy, no provider, no ledger, no DB, no clock, no model — so it
    // cannot fork a second enforcement, generation or transport path.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/phone",
      "@/lib/receptionist/conversation-context",
      "@/lib/receptionist/conversation-goal",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal / information write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
    expect(INFORMATION_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no context assembly, no intent resolution and no goal resolution — it names none of their resolvers/planners", () => {
    // The cardinal R20 boundary: the engine consumes an ALREADY-assembled context and an ALREADY-resolved
    // goal; it never RE-assembles context, RE-resolves intent, or RE-resolves goal. In executable source it
    // names none of the context assembler, the intent resolver/planner, or the goal resolver/planner — so it
    // re-implements no layer beneath it, exactly as the directive requires ("must NOT duplicate ... context
    // assembly, intent resolution, OR goal resolution"). The context and goal modules are imported for their
    // TYPES ALONE.
    expect(/\bassembleConversationContext\b/.test(core), "never names the context assembler").toBe(false);
    expect(/\bresolveIntent\b/.test(core), "never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never names the intent planner").toBe(false);
    expect(/\bresolveGoal\b/.test(core), "never names the goal resolver").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never names the goal planner").toBe(false);
  });

  it("EXTRACTS ONLY — it re-orchestrates no runtime and executes no business action (booking/scheduling are R20 non-goals)", () => {
    // The engine extracts information and stops; acting on it is a future capability that CONSUMES it. In
    // executable source it names neither the turn orchestrator nor the canonical dispatch — so it can neither
    // re-run the runtime nor send/book/schedule anything.
    expect(/\brunConversationTurn\b/.test(core), "never re-orchestrates the runtime").toBe(false);
    expect(/\bdispatchReceptionistReply\b/.test(core), "never dispatches a reply").toBe(false);
  });

  it("is NOT server-only and touches no admin client — model-free extraction calculus usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole information surface in the pure engine — no other module DEFINES any member", () => {
    // Each member is declared (export const/function) in EXACTLY the pure engine and nowhere else, so the
    // vocabulary, the slot schema, the extractor, the fold and the planner cannot fork into a second authority.
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of INFORMATION_SYMBOLS) expect(definersOf(re), re.source).toEqual([INFORMATION_CORE]);
  });

  it("the extractor has EXACTLY ONE consumer — the canonical service (no feature extracts information independently)", () => {
    // extractInformation is named by the engine (its definition) and the service (its sole consumer) and
    // NOTHING else: no feature reads structured information out of a conversation outside the single authority.
    const consumers = namersOf(/\bextractInformation\b/).filter((p) => p !== INFORMATION_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("the turn-driven update planner has EXACTLY ONE consumer — the canonical service", () => {
    const consumers = namersOf(/\bplanInformationUpdate\b/).filter((p) => p !== INFORMATION_CORE);
    expect(consumers).toEqual([SERVICE]);
  });

  it("the information writer is named by EXACTLY ONE module — the canonical service", () => {
    expect(namersOf(INFORMATION_WRITE_FN)).toEqual([SERVICE]);
  });

  it("persists information ONLY through the SECURITY DEFINER writer — the helper reaches the RPC and throws on failure", () => {
    // The only mutation of `information` is via the validated writer RPC; the helper never `.update(...)`s the
    // conversations table inline, and a failed write THROWS (the caller then swallows it — a bookkeeping write
    // never gates the turn), exactly like the runtime-state (§9), intent (§10) and goal (§13) writers.
    expect(service).toMatch(
      /async function setConversationInformation\([\s\S]*?rpc\(\s*["']set_receptionist_conversation_information["']/,
    );
    expect(service).toMatch(
      /async function setConversationInformation\([\s\S]*?set_receptionist_conversation_information[\s\S]*?throw new Error/,
    );
  });

  it("EXTRACTS from the assembled context + resolved goal and PLANS from (prior information, extracted information) alone", () => {
    // The engine extracts the facts the goal the R19 engine JUST resolved (`nextGoal`, the goal state of
    // record) needs, from the ONE assembled context — NOT a second read, NOT a model call — then plans the
    // accumulation from the prior persisted information and that freshly-extracted information. This is the
    // seam that proves the linear stack Context → Intent → Goal → Information.
    expect(service).toMatch(/extractInformation\(assembledContext,\s*nextGoal\)/);
    expect(service).toMatch(/planInformationUpdate\(priorInformation,\s*extractedInformation\)/);
  });

  it("persists an update ONLY under a validated `updated` — the information writer is guarded by the plan kind", () => {
    // The single information-write call site runs inside the `informationUpdate.kind === "updated"` branch and
    // persists the engine's validated `informationUpdate.information`. An `unchanged` turn writes nothing.
    expect(service).toMatch(
      /informationUpdate\.kind === "updated"[\s\S]*?setConversationInformation\(\{[\s\S]*?information:\s*informationUpdate\.information/,
    );
  });

  it("has NO `rejected` arm — extraction validates on the way in, so the only turn outcomes are updated / unchanged", () => {
    // Unlike the R17/R18/R19 transition plans, the information update type has no `rejected` arm: a value can
    // only enter through an extractor, which validates it, so a malformed value can never be proposed to the
    // fold. The engine's discriminated union names exactly `updated` and `unchanged`.
    expect(core).toMatch(/kind:\s*"updated"/);
    expect(core).toMatch(/kind:\s*"unchanged"/);
    expect(core, "no rejected arm").not.toMatch(/kind:\s*"rejected"/);
  });

  it("NEVER moves the ownership, intent OR goal marker — information extraction cannot bypass any layer beneath it", () => {
    // The engine writes only the `information` column, through its OWN writer; in executable source it names
    // none of: the runtime-state / intent / goal write primitives, or the state / intent / goal planners. And
    // the layers beneath it are UNDISTURBED: the R17 state writer, the R18 intent writer and the R19 goal
    // writer are STILL each named by exactly the service. So `runtime_state`, `intent`, `goal` and
    // `information` are four independent observations written by four distinct, separately-guarded doors —
    // extracting information can never advance (or bypass the governance of) any marker beneath it.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "never names the intent writer").toBe(false);
    expect(GOAL_WRITE_FN.test(core), "never names the goal writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "never reaches the state machine").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never reaches the intent planner").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never reaches the goal planner").toBe(false);
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
  });
});

// =====================================================================
// 17. R20 — THE INFORMATION MIGRATION SHIPS THE MINIMAL STATE — additive, CHECK-bounded to a
//     jsonb OBJECT, surfaced on the list view, persisted only through an org-scoped SECURITY
//     DEFINER writer that validates the SHAPE in-DDL. NO backfill: '{}' is the honest initial
//     value for every pre-R20 row.
// =====================================================================

describe("receptionist runtime — R20: the information migration is additive, bounded and org-scoped", () => {
  it(`ships the information migration ${INFORMATION_MIGRATION}`, () => {
    expect(existsSync(resolve(ROOT, INFORMATION_MIGRATION)), INFORMATION_MIGRATION).toBe(true);
  });

  const sql = sqlCodeOf(read(INFORMATION_MIGRATION));

  it("adds ONE object-defaulted, CHECK-bounded jsonb column (provably additive), and NEEDS no backfill", () => {
    expect(sql).toMatch(/add column if not exists information jsonb not null default '\{\}'::jsonb/i);
    expect(sql).toMatch(/check\s*\(\s*jsonb_typeof\(information\)\s*=\s*'object'\s*\)/i);
    // '{}' is the honest initial value for every pre-R20 row, so — like the R18/R19 marker migrations and
    // unlike the R15 runtime_state migration (§6) — this migration performs NO backfill UPDATE that sets
    // information to a literal value.
    expect(sql, "no backfill of the information column").not.toMatch(/set information\s*=\s*'/i);
  });

  it("recreates the list view to EXPOSE information (the R11 read model stays the single reader)", () => {
    expect(sql).toMatch(/create or replace view public\.receptionist_conversation_list/i);
    expect(sql).toMatch(/c\.information/i);
  });

  it("persists information ONLY through a validated, org-scoped SECURITY DEFINER writer that bounds the SHAPE in-DDL", () => {
    expect(sql).toMatch(
      /create or replace function public\.set_receptionist_conversation_information\(/i,
    );
    expect(sql).toMatch(/returns void/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = ''/i);
    // The SHAPE is validated in-DDL: a jsonb object, every key in the closed field vocabulary, every value a
    // string — so the writer can never persist an out-of-vocabulary key or a non-string value.
    expect(sql).toMatch(/jsonb_typeof\(p_information\)\s*<>\s*'object'/i);
    expect(sql).toMatch(/jsonb_object_keys\(p_information\)/i);
    expect(sql).toMatch(
      /v_key not in \('email_address', 'phone_number', 'postcode', 'job_type'\)/i,
    );
    expect(sql).toMatch(/jsonb_typeof\(p_information -> v_key\)\s*<>\s*'string'/i);
    expect(sql).toMatch(/raise exception/i);
    // Org-scoped: a caller advances only its OWN conversation.
    expect(sql).toMatch(
      /update public\.receptionist_conversations[\s\S]*?where id = p_conversation_id[\s\S]*?and org_id = p_org_id/i,
    );
    expect(sql).toMatch(/revoke all on function[\s\S]*?from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]*?to service_role/i);
  });
});

// =====================================================================
// 18. R20 — THE INFORMATION FIELD VOCABULARY IS DEFINED ONCE — the pure engine, mirrored by the
//     migration's in-DDL key validation.
// =====================================================================

describe("receptionist runtime — R20: the information field vocabulary is single-sourced and mirrored", () => {
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines the field vocabulary in exactly one file — the pure engine", () => {
    expect(definersOf(/export const INFORMATION_FIELDS/)).toEqual([INFORMATION_CORE]);
  });

  it("defines the extractor, the fold, and the turn planner in exactly one file — the pure engine", () => {
    expect(definersOf(/export function extractInformation\(/)).toEqual([INFORMATION_CORE]);
    expect(definersOf(/export function advanceInformation\(/)).toEqual([INFORMATION_CORE]);
    expect(definersOf(/export function planInformationUpdate\(/)).toEqual([INFORMATION_CORE]);
  });

  it("the pure engine and the migration name the IDENTICAL four-field vocabulary (lock-step)", () => {
    const core = codeOf(read(INFORMATION_CORE));
    const sql = sqlCodeOf(read(INFORMATION_MIGRATION));
    for (const field of ["email_address", "phone_number", "postcode", "job_type"]) {
      expect(core, `engine names ${field}`).toContain(`"${field}"`);
      expect(sql, `migration names ${field}`).toContain(`'${field}'`);
    }
  });
});

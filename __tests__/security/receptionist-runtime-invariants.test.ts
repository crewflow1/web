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
// R25 — the Conversation Generation Engine SERVER runtime (the ONE model reach + the coalesced R12
// context fetch). The R13 DRAFT seam above is now a thin adapter that delegates the whole generation to
// this engine, so the R16 context-coalescing invariant below asserts against it.
const ENGINE = "server/services/receptionist-generation.ts";
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
const GAP_CORE = "lib/receptionist/conversation-gap.ts";
/** The read model — the single canonical reader over the conversation substrate (R11), which DERIVES the
 *  R21 gap on read. */
const READS = "server/services/receptionist-conversation-reads.ts";
/** A gap write primitive would be the shape of `set_receptionist_conversation_gap` — asserted NEVER to
 *  exist, because the R21 gap is DERIVED, never persisted (no column, no writer, no migration). */
const GAP_WRITE_FN = /\bset_receptionist_conversation_gap\b/;
const STRATEGY_CORE = "lib/receptionist/conversation-strategy.ts";
/** A strategy write primitive would be the shape of `set_receptionist_conversation_strategy` — asserted
 *  NEVER to exist, because the R22 strategy is DERIVED, never persisted (no column, no writer, no
 *  migration): it is a total function of the ALREADY-derived R21 gap. */
const STRATEGY_WRITE_FN = /\bset_receptionist_conversation_strategy\b/;
const PLANNER_CORE = "lib/receptionist/conversation-prompt.ts";
/** A prompt write primitive would be the shape of `set_receptionist_conversation_prompt` — asserted NEVER
 *  to exist, because the R23 prompt plan is DERIVED, never persisted (no column, no writer, no migration):
 *  it is a total function of the ALREADY-derived R22 strategy decision. */
const PROMPT_WRITE_FN = /\bset_receptionist_conversation_prompt\b/;
const RESPONSE_CORE = "lib/receptionist/conversation-response.ts";
/** A response write primitive would be the shape of `set_receptionist_conversation_response` — asserted NEVER
 *  to exist, because the R24 response spec is DERIVED, never persisted (no column, no writer, no migration):
 *  it is a total function of the ALREADY-derived R23 prompt plan. */
const RESPONSE_WRITE_FN = /\bset_receptionist_conversation_response\b/;

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
    // spares the generator a duplicate reconstruction, NOT a prior-state gate. The THIRD argument is the
    // R24 `responseSpec` derived this turn (R25), which the Generation Engine consumes into the model
    // instruction — guidance for HOW to draft, never a gate on WHETHER to. R17 adds a formal state
    // machine, but it GOVERNS the state's PROGRESSION (post-dispatch); it does NOT GATE the turn on the
    // prior state — no prior-state branch re-shapes the dispatch, so intent progression and slot filling
    // stay non-goals the runtime encodes none of.
    expect(code).toMatch(
      /const dispatch = await dispatchReceptionistReply\(\s*input,\s*assembledContext,\s*responseSpec\s*\)/,
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

  it("the generator REUSES a threaded context, its own fetch retained ONLY as the fallback (R16 preserved through R25)", () => {
    // R25 lifted the coalescing fetch INTO the engine. The R13 seam is now a thin adapter that threads the
    // caller's context straight through (input.context ?? null), and the ENGINE consumes that context
    // verbatim, falling back to its OWN org-scoped R12 fetch ONLY when nothing was threaded — so an
    // ORCHESTRATED turn still never triggers a second reconstruction, while a STANDALONE caller keeps the
    // pre-R16 fetch behaviour, unchanged.
    const seam = codeOf(read(DRAFT));
    expect(seam, "the adapter threads the caller's context through").toMatch(/input\.context\s*\?\?/);
    const engine = codeOf(read(ENGINE));
    expect(engine, "the engine consumes the threaded context first").toMatch(/request\.context\s*\?\?/);
    expect(engine, "the engine's own fetch is the coalesced fallback").toMatch(
      /\bgetConversationContext\s*\(/,
    );
  });

  it("the dispatch accepts the pre-assembled context AND the R24 spec, threading both to the generator (input passed verbatim)", () => {
    const code = codeOf(read(SERVICE));
    // dispatchReceptionistReply takes the already-assembled context as an optional second argument, and
    // the R24 response spec as an optional third (R25)…
    expect(code).toMatch(
      /export async function dispatchReceptionistReply\(\s*input:[\s\S]*?context\?:\s*ConversationContext[\s\S]*?spec\?:\s*ResponseSpecification[\s\S]*?\)/,
    );
    // …and hands BOTH to the generator, so the draft is built from the runtime's ONE assembly (R16) and
    // shaped by the spec derived this turn (R25).
    expect(code).toMatch(
      /export async function dispatchReceptionistReply\([\s\S]*?generateReplyDraft\(\{[\s\S]*?context,[\s\S]*?spec,[\s\S]*?\}\)/,
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

  it("has EXACTLY FOUR importers — the service, the R20 information engine (type-only), the R21 gap engine (type-only), and the read model (the coercer only)", () => {
    // R19 shipped with a SINGLE importer (the service). Three layers now sit ON TOP of the goal engine and
    // import the goal module, but NONE of them reaches its resolver or planner:
    //   • the R20 information engine — ONLY the `ConversationGoal` TYPE it keys its slot schema on (type-only);
    //   • the R21 gap engine — ONLY the `ConversationGoal` TYPE it keys the gap on (type-only);
    //   • the R11 read model — ONLY the deny-unknown `coerceConversationGoal`, to DERIVE the gap on read.
    // The goal engine's AUTHORITY is therefore undiminished: its resolver and its turn-driven planner STILL
    // have exactly the one consumer each (the service, asserted just above), and none of the three new
    // importers names either. The module-import set is EXACTLY these four and nothing more.
    const importers = walkSources(SOURCE_ROOTS)
      .filter((full) =>
        importSpecifiers(codeOf(read(rel(full)))).includes("@/lib/receptionist/conversation-goal"),
      )
      .map(rel)
      .sort();
    expect(importers).toEqual([GAP_CORE, INFORMATION_CORE, READS, SERVICE]);
    // None of the three non-service importers consumes the goal RESOLVER or the goal PLANNER — they take the
    // vocabulary type (info/gap engines) or the coercer (read model), never the authority.
    for (const importer of [INFORMATION_CORE, GAP_CORE, READS] as const) {
      const src = codeOf(read(importer));
      expect(/\bresolveGoal\b/.test(src), `${importer} does not consume the goal resolver`).toBe(
        false,
      );
      expect(
        /\bplanGoalProgression\b/.test(src),
        `${importer} does not consume the goal planner`,
      ).toBe(false);
    }
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

// =====================================================================
// 19. R21 — THE CONVERSATION GAP ENGINE: a FIFTH pure leaf that sits ON TOP of the R20 information
//     engine — it DERIVES conversational COMPLETENESS (what is MISSING, which item is MOST important,
//     is the objective SATISFIED, is another turn REQUIRED) from the ALREADY-persisted goal + information.
//     It is the FIRST layer that persists NOTHING: no column, no writer, no migration — the gap is a total,
//     deterministic PROJECTION of two persisted observations, so a second source of truth can never drift
//     from them. Single-sourced, REUSING R20's completeness surface (it forks no "what's missing" logic),
//     DUPLICATING no context assembly, no intent/goal resolution AND no information extraction, and NEVER
//     moving any marker beneath it. It DERIVES; it never ACTS (booking / scheduling / slot-prompting are
//     explicit R21 non-goals a future capability performs by CONSUMING this gap).
// =====================================================================

describe("receptionist runtime — R21: the conversation gap engine is a governed, single-sourced, DERIVED pure leaf", () => {
  const core = codeOf(read(GAP_CORE));
  const service = codeOf(read(SERVICE));
  const reads = codeOf(read(READS));

  // The whole gap-engine surface: the priority vocabulary, the priority sort, the missing-info list, the
  // next-required selector, the two completeness predicates, and the single composed entry point. The
  // analogue of §16's INFORMATION_SYMBOLS, for the gap layer.
  const GAP_SYMBOLS: readonly RegExp[] = [
    /export const FIELD_PRIORITY\b/,
    /export function prioritiseFields\(/,
    /export function missingInformation\(/,
    /export function nextRequiredInformation\(/,
    /export function isGoalSatisfied\(/,
    /export function isTurnRequired\(/,
    /export function detectGap\(/,
  ];

  it(`ships the pure gap engine ${GAP_CORE}, exporting the whole derived surface`, () => {
    expect(existsSync(resolve(ROOT, GAP_CORE)), GAP_CORE).toBe(true);
    for (const re of GAP_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly TWO pure layers and NOTHING else — the R19 goal TYPE and the R20 information engine", () => {
    // Its ENTIRE import surface is the R19 goal module (the `ConversationGoal` TYPE it keys the gap on) and
    // the R20 information module (the completeness SURFACE it reads + its types). It reaches no third module
    // — no context, no policy, no provider, no ledger, no DB, no clock, no model — so it cannot fork any
    // enforcement, generation or transport path.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/receptionist/conversation-goal",
      "@/lib/receptionist/conversation-information",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal / information / gap write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
    expect(INFORMATION_WRITE_FN.test(core)).toBe(false);
    expect(GAP_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no context assembly, no intent / goal resolution AND NO INFORMATION EXTRACTION — the cardinal R21 boundary", () => {
    // The gap engine consumes an ALREADY-resolved goal and ALREADY-extracted information; it never
    // re-assembles context, re-resolves intent/goal, or RE-EXTRACTS information. In executable source it
    // names none of the context assembler, the intent/goal resolvers or planners, or the information
    // extractor / update planner — so it re-implements no layer beneath it, exactly as the directive requires
    // ("must NOT duplicate ... information extraction"). The goal + information modules are imported for the
    // TYPE / completeness surface ALONE.
    expect(/\bassembleConversationContext\b/.test(core), "never names the context assembler").toBe(false);
    expect(/\bresolveIntent\b/.test(core), "never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never names the intent planner").toBe(false);
    expect(/\bresolveGoal\b/.test(core), "never names the goal resolver").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never names the goal planner").toBe(false);
    expect(/\bextractInformation\b/.test(core), "never names the information extractor").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never names the information update planner").toBe(false);
  });

  it("REUSES R20's completeness authority rather than forking it — it NAMES the slot surface and DEFINES none of it", () => {
    // "What does this goal need / what is outstanding / is it complete" is R20's single authority. The gap
    // engine READS it (it names `outstandingSlots` and `isInformationComplete`) and re-implements NEITHER —
    // so there is exactly ONE completeness definition, exactly as the directive requires ("No feature may
    // implement independent completeness logic").
    expect(/\boutstandingSlots\b/.test(core), "reuses R20 outstandingSlots").toBe(true);
    expect(/\bisInformationComplete\b/.test(core), "reuses R20 isInformationComplete").toBe(true);
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    expect(definersOf(/export function outstandingSlots\(/)).toEqual([INFORMATION_CORE]);
    expect(definersOf(/export function isInformationComplete\(/)).toEqual([INFORMATION_CORE]);
  });

  it("DERIVES ONLY — it re-orchestrates no runtime and executes no business action (booking / scheduling are R21 non-goals)", () => {
    // The engine derives completeness and stops; ACTING on the gap is a future capability that CONSUMES it.
    // In executable source it names neither the turn orchestrator nor the canonical dispatch — so it can
    // neither re-run the runtime nor send / book / schedule anything.
    expect(/\brunConversationTurn\b/.test(core), "never re-orchestrates the runtime").toBe(false);
    expect(/\bdispatchReceptionistReply\b/.test(core), "never dispatches a reply").toBe(false);
  });

  it("is NOT server-only and touches no admin client — a model-free derivation usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole gap surface in the pure engine — no other module DEFINES any member", () => {
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of GAP_SYMBOLS) expect(definersOf(re), re.source).toEqual([GAP_CORE]);
  });

  it("the gap detector has EXACTLY the two authorised consumers — the runtime service and the read model", () => {
    // detectGap is named by the engine (its definition), the orchestrating service (it surfaces the gap on
    // the turn result) and the read model (it derives the gap on read) — and NOTHING else: no feature
    // computes conversational completeness independently.
    const consumers = namersOf(/\bdetectGap\b/).filter((p) => p !== GAP_CORE);
    expect(consumers).toEqual([READS, SERVICE]);
  });

  it("PERSISTS NOTHING — the R21 divergence: no gap column, no gap writer, no gap migration (the gap is DERIVED)", () => {
    // Unlike R15 / R17 / R18 / R19 / R20, the gap layer ships NO migration and NO writer: the gap is a total
    // function of the ALREADY-persisted goal + information, and persisting it would create a second,
    // driftable source of truth. Proof — there is no gap migration file; no module in the source tree names a
    // gap write primitive; and no migration adds a gap column or projects one onto the R11 list view (the way
    // the R20 migration added `c.information`).
    const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(migrations.some((f) => /gap/i.test(f)), "no gap migration file exists").toBe(false);
    expect(namersOf(GAP_WRITE_FN), "no module names a gap write primitive").toEqual([]);
    for (const f of migrations) {
      const sql = sqlCodeOf(read(`supabase/migrations/${f}`));
      expect(GAP_WRITE_FN.test(sql), `${f} defines no gap writer`).toBe(false);
      expect(/\bc\.gap\b/i.test(sql), `${f} projects no gap column onto the list view`).toBe(false);
      expect(/add column[^;]*\bgap\b/i.test(sql), `${f} adds no gap column`).toBe(false);
    }
  });

  it("DERIVES the gap in the runtime from (nextGoal, nextInformation) — the seam that proves Context → Intent → Goal → Information → Gap", () => {
    // The runtime derives the gap from the goal the R19 engine JUST resolved (`nextGoal`) and the information
    // the R20 engine JUST accumulated (`nextInformation`) — NOT a second read, NOT a model call. This is the
    // linear stack, one layer taller.
    expect(service).toMatch(/detectGap\(nextGoal,\s*nextInformation\)/);
  });

  it("DERIVES the gap on READ from the persisted (goal, information), persisting nothing", () => {
    // The read model computes the gap FRESH on every read — coercing the persisted goal + information
    // deny-unknown, then deriving through the ONE authority — and writes nothing. So the read exposure is a
    // projection, never a stored column, and the read model names NO write primitive of any layer.
    expect(reads).toMatch(
      /detectGap\(\s*coerceConversationGoal\(row\.goal\),\s*coerceConversationInformation\(row\.information\)/,
    );
    expect(GAP_WRITE_FN.test(reads), "read model persists no gap").toBe(false);
    expect(INFORMATION_WRITE_FN.test(reads), "read model persists no information").toBe(false);
    expect(GOAL_WRITE_FN.test(reads), "read model persists no goal").toBe(false);
  });

  it("NEVER moves the ownership, intent, goal OR information marker — a FIFTH observation that bypasses no layer beneath it", () => {
    // The engine writes NOTHING; in executable source it names none of the four write primitives or their
    // planners. And the layers beneath are UNDISTURBED: the R17 state, R18 intent, R19 goal and R20
    // information writers are STILL each named by exactly the service. So `runtime_state`, `intent`, `goal`
    // and `information` remain four independent, separately-guarded doors — deriving the gap can move none of
    // them (or bypass their governance).
    expect(RUNTIME_STATE_WRITE_FN.test(core), "never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "never names the intent writer").toBe(false);
    expect(GOAL_WRITE_FN.test(core), "never names the goal writer").toBe(false);
    expect(INFORMATION_WRITE_FN.test(core), "never names the information writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "never reaches the state machine").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never reaches the intent planner").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never reaches the goal planner").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never reaches the information planner").toBe(false);
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INFORMATION_WRITE_FN)).toEqual([SERVICE]);
  });
});

// =====================================================================
// 20. R21 — THE PRIORITY VOCABULARY IS SINGLE-SOURCED AND INDEPENDENT — defined ONCE in the gap engine,
//     ranking exactly the R20 field vocabulary in a DIFFERENT order (the gap engine's own semantic), never
//     in the information engine.
// =====================================================================

describe("receptionist runtime — R21: the priority vocabulary is single-sourced and independent", () => {
  const core = codeOf(read(GAP_CORE));
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  it("defines the priority ordering in exactly one file — the gap engine", () => {
    expect(definersOf(/export const FIELD_PRIORITY/)).toEqual([GAP_CORE]);
  });

  it("does NOT define the priority ordering in the information engine — priority is a GAP concern, not an information one", () => {
    const infoCore = codeOf(read(INFORMATION_CORE));
    expect(/FIELD_PRIORITY/.test(infoCore), "the information engine names no priority ordering").toBe(
      false,
    );
  });

  it("ranks exactly the R20 field vocabulary (lock-step) — no out-of-vocabulary field gains a rank", () => {
    // FIELD_PRIORITY names the SAME four fields the R20 vocabulary defines, so a priority rank exists for
    // every field the schema can ask for and for no other. (That it is a genuine PERMUTATION — same set,
    // different order, here the exact reverse — is proven at runtime in the unit tier.)
    for (const field of ["email_address", "phone_number", "postcode", "job_type"]) {
      expect(core, `priority names ${field}`).toContain(`"${field}"`);
    }
  });

  it("orders the priority INDEPENDENTLY of the vocabulary's declaration order (job_type first, not last)", () => {
    // In the gap engine's executable source the ONLY place the field names appear is FIELD_PRIORITY, and it
    // ranks job_type BEFORE email_address; the information engine's INFORMATION_FIELDS declares them in the
    // OPPOSITE order (email_address before job_type). So the priority is a distinct ordering, not a copy of
    // the vocabulary.
    const jt = core.indexOf('"job_type"');
    const em = core.indexOf('"email_address"');
    expect(jt, "gap engine names job_type").toBeGreaterThanOrEqual(0);
    expect(em, "gap engine ranks job_type before email_address").toBeGreaterThan(jt);
    const infoCore = codeOf(read(INFORMATION_CORE));
    expect(
      infoCore.indexOf('"email_address"'),
      "information engine declares email_address before job_type",
    ).toBeLessThan(infoCore.indexOf('"job_type"'));
  });
});

// =====================================================================
// 21. R22 — THE CONVERSATION STRATEGY ENGINE IS A GOVERNED, SINGLE-SOURCED, DERIVED PURE LEAF.
//     lib/receptionist/conversation-strategy.ts is the SECOND purely-derived layer (like R21's gap): it
//     adds NO column, NO migration and NO writer. It CONSUMES the already-derived R21 gap and decides the
//     next conversational ACTION — reusing the gap's completeness view, duplicating no context assembly,
//     intent/goal resolution, information extraction OR gap detection, and executing NO business action. It
//     is single-sourced, has EXACTLY the two authorised consumers (the service + the read model), reaches
//     only the two TYPE modules it declares, and is surfaced on the turn result + re-derived on every read.
// =====================================================================

describe("receptionist runtime — R22: the conversation strategy engine is a governed, single-sourced, DERIVED pure leaf", () => {
  const core = codeOf(read(STRATEGY_CORE));
  const service = codeOf(read(SERVICE));
  const reads = codeOf(read(READS));

  // The whole strategy-engine surface: the derived priority vocabulary and the single composed entry point.
  // The analogue of §19's GAP_SYMBOLS, for the strategy layer.
  const STRATEGY_SYMBOLS: readonly RegExp[] = [
    /export const STRATEGY_PRIORITY\b/,
    /export function resolveStrategy\(/,
  ];

  it(`ships the pure strategy engine ${STRATEGY_CORE}, exporting the whole derived surface`, () => {
    expect(existsSync(resolve(ROOT, STRATEGY_CORE)), STRATEGY_CORE).toBe(true);
    for (const re of STRATEGY_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly TWO pure layers and NOTHING else — the R21 gap TYPE and the R20 information-field TYPE", () => {
    // Its ENTIRE import surface is the R21 gap module (the `ConversationGap` TYPE it reads the decision from)
    // and the R20 information module (the `InformationField` TYPE a slot-filling decision targets). BOTH are
    // type-only, so the engine names no runtime value from any other layer — no context, no policy, no
    // provider, no ledger, no DB, no clock, no model. It cannot fork any enforcement, generation or transport
    // path.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/receptionist/conversation-gap",
      "@/lib/receptionist/conversation-information",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal / information / gap / strategy write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
    expect(INFORMATION_WRITE_FN.test(core)).toBe(false);
    expect(GAP_WRITE_FN.test(core)).toBe(false);
    expect(STRATEGY_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no context assembly, no intent / goal resolution, no information extraction AND NO GAP DETECTION — the cardinal R22 boundary", () => {
    // The strategy engine consumes an ALREADY-derived gap; it never re-assembles context, re-resolves
    // intent/goal, re-extracts information, or RE-DETECTS the gap. In executable source it names none of the
    // context assembler, the intent/goal resolvers or planners, the information extractor / update planner,
    // OR the gap detector — so it re-implements no layer beneath it, exactly as the directive requires ("must
    // NOT duplicate ... gap detection"). The gap + information modules are imported for the TYPE alone.
    expect(/\bassembleConversationContext\b/.test(core), "never names the context assembler").toBe(false);
    expect(/\bresolveIntent\b/.test(core), "never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never names the intent planner").toBe(false);
    expect(/\bresolveGoal\b/.test(core), "never names the goal resolver").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never names the goal planner").toBe(false);
    expect(/\bextractInformation\b/.test(core), "never names the information extractor").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never names the information update planner").toBe(false);
    expect(/\bdetectGap\b/.test(core), "never RE-DETECTS the gap (it CONSUMES the derived gap)").toBe(false);
  });

  it("REUSES the R21 gap's completeness view rather than forking it — it re-derives NO completeness OR priority", () => {
    // "What is missing / most important / satisfied" is R21's single authority, itself delegating "what's
    // outstanding / complete" to R20. The strategy engine reads the DERIVED gap (its `goal`, `satisfied`,
    // `nextRequired`) and re-implements none of that arithmetic: it names neither R20's slot surface nor
    // R21's derivation helpers. So there is exactly ONE completeness definition (R21/R20) and exactly ONE
    // planning definition (R22) — no feature computes either independently.
    expect(/\boutstandingSlots\b/.test(core), "does not fork the R20 slot surface").toBe(false);
    expect(/\bisInformationComplete\b/.test(core), "does not fork the R20 completeness predicate").toBe(false);
    expect(/\bmissingInformation\b/.test(core), "does not re-derive the missing list").toBe(false);
    expect(/\bnextRequiredInformation\b/.test(core), "does not re-derive the next-required field").toBe(false);
  });

  it("DERIVES ONLY — it re-orchestrates no runtime and executes NO business action (booking / scheduling are R22 non-goals)", () => {
    // The engine decides the next conversational action and stops; ACTING on it is a future capability that
    // CONSUMES the decision. In executable source it names neither the turn orchestrator nor the canonical
    // dispatch — so it can neither re-run the runtime nor send / book / schedule anything. The Strategy
    // Engine determines conversational actions ONLY.
    expect(/\brunConversationTurn\b/.test(core), "never re-orchestrates the runtime").toBe(false);
    expect(/\bdispatchReceptionistReply\b/.test(core), "never dispatches a reply").toBe(false);
  });

  it("is NOT server-only and touches no admin client — a model-free derivation usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole strategy surface in the pure engine — no other module DEFINES any member", () => {
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of STRATEGY_SYMBOLS) expect(definersOf(re), re.source).toEqual([STRATEGY_CORE]);
  });

  it("the strategy resolver has EXACTLY the two authorised consumers — the runtime service and the read model", () => {
    // resolveStrategy is named by the engine (its definition), the orchestrating service (it surfaces the
    // strategy on the turn result) and the read model (it derives the strategy on read) — and NOTHING else:
    // no feature computes conversational planning independently.
    const consumers = namersOf(/\bresolveStrategy\b/).filter((p) => p !== STRATEGY_CORE);
    expect(consumers).toEqual([READS, SERVICE]);
  });

  it("PERSISTS NOTHING — the R22 divergence (like R21): no strategy column, no strategy writer, no strategy migration (the strategy is DERIVED)", () => {
    // Like the R21 gap, the strategy layer ships NO migration and NO writer: the strategy is a total function
    // of the ALREADY-derived gap, and persisting it would create a second, driftable source of truth. Proof —
    // there is no strategy migration file; no module in the source tree names a strategy write primitive; and
    // no migration adds a strategy column or projects one onto the R11 list view.
    const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(migrations.some((f) => /strategy/i.test(f)), "no strategy migration file exists").toBe(false);
    expect(namersOf(STRATEGY_WRITE_FN), "no module names a strategy write primitive").toEqual([]);
    for (const f of migrations) {
      const sql = sqlCodeOf(read(`supabase/migrations/${f}`));
      expect(STRATEGY_WRITE_FN.test(sql), `${f} defines no strategy writer`).toBe(false);
      expect(/\bc\.strategy\b/i.test(sql), `${f} projects no strategy column onto the list view`).toBe(false);
      expect(/add column[^;]*\bstrategy\b/i.test(sql), `${f} adds no strategy column`).toBe(false);
    }
  });

  it("DERIVES the strategy in the runtime from the gap — the seam that proves Context → Intent → Goal → Information → Gap → Strategy", () => {
    // The runtime derives the strategy from the gap the R21 engine JUST derived (`gap`) — NOT a second read,
    // NOT a model call. This is the linear stack, one layer taller.
    expect(service).toMatch(/resolveStrategy\(gap\)/);
  });

  it("DERIVES the strategy on READ from the derived gap, persisting nothing", () => {
    // The read model computes the strategy FRESH on every read — deriving the gap through the ONE gap
    // authority, then the strategy from THAT gap through the ONE strategy authority — and writes nothing. So
    // the read exposure is a projection, never a stored column, and the read model names NO write primitive of
    // any layer.
    expect(reads).toMatch(/resolveStrategy\(gap\)/);
    expect(STRATEGY_WRITE_FN.test(reads), "read model persists no strategy").toBe(false);
    expect(GAP_WRITE_FN.test(reads), "read model persists no gap").toBe(false);
    expect(INFORMATION_WRITE_FN.test(reads), "read model persists no information").toBe(false);
    expect(GOAL_WRITE_FN.test(reads), "read model persists no goal").toBe(false);
  });

  it("NEVER moves the ownership, intent, goal, information OR gap marker — a SIXTH observation that bypasses no layer beneath it", () => {
    // The engine writes NOTHING; in executable source it names none of the write primitives or their planners.
    // And the layers beneath are UNDISTURBED: the R17 state, R18 intent, R19 goal and R20 information writers
    // are STILL each named by exactly the service. So deriving the strategy can move no marker or bypass any
    // governance.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "never names the intent writer").toBe(false);
    expect(GOAL_WRITE_FN.test(core), "never names the goal writer").toBe(false);
    expect(INFORMATION_WRITE_FN.test(core), "never names the information writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "never reaches the state machine").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never reaches the intent planner").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never reaches the goal planner").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never reaches the information planner").toBe(false);
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INFORMATION_WRITE_FN)).toEqual([SERVICE]);
  });
});

// =====================================================================
// 22. R22 — THE STRATEGY VOCABULARY IS SINGLE-SOURCED AND INDEPENDENT OF THE GOAL ENGINE — the priority is
//     defined ONCE in the strategy engine and DERIVED from its ordered rule table (so resolution order and
//     priority order can never drift), the engine keys off the gap's goal by LITERAL (adding no importer to
//     the R19 goal engine), and the strategy vocabulary is DISJOINT from the goal vocabulary (a strategy is
//     a MOVE, never an objective).
// =====================================================================

describe("receptionist runtime — R22: the strategy vocabulary is single-sourced and independent of the goal engine", () => {
  const core = codeOf(read(STRATEGY_CORE));
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  const STRATEGY_NAMES = [
    "acknowledge",
    "request_information",
    "provide_answer",
    "escalate_to_human",
    "progress_goal",
  ] as const;

  it("defines the strategy priority in exactly one file — the strategy engine", () => {
    expect(definersOf(/export const STRATEGY_PRIORITY/)).toEqual([STRATEGY_CORE]);
  });

  it("DERIVES the priority from the ordered rule table — one source of truth, no drift between order and priority", () => {
    // STRATEGY_PRIORITY is not a second hand-maintained list: it is the rule table projected onto its strategy
    // names (STRATEGY_RULES.map(...)). So the resolution order (first applicable rule wins) and the published
    // priority order are the SAME order by construction.
    expect(/STRATEGY_RULES\b/.test(core), "the ordered rule table is defined").toBe(true);
    expect(/STRATEGY_RULES\.map\(/.test(core), "STRATEGY_PRIORITY is the rule table's projection").toBe(true);
  });

  it("keys off the gap's goal by LITERAL — it adds NO importer to the R19 goal engine", () => {
    // The strategy engine distinguishes goals (undetermined / answer_enquiry / handoff_to_human) by comparing
    // gap.goal against STRING LITERALS, NOT by importing the goal module. So R19's importer set is undisturbed
    // (the §13-analogue still pins it at exactly four: the service, the information engine, the gap engine and
    // the read model), and the strategy engine reaches only the two TYPE modules it declares.
    expect(importSpecifiers(core)).not.toContain("@/lib/receptionist/conversation-goal");
  });

  it("names the whole strategy vocabulary, and the R19 goal engine names NONE of it — disjoint vocabularies", () => {
    // The five strategy names live ONLY in the strategy engine; the goal engine references none of them. So
    // the strategy vocabulary is the strategy engine's OWN, not a re-labelling of goal concerns. (That the two
    // vocabularies share no member at runtime — the strategy `provide_answer` ≠ the goal `answer_enquiry`, the
    // strategy `escalate_to_human` ≠ the goal `handoff_to_human` — is proven in the unit tier.)
    const goalCore = codeOf(read(GOAL_CORE));
    for (const name of STRATEGY_NAMES) {
      expect(core, `strategy engine names ${name}`).toContain(`"${name}"`);
      expect(goalCore, `goal engine does NOT name the strategy ${name}`).not.toContain(`"${name}"`);
    }
  });
});

// =====================================================================
// 23. R23 — THE CONVERSATION PROMPT PLANNER IS A GOVERNED, SINGLE-SOURCED, DERIVED PURE LEAF — the THIRD
//     purely-derived layer (like R21 gap and R22 strategy): it PERSISTS NOTHING (no column, no writer, no
//     migration), REUSES exactly the R22 strategy TYPES and the R20 information-field TYPE and nothing else,
//     DUPLICATES no context assembly / intent-goal resolution / information extraction / gap detection / OR
//     strategy resolution, has EXACTLY the runtime service and the read model as consumers, and is DERIVED
//     both in the runtime and on read from the ALREADY-derived strategy. It PLANS the next prompt and
//     executes NO business action (booking / scheduling are explicit R23 non-goals).
// =====================================================================

describe("receptionist runtime — R23: the conversation prompt planner is a governed, single-sourced, DERIVED pure leaf", () => {
  const core = codeOf(read(PLANNER_CORE));
  const service = codeOf(read(SERVICE));
  const reads = codeOf(read(READS));

  // The whole prompt-planner surface: the derived act vocabulary and the single composed entry point. The
  // analogue of §22's STRATEGY_SYMBOLS, for the prompt layer.
  const PROMPT_SYMBOLS: readonly RegExp[] = [
    /export const PROMPT_ACTS\b/,
    /export function planPrompt\(/,
  ];

  it(`ships the pure prompt planner ${PLANNER_CORE}, exporting the whole derived surface`, () => {
    expect(existsSync(resolve(ROOT, PLANNER_CORE)), PLANNER_CORE).toBe(true);
    for (const re of PROMPT_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly TWO pure layers and NOTHING else — the R22 strategy TYPES and the R20 information-field TYPE", () => {
    // Its ENTIRE import surface is the R22 strategy module (the `StrategyDecision` + `ConversationStrategy`
    // TYPES it reads the decision from and maps the act by) and the R20 information module (the
    // `InformationField` TYPE an `ask` decision targets). BOTH are type-only, so the planner names no runtime
    // value from any other layer — no gap, no context, no policy, no provider, no ledger, no DB, no clock, no
    // model. It cannot fork any enforcement, generation or transport path.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/receptionist/conversation-information",
      "@/lib/receptionist/conversation-strategy",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal / information / gap / strategy / prompt write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
    expect(INFORMATION_WRITE_FN.test(core)).toBe(false);
    expect(GAP_WRITE_FN.test(core)).toBe(false);
    expect(STRATEGY_WRITE_FN.test(core)).toBe(false);
    expect(PROMPT_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no context assembly, no intent / goal resolution, no information extraction, NO gap detection AND NO STRATEGY RESOLUTION — the cardinal R23 boundary", () => {
    // The planner consumes an ALREADY-derived strategy decision; it never re-assembles context, re-resolves
    // intent/goal, re-extracts information, re-detects the gap, OR re-resolves the strategy. In executable
    // source it names none of the context assembler, the intent/goal resolvers or planners, the information
    // extractor / update planner, the gap detector OR the strategy resolver — so it re-implements no layer
    // beneath it, exactly as the directive requires ("must NOT duplicate ... strategy resolution"). The
    // strategy + information modules are imported for the TYPE alone.
    expect(/\bassembleConversationContext\b/.test(core), "never names the context assembler").toBe(false);
    expect(/\bresolveIntent\b/.test(core), "never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never names the intent planner").toBe(false);
    expect(/\bresolveGoal\b/.test(core), "never names the goal resolver").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never names the goal planner").toBe(false);
    expect(/\bextractInformation\b/.test(core), "never names the information extractor").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never names the information update planner").toBe(false);
    expect(/\bdetectGap\b/.test(core), "never names the gap detector").toBe(false);
    expect(/\bresolveStrategy\b/.test(core), "never RE-RESOLVES the strategy (it CONSUMES the derived decision)").toBe(false);
  });

  it("REUSES the R22 strategy decision rather than forking it — it re-derives NO strategy, priority OR gap", () => {
    // "What is the next action / what does it target / does it expect a reply" is R22's single authority. The
    // planner reads the DERIVED decision (its `strategy`, `target`, `expectsReply`) and re-implements none of
    // that: it names neither R22's ordered rule table, its selector, its published priority, NOR the R21 gap
    // TYPE or its fields. So there is exactly ONE planning definition (R22) and exactly ONE prompt-planning
    // definition (R23) — no feature computes either independently. It reaches the gap ONLY through the
    // decision, never the gap itself.
    expect(/\bSTRATEGY_RULES\b/.test(core), "does not fork the R22 rule table").toBe(false);
    expect(/\bselectStrategy\b/.test(core), "does not fork the R22 selector").toBe(false);
    expect(/\bSTRATEGY_PRIORITY\b/.test(core), "does not re-derive the R22 priority").toBe(false);
    expect(/\bConversationGap\b/.test(core), "does not name the R21 gap TYPE").toBe(false);
    expect(/\bnextRequired\b/.test(core), "does not read the gap's nextRequired directly").toBe(false);
  });

  it("DERIVES ONLY — it re-orchestrates no runtime and executes NO business action (booking / scheduling are R23 non-goals)", () => {
    // The planner plans the next prompt and stops; ACTING on it — generating the prose, booking, scheduling —
    // is a future/existing capability that CONSUMES the plan. In executable source it names neither the turn
    // orchestrator nor the canonical dispatch — so it can neither re-run the runtime nor send / book /
    // schedule anything. The Prompt Planner determines conversational prompts ONLY.
    expect(/\brunConversationTurn\b/.test(core), "never re-orchestrates the runtime").toBe(false);
    expect(/\bdispatchReceptionistReply\b/.test(core), "never dispatches a reply").toBe(false);
  });

  it("is NOT server-only and touches no admin client — a model-free derivation usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole prompt surface in the pure planner — no other module DEFINES any member", () => {
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of PROMPT_SYMBOLS) expect(definersOf(re), re.source).toEqual([PLANNER_CORE]);
  });

  it("the prompt planner has EXACTLY the two authorised consumers — the runtime service and the read model", () => {
    // planPrompt is named by the planner (its definition), the orchestrating service (it surfaces the plan on
    // the turn result) and the read model (it derives the plan on read) — and NOTHING else: no feature
    // computes conversational prompt planning independently.
    const consumers = namersOf(/\bplanPrompt\b/).filter((p) => p !== PLANNER_CORE);
    expect(consumers).toEqual([READS, SERVICE]);
  });

  it("PERSISTS NOTHING — the R23 divergence (like R21 / R22): no prompt column, no prompt writer, no prompt migration (the plan is DERIVED)", () => {
    // Like the R21 gap and the R22 strategy, the prompt layer ships NO migration and NO writer: the plan is a
    // total function of the ALREADY-derived strategy decision, and persisting it would create a second,
    // driftable source of truth. Proof — there is no prompt migration file; no module in the source tree names
    // a prompt write primitive; and no migration adds a prompt_plan column or projects one onto the R11 list
    // view. (The `prompt_plan` token is used, not a bare `prompt`, so unrelated `prompt` columns in other
    // migrations do not confound the check.)
    const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(migrations.some((f) => /prompt/i.test(f)), "no prompt migration file exists").toBe(false);
    expect(namersOf(PROMPT_WRITE_FN), "no module names a prompt write primitive").toEqual([]);
    for (const f of migrations) {
      const sql = sqlCodeOf(read(`supabase/migrations/${f}`));
      expect(PROMPT_WRITE_FN.test(sql), `${f} defines no prompt writer`).toBe(false);
      expect(/\bc\.prompt_plan\b/i.test(sql), `${f} projects no prompt_plan column onto the list view`).toBe(false);
      expect(/add column[^;]*\bprompt_plan\b/i.test(sql), `${f} adds no prompt_plan column`).toBe(false);
    }
  });

  it("DERIVES the prompt in the runtime from the strategy — the seam that proves Context → … → Strategy → Prompt", () => {
    // The runtime plans the prompt from the strategy the R22 engine JUST derived (`strategy`) — NOT a second
    // read, NOT a model call. This is the linear stack, one layer taller.
    expect(service).toMatch(/planPrompt\(strategy\)/);
  });

  it("DERIVES the prompt on READ from the derived strategy, persisting nothing", () => {
    // The read model computes the plan FRESH on every read — deriving the gap, then the strategy from THAT
    // gap, then the plan from THAT strategy through the ONE prompt authority — and writes nothing. So the read
    // exposure is a projection, never a stored column, and the read model names NO write primitive of any layer.
    expect(reads).toMatch(/planPrompt\(strategy\)/);
    expect(PROMPT_WRITE_FN.test(reads), "read model persists no prompt").toBe(false);
    expect(STRATEGY_WRITE_FN.test(reads), "read model persists no strategy").toBe(false);
    expect(GAP_WRITE_FN.test(reads), "read model persists no gap").toBe(false);
    expect(INFORMATION_WRITE_FN.test(reads), "read model persists no information").toBe(false);
    expect(GOAL_WRITE_FN.test(reads), "read model persists no goal").toBe(false);
  });

  it("NEVER moves the ownership, intent, goal, information, gap OR strategy marker — a SEVENTH observation that bypasses no layer beneath it", () => {
    // The planner writes NOTHING; in executable source it names none of the write primitives or their planners.
    // And the layers beneath are UNDISTURBED: the R17 state, R18 intent, R19 goal and R20 information writers
    // are STILL each named by exactly the service. So deriving the prompt plan can move no marker or bypass any
    // governance.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "never names the intent writer").toBe(false);
    expect(GOAL_WRITE_FN.test(core), "never names the goal writer").toBe(false);
    expect(INFORMATION_WRITE_FN.test(core), "never names the information writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "never reaches the state machine").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never reaches the intent planner").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never reaches the goal planner").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never reaches the information planner").toBe(false);
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INFORMATION_WRITE_FN)).toEqual([SERVICE]);
  });
});

// =====================================================================
// 24. R23 — THE PROMPT-ACT VOCABULARY IS SINGLE-SOURCED AND INDEPENDENT OF THE STRATEGY AND GOAL ENGINES —
//     the act vocabulary is defined ONCE in the planner, the strategy → act mapping is a total literal-keyed
//     table (so the planner keys off the decision's strategy by LITERAL, adding no importer to the R21 gap
//     engine), and the prompt-act vocabulary is DISJOINT from BOTH the R22 strategy vocabulary and the R19
//     goal vocabulary (a prompt act is an UTTERANCE, never a move, never an objective).
// =====================================================================

describe("receptionist runtime — R23: the prompt-act vocabulary is single-sourced and independent of the strategy and goal engines", () => {
  const core = codeOf(read(PLANNER_CORE));
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  const PROMPT_ACT_NAMES = ["greet", "ask", "answer", "handoff", "proceed"] as const;

  it("defines the prompt-act vocabulary in exactly one file — the prompt planner", () => {
    expect(definersOf(/export const PROMPT_ACTS/)).toEqual([PLANNER_CORE]);
  });

  it("maps the strategy to the act through a total literal-keyed table — one source of truth", () => {
    // The act is chosen by indexing a total `Record<ConversationStrategy, PromptAct>` (STRATEGY_ACT) with the
    // decision's strategy LITERAL — the analogue of how R22 keyed its rules off gap.goal. So the mapping is
    // exhaustive by construction (a missing strategy fails tsc) and lives in exactly one place.
    expect(/\bSTRATEGY_ACT\b/.test(core), "the strategy→act table is defined").toBe(true);
    expect(/STRATEGY_ACT\[decision\.strategy\]/.test(core), "the act is keyed off the decision's strategy literal").toBe(true);
  });

  it("keys off the decision's strategy by LITERAL — it adds NO importer to the R21 gap engine", () => {
    // The planner reads the strategy DECISION, not the gap; it never imports the gap module. So the R21 gap
    // engine's importer set is undisturbed, and the planner reaches only the two TYPE modules it declares.
    expect(importSpecifiers(core)).not.toContain("@/lib/receptionist/conversation-gap");
  });

  it("names the whole act vocabulary, and NEITHER the R22 strategy engine NOR the R19 goal engine names ANY of it — disjoint vocabularies", () => {
    // The five act names live ONLY in the planner; neither the strategy engine nor the goal engine references
    // any of them as a quoted literal. So the act vocabulary is the planner's OWN, not a re-labelling of a
    // strategy or goal concern. The names are deliberately chosen not to collide — the act `answer` ≠ the
    // strategy `provide_answer` ≠ the goal `answer_enquiry`; the act `handoff` ≠ the strategy
    // `escalate_to_human` ≠ the goal `handoff_to_human`.
    const strategyCore = codeOf(read(STRATEGY_CORE));
    const goalCore = codeOf(read(GOAL_CORE));
    for (const name of PROMPT_ACT_NAMES) {
      expect(core, `prompt planner names ${name}`).toContain(`"${name}"`);
      expect(strategyCore, `strategy engine does NOT name the act ${name}`).not.toContain(`"${name}"`);
      expect(goalCore, `goal engine does NOT name the act ${name}`).not.toContain(`"${name}"`);
    }
  });
});

// =====================================================================
// 25. R24 — THE CONVERSATION RESPONSE ENGINE IS A GOVERNED, SINGLE-SOURCED, DERIVED PURE LEAF — the FOURTH
//     purely-derived layer (like R21 gap, R22 strategy and R23 prompt plan): it PERSISTS NOTHING (no column, no
//     writer, no migration), REUSES exactly the R23 prompt-plan TYPES and the R20 information-field TYPE and
//     nothing else, DUPLICATES no context assembly / intent-goal resolution / information extraction / gap
//     detection / strategy resolution OR prompt planning, has EXACTLY the runtime service and the read model as
//     consumers, and is DERIVED both in the runtime and on read from the ALREADY-derived prompt plan. It PREPARES
//     the response and executes NO business action (draft generation / booking / scheduling are explicit R24
//     non-goals — the engine determines HOW the response should be produced, never produces it).
// =====================================================================

describe("receptionist runtime — R24: the conversation response engine is a governed, single-sourced, DERIVED pure leaf", () => {
  const core = codeOf(read(RESPONSE_CORE));
  const service = codeOf(read(SERVICE));
  const reads = codeOf(read(READS));

  // The whole response-engine surface: the derived objective vocabulary and the single composed entry point. The
  // analogue of §23's PROMPT_SYMBOLS, for the response layer.
  const RESPONSE_SYMBOLS: readonly RegExp[] = [
    /export const RESPONSE_OBJECTIVES\b/,
    /export function buildResponseSpec\(/,
  ];

  it(`ships the pure response engine ${RESPONSE_CORE}, exporting the whole derived surface`, () => {
    expect(existsSync(resolve(ROOT, RESPONSE_CORE)), RESPONSE_CORE).toBe(true);
    for (const re of RESPONSE_SYMBOLS) expect(core, re.source).toMatch(re);
  });

  it("REUSES exactly TWO pure layers and NOTHING else — the R23 prompt-plan TYPES and the R20 information-field TYPE", () => {
    // Its ENTIRE import surface is the R23 prompt module (the `ConversationPromptPlan` + `PromptAct` TYPES it
    // reads the plan from and maps the objective by) and the R20 information module (the `InformationField` TYPE a
    // `gather` response solicits). BOTH are type-only, so the engine names no runtime value from any other layer —
    // no strategy, no gap, no context, no policy, no provider, no ledger, no DB, no clock, no model. It cannot
    // fork any enforcement, generation or transport path.
    expect(importSpecifiers(core).sort()).toEqual([
      "@/lib/receptionist/conversation-information",
      "@/lib/receptionist/conversation-prompt",
    ]);
  });

  it("names no decision surface, no provider, no transport / state / intent / goal / information / gap / strategy / prompt / response write primitive — a pure leaf", () => {
    expect(DECISION_FNS.test(core)).toBe(false);
    expect(PROVIDER_FACTORY.test(core)).toBe(false);
    expect(TRANSPORT_WRITE_FN.test(core)).toBe(false);
    expect(RUNTIME_STATE_WRITE_FN.test(core)).toBe(false);
    expect(INTENT_WRITE_FN.test(core)).toBe(false);
    expect(GOAL_WRITE_FN.test(core)).toBe(false);
    expect(INFORMATION_WRITE_FN.test(core)).toBe(false);
    expect(GAP_WRITE_FN.test(core)).toBe(false);
    expect(STRATEGY_WRITE_FN.test(core)).toBe(false);
    expect(PROMPT_WRITE_FN.test(core)).toBe(false);
    expect(RESPONSE_WRITE_FN.test(core)).toBe(false);
  });

  it("DUPLICATES no context assembly, no intent / goal resolution, no information extraction, no gap detection, NO strategy resolution AND NO PROMPT PLANNING — the cardinal R24 boundary", () => {
    // The engine consumes an ALREADY-derived prompt plan; it never re-assembles context, re-resolves intent/goal,
    // re-extracts information, re-detects the gap, re-resolves the strategy OR re-plans the prompt. In executable
    // source it names none of the context assembler, the intent/goal resolvers or planners, the information
    // extractor / update planner, the gap detector, the strategy resolver OR the prompt planner — so it
    // re-implements no layer beneath it, exactly as the directive requires ("must NOT duplicate ... planning
    // logic"). The prompt + information modules are imported for the TYPE alone.
    expect(/\bassembleConversationContext\b/.test(core), "never names the context assembler").toBe(false);
    expect(/\bresolveIntent\b/.test(core), "never names the intent resolver").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never names the intent planner").toBe(false);
    expect(/\bresolveGoal\b/.test(core), "never names the goal resolver").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never names the goal planner").toBe(false);
    expect(/\bextractInformation\b/.test(core), "never names the information extractor").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never names the information update planner").toBe(false);
    expect(/\bdetectGap\b/.test(core), "never names the gap detector").toBe(false);
    expect(/\bresolveStrategy\b/.test(core), "never names the strategy resolver").toBe(false);
    expect(/\bplanPrompt\b/.test(core), "never RE-PLANS the prompt (it CONSUMES the derived plan)").toBe(false);
  });

  it("REUSES the R23 prompt plan rather than forking it — it re-plans NO prompt and reaches NEITHER the strategy NOR the gap surface directly", () => {
    // "What is the next act / what does it target / what does it focus on / does it expect a reply" is R23's single
    // authority. The engine reads the DERIVED plan (its `act`, `field`, `focus`, `expectsReply`) and re-implements
    // none of that: it names neither R23's strategy→act table, its per-field / per-act focus tables, NOR the R22
    // strategy TYPES or the R21 gap TYPE / its fields. So there is exactly ONE prompt-planning definition (R23) and
    // exactly ONE response-preparation definition (R24) — no feature computes either independently. It reaches the
    // strategy and the gap ONLY through the plan, never directly.
    expect(/\bSTRATEGY_ACT\b/.test(core), "does not fork the R23 strategy→act table").toBe(false);
    expect(/\bFIELD_FOCUS\b/.test(core), "does not fork the R23 per-field focus table").toBe(false);
    expect(/\bACT_FOCUS\b/.test(core), "does not fork the R23 per-act focus table").toBe(false);
    expect(/\bConversationStrategy\b/.test(core), "does not name the R22 strategy TYPE").toBe(false);
    expect(/\bStrategyDecision\b/.test(core), "does not name the R22 decision TYPE").toBe(false);
    expect(/\bConversationGap\b/.test(core), "does not name the R21 gap TYPE").toBe(false);
    expect(/\bnextRequired\b/.test(core), "does not read the gap's nextRequired directly").toBe(false);
  });

  it("DERIVES ONLY — it re-orchestrates no runtime, GENERATES no draft and executes NO business action (draft generation / booking / scheduling are R24 non-goals)", () => {
    // The engine PREPARES the response spec and stops; PRODUCING the prose — generating the draft with the model —
    // routing to a human, booking, scheduling are future/existing capabilities that CONSUME the spec. In executable
    // source it names neither the turn orchestrator, the draft generator NOR the canonical dispatch — so it can
    // neither re-run the runtime, draft the reply, nor send / book / schedule anything. Critically it never names
    // the draft generator: R24 does NOT couple response preparation to draft generation (the CEO's explicit
    // refinement). The Response Engine determines HOW the response should be produced ONLY.
    expect(/\brunConversationTurn\b/.test(core), "never re-orchestrates the runtime").toBe(false);
    expect(/\bgenerateReplyDraft\b/.test(core), "never GENERATES the draft — no coupling to draft generation").toBe(false);
    expect(/\bdispatchReceptionistReply\b/.test(core), "never dispatches a reply").toBe(false);
  });

  it("is NOT server-only and touches no admin client — a model-free derivation usable in any tier", () => {
    expect(importSpecifiers(core)).not.toContain("server-only");
    expect(importSpecifiers(core)).not.toContain("@/lib/supabase/admin");
  });

  it("single-sources the whole response surface in the pure engine — no other module DEFINES any member", () => {
    const definersOf = (re: RegExp) =>
      walkSources(SOURCE_ROOTS).filter((full) => re.test(codeOf(read(rel(full))))).map(rel).sort();
    for (const re of RESPONSE_SYMBOLS) expect(definersOf(re), re.source).toEqual([RESPONSE_CORE]);
  });

  it("the response engine has EXACTLY the two authorised consumers — the runtime service and the read model", () => {
    // buildResponseSpec is named by the engine (its definition), the orchestrating service (it surfaces the spec on
    // the turn result) and the read model (it derives the spec on read) — and NOTHING else: no feature computes
    // response preparation independently.
    const consumers = namersOf(/\bbuildResponseSpec\b/).filter((p) => p !== RESPONSE_CORE);
    expect(consumers).toEqual([READS, SERVICE]);
  });

  it("PERSISTS NOTHING — the R24 divergence (like R21 / R22 / R23): no response column, no response writer, no response migration (the spec is DERIVED)", () => {
    // Like the R21 gap, the R22 strategy and the R23 prompt plan, the response layer ships NO migration and NO
    // writer: the spec is a total function of the ALREADY-derived prompt plan, and persisting it would create a
    // second, driftable source of truth. Proof — there is no response migration file; no module in the source tree
    // names a response write primitive; and no migration adds a response_spec column or projects one onto the R11
    // list view.
    const migrations = readdirSync(resolve(ROOT, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(migrations.some((f) => /response/i.test(f)), "no response migration file exists").toBe(false);
    expect(namersOf(RESPONSE_WRITE_FN), "no module names a response write primitive").toEqual([]);
    for (const f of migrations) {
      const sql = sqlCodeOf(read(`supabase/migrations/${f}`));
      expect(RESPONSE_WRITE_FN.test(sql), `${f} defines no response writer`).toBe(false);
      expect(/\bc\.response_spec\b/i.test(sql), `${f} projects no response_spec column onto the list view`).toBe(false);
      expect(/add column[^;]*\bresponse_spec\b/i.test(sql), `${f} adds no response_spec column`).toBe(false);
    }
  });

  it("DERIVES the response in the runtime from the prompt plan — the seam that proves Context → … → Prompt → Response", () => {
    // The runtime prepares the response spec from the prompt plan the R23 planner JUST derived (`promptPlan`) — NOT
    // a second read, NOT a model call. This is the linear stack, one layer taller.
    expect(service).toMatch(/buildResponseSpec\(promptPlan\)/);
  });

  it("DERIVES the response on READ from the derived prompt plan, persisting nothing", () => {
    // The read model computes the spec FRESH on every read — deriving the gap, the strategy, the plan, then the
    // spec from THAT plan through the ONE response authority — and writes nothing. So the read exposure is a
    // projection, never a stored column, and the read model names NO write primitive of any layer.
    expect(reads).toMatch(/buildResponseSpec\(promptPlan\)/);
    expect(RESPONSE_WRITE_FN.test(reads), "read model persists no response").toBe(false);
    expect(PROMPT_WRITE_FN.test(reads), "read model persists no prompt").toBe(false);
    expect(STRATEGY_WRITE_FN.test(reads), "read model persists no strategy").toBe(false);
    expect(GAP_WRITE_FN.test(reads), "read model persists no gap").toBe(false);
    expect(INFORMATION_WRITE_FN.test(reads), "read model persists no information").toBe(false);
    expect(GOAL_WRITE_FN.test(reads), "read model persists no goal").toBe(false);
  });

  it("NEVER moves the ownership, intent, goal, information, gap, strategy OR prompt marker — an EIGHTH observation that bypasses no layer beneath it", () => {
    // The engine writes NOTHING; in executable source it names none of the write primitives or their planners. And
    // the layers beneath are UNDISTURBED: the R17 state, R18 intent, R19 goal and R20 information writers are STILL
    // each named by exactly the service, and the R23 prompt planner STILL has exactly its two consumers. So
    // deriving the response spec can move no marker or bypass any governance.
    expect(RUNTIME_STATE_WRITE_FN.test(core), "never names the state writer").toBe(false);
    expect(INTENT_WRITE_FN.test(core), "never names the intent writer").toBe(false);
    expect(GOAL_WRITE_FN.test(core), "never names the goal writer").toBe(false);
    expect(INFORMATION_WRITE_FN.test(core), "never names the information writer").toBe(false);
    expect(/\bplanConversationTransition\b/.test(core), "never reaches the state machine").toBe(false);
    expect(/\bplanIntentProgression\b/.test(core), "never reaches the intent planner").toBe(false);
    expect(/\bplanGoalProgression\b/.test(core), "never reaches the goal planner").toBe(false);
    expect(/\bplanInformationUpdate\b/.test(core), "never reaches the information planner").toBe(false);
    expect(namersOf(RUNTIME_STATE_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INTENT_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(GOAL_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(INFORMATION_WRITE_FN)).toEqual([SERVICE]);
    expect(namersOf(/\bplanPrompt\b/).filter((p) => p !== PLANNER_CORE)).toEqual([READS, SERVICE]);
  });
});

// =====================================================================
// 26. R24 — THE RESPONSE-OBJECTIVE VOCABULARY IS SINGLE-SOURCED AND INDEPENDENT OF THE PROMPT, STRATEGY AND GOAL
//     ENGINES — the objective vocabulary is defined ONCE in the response engine, the act → objective mapping is a
//     total literal-keyed table (so the engine keys off the plan's act by LITERAL, adding no importer to the R22
//     strategy engine or the R21 gap engine), and the response-objective vocabulary is DISJOINT from the R23
//     prompt-act vocabulary, the R22 strategy vocabulary AND the R19 goal vocabulary (a response objective is a
//     PREPARATION MODE — how the produced response should be shaped — never an utterance, never a move, never an
//     objective the conversation serves).
// =====================================================================

describe("receptionist runtime — R24: the response-objective vocabulary is single-sourced and independent of the prompt, strategy and goal engines", () => {
  const core = codeOf(read(RESPONSE_CORE));
  const sources = walkSources(SOURCE_ROOTS).map((full) => ({
    path: rel(full),
    code: codeOf(read(rel(full))),
  }));
  const definersOf = (re: RegExp) =>
    sources.filter((s) => re.test(s.code)).map((s) => s.path).sort();

  const RESPONSE_OBJECTIVE_NAMES = ["welcome", "gather", "inform", "transfer", "confirm"] as const;

  it("defines the response-objective vocabulary in exactly one file — the response engine", () => {
    expect(definersOf(/export const RESPONSE_OBJECTIVES/)).toEqual([RESPONSE_CORE]);
  });

  it("maps the prompt act to the objective through a total literal-keyed table — one source of truth", () => {
    // The objective is chosen by indexing a total `Record<PromptAct, ResponseObjective>` (PROMPT_OBJECTIVE) with the
    // plan's act LITERAL — the analogue of how R23 keyed its acts off decision.strategy. So the mapping is exhaustive
    // by construction (a missing act fails tsc) and lives in exactly one place.
    expect(/\bPROMPT_OBJECTIVE\b/.test(core), "the act→objective table is defined").toBe(true);
    expect(/PROMPT_OBJECTIVE\[plan\.act\]/.test(core), "the objective is keyed off the plan's act literal").toBe(true);
  });

  it("keys off the plan's act by LITERAL — it adds NO importer to the R22 strategy engine OR the R21 gap engine", () => {
    // The engine reads the prompt PLAN, not the strategy decision or the gap; it imports neither the strategy module
    // nor the gap module. So the R22 strategy engine's and the R21 gap engine's importer sets are undisturbed, and
    // the engine reaches only the two TYPE modules it declares.
    expect(importSpecifiers(core)).not.toContain("@/lib/receptionist/conversation-strategy");
    expect(importSpecifiers(core)).not.toContain("@/lib/receptionist/conversation-gap");
  });

  it("names the whole objective vocabulary, and NEITHER the R23 prompt planner NOR the R22 strategy engine NOR the R19 goal engine names ANY of it — disjoint vocabularies", () => {
    // The five objective names live ONLY in the response engine; none of the prompt planner, the strategy engine or
    // the goal engine references any of them as a quoted literal. So the objective vocabulary is the engine's OWN,
    // not a re-labelling of a prompt, strategy or goal concern. The names are deliberately chosen not to collide —
    // the objective `inform` ≠ the act `answer` ≠ the strategy `provide_answer` ≠ the goal `answer_enquiry`; the
    // objective `transfer` ≠ the act `handoff` ≠ the strategy `escalate_to_human` ≠ the goal `handoff_to_human`.
    const plannerCore = codeOf(read(PLANNER_CORE));
    const strategyCore = codeOf(read(STRATEGY_CORE));
    const goalCore = codeOf(read(GOAL_CORE));
    for (const name of RESPONSE_OBJECTIVE_NAMES) {
      expect(core, `response engine names ${name}`).toContain(`"${name}"`);
      expect(plannerCore, `prompt planner does NOT name the objective ${name}`).not.toContain(`"${name}"`);
      expect(strategyCore, `strategy engine does NOT name the objective ${name}`).not.toContain(`"${name}"`);
      expect(goalCore, `goal engine does NOT name the objective ${name}`).not.toContain(`"${name}"`);
    }
  });
});

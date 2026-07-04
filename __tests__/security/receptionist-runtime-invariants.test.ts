import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — MULTI-TURN CONVERSATION RUNTIME invariants
 * (the AI Receptionist Programme, R15 — MULTI-TURN CONVERSATION RUNTIME).
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
 *     → classifies → advances; the dispatch consumes the caller's input UNCHANGED (a marker, never a
 *     gate — no formal state machine).
 *   • ONLY THE RUNTIME ADVANCES STATE — the state writer is named by exactly one module, org-scoped in
 *     the migration, and the vocabulary is defined ONCE in the pure core and mirrored by the CHECK.
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
const DRAFT = "server/services/receptionist-draft.ts";
const CONTEXT_SEAM = "server/services/receptionist-conversation-context.ts";
const POLICY = "lib/receptionist/policy.ts";
const COMMS_INDEX = "lib/comms/index.ts";
const MIGRATION = "supabase/migrations/20260822000000_receptionist_conversation_runtime.sql";

/** The harvested policy's decision surface. */
const DECISION_FNS = /\b(?:evaluateReply|isAutoSendable|redactReply)\b/;
const POLICY_SPEC = "@/lib/receptionist/policy";
/** The provider factory — the only door to a vendor adapter. */
const PROVIDER_FACTORY = /\bgetSmsProvider\b/;
/** The transport ledger's write primitive. */
const TRANSPORT_WRITE_FN = /\brecord_ai_reply_transport\b/;
/** The runtime state's write primitive — the only door that advances a conversation's state. */
const RUNTIME_STATE_WRITE_FN = /\bset_receptionist_conversation_runtime_state\b/;

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

  it("runConversationTurn RESOLVES → RECONSTRUCTS+ASSEMBLES ONCE → DISPATCHES → CLASSIFIES → ADVANCES, in that order", () => {
    // Steps 2–4 go THROUGH the R12 seam `getConversationTurnContext` — the single server-side
    // reconstruct-and-assemble path (R16), which yields BOTH the assembled context AND the summary
    // (carrying `runtime_state`) from ONE reconstruction, so state is determined WITHOUT a separate
    // read. The runtime never calls the pure `assembleConversationContext` directly (that would be a
    // second assembly path, forbidden by the R12 invariant). Then the pipeline is delegated whole.
    expect(code).toMatch(
      /export async function runConversationTurn\([\s\S]*?getConversationTurnContext\([\s\S]*?dispatchReceptionistReply\(\s*input,[\s\S]*?classifyTurn\([\s\S]*?nextConversationState\([\s\S]*?setConversationRuntimeState\(/,
    );
  });

  it("delegates GENERATE→POLICY→AUDIT→ROUTE WHOLE to the canonical dispatch — the input is UNCHANGED (a marker, not a gate)", () => {
    // The dispatch receives the caller's `input` VERBATIM as its first argument. The second argument is
    // the already-assembled canonical context threaded down (R16) — a performance consolidation that
    // spares the generator a duplicate reconstruction, NOT a prior-state gate: no prior-state branch
    // re-shapes the turn, so the runtime encodes no formal state machine / intent progression (R16+
    // non-goals).
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

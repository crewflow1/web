import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — the CONVERSATION GENERATION ENGINE, single-authority invariants
 * (the AI Receptionist Programme, R25 — CONVERSATION GENERATION ENGINE).
 *
 * The conversation stack derives, in a clean linear order, EIGHT questions before a single word is written:
 * Context (R12/R16) → State (R17) → Intent (R18) → Goal (R19) → Information (R20) → Gap (R21) → Strategy (R22)
 * → Prompt (R23) → Response (R24). R24 is the last DERIVED leaf — it PREPARES a model-ready RESPONSE
 * SPECIFICATION and STOPS, writing no words. R25 is the layer that finally PRODUCES the words: the canonical
 * architectural capability responsible for CONVERSATIONAL LANGUAGE GENERATION — the single authority that
 * CONVERTS an R24 {@link ResponseSpecification}, grounded in the canonical R12 {@link ConversationContext},
 * into a draft. It is expressed in two modules:
 *   • the PURE CORE (lib/receptionist/conversation-generation.ts) — the GENERATION MODEL (request, instruction,
 *     result, interface), the RESPONSE-SPECIFICATION CONSUMPTION (`prepareGenerationInstruction`, the ONE place
 *     a spec becomes a model instruction) and the deterministic FALLBACK shaping (`fallbackResponse`). It
 *     reaches NO model — pure, client/server-safe, deterministic, in the exact discipline of R12/R13/R24's cores.
 *   • the SERVER RUNTIME (server/services/receptionist-generation.ts) — `generateConversationResponse`, the ONE
 *     place conversational language generation reaches a language model, and only through the house abstraction
 *     (lib/ai/text::getTextProvider — no vendor SDK), at a BOUNDED edge, degrading to the deterministic fallback
 *     rather than throwing.
 *
 * The receptionist reply draft (server/services/receptionist-draft.ts) is the FIRST IMPLEMENTATION produced
 * THROUGH this engine, now a THIN adapter that submits a request and returns what the engine produces — it forks
 * no generation logic. Booking, scheduling, CRM, support, voice and every future multi-channel utterance must
 * ALSO generate their language through this ONE engine; no feature may implement independent language-generation
 * logic. This suite proves that single-authority contract as a matter of SOURCE, not discipline — the house bar
 * of the R12–R24 invariant suites:
 *
 *   • THE ENGINE SHIPS — a pure core + a server runtime, exporting the model, the consumption, the fallback and
 *     the single generation entry point.
 *   • ADDITIVE, CODE-ONLY — neither module contains SQL DDL; generation PERSISTS NOTHING (no generation writer
 *     exists anywhere): the engine produces a draft and stops.
 *   • THE PURE CORE REACHES NO MODEL — not server-only, imports no vendor SDK and no text abstraction, invokes no
 *     model, does zero I/O, is deterministic (no clock, no RNG), mutates nothing, and depends ONLY on R13's
 *     prompt builder, R4's composer and three pure types.
 *   • THE CONSUMPTION IS SINGLE-SOURCED + REUSES R13 — `prepareGenerationInstruction` is DEFINED once and is the
 *     ONLY consumer of R13's `buildReplyPrompt`; the fixed `system` framing is R13's VERBATIM (never
 *     spec-derived — a conversation can never steer the safety rules); a spec only ADDS guidance to the `user`
 *     channel.
 *   • THE RUNTIME REACHES THE MODEL ONLY THROUGH THE ABSTRACTION — server-only; the ONE model door is
 *     getTextProvider; no vendor SDK; the edge is BOUNDED (it applies exactly the prepared instruction); it
 *     consumes ONLY the canonical R12 context; and it GENERATES ONLY (enforces / audits / transports / writes
 *     nothing).
 *   • THE ENGINE IS THE SINGLE GENERATION AUTHORITY — `generateConversationResponse` is DEFINED once and reached
 *     ONLY through the first implementation; the consumption and the fallback are DEFINED once and consumed only
 *     by the runtime; and across the receptionist reply path the model is reached in the engine alone.
 *   • THE FIRST IMPLEMENTATION IS A THIN ADAPTER — it delegates WHOLE to the engine and re-implements no
 *     generation (it names no model door, no context fetch, no prompt builder, no fallback composer), re-exporting
 *     only the engine's provenance labels.
 *   • UPSTREAM AUTHORITIES PRESERVED — the engine CONSUMES the R24 spec type and never re-derives the spec (R24)
 *     or the plan (R23); the runtime reaches the engine ONLY through the first implementation.
 *
 * The engine's runtime behaviour (the model path, every degradation to the acknowledgement, provenance) is pinned
 * in __tests__/receptionist/conversation-generation.test.ts and __tests__/receptionist/draft.test.ts, and end to
 * end over real Postgres in the integration tier. This tier is HERMETIC — a filesystem scan over comment-stripped
 * source — so the prose documenting the contract can neither satisfy a positive match nor trip a negative.
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

/** Every source module whose comment-stripped code matches `re` — the set that NAMES a symbol. */
function matchingSources(re: RegExp): string[] {
  return walkSources(SOURCE_ROOTS)
    .filter((full) => re.test(codeOf(read(rel(full)))))
    .map(rel)
    .sort();
}

// The R25 engine — its two modules.
const ENGINE_CORE = "lib/receptionist/conversation-generation.ts";
const ENGINE = "server/services/receptionist-generation.ts";
// The FIRST implementation through the engine.
const DRAFT_ADAPTER = "server/services/receptionist-draft.ts";
// The orchestrating runtime.
const SERVICE = "server/services/receptionist.ts";
// The upstream companion the engine REUSES, never forks (R13 — the two-part prompt). The R24 spec
// authority and the R4 deterministic fallback are referenced below by their @/ import specifiers.
const PROMPT_BUILDER = "lib/receptionist/draft.ts";

const TEXT_ABSTRACTION = "@/lib/ai/text";
const CONTEXT_TYPE = "@/lib/receptionist/conversation-context";
const RESPONSE_SPEC_TYPE = "@/lib/receptionist/conversation-response";

// =====================================================================
// 0. THE ENGINE SHIPS — a pure core + a server runtime.
// =====================================================================

describe("conversation generation engine — the engine ships", () => {
  it(`ships the pure core ${ENGINE_CORE}`, () => {
    expect(existsSync(resolve(ROOT, ENGINE_CORE)), ENGINE_CORE).toBe(true);
  });

  it(`ships the server runtime ${ENGINE}`, () => {
    expect(existsSync(resolve(ROOT, ENGINE)), ENGINE).toBe(true);
  });

  it("the pure core exports the generation MODEL, the CONSUMPTION, the FALLBACK and the provenance vocabulary", () => {
    const code = codeOf(read(ENGINE_CORE));
    // The model — request, instruction, result, interface.
    expect(code).toMatch(/export type GenerationRequest\b/);
    expect(code).toMatch(/export type GenerationInstruction\b/);
    expect(code).toMatch(/export type GeneratedResponse\b/);
    expect(code).toMatch(/export type GenerationEngine\b/);
    // The consumption + the fallback.
    expect(code).toMatch(/export function prepareGenerationInstruction\(/);
    expect(code).toMatch(/export function fallbackResponse\(/);
    // The provenance vocabulary + the bounded temperature.
    expect(code).toMatch(/export const MODEL_PRODUCER\b/);
    expect(code).toMatch(/export const FALLBACK_PRODUCER\b/);
    expect(code).toMatch(/export const GENERATION_TEMPERATURE\b/);
  });

  it("the server runtime exports the single generation entry point", () => {
    const code = codeOf(read(ENGINE));
    expect(code).toMatch(/export async function generateConversationResponse\(/);
  });

  it("names the model and fallback producers distinctly (a closed provenance vocabulary)", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(code).toMatch(/MODEL_PRODUCER\s*=\s*["']conversation_aware_reply["']/);
    expect(code).toMatch(/FALLBACK_PRODUCER\s*=\s*["']deterministic_acknowledgement["']/);
  });
});

// =====================================================================
// 1. ADDITIVE, CODE-ONLY — no schema, no DDL; generation PERSISTS NOTHING.
// =====================================================================

describe("conversation generation engine — additive, code-only, persists nothing", () => {
  it("neither engine module contains any SQL DDL — R25 changes no schema, no substrate, no read model", () => {
    for (const file of [ENGINE_CORE, ENGINE]) {
      const code = codeOf(read(file));
      expect(code, `${file} must create no relation`).not.toMatch(
        /create\s+(or\s+replace\s+)?(table|view|materialized\s+view|function|trigger|policy)/i,
      );
      expect(code, `${file} must alter nothing`).not.toMatch(/alter\s+table/i);
      expect(code, `${file} must drop nothing`).not.toMatch(/drop\s+(table|view|function|column)/i);
    }
  });

  it("generation is NEVER persisted — no generation write primitive exists anywhere in source", () => {
    // The engine produces a draft that flows on through the pipeline; the generation itself is not a
    // derived leaf that gets stored. A `set_receptionist_conversation_generation` writer would contradict
    // "produces drafts only" — assert none exists.
    expect(matchingSources(/\bset_receptionist_conversation_generation\b/)).toEqual([]);
  });
});

// =====================================================================
// 2. THE PURE CORE REACHES NO MODEL — truly pure, in R12/R13/R24's discipline.
// =====================================================================

describe("conversation generation engine — the pure core reaches no model", () => {
  const code = codeOf(read(ENGINE_CORE));

  it("is NOT server-only — a shared, client/server-safe module reasoned about in isolation", () => {
    expect(importSpecifiers(code)).not.toContain("server-only");
  });

  it("imports NO vendor SDK and NO text abstraction — it reaches no model", () => {
    const imports = importSpecifiers(code);
    for (const banned of [
      "@anthropic-ai/sdk",
      "openai",
      TEXT_ABSTRACTION,
      "@/lib/ai/llm",
      "@/lib/ai/embeddings",
      "@/lib/ai",
    ]) {
      expect(imports, `${ENGINE_CORE} must not import ${banned}`).not.toContain(banned);
    }
    expect(code, "no provider factory").not.toMatch(/\bgetTextProvider\b/);
    expect(code, "no vendor message call").not.toMatch(/\.messages\.create\b/);
    expect(code, "no vendor chat call").not.toMatch(/\.chat\.completions\b/);
    expect(code, "no house generation helper").not.toMatch(
      /\b(?:generateText|streamText|generateObject)\b/,
    );
  });

  it("does ZERO I/O — no db client, no fetch", () => {
    expect(importSpecifiers(code).some((s) => /supabase/i.test(s)), "no supabase client").toBe(false);
    expect(code).not.toMatch(/createAdminClient|createClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("is DETERMINISTIC — no clock, no RNG (the model latency is the server runtime's concern)", () => {
    expect(code, "no clock").not.toMatch(/\bDate\.now\s*\(|\bnew\s+Date\s*\(/);
    expect(code, "no RNG").not.toMatch(/\bMath\.random\s*\(|\bcrypto\.randomUUID\s*\(/);
  });

  it("mutates nothing — no query verb, no RPC", () => {
    expect(code).not.toMatch(/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.rpc\b/);
  });

  it("depends ONLY on R13's builder, R4's composer, and three pure types — nothing else", () => {
    expect(importSpecifiers(code).sort()).toEqual(
      [
        CONTEXT_TYPE, // the R12 context type
        RESPONSE_SPEC_TYPE, // the R24 spec type
        "@/lib/receptionist/draft", // R13's prompt builder + the token cap
        "@/lib/receptionist/reply", // R4's deterministic composer (the fallback)
        "@/lib/receptionist/types", // the InboundChannel type
      ].sort(),
    );
  });
});

// =====================================================================
// 3. THE CONSUMPTION IS SINGLE-SOURCED + REUSES R13 — one spec→instruction site.
// =====================================================================

describe("conversation generation engine — the response-spec consumption is single-sourced and reuses R13", () => {
  it("prepareGenerationInstruction is DEFINED in exactly one module (the pure core)", () => {
    expect(matchingSources(/export function prepareGenerationInstruction\(/)).toEqual([ENGINE_CORE]);
  });

  it("prepareGenerationInstruction is REFERENCED only by the core (its definition) + the server runtime", () => {
    expect(matchingSources(/\bprepareGenerationInstruction\s*\(/)).toEqual(
      [ENGINE_CORE, ENGINE].sort(),
    );
  });

  it("REUSES R13's buildReplyPrompt — the core imports the builder and forks no prompt logic", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(importSpecifiers(code), "imports the R13 builder module").toContain(
      "@/lib/receptionist/draft",
    );
    expect(code, "calls the R13 builder").toMatch(/\bbuildReplyPrompt\s*\(/);
    // It re-implements NEITHER the builder NOR the fixed system framing constant.
    expect(code, "does not re-define the builder").not.toMatch(/function buildReplyPrompt\(/);
    expect(code, "does not re-define the system framing").not.toMatch(
      /REPLY_DRAFT_SYSTEM_PROMPT\s*=/,
    );
  });

  it("buildReplyPrompt is consumed by EXACTLY the builder + the engine core — no second prompt path", () => {
    // R13 single-sourced the two-part prompt; R25's ONE consumer of it is the engine core's spec
    // consumption. If this list grows, a feature has built a reply prompt some other way.
    expect(matchingSources(/\bbuildReplyPrompt\s*\(/)).toEqual([ENGINE_CORE, PROMPT_BUILDER].sort());
  });

  it("CONSUMES the R24 spec's model-ready fields — objective, directive, guardrails", () => {
    const code = codeOf(read(ENGINE_CORE));
    expect(code).toMatch(/\bspec\.objective\b/);
    expect(code).toMatch(/\bspec\.directive\b/);
    expect(code).toMatch(/\bspec\.guardrails\b/);
  });
});

// =====================================================================
// 4. THE SPEC NEVER STEERS THE FRAMING — safety is not conversation-derived.
// =====================================================================

describe("conversation generation engine — a spec adds to the user channel only, never the framing", () => {
  const code = codeOf(read(ENGINE_CORE));

  it("the instruction's system channel is R13's builder framing, VERBATIM", () => {
    expect(code, "system is the builder's system").toMatch(/system:\s*prompt\.system\b/);
    // The system channel is never a template literal and never mixes in spec content.
    expect(code, "system is not synthesised from a template").not.toMatch(/system:\s*`/);
    expect(code, "system is not derived from the spec").not.toMatch(/system:[^,\n]*\bspec\b/);
  });

  it("the spec's guidance is rendered into the USER channel, appended to R13's ask", () => {
    // The guidance renderer feeds the user construction (prompt.user + guidance), never the system.
    expect(code).toMatch(/\bprompt\.user\b/);
    expect(code).toMatch(/renderResponseGuidance\s*\(\s*spec\s*\)/);
  });

  it("the guardrail set is rendered from the spec's OWN guardrails — a closed, spec-derived list", () => {
    expect(code).toMatch(/spec\.guardrails\.join\(/);
  });
});

// =====================================================================
// 5. THE SERVER RUNTIME — model only through the abstraction, bounded, generates only.
// =====================================================================

describe("conversation generation engine — the server runtime reaches the model only through the abstraction", () => {
  const code = codeOf(read(ENGINE));

  it("is a server-only module", () => {
    expect(importSpecifiers(code)).toContain("server-only");
  });

  it("its ONLY model door is getTextProvider from lib/ai/text — no vendor SDK", () => {
    const imports = importSpecifiers(code);
    expect(imports, "reaches the model through the house abstraction").toContain(TEXT_ABSTRACTION);
    expect(code).toMatch(/\bgetTextProvider\s*\(/);
    for (const banned of ["@anthropic-ai/sdk", "openai", "@/lib/ai/llm", "@/lib/ai/embeddings"]) {
      expect(imports, `${ENGINE} must not import ${banned}`).not.toContain(banned);
    }
    expect(code, "no direct Anthropic client").not.toMatch(/new\s+Anthropic\b/);
    expect(code, "no direct OpenAI client").not.toMatch(/new\s+OpenAI\b/);
    expect(code, "no vendor message call").not.toMatch(/\.messages\.create\b/);
    expect(code, "no vendor chat call").not.toMatch(/\.chat\.completions\b/);
  });

  it("the edge is BOUNDED — it drives the model with EXACTLY the prepared instruction", () => {
    // The runtime prepares the instruction through the pure core, then applies its system/temperature/cap
    // at the model door — it re-chooses none of them.
    expect(code, "prepares through the pure core").toMatch(/\bprepareGenerationInstruction\s*\(/);
    expect(code).toMatch(/system:\s*instruction\.system\b/);
    expect(code).toMatch(/temperature:\s*instruction\.temperature\b/);
    expect(code).toMatch(/maxTokens:\s*instruction\.max_tokens\b/);
  });

  it("consumes ONLY the canonical R12 context — never reconstructs or assembles", () => {
    const imports = importSpecifiers(code);
    expect(imports, "the R12 seam").toContain("@/server/services/receptionist-conversation-context");
    expect(code, "the org-scoped fetch is the fallback").toMatch(/\bgetConversationContext\s*\(/);
    expect(imports, "must not import the R11 read service").not.toContain(
      "@/server/services/receptionist-conversation-reads",
    );
    expect(code, "must not reconstruct").not.toMatch(/\breconstructConversation\b/);
    expect(code, "must not assemble").not.toMatch(/\bassembleConversationContext\b/);
    expect(code, "touches no conversation substrate table").not.toMatch(
      /\breceptionist_conversations\b|\breceptionist_messages\b/,
    );
  });

  it("GENERATES ONLY — it names no policy, no audit, no transport, and writes nothing", () => {
    const imports = importSpecifiers(code);
    expect(imports, "no policy").not.toContain("@/lib/receptionist/policy");
    expect(imports, "no comms").not.toContain("@/lib/comms");
    expect(code, "no policy decision").not.toMatch(
      /\b(?:evaluateReply|isAutoSendable|enforceReceptionistReply)\b/,
    );
    expect(code, "no audit primitive").not.toMatch(/\brecord_ai_reply_audit\b/);
    expect(code, "no audit seam").not.toMatch(/\benforceAndAuditReply\b/);
    expect(code, "no transport primitive").not.toMatch(/\brecord_ai_reply_transport\b/);
    expect(code, "no transport / dispatch").not.toMatch(
      /\b(?:transportReply|dispatchReply|dispatchReceptionistReply)\b/,
    );
    expect(code, "no comms door").not.toMatch(/\bgetSmsProvider\b|\.send\s*\(/);
    expect(code, "writes nothing").not.toMatch(
      /\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.rpc\b|createAdminClient\b/,
    );
  });
});

// =====================================================================
// 6. THE ENGINE IS THE SINGLE GENERATION AUTHORITY — one entry, reached one way.
// =====================================================================

describe("conversation generation engine — one generation authority, reached one way", () => {
  it("generateConversationResponse is DEFINED in exactly one module (the server runtime)", () => {
    expect(matchingSources(/export async function generateConversationResponse\(/)).toEqual([ENGINE]);
  });

  it("generateConversationResponse is REFERENCED only by the runtime + the first implementation (the adapter)", () => {
    // The receptionist reply draft is the FIRST implementation and reaches the engine here; if this list
    // grows to a module OTHER than a legitimate engine implementation, a feature has generated language
    // some other way — exactly what the directive forbids.
    expect(matchingSources(/\bgenerateConversationResponse\s*\(/)).toEqual(
      [DRAFT_ADAPTER, ENGINE].sort(),
    );
  });

  it("the deterministic fallback shaping is DEFINED once (the core) and consumed only by the runtime", () => {
    expect(matchingSources(/export function fallbackResponse\(/)).toEqual([ENGINE_CORE]);
    expect(matchingSources(/\bfallbackResponse\s*\(/)).toEqual([ENGINE_CORE, ENGINE].sort());
  });

  it("across the receptionist reply path, the model is reached in the ENGINE alone", () => {
    // The other receptionist reply-generation modules — R13's pure builder, the engine's pure core, and the
    // first-implementation adapter — never reach the provider; only the server runtime does. (Unrelated
    // capabilities such as HQ drafting or memory summarisation reach the abstraction for their own purposes;
    // this invariant scopes the receptionist REPLY generation path.)
    for (const file of [PROMPT_BUILDER, ENGINE_CORE, DRAFT_ADAPTER]) {
      expect(codeOf(read(file)), `${file} must not reach the model`).not.toMatch(
        /\bgetTextProvider\s*\(/,
      );
    }
    expect(codeOf(read(ENGINE))).toMatch(/\bgetTextProvider\s*\(/);
  });
});

// =====================================================================
// 7. THE FIRST IMPLEMENTATION IS A THIN ADAPTER — it forks no generation logic.
// =====================================================================

describe("conversation generation engine — the receptionist draft is a thin first implementation", () => {
  const code = codeOf(read(DRAFT_ADAPTER));

  it("delegates WHOLE to the engine — imports and calls generateConversationResponse", () => {
    expect(importSpecifiers(code), "imports the engine runtime").toContain(
      "@/server/services/receptionist-generation",
    );
    expect(code).toMatch(/\bgenerateConversationResponse\s*\(/);
  });

  it("re-implements NO generation logic — no model door, no context fetch, no prompt builder, no fallback composer", () => {
    expect(code, "no model door").not.toMatch(/\bgetTextProvider\b/);
    expect(code, "no context fetch call").not.toMatch(/\bgetConversationContext\s*\(/);
    expect(code, "no prompt building").not.toMatch(/\bbuildReplyPrompt\b/);
    expect(code, "no spec consumption").not.toMatch(/\bprepareGenerationInstruction\b/);
    expect(code, "no fallback shaping").not.toMatch(/\bfallbackResponse\b|\bcomposeReceptionistReply\b/);
    // It also runs no model call of any kind.
    expect(code).not.toMatch(/\.messages\.create\b|\.chat\.completions\b/);
  });

  it("re-exports the engine's provenance labels — its consumers still import them from the seam", () => {
    expect(code).toMatch(/export\s*\{[^}]*\bMODEL_PRODUCER\b[\s\S]*?\}/);
    expect(code).toMatch(/export\s*\{[^}]*\bFALLBACK_PRODUCER\b[\s\S]*?\}/);
    // And it SOURCES them from the engine core (the provenance authority), not by re-declaration.
    expect(importSpecifiers(code)).toContain("@/lib/receptionist/conversation-generation");
    expect(code, "does not re-declare the labels").not.toMatch(/const MODEL_PRODUCER\s*=/);
  });
});

// =====================================================================
// 8. UPSTREAM AUTHORITIES PRESERVED — the engine consumes, it does not re-derive.
// =====================================================================

describe("conversation generation engine — the Response Engine and Prompt Planner remain authoritative", () => {
  it("the engine core CONSUMES the R24 spec TYPE — it does not re-derive the spec", () => {
    const raw = read(ENGINE_CORE);
    expect(importSpecifiers(codeOf(raw)), "imports the R24 spec module").toContain(
      RESPONSE_SPEC_TYPE,
    );
    // It is a TYPE dependency — the engine folds the spec's shape, never the R24 derivation machinery.
    expect(raw).toMatch(
      /import\s+type\s*\{[^}]*ResponseSpecification[^}]*\}\s*from\s*["']@\/lib\/receptionist\/conversation-response["']/,
    );
  });

  it("neither engine module re-derives an upstream leaf — not the R24 spec, nor the R23 plan, nor strategy/gap", () => {
    for (const file of [ENGINE_CORE, ENGINE]) {
      const code = codeOf(read(file));
      expect(code, `${file} must not re-derive the R24 spec`).not.toMatch(/\bbuildResponseSpec\b/);
      expect(code, `${file} must not re-derive the R23 plan`).not.toMatch(/\bplanPrompt\b/);
      expect(code, `${file} must not re-derive the R22 strategy`).not.toMatch(
        /\bderiveConversationStrategy\b|\bdecideStrategy\b/,
      );
    }
  });

  it("the runtime reaches the engine ONLY through the first implementation — never the engine directly", () => {
    // The orchestrating service consumes the draft SEAM (generateReplyDraft), which delegates to the engine;
    // it does not import the engine runtime directly. Draft generation stays the first implementation THROUGH
    // the engine, not a shortcut around it.
    const imports = importSpecifiers(codeOf(read(SERVICE)));
    expect(imports, "consumes the first implementation").toContain(
      "@/server/services/receptionist-draft",
    );
    expect(imports, "does not import the engine runtime directly").not.toContain(
      "@/server/services/receptionist-generation",
    );
  });
});

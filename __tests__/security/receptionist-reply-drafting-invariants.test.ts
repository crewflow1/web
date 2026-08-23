import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation-aware reply DRAFTING invariants
 * (the AI Receptionist Programme, R13 — CONVERSATION-AWARE REPLY DRAFTING).
 *
 * R4 shipped a FIXED acknowledgement composer (lib/receptionist/reply.ts). R13 replaces it with a
 * conversation-aware draft GENERATOR — the pure prompt builder (lib/receptionist/draft.ts) plus its
 * server seam (server/services/receptionist-draft.ts::generateReplyDraft) — WITHOUT widening the
 * pipeline. The generator has exactly two edges: it CONSUMES ONLY the canonical R12 context (through
 * the R12 server seam, never reconstructing or assembling on its own), and it reaches a model ONLY
 * through the existing abstraction (lib/ai/text::getTextProvider — no vendor SDK). Its single output
 * is a draft string; it enforces nothing, audits nothing, transports nothing — the UNCHANGED canonical
 * service runs that draft through Enforce → Audit → (deny-by-default) → Transport exactly as it ran the
 * fixed acknowledgement. And it ALWAYS yields a draft: with no provider / no conversation / no context /
 * a provider throw, it degrades to the very acknowledgement R4 shipped. This suite proves that contract
 * as a matter of SOURCE, not discipline — the house bar of the R9–R12 invariant suites:
 *
 *   • ADDITIVE, CODE-ONLY — R13 ships two source modules and NO migration; neither contains SQL DDL.
 *   • DRAFT ONLY FROM THE CANONICAL R12 CONTEXT (headline) — the seam's ONLY conversation input is the
 *     R12 seam's getConversationContext; it never imports the R11 read service, never names
 *     reconstructConversation or assembleConversationContext, and reads no substrate table / read-model
 *     view. The pure builder imports the R12 context TYPE and nothing else.
 *   • MODEL ONLY THROUGH THE ABSTRACTION (headline) — the seam's ONLY model door is getTextProvider from
 *     lib/ai/text; it imports no vendor SDK and names no vendor entry point, and the edge is BOUNDED
 *     (temperature 0, a capped output). The pure builder invokes no model at all.
 *   • THE GENERATOR GENERATES ONLY — the seam names no policy, no audit primitive, no transport primitive,
 *     no comms door, and writes nothing. It decides no verdict and sends no message.
 *   • THE PIPELINE WELD IS PRESERVED — the canonical service GENERATES the draft then routes it through
 *     the unchanged enforceAndAuditReply / dispatchReply; the deny-by-default gate is intact; and the
 *     service no longer reaches the raw composer directly (the old path was fully replaced, not doubled).
 *   • SINGLE DRAFT PATH — generateReplyDraft is defined in exactly one module and referenced only by that
 *     seam + the canonical service; buildReplyPrompt likewise lives in one module. No feature drafts a
 *     reply another way.
 *   • CORRECT LAYERING — the seam is server-only; the pure builder is not (client/server-safe, reasoned
 *     about in isolation), and it is truly pure: no I/O, no model, no clock, no RNG, no mutation.
 *   • FALLBACK PRESERVED — the seam imports composeReceptionistReply and labels the fallback with the
 *     pre-R13 audit producer, so the degraded draft is byte-for-byte, and in provenance, the R4 reply.
 *
 * R25 UPDATE — the Conversation Generation Engine now OWNS the generation. R25 lifted the model reach, the
 * R12-context consumption, the response-spec→instruction consumption and the fallback shaping OUT of the R13
 * seam and INTO the canonical engine: its PURE core (lib/receptionist/conversation-generation.ts — spec
 * consumption + fallback shaping, reaching NO model) and its SERVER runtime
 * (server/services/receptionist-generation.ts — the ONE model reach). The R13 seam is now a THIN adapter that
 * delegates to the engine and re-exports its producer labels. So the HEADLINE invariants above — draft only
 * from the canonical R12 context, model only through the abstraction, the bounded edge, the preserved fallback —
 * are asserted here against the ENGINE, not the adapter; the adapter is still proved to generate ONLY (it
 * enforces/audits/transports nothing), and the single-draft-path weld through the canonical service is
 * unchanged. The engine's own single-authority invariants are pinned in
 * __tests__/security/receptionist-generation-invariants.test.ts.
 *
 * The layer's runtime behaviour (deterministic prompt assembly; the model path; every degradation to the
 * acknowledgement; the generated draft flowing Enforce → Audit → Transport; org-scoped context
 * consumption) is pinned in __tests__/receptionist/draft.test.ts and
 * __tests__/integration/receptionist/reply-drafting.test.ts. This tier is HERMETIC — a filesystem scan
 * over comment-stripped source — so the prose documenting the contract can neither satisfy a positive
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

const PURE = "lib/receptionist/draft.ts";
const SEAM = "server/services/receptionist-draft.ts";
// R25 — the Conversation Generation Engine subsumes R13's model reach. The generation of the draft (consuming
// the R12 context, consuming an R24 spec into the model instruction, reaching the model, shaping the fallback)
// moved OUT of the R13 seam and INTO the engine: its PURE core (spec consumption + fallback shaping, no model)
// and its SERVER runtime (the ONE model reach). The R13 SEAM above is now a THIN adapter that delegates to the
// engine, so the headline consumption/model/fallback invariants below assert on the engine, not the adapter.
const ENGINE_CORE = "lib/receptionist/conversation-generation.ts";
const ENGINE = "server/services/receptionist-generation.ts";
const SERVICE = "server/services/receptionist.ts";
const CONTEXT_SEAM = "server/services/receptionist-conversation-context.ts";
const READS = "server/services/receptionist-conversation-reads.ts";
const REPLY = "lib/receptionist/reply.ts";
const CONTEXT_TYPE = "@/lib/receptionist/conversation-context";
const TEXT_ABSTRACTION = "@/lib/ai/text";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The drafting layer ships — pure prompt builder + server generator seam.
// =====================================================================

describe("receptionist reply drafting — the drafting layer ships", () => {
  it(`ships the pure prompt builder ${PURE}`, () => {
    expect(existsSync(resolve(ROOT, PURE)), PURE).toBe(true);
  });

  it(`ships the server generator seam ${SEAM}`, () => {
    expect(existsSync(resolve(ROOT, SEAM)), SEAM).toBe(true);
  });

  it("the pure builder exports the prompt builder, the fixed system framing, and the token cap", () => {
    const code = codeOf(read(PURE));
    expect(code).toMatch(/export function buildReplyPrompt\(/);
    expect(code).toMatch(/export const REPLY_DRAFT_SYSTEM_PROMPT\b/);
    expect(code).toMatch(/export const DEFAULT_REPLY_DRAFT_MAX_TOKENS\b/);
  });

  it("the server seam exports the generateReplyDraft entry point + re-exports the engine's producer labels", () => {
    const code = codeOf(read(SEAM));
    expect(code).toMatch(/export async function generateReplyDraft\(/);
    // Under R25 the producer labels are DEFINED by the engine core (the provenance authority) and
    // RE-EXPORTED here, so the seam's existing consumers still import them from this module unchanged.
    expect(code).toMatch(/export\s*\{[^}]*\bMODEL_PRODUCER\b[\s\S]*?\}/);
    expect(code).toMatch(/export\s*\{[^}]*\bFALLBACK_PRODUCER\b[\s\S]*?\}/);
  });
});

// =====================================================================
// 1. ADDITIVE, CODE-ONLY — two source modules, no schema, no DDL.
// =====================================================================

describe("receptionist reply drafting — it is additive, code-only", () => {
  it("neither module contains any SQL DDL — R13 changes no schema, no substrate, no read model", () => {
    for (const file of [PURE, SEAM]) {
      const code = codeOf(read(file));
      expect(code, `${file} must create no relation`).not.toMatch(
        /create\s+(or\s+replace\s+)?(table|view|materialized\s+view|function|trigger|policy)/i,
      );
      expect(code, `${file} must alter nothing`).not.toMatch(/alter\s+table/i);
      expect(code, `${file} must drop nothing`).not.toMatch(/drop\s+(table|view|function|column)/i);
    }
  });
});

// =====================================================================
// 2. DRAFT ONLY FROM THE CANONICAL R12 CONTEXT — the headline consumption invariant.
// =====================================================================

describe("receptionist reply drafting — every draft is built from the canonical R12 context ONLY", () => {
  it("the engine's ONLY conversation input is the R12 server seam's getConversationContext", () => {
    const code = codeOf(read(ENGINE));
    expect(importSpecifiers(code), "consumes the canonical R12 seam").toContain(
      "@/server/services/receptionist-conversation-context",
    );
    expect(code, "and calls its org-scoped fetch").toMatch(/\bgetConversationContext\s*\(/);
  });

  it("the engine NEVER reconstructs or assembles context itself — it folds what R12 produced", () => {
    const code = codeOf(read(ENGINE));
    const imports = importSpecifiers(code);
    // It does not reach the R11 read model…
    expect(imports, "must not import the R11 read service").not.toContain(
      "@/server/services/receptionist-conversation-reads",
    );
    expect(code, "must not reconstruct a conversation").not.toMatch(/\breconstructConversation\b/);
    // …nor the pure R12 assembler — the context arrives already assembled, through the seam.
    expect(code, "must not assemble context").not.toMatch(/\bassembleConversationContext\b/);
    expect(imports, "must not import the pure assembler module").not.toContain(CONTEXT_TYPE);
  });

  it("no drafting module reads a substrate table or a read-model view — reconstruction stays R11's job", () => {
    for (const file of [PURE, SEAM, ENGINE_CORE, ENGINE]) {
      const code = codeOf(read(file));
      expect(code, `${file} must not read the timeline view`).not.toMatch(
        /\breceptionist_conversation_timeline\b/,
      );
      expect(code, `${file} must not read the list view`).not.toMatch(
        /\breceptionist_conversation_list\b/,
      );
      expect(code, `${file} must touch no conversation substrate table`).not.toMatch(
        /\breceptionist_conversations\b|\breceptionist_messages\b/,
      );
      expect(code, `${file} must not read raw enquiries`).not.toMatch(/\binbound_enquiries\b/);
    }
  });

  it("the pure builder consumes the R12 context TYPE and nothing else — a type-only dependency", () => {
    const raw = read(PURE);
    expect(importSpecifiers(codeOf(raw)), "exactly one import: the R12 context type").toEqual([
      CONTEXT_TYPE,
    ]);
    // And it is a TYPE import — the pure builder folds the shape, never runtime context machinery.
    expect(raw).toMatch(
      /import\s+type\s*\{[^}]*ConversationContext[^}]*\}\s*from\s*["']@\/lib\/receptionist\/conversation-context["']/,
    );
  });
});

// =====================================================================
// 3. MODEL ONLY THROUGH THE ABSTRACTION — the headline model-access invariant.
// =====================================================================

describe("receptionist reply drafting — the model is reached ONLY through the existing abstraction", () => {
  it("the engine's ONLY model door is getTextProvider from lib/ai/text", () => {
    const code = codeOf(read(ENGINE));
    expect(importSpecifiers(code), "reaches the model through the house abstraction").toContain(
      TEXT_ABSTRACTION,
    );
    expect(code).toMatch(/\bgetTextProvider\s*\(/);
  });

  it("no drafting module imports a vendor SDK or names a vendor entry point", () => {
    for (const file of [ENGINE, ENGINE_CORE, SEAM]) {
      const code = codeOf(read(file));
      const imports = importSpecifiers(code);
      for (const banned of ["@anthropic-ai/sdk", "openai", "@/lib/ai/llm", "@/lib/ai/embeddings"]) {
        expect(imports, `${file} must not import ${banned}`).not.toContain(banned);
      }
      expect(code, `${file}: no direct Anthropic client`).not.toMatch(/new\s+Anthropic\b/);
      expect(code, `${file}: no direct OpenAI client`).not.toMatch(/new\s+OpenAI\b/);
      expect(code, `${file}: no vendor message call`).not.toMatch(/\.messages\.create\b/);
      expect(code, `${file}: no vendor chat call`).not.toMatch(/\.chat\.completions\b/);
      expect(code, `${file}: no embedding call`).not.toMatch(
        /\b(?:createEmbedding|embedText|embedMany)\b/,
      );
    }
  });

  it("the model edge is BOUNDED — temperature 0 and a capped output", () => {
    // The bound is DEFINED in the pure engine core: temperature pinned to 0, the cap defaulting to R13's constant.
    const core = codeOf(read(ENGINE_CORE));
    expect(core, "bounded determinism: temperature pinned to 0").toMatch(
      /GENERATION_TEMPERATURE\s*=\s*0\b/,
    );
    expect(core, "the cap defaults to the pure module's constant").toMatch(
      /\bDEFAULT_REPLY_DRAFT_MAX_TOKENS\b/,
    );
    // The server runtime applies EXACTLY that prepared instruction at the model door — nothing re-chosen.
    const engine = codeOf(read(ENGINE));
    expect(engine, "temperature from the prepared instruction").toMatch(
      /temperature:\s*instruction\.temperature\b/,
    );
    expect(engine, "maxTokens from the prepared instruction").toMatch(
      /maxTokens:\s*instruction\.max_tokens\b/,
    );
  });

  it("the pure builder invokes NO model — it only constructs the ask", () => {
    const code = codeOf(read(PURE));
    const imports = importSpecifiers(code);
    for (const banned of [
      "@anthropic-ai/sdk",
      "openai",
      TEXT_ABSTRACTION,
      "@/lib/ai/llm",
      "@/lib/ai/embeddings",
      "@/lib/ai",
    ]) {
      expect(imports, `${PURE} must not import ${banned}`).not.toContain(banned);
    }
    expect(code).not.toMatch(/\bgetTextProvider\b/);
    expect(code).not.toMatch(/\.messages\.create\b/);
    expect(code).not.toMatch(/\b(?:generateText|streamText|generateObject)\b/);
  });
});

// =====================================================================
// 4. THE GENERATOR GENERATES ONLY — it enforces, audits, transports nothing.
// =====================================================================

describe("receptionist reply drafting — the generator generates only (no bypass)", () => {
  it("neither the seam nor the engine names any policy — they decide no verdict", () => {
    for (const file of [SEAM, ENGINE]) {
      const code = codeOf(read(file));
      expect(importSpecifiers(code), `${file} must not import the policy`).not.toContain(
        "@/lib/receptionist/policy",
      );
      expect(code).not.toMatch(/\b(?:evaluateReply|isAutoSendable|enforceReceptionistReply)\b/);
    }
  });

  it("neither the seam nor the engine names an audit primitive or the audit seam — they record no attempt", () => {
    for (const file of [SEAM, ENGINE]) {
      const code = codeOf(read(file));
      expect(code).not.toMatch(/\brecord_ai_reply_audit\b/);
      expect(code).not.toMatch(/\benforceAndAuditReply\b/);
    }
  });

  it("neither the seam nor the engine names a transport primitive, transport function, or comms door — they send nothing", () => {
    for (const file of [SEAM, ENGINE]) {
      const code = codeOf(read(file));
      expect(importSpecifiers(code), `${file} must not import comms`).not.toContain("@/lib/comms");
      expect(code).not.toMatch(/\brecord_ai_reply_transport\b/);
      expect(code).not.toMatch(/\b(?:transportReply|dispatchReply|dispatchReceptionistReply)\b/);
      expect(code).not.toMatch(/\bgetSmsProvider\b/);
      expect(code).not.toMatch(/\.send\s*\(/);
    }
  });

  it("neither the seam nor the engine writes ANYTHING — no mutating query verb, no RPC", () => {
    for (const file of [SEAM, ENGINE]) {
      const code = codeOf(read(file));
      expect(code).not.toMatch(/\.insert\s*\(/);
      expect(code).not.toMatch(/\.update\s*\(/);
      expect(code).not.toMatch(/\.delete\s*\(/);
      expect(code).not.toMatch(/\.upsert\s*\(/);
      expect(code).not.toMatch(/\.rpc\b/);
      expect(code).not.toMatch(/createAdminClient\b/);
    }
  });
});

// =====================================================================
// 5. THE PIPELINE WELD IS PRESERVED — the canonical service routes the generated draft
//    through the UNCHANGED Enforce → Audit → (deny-by-default) → Transport.
// =====================================================================

describe("receptionist reply drafting — the canonical service welds the generated draft into the unchanged pipeline", () => {
  it("the service consumes the R13 generator seam", () => {
    expect(importSpecifiers(codeOf(read(SERVICE)))).toContain(
      "@/server/services/receptionist-draft",
    );
  });

  it("the INTERNAL path GENERATES then hands the draft to the mandatory enforce+audit seam", () => {
    const code = codeOf(read(SERVICE));
    // produceAndEnforceReply: generateReplyDraft(...) → enforceAndAuditReply(...).
    expect(code).toMatch(/generateReplyDraft\([\s\S]{0,400}enforceAndAuditReply\(/);
    // The generated draft's provenance is folded into the audit metadata (HOW it was drafted).
    expect(code).toMatch(/\bdraftProvenance\s*\(/);
  });

  it("the OUTBOUND path GENERATES then hands the draft to dispatchReply (Enforce → Audit → Transport)", () => {
    const code = codeOf(read(SERVICE));
    expect(code).toMatch(/generateReplyDraft\([\s\S]{0,400}dispatchReply\(/);
  });

  it("the deny-by-default gate and the mandatory audit are UNCHANGED — R13 weakened neither", () => {
    const code = codeOf(read(SERVICE));
    // The R5 gate: only a clean allow is carried past the audit to a transport.
    expect(code, "deny-by-default gate intact").toMatch(/if\s*\(\s*!\s*outcome\.decision\.allowed/);
    // The R4 mandatory audit primitive is still the one door to the ledger, inside the service.
    expect(code, "mandatory audit intact").toMatch(/\brecord_ai_reply_audit\b/);
    // A transport is only ever reached from dispatchReply, after the audit — the weld R5 proved.
    expect(code).toMatch(/enforceAndAuditReply[\s\S]{0,1200}transportReply\(/);
  });

  it("the service no longer reaches the RAW composer directly — the old path was replaced, not doubled", () => {
    const code = codeOf(read(SERVICE));
    // The fixed acknowledgement is now reachable ONLY through the generator's fallback, never
    // composed directly by the pipeline: exactly one draft source remains.
    expect(importSpecifiers(code), "the service must not import the raw reply composer").not.toContain(
      "@/lib/receptionist/reply",
    );
    expect(code).not.toMatch(/\bcomposeReceptionistReply\b/);
  });
});

// =====================================================================
// 6. SINGLE DRAFT PATH — drafting lives in exactly one seam, reached one way.
// =====================================================================

describe("receptionist reply drafting — drafting lives in exactly one seam", () => {
  it("generateReplyDraft is DEFINED in exactly one source module (the seam)", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export async function generateReplyDraft\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([SEAM]);
  });

  it("generateReplyDraft is REFERENCED only by the seam + the canonical service across all source", () => {
    const referers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bgenerateReplyDraft\s*\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // If this list grows, a feature has drafted a reply some other way — exactly what the directive
    // forbids ("it must remain a draft generator only", consumed through the one canonical pipeline).
    expect(referers).toEqual([SEAM, SERVICE].sort());
  });

  it("buildReplyPrompt is DEFINED in exactly one module and REFERENCED only by the builder + the engine core", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function buildReplyPrompt\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([PURE]);
    // Under R25 the ONE consumer of R13's prompt builder is the engine core's spec consumption
    // (prepareGenerationInstruction). The seam no longer builds the prompt — it delegates to the engine.
    const referers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bbuildReplyPrompt\s*\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(referers).toEqual([PURE, ENGINE_CORE].sort());
  });
});

// =====================================================================
// 7. CORRECT LAYERING — the seam is server-only; the pure builder is not, and is truly pure.
// =====================================================================

describe("receptionist reply drafting — correct layering, and the builder is truly pure", () => {
  it("the server seam is a server-only module", () => {
    expect(importSpecifiers(codeOf(read(SEAM)))).toContain("server-only");
  });

  it("the pure builder is NOT server-only — it stays client/server-safe", () => {
    expect(importSpecifiers(codeOf(read(PURE)))).not.toContain("server-only");
  });

  it("the pure builder does ZERO I/O — no db client, no fetch", () => {
    const code = codeOf(read(PURE));
    expect(importSpecifiers(code).some((s) => /supabase/i.test(s)), "no supabase client").toBe(false);
    expect(code).not.toMatch(/createAdminClient|createClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("the pure builder is DETERMINISTIC — no clock, no RNG (deterministic input assembly)", () => {
    const code = codeOf(read(PURE));
    expect(code, "no clock").not.toMatch(/\bDate\.now\s*\(|\bnew\s+Date\s*\(/);
    expect(code, "no RNG").not.toMatch(/\bMath\.random\s*\(|\bcrypto\.randomUUID\s*\(/);
  });

  it("the pure builder mutates nothing — no query verb", () => {
    const code = codeOf(read(PURE));
    expect(code).not.toMatch(/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.rpc\b/);
  });
});

// =====================================================================
// 8. FALLBACK PRESERVED — the deterministic acknowledgement R4 shipped is retained, in text and provenance.
// =====================================================================

describe("receptionist reply drafting — the deterministic fallback is the pre-R13 reply", () => {
  it("the engine core imports the R4 acknowledgement composer as its deterministic fallback", () => {
    expect(importSpecifiers(codeOf(read(ENGINE_CORE))), "the fallback is the R4 composer").toContain(
      "@/lib/receptionist/reply",
    );
    expect(codeOf(read(ENGINE_CORE))).toMatch(/\bcomposeReceptionistReply\s*\(/);
  });

  it("the fallback's producer label is the pre-R13 audit producer — identical in provenance too", () => {
    expect(codeOf(read(ENGINE_CORE))).toMatch(
      /FALLBACK_PRODUCER\s*=\s*["']deterministic_acknowledgement["']/,
    );
  });

  it("the R4 composer it falls back to is an unmodified companion module, not an R13 file", () => {
    // R13 is additive: it consumes the R4 reply by import, so that module must still exist as its
    // own file (R13 folded neither the composer nor the read model into itself).
    expect(existsSync(resolve(ROOT, REPLY)), REPLY).toBe(true);
    expect(existsSync(resolve(ROOT, CONTEXT_SEAM)), CONTEXT_SEAM).toBe(true);
    expect(existsSync(resolve(ROOT, READS)), READS).toBe(true);
  });
});

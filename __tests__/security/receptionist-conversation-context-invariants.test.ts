import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

/**
 * Voice Receptionist AI — conversation context ASSEMBLY invariants
 * (the AI Receptionist Programme, R12 — CONVERSATION CONTEXT ASSEMBLY).
 *
 * R11 built the canonical READ model (reconstructConversation). R12 is the canonical ASSEMBLY
 * layer above it — the pure, deterministic transform (lib/receptionist/conversation-context.ts)
 * plus its org-scoped server seam (server/services/receptionist-conversation-context.ts) that turns
 * a reconstructed conversation into a MODEL-READY context object. The cardinal safety property is
 * that it is ASSEMBLY, NOT GENERATION: it invokes NO model, it is additive and read-only, it reuses
 * R11's reconstruction + the memory layer's tokeniser rather than re-deriving them, and it is the
 * SINGLE assembly path — no feature may assemble conversation context any other way. This suite
 * proves that contract as a matter of SOURCE, not discipline — the house bar of the R9/R10/R11
 * invariant suites:
 *
 *   • ADDITIVE, CODE-ONLY — R12 ships two source modules and NO migration; neither module contains
 *     any SQL DDL. It changes no substrate, no read model, no schema.
 *   • NO MUTATION — the pure assembler does ZERO I/O (no server-only, no db client, no fetch); the
 *     seam names no write primitive and calls no vendor; neither uses a mutating query verb.
 *   • NO MODEL (the headline) — neither module imports an LLM/embeddings SDK or the model seam, and
 *     neither names a generation/embedding entry point. The layer assembles; it never generates.
 *   • REUSES R11 + THE MEMORY TOKENISER, DUPLICATES NOTHING — the assembler imports estimateTokens
 *     from the memory layer (defining none of its own); the seam reconstructs THROUGH R11's
 *     reconstructConversation and never re-reads the read-model views.
 *   • SINGLE ASSEMBLY PATH — assembleConversationContext is defined in exactly one module and
 *     referenced only by that module + its seam across all source.
 *   • CORRECT LAYERING — the seam is server-only; the pure assembler is NOT (it stays
 *     client/server-safe), so the assembly transform can be reasoned about in isolation.
 *   • BEHAVIOUR UNCHANGED — neither module imports the reply producer, the policy, comms, or the
 *     inbound pipeline; R12 adds a new read-side path and touches no existing receptionist behaviour.
 *
 * The assembly layer's runtime behaviour (deterministic byte-identical assembly; faithful role/text
 * projection; verbatim metadata; deterministic truncation; org isolation; no mutation) is pinned
 * against real Postgres in __tests__/integration/receptionist/conversation-context.test.ts, and the
 * pure fold in __tests__/receptionist/conversation-context.test.ts. This tier is HERMETIC — a
 * filesystem scan over comment-stripped source — so the prose documenting the contract can neither
 * satisfy a positive match nor trip a negative.
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

const PURE = "lib/receptionist/conversation-context.ts";
const SEAM = "server/services/receptionist-conversation-context.ts";
const READS = "server/services/receptionist-conversation-reads.ts";
const RETRIEVAL = "lib/memory/retrieval.ts";

const SOURCE_ROOTS = ["app", "server", "lib"] as const;

// =====================================================================
// 0. The assembly layer ships — pure transform + server seam.
// =====================================================================

describe("receptionist conversation context — the assembly layer ships", () => {
  it(`ships the pure assembler ${PURE}`, () => {
    expect(existsSync(resolve(ROOT, PURE)), PURE).toBe(true);
  });

  it(`ships the server seam ${SEAM}`, () => {
    expect(existsSync(resolve(ROOT, SEAM)), SEAM).toBe(true);
  });

  it("the pure assembler exports the assemble + role + text-resolution seams", () => {
    const code = codeOf(read(PURE));
    expect(code).toMatch(/export function assembleConversationContext\(/);
    expect(code).toMatch(/export function roleOf\(/);
    expect(code).toMatch(/export function resolveEventText\(/);
  });

  it("the server seam exports the org-scoped getConversationContext entry point", () => {
    expect(codeOf(read(SEAM))).toMatch(/export async function getConversationContext\(/);
  });
});

// =====================================================================
// 1. ADDITIVE, CODE-ONLY — two source modules, no schema, no DDL.
// =====================================================================

describe("receptionist conversation context — it is additive, code-only", () => {
  it("neither module contains any SQL DDL — R12 changes no schema, no substrate, no read model", () => {
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
// 2. NO MUTATION — the assembler is a pure projection; the seam only reads.
// =====================================================================

describe("receptionist conversation context — it performs no mutation", () => {
  it("neither module uses a mutating query verb (insert/update/delete/upsert/rpc)", () => {
    for (const file of [PURE, SEAM]) {
      const code = codeOf(read(file));
      expect(code, `${file}`).not.toMatch(/\.insert\s*\(/);
      expect(code, `${file}`).not.toMatch(/\.update\s*\(/);
      expect(code, `${file}`).not.toMatch(/\.delete\s*\(/);
      expect(code, `${file}`).not.toMatch(/\.upsert\s*\(/);
      expect(code, `${file}`).not.toMatch(/\.rpc\b/);
    }
  });

  it("the pure assembler does ZERO I/O — no server-only, no db client, no fetch", () => {
    const code = codeOf(read(PURE));
    const imports = importSpecifiers(code);
    expect(imports, "the pure lib must not be server-only").not.toContain("server-only");
    expect(imports.some((s) => /supabase/i.test(s)), "no supabase client").toBe(false);
    expect(code).not.toMatch(/createAdminClient|createClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it("the seam names no write primitive and calls no vendor — it reconstructs and assembles only", () => {
    const code = codeOf(read(SEAM));
    expect(code).not.toMatch(/record_ai_reply_audit|record_ai_reply_transport|record_ai_reply_delivery_receipt/);
    expect(code).not.toMatch(/\b(?:resolve_receptionist_conversation|append_receptionist_message)\b/);
    expect(code).not.toMatch(/\b(?:dispatchReply|dispatchReceptionistReply|getSmsProvider)\b/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\.send\s*\(/);
  });
});

// =====================================================================
// 3. NO MODEL — the headline: the assembly layer invokes no LLM (assembly, not generation).
// =====================================================================

describe("receptionist conversation context — it invokes no AI model", () => {
  it("neither module imports an LLM/embeddings SDK or the model seam", () => {
    for (const file of [PURE, SEAM]) {
      const imports = importSpecifiers(codeOf(read(file)));
      for (const banned of [
        "@anthropic-ai/sdk",
        "openai",
        "@/lib/ai/text",
        "@/lib/ai/llm",
        "@/lib/ai/embeddings",
        "@/lib/ai",
      ]) {
        expect(imports, `${file} must not import ${banned}`).not.toContain(banned);
      }
    }
  });

  it("neither module names a generation or embedding entry point", () => {
    for (const file of [PURE, SEAM]) {
      const code = codeOf(read(file));
      expect(code, `${file}`).not.toMatch(/\bgetTextProvider\b/);
      expect(code, `${file}`).not.toMatch(/\b(?:generateText|streamText|generateObject)\b/);
      expect(code, `${file}`).not.toMatch(/\.messages\.create\b/);
      expect(code, `${file}`).not.toMatch(/\b(?:createEmbedding|embedText|embedMany)\b/);
    }
  });
});

// =====================================================================
// 4. REUSES R11 + THE MEMORY TOKENISER — duplicates nothing.
// =====================================================================

describe("receptionist conversation context — it reuses R11 + the memory tokeniser", () => {
  it("the assembler reuses estimateTokens from the memory layer and defines no tokeniser of its own", () => {
    const code = codeOf(read(PURE));
    expect(importSpecifiers(code)).toContain("@/lib/memory/retrieval");
    expect(code).toMatch(/\bestimateTokens\s*\(/); // it CALLS the reused primitive
    expect(code, "must not re-derive a tokeniser").not.toMatch(/function\s+estimateTokens\b/);
  });

  it("the seam reconstructs THROUGH R11 and applies the pure assembler — composing, not forking", () => {
    const code = codeOf(read(SEAM));
    const imports = importSpecifiers(code);
    expect(imports).toContain("@/server/services/receptionist-conversation-reads");
    expect(imports).toContain("@/lib/receptionist/conversation-context");
    expect(code).toMatch(/\breconstructConversation\s*\(/);
    expect(code).toMatch(/\bassembleConversationContext\s*\(/);
  });

  it("neither module re-reads the R11 read-model views — reconstruction stays R11's single job", () => {
    for (const file of [PURE, SEAM]) {
      const code = codeOf(read(file));
      expect(code, `${file} must not read the timeline view`).not.toMatch(
        /\breceptionist_conversation_timeline\b/,
      );
      expect(code, `${file} must not read the list view`).not.toMatch(
        /\breceptionist_conversation_list\b/,
      );
    }
  });
});

// =====================================================================
// 5. SINGLE ASSEMBLY PATH — assembly lives in exactly one module.
// =====================================================================

describe("receptionist conversation context — assembly lives in exactly one module", () => {
  it("assembleConversationContext is DEFINED in exactly one source module", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export function assembleConversationContext\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([PURE]);
  });

  it("assembleConversationContext is REFERENCED only by the assembler + its seam across all source", () => {
    const referers = walkSources(SOURCE_ROOTS)
      .filter((full) => /\bassembleConversationContext\s*\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    // If this list grows, a feature has assembled context some other way — exactly what the
    // directive forbids ("no feature may assemble context independently").
    expect(referers).toEqual([PURE, SEAM].sort());
  });

  it("getConversationContext is defined in exactly one source module (the seam)", () => {
    const definers = walkSources(SOURCE_ROOTS)
      .filter((full) => /export async function getConversationContext\(/.test(codeOf(read(rel(full)))))
      .map(rel)
      .sort();
    expect(definers).toEqual([SEAM]);
  });
});

// =====================================================================
// 6. CORRECT LAYERING — the seam is server-only, the pure assembler is not.
// =====================================================================

describe("receptionist conversation context — correct layering", () => {
  it("the server seam is a server-only module", () => {
    expect(importSpecifiers(codeOf(read(SEAM)))).toContain("server-only");
  });

  it("the pure assembler is NOT server-only — it stays client/server-safe", () => {
    expect(importSpecifiers(codeOf(read(PURE)))).not.toContain("server-only");
  });
});

// =====================================================================
// 7. BEHAVIOUR UNCHANGED — the assembly layer does not touch the reply pipeline.
// =====================================================================

describe("receptionist conversation context — it does not touch the reply pipeline", () => {
  it("neither module imports the reply producer, the policy, comms, or the inbound pipeline", () => {
    for (const file of [PURE, SEAM]) {
      const imports = importSpecifiers(codeOf(read(file)));
      expect(imports, `${file}`).not.toContain("@/lib/receptionist/reply");
      expect(imports, `${file}`).not.toContain("@/lib/receptionist/policy");
      expect(imports, `${file}`).not.toContain("@/lib/comms");
      expect(imports, `${file}`).not.toContain("@/server/services/receptionist");
    }
  });

  it("the read model + the memory tokeniser it reuses are unmodified companions, not R12 files", () => {
    // R12 is additive: it consumes R11's read service and the memory tokeniser by import, so both
    // must still exist as their own modules (R12 forked neither into itself).
    expect(existsSync(resolve(ROOT, READS)), READS).toBe(true);
    expect(existsSync(resolve(ROOT, RETRIEVAL)), RETRIEVAL).toBe(true);
  });
});

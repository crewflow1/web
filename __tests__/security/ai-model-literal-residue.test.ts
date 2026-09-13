import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MODEL-LITERAL RESIDUE — removed 2026-09-13, and pinned so it stays removed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 2026-09-13 census found the last places a MODEL LITERAL could still
 * reach an API call: two transport constructors that DEFAULTED their `model`
 * parameter to a hard-coded id, and four `TIER_MODEL.x?.model ?? "literal"`
 * fallbacks. Every one was documented "inert / impossible null case" — but an
 * inert literal is one refactor away from running, and a model the registry
 * never named must be structurally unrunnable, not merely commented as such.
 *
 * The shape now, pinned per file below:
 *
 *   • TRANSPORTS take `model` as a REQUIRED argument. Only a factory holding a
 *     tier binding can name a model; forgetting one is a compile error (the
 *     compile-level halves live in __tests__/memory/text-provider.test.ts).
 *
 *   • SELF-SDK SERVICE LEGS read their tier's binding HARD: null ⇒ each file's
 *     OWN degradation idiom (throw into the governed leg's failure settlement
 *     for lead-summary/receptionist; `usage: null` claim-release for
 *     research-llm). Never a substitute model.
 *
 *   • The embeddings transport is the ONE deliberate pinned literal left, and
 *     it is pinned AGAINST the binding (double-lock: the factory refuses on
 *     mismatch, and __tests__/memory/embedding-provider.test.ts fails on
 *     drift) — so a drive-by registry rebind goes dark instead of being
 *     silently followed.
 *
 * All pins run over comment-stripped code, so prose documenting the removal
 * can neither satisfy nor trip them.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block and line comments. Prose must not satisfy or trip a pin. */
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** A `?? "<model-ish literal>"` fallback — the residue class this wave removed. */
const MODEL_LITERAL_FALLBACK = /\?\?\s*["'`](?:claude-|gpt-|text-embedding-|gemini|mistral|llama)/;

const TOUCHED = [
  "lib/ai/text/anthropic.ts",
  "lib/ai/text/openai.ts",
  "lib/ai/vision/anthropic.ts",
  "lib/ai/embeddings/openai.ts",
  "server/services/lead-summary.ts",
  "server/services/receptionist.ts",
  "server/services/research-llm.ts",
] as const;

describe("no model-literal fallback survives in any touched file", () => {
  for (const file of TOUCHED) {
    it(`${file} contains no \`?? "model-literal"\` fallback`, () => {
      expect(codeOf(read(file))).not.toMatch(MODEL_LITERAL_FALLBACK);
    });
  }
});

describe("transports carry NO default model — the binding is the only namer", () => {
  const TRANSPORTS = [
    ["lib/ai/text/anthropic.ts", /createAnthropicTextProvider\(apiKey: string, model: string\)/],
    ["lib/ai/text/openai.ts", /createOpenAiTextProvider\(apiKey: string, model: string\)/],
    ["lib/ai/vision/anthropic.ts", /createAnthropicVisionProvider\(apiKey: string, model: string\)/],
  ] as const;

  for (const [file, signature] of TRANSPORTS) {
    it(`${file} requires model (no DEFAULT_MODEL const, no parameter default)`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(signature);
      expect(code).not.toMatch(/DEFAULT_MODEL/);
      expect(code).not.toMatch(/model:\s*string\s*=/);
    });
  }

  it("the vision transport no longer reads TIER_MODEL — it is pure transport behind the door", () => {
    // The door (lib/ai/vision/index.ts) resolves the cheap binding and passes
    // binding.model; the transport resolving it AGAIN was the duplication that
    // carried the literal fallback.
    expect(codeOf(read("lib/ai/vision/anthropic.ts"))).not.toMatch(/TIER_MODEL/);
  });
});

describe("self-SDK service legs HARD-READ their binding and refuse on null", () => {
  it("lead-summary throws on a null cheap binding (its leg's failure idiom)", () => {
    const code = codeOf(read("server/services/lead-summary.ts"));
    expect(code).toMatch(/const binding = TIER_MODEL\.cheap;/);
    expect(code).toMatch(/cheap tier binding missing — refusing unbound model call/);
    expect(code).toMatch(/const model = binding\.model;/);
  });

  it("receptionist throws on a null cheap binding (its leg's failure idiom)", () => {
    const code = codeOf(read("server/services/receptionist.ts"));
    expect(code).toMatch(/const binding = TIER_MODEL\.cheap;/);
    expect(code).toMatch(/cheap tier binding missing — refusing unbound model call/);
  });

  it("research-llm releases the claim on a null high binding (usage: null idiom)", () => {
    const code = codeOf(read("server/services/research-llm.ts"));
    expect(code).toMatch(/const binding = TIER_MODEL\.high;/);
    expect(code).toMatch(/if \(!binding\) return \{ value: null, usage: null \};/);
    // The module-scope resolved const is gone: the model is read inside the
    // governed leg, after the gate, never at import time.
    expect(code).not.toMatch(/const ANTHROPIC_MODEL/);
  });
});

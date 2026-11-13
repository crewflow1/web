import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import {
  AI_FEATURES,
  TASK_CLASS_TIER,
  TIER_MODEL,
  type AiTier,
} from "@/lib/ai/governor/registry";

/**
 * THE RESERVATION ENVELOPE RATCHET.
 *
 * The atomic budget gate admits a call on a CLAIM — the tier binding's
 * worst-case token envelope, priced. docs/ai-cost-governor.md states the one
 * residue plainly: the ceiling holds exactly while each call's true cost is no
 * greater than the claim it was admitted on.
 *
 * That residue stopped being an edge the day a call site's output cap was raised
 * past its tier's envelope: #1070 took the quote writer from 2,000 to 4,000
 * output tokens and left `TIER_MODEL.mid.reserveOutputTokens` at 2,000, with a
 * comment saying "the governor's mid-tier envelope still caps spend". It does
 * not — the envelope is the CLAIM, not a cap. Every quote draft was thereafter
 * admitted on a claim smaller than its own worst case.
 *
 * So the relationship is now derived from SOURCE TEXT:
 *
 *   for every governed GENERATIVE call site, the largest output-token cap it can
 *   request  <=  the reserveOutputTokens of the tier its feature runs on.
 *
 * and the table is closed: a NEW file that calls invokeWithGovernor fails this
 * test until it is added here with its tier, so a cap can never again be raised
 * (or a call site added) without the envelope being looked at in the same diff.
 *
 * Embedding and transcription sites are exempt BY NAME — they bill input only
 * (reserveOutputTokens is 0 by definition) and carry their own input clamps.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Every numeric output-token cap that appears in a source file. */
function outputCaps(src: string): number[] {
  const caps: number[] = [];
  const num = (raw: string) => Number(raw.replace(/_/g, ""));
  const patterns: RegExp[] = [
    // maxTokens: 200  /  max_tokens: 400
    /\bmax_?[tT]okens\s*:\s*([0-9][0-9_]*)\b/g,
    // const ANSWER_MAX_TOKENS = 800 / MAX_OUTPUT_TOKENS = 4_000 / DEFAULT_MAX_TOKENS = 700
    /\b[A-Z_]*MAX_(?:OUTPUT_)?TOKENS\s*=\s*([0-9][0-9_]*)\b/g,
    // research: callJson("research.sales_prep", system, user, 3200)
    /\bcallJson\(\s*"[a-z_.]+"\s*,\s*\w+\s*,\s*\w+\s*,\s*([0-9][0-9_]*)\s*\)/g,
  ];
  for (const rx of patterns) {
    for (const m of src.matchAll(rx)) caps.push(num(m[1]!));
  }
  return caps;
}

/**
 * Governed GENERATIVE call sites → the tier they run on, plus any sibling file
 * that actually holds the numeric cap. `tier` is cross-checked against the
 * registry below, so this table cannot drift from the features it describes.
 */
const SITES: ReadonlyArray<{ file: string; tier: AiTier; features: string[]; capFiles?: string[] }> =
  [
    // ── mid (drafting) ──
    { file: "server/services/ai-question.ts", tier: "mid", features: ["insights.question"] },
    { file: "lib/ai/insight-narrative.ts", tier: "mid", features: ["insights.narrative"] },
    { file: "server/services/ai-quote-writer.ts", tier: "mid", features: ["quote.writer_draft"] },
    { file: "server/services/chat-auto-reply.ts", tier: "mid", features: ["chat.auto_reply"] },
    {
      file: "server/services/receptionist-generation.ts",
      tier: "mid",
      features: ["receptionist.reply_draft"],
      capFiles: ["lib/receptionist/draft.ts"],
    },
    { file: "lib/telephony/ai-turn.ts", tier: "mid", features: ["receptionist.voice_turn"] },
    { file: "server/services/hq-drafts.ts", tier: "mid", features: ["hq.draft"] },
    { file: "server/services/hq-generative-seams.ts", tier: "mid", features: [] },
    { file: "server/services/hq-narrative.ts", tier: "mid", features: [] },
    { file: "server/services/hq-support-ai.ts", tier: "mid", features: ["hq.draft"] },
    // ── cheap (classification) ──
    { file: "lib/imports/ocr.ts", tier: "cheap", features: ["imports.ocr"] },
    { file: "lib/imports/autofill/extract.ts", tier: "cheap", features: ["document.form_autofill"] },
    {
      file: "server/services/expense-drafts.ts",
      tier: "cheap",
      features: ["expense.receipt_extraction"],
    },
    { file: "server/services/lead-summary.ts", tier: "cheap", features: ["lead.summary"] },
    {
      file: "server/services/receptionist.ts",
      tier: "cheap",
      features: ["receptionist.inbound_extraction"],
    },
    {
      // No explicit cap at the call site: it inherits the text door's default.
      file: "server/services/memory-lifecycle.ts",
      tier: "cheap",
      features: ["memory.summarise"],
      capFiles: ["lib/ai/text/anthropic.ts", "lib/ai/text/openai.ts"],
    },
    // ── high (complex) ──
    {
      file: "server/services/site-manager/orchestrator.ts",
      tier: "high",
      features: ["site_manager.answer"],
    },
    { file: "server/services/research-llm.ts", tier: "high", features: [] },
    { file: "lib/hq/workflow/ai-decompose.ts", tier: "high", features: ["hq.saga_decomposition"] },
  ];

/** Input-only modalities: no output tokens to reserve. Exempt by name. */
const INPUT_ONLY_SITES = new Set(["lib/ai/embeddings/governed.ts", "lib/ai/transcription.ts"]);

function governedSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && /\binvokeWithGovernor(?:<[^>]*>)?\(/.test(readFileSync(full, "utf8"))) {
        out.push(relative(ROOT, full));
      }
    }
  };
  for (const root of ["app", "lib", "server"]) walk(resolve(ROOT, root));
  // The governor's own definition is not a call site.
  return out.filter((f) => f !== "lib/ai/governor.ts").sort();
}

describe("AI reservation envelope — the claim covers every call site's worst-case output", () => {
  it("the table is CLOSED: every file that calls invokeWithGovernor is classified here", () => {
    const classified = new Set([...SITES.map((s) => s.file), ...INPUT_ONLY_SITES]);
    const unclassified = governedSourceFiles().filter((f) => !classified.has(f));
    expect(
      unclassified,
      "a new governed call site must be added to SITES (with its tier) so its output cap is " +
        "checked against the tier's reservation envelope",
    ).toEqual([]);
    // …and nothing in the table has gone stale.
    const present = new Set(governedSourceFiles());
    expect([...classified].filter((f) => !present.has(f))).toEqual([]);
  });

  it("each site's declared tier is the tier the REGISTRY routes its features to", () => {
    for (const site of SITES) {
      for (const key of site.features) {
        const def = (AI_FEATURES as Record<string, { taskClass: keyof typeof TASK_CLASS_TIER }>)[key];
        expect(def, `${site.file}: feature "${key}" must exist in AI_FEATURES`).toBeTruthy();
        expect(TASK_CLASS_TIER[def!.taskClass], `${site.file}: ${key}`).toBe(site.tier);
        expect(read(site.file), `${site.file} must name its feature "${key}"`).toMatch(
          key === "quote.writer_draft" ? /QUOTE_WRITER_FEATURE/ : new RegExp(`"${key.replace(".", "\\.")}"`),
        );
      }
    }
  });

  it("no call site can request more output tokens than its tier reserves for", () => {
    const breaches: string[] = [];
    for (const site of SITES) {
      const binding = TIER_MODEL[site.tier];
      expect(binding, `${site.tier} is bound in this build`).not.toBeNull();
      const caps = [site.file, ...(site.capFiles ?? [])].flatMap((f) => outputCaps(read(f)));
      expect(
        caps.length,
        `${site.file}: no numeric output cap found — a governed generative call must state one ` +
          `(or name the file that does in capFiles)`,
      ).toBeGreaterThan(0);
      const worst = Math.max(...caps);
      if (worst > binding!.reserveOutputTokens) {
        breaches.push(
          `${site.file}: output cap ${worst} > ${site.tier} envelope ${binding!.reserveOutputTokens}`,
        );
      }
    }
    expect(
      breaches,
      "raise TIER_MODEL[tier].reserveOutputTokens in the SAME diff that raises a call site's cap — " +
        "the envelope is the budget CLAIM, and a claim smaller than the worst case under-reserves",
    ).toEqual([]);
  });

  it("the quote writer's cap is exactly what the mid envelope was sized to (the #1070 regression)", () => {
    const caps = outputCaps(read("server/services/ai-quote-writer.ts"));
    expect(Math.max(...caps)).toBe(4_000);
    expect(TIER_MODEL.mid!.reserveOutputTokens).toBeGreaterThanOrEqual(4_000);
  });

  it("the provider doors' DEFAULT output cap fits the smallest generative envelope", () => {
    // A call site that passes no cap inherits the door default; it must be
    // coverable by whichever generative tier resolved the provider.
    const smallest = Math.min(
      TIER_MODEL.cheap!.reserveOutputTokens,
      TIER_MODEL.mid!.reserveOutputTokens,
      TIER_MODEL.high!.reserveOutputTokens,
    );
    for (const door of ["lib/ai/text/anthropic.ts", "lib/ai/text/openai.ts", "lib/ai/vision/anthropic.ts"]) {
      const m = read(door).match(/const DEFAULT_MAX_TOKENS\s*=\s*([0-9_]+)/);
      expect(m, `${door} declares DEFAULT_MAX_TOKENS`).toBeTruthy();
      expect(Number(m![1]!.replace(/_/g, ""))).toBeLessThanOrEqual(smallest);
    }
  });

  it("every provider request in the build states an output cap (no unbounded generation)", () => {
    // Each SDK messages.create / chat.completions.create must carry max_tokens.
    const constructions: Array<{ file: string; call: RegExp }> = [
      { file: "lib/ai/text/anthropic.ts", call: /client\.messages\.create\(/ },
      { file: "lib/ai/text/openai.ts", call: /client\.chat\.completions\.create\(/ },
      { file: "lib/ai/vision/anthropic.ts", call: /client\.messages\.create\(/ },
      { file: "server/services/lead-summary.ts", call: /client\.messages\.create\(/ },
      { file: "server/services/receptionist.ts", call: /client\.messages\.create\(/ },
      { file: "server/services/research-llm.ts", call: /client\.messages\.create\(/ },
    ];
    for (const { file, call } of constructions) {
      const src = read(file);
      const at = src.search(call);
      expect(at, `${file} still constructs a provider request`).toBeGreaterThan(-1);
      // The cap must appear inside the request object that follows.
      expect(src.slice(at, at + 1600), `${file}: request must set max_tokens`).toMatch(/\bmax_tokens\s*:/);
    }
  });
});

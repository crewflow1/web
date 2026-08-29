import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P3 — Shared-Memory retrieval is CONSUMED by the runners, not discarded.
 *
 * The defect: hq-research.ts and hq-qualification.ts awaited
 * `recallForTask(...)` and threw the result away — the memory engine's read
 * side had no effect on any artifact. The fix threads the recall into each
 * runner's deterministic result:
 *
 *   • research  → `result.memory_context` (bounded recall summaries + a note
 *     saying the report is grounded in them);
 *   • qualification → `result.memory_context` PLUS the one documented
 *     deterministic adjustment: a recalled PRIOR-DECISION memory about the
 *     same company flags the run as a REPEAT EVALUATION (artifact + step
 *     detail + timeline metadata), without touching the rubric's arithmetic.
 *
 * Pinned here: the pure fold helpers (exact behaviour from fixtures) and —
 * source-level, comments stripped — that both runners now capture the recall
 * and assign it into their result artifact.
 */

// Import-safety: the qualification module graph pulls the runner SDK, which
// reaches for the embedding provider at import time.
vi.mock("@/lib/ai/embeddings", () => ({ getEmbeddingProvider: vi.fn() }));

import {
  memoryContextFromRecall,
  priorDecisionMemoryIds,
  MEMORY_CONTEXT_LIMIT,
  PRIOR_DECISION_MEMORY_TYPES,
} from "@/server/services/hq-runner-memory";
import { assessRecallForQualification } from "@/server/services/hq-qualification";
import type { RecallResult, RecalledMemory } from "@/server/sdk/memory";

function mem(over: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    id: "m-1",
    class: "episodic",
    type: "research_outcome",
    title: "Researched Acme Ltd",
    summary: "Research completed for Acme Ltd: 72/100 (Strong).",
    visibility: "public_hq",
    department: null,
    ownerEmployeeId: "emp-1",
    importance: "normal",
    salience: 60,
    pinned: false,
    score: 0.8,
    form: "summary",
    ...over,
  } as RecalledMemory;
}

function recallOf(items: RecalledMemory[]): RecallResult {
  return {
    context: { text: "", memoryCount: items.length, tokensUsed: 0, budget: 0 },
    items,
    manifest: {} as RecallResult["manifest"],
  };
}

const ROOT = resolve(__dirname, "..", "..");
const codeOf = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("memoryContextFromRecall — the artifact fold (pure)", () => {
  it("folds recalled items to bounded summaries + the note", () => {
    const ctx = memoryContextFromRecall(
      recallOf([mem(), mem({ id: "m-2", type: "qualification_decision" })]),
      "grounded the report",
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.note).toBe("grounded the report");
    expect(ctx!.recalled).toEqual([
      {
        id: "m-1",
        class: "episodic",
        type: "research_outcome",
        title: "Researched Acme Ltd",
        summary: "Research completed for Acme Ltd: 72/100 (Strong).",
      },
      {
        id: "m-2",
        class: "episodic",
        type: "qualification_decision",
        title: "Researched Acme Ltd",
        summary: "Research completed for Acme Ltd: 72/100 (Strong).",
      },
    ]);
  });

  it("null recall (capability-gated off / degraded) → null, an honest absence", () => {
    expect(memoryContextFromRecall(null, "n")).toBeNull();
  });

  it("empty recall → null (a section exists iff real memories informed the run)", () => {
    expect(memoryContextFromRecall(recallOf([]), "n")).toBeNull();
  });

  it("caps the artifact at MEMORY_CONTEXT_LIMIT summaries (relevance order kept)", () => {
    const many = Array.from({ length: MEMORY_CONTEXT_LIMIT + 3 }, (_, i) =>
      mem({ id: `m-${i}` }),
    );
    const ctx = memoryContextFromRecall(recallOf(many), "n")!;
    expect(ctx.recalled).toHaveLength(MEMORY_CONTEXT_LIMIT);
    expect(ctx.recalled[0]!.id).toBe("m-0");
  });
});

describe("priorDecisionMemoryIds — the repeat-evaluation detector (pure)", () => {
  it("recognises exactly the decision types", () => {
    expect([...PRIOR_DECISION_MEMORY_TYPES].sort()).toEqual([
      "decision",
      "qualification_decision",
    ]);
    const ids = priorDecisionMemoryIds(
      recallOf([
        mem({ id: "a", type: "research_outcome" }),
        mem({ id: "b", type: "qualification_decision" }),
        mem({ id: "c", type: "decision" }),
      ]),
    );
    expect(ids).toEqual(["b", "c"]);
  });

  it("null recall → no prior decisions", () => {
    expect(priorDecisionMemoryIds(null)).toEqual([]);
  });
});

describe("assessRecallForQualification — the documented deterministic adjustment", () => {
  it("a prior qualification decision about the company flags a REPEAT EVALUATION", () => {
    const ctx = assessRecallForQualification(
      recallOf([
        mem({ id: "d-1", type: "qualification_decision", title: "Qualified Acme: qualified" }),
        mem({ id: "r-1", type: "research_outcome" }),
      ]),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.repeatEvaluation).toBe(true);
    expect(ctx!.priorDecisionMemoryIds).toEqual(["d-1"]);
    expect(ctx!.note).toMatch(/repeat evaluation/i);
    expect(ctx!.recalled.map((m) => m.id)).toEqual(["d-1", "r-1"]);
  });

  it("recall with NO decision memory → context present, repeat flag false", () => {
    const ctx = assessRecallForQualification(recallOf([mem({ type: "research_outcome" })]));
    expect(ctx!.repeatEvaluation).toBe(false);
    expect(ctx!.priorDecisionMemoryIds).toEqual([]);
    expect(ctx!.note).not.toMatch(/repeat evaluation/i);
  });

  it("null/empty recall → null (lead-qualification holds no memory token today — honest no-op)", () => {
    expect(assessRecallForQualification(null)).toBeNull();
    expect(assessRecallForQualification(recallOf([]))).toBeNull();
  });
});

describe("the runners CONSUME the recall — source pins (comments stripped)", () => {
  it("hq-research captures the recall and assigns memory_context on the artifact", () => {
    const code = codeOf("server/services/hq-research.ts");
    expect(code).toMatch(/const recall = await recallForTask\(/);
    expect(code).toMatch(/result\.memory_context = memoryContextFromRecall\(\s*\n?\s*recall/);
    // The discard shape is gone: no bare awaited recall.
    expect(code).not.toMatch(/^\s*await recallForTask\(/m);
  });

  it("hq-qualification captures the recall, assigns memory_context, and applies the repeat flag", () => {
    const code = codeOf("server/services/hq-qualification.ts");
    expect(code).toMatch(/const recall = await recallForTask\(/);
    expect(code).toMatch(/result\.memory_context = assessRecallForQualification\(recall\)/);
    expect(code).not.toMatch(/^\s*await recallForTask\(/m);
    // The adjustment reaches the human-visible surfaces: the timeline metadata
    // and the decision step detail.
    expect(code).toMatch(/repeat_evaluation: repeatEvaluation/);
    expect(code).toMatch(/prior_decision_memories/);
    expect(code).toMatch(/repeat evaluation \(prior decision on record\)/);
  });
});

import "server-only";
import {
  employeeCanUseMemory,
  type MemoryCapabilityMode,
} from "@/lib/memory/model";
import type {
  BoundMemory,
  RecallOpts,
  RecallResult,
  RememberOpts,
} from "@/server/sdk/memory";
import type { ResolvedCapabilitySet } from "@/server/sdk/tasks";

/**
 * CrewFlow HQ — shared-memory wiring for the deterministic task runners
 * (CEO Directive: wire the shared-memory engine into the LIVE runners).
 *
 * The shared-memory engine (`hq_memories` + recall/write/consolidate/forget)
 * and its sanctioned SDK facet (`ctx.memory`, server/sdk/memory.ts) were built
 * and tested but had NO live AI caller: the deterministic runners never recalled
 * before acting or remembered after. This module is the ONE seam that closes
 * that — the two gated verbs every runner (research / qualification / outreach)
 * calls, so the wiring, the capability gate, and the degradation policy live in
 * exactly one place instead of being re-implemented three times.
 *
 * It adds NO new authority and NO raw table access: it calls the employee's own
 * bound `ctx.memory` facet (identity-stamped, permission-gated in SQL), and it
 * gates the CALL on the employee's resolved capability tokens FIRST — the
 * default-deny floor honoured one layer before the SQL boundary, so an employee
 * that was never granted memory (e.g. lead-qualification) never round-trips to a
 * primitive that would only refuse it.
 *
 * DEGRADATION, not failure. Memory here is auxiliary grounding + provenance, not
 * the runner's primary work (a research run's product is the report; an outreach
 * run's is the draft). The memory facet's ABI is throw-based, but a memory hiccup
 * must never fail an otherwise-good run — mirroring the Draft Engine's existing
 * "degrade to null on recall failure" and Research AI's "Memory engine
 * unavailable → skipped". So both verbs SWALLOW-AND-LOG and return null; the run
 * completes on its real work regardless.
 *
 * Recall is lexical + structural ONLY by construction: the facet asks the (dark)
 * embedding provider for a vector itself and degrades to lexical when none is
 * configured, so nothing here depends on embeddings being enabled.
 */

/**
 * The minimal RunContext shape the memory wiring needs: the bound memory facet
 * and the resolved capability tokens. Typed structurally (not as the whole
 * `RunContext`) so it is trivially exercisable in a unit test with a real
 * `createMemory(...)` facet over a mocked DB.
 */
export interface MemoryCapableContext {
  memory: BoundMemory;
  capabilities: ResolvedCapabilitySet;
}

// ---------------------------------------------------------------------
// The artifact-side fold — recalled memory made VISIBLE in the runner's
// deterministic result (P3: shared-memory retrieval must inform the output,
// not just be fetched and discarded).
// ---------------------------------------------------------------------

/** One recalled memory, folded to the bounded shape a task artifact carries. */
export type RecalledMemorySummary = {
  id: string;
  class: string;
  type: string;
  title: string;
  summary: string;
};

/**
 * The `memory_context` section of a runner's result artifact: the recalled
 * memories that actually informed the run, plus a plain-English note saying
 * HOW they informed it. `null` (the caller keeps the field null) means the
 * recall was unavailable — no capability, degraded, or nothing recalled —
 * which is an honest absence, never an empty fabrication.
 */
export type TaskMemoryContext = {
  recalled: RecalledMemorySummary[];
  note: string;
};

/** Bound: a task artifact never carries more than this many recall summaries. */
export const MEMORY_CONTEXT_LIMIT = 5;

/**
 * Fold a recall result into the artifact's `memory_context` section — PURE.
 * Returns null when the recall was null (capability-gated off / degraded) or
 * recalled nothing, so callers can assign it directly and the artifact stays
 * honest: a section exists if and only if real memories informed the run.
 * Items are already relevance-ranked by the recall (§7.3); we keep the top
 * `MEMORY_CONTEXT_LIMIT` and only the bounded summary fields (never bodies),
 * so the result jsonb stays small by construction.
 */
export function memoryContextFromRecall(
  recall: RecallResult | null,
  note: string,
): TaskMemoryContext | null {
  if (!recall || recall.items.length === 0) return null;
  return {
    recalled: recall.items.slice(0, MEMORY_CONTEXT_LIMIT).map((m) => ({
      id: m.id,
      class: m.class,
      type: m.type,
      title: m.title,
      summary: m.summary,
    })),
    note,
  };
}

/**
 * Memory types that record a PRIOR DECISION about the recall's subject. When
 * qualification recalls one of these for the company it is scoring, the run is
 * a REPEAT EVALUATION — a documented deterministic adjustment (the flag) is
 * applied so the verdict is never presented as a first look when it is not.
 * `qualification_decision` is what rememberForTask writes after every verdict;
 * `decision` is the generic decision-class type other employees may record.
 */
export const PRIOR_DECISION_MEMORY_TYPES: readonly string[] = [
  "qualification_decision",
  "decision",
];

/** The ids of recalled memories that record a prior decision — PURE. */
export function priorDecisionMemoryIds(recall: RecallResult | null): string[] {
  if (!recall) return [];
  return recall.items
    .filter((m) => PRIOR_DECISION_MEMORY_TYPES.includes(m.type))
    .map((m) => m.id);
}

function canUse(ctx: MemoryCapableContext, mode: MemoryCapabilityMode): boolean {
  return employeeCanUseMemory(ctx.capabilities.tokens, mode);
}

/**
 * Recall relevant prior knowledge BEFORE the runner acts — the read side.
 * Returns the recall result (whose ids the runner auto-drains into the output
 * envelope's `evidence[]`), or null when the employee lacks the recall
 * capability or the recall degraded. Never throws.
 */
export async function recallForTask(
  ctx: MemoryCapableContext,
  opts: RecallOpts,
): Promise<RecallResult | null> {
  if (!canUse(ctx, "recall")) return null;
  try {
    return await ctx.memory.recall(opts);
  } catch (err) {
    console.error(
      "[hq-runner-memory] recall degraded",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Record the runner's REAL task outcome AFTER it acts — the write side. Returns
 * the write result (`id` on an autonomous commit, or `approvalRequired` when the
 * §6 gate withheld a shared proposal), or null when the employee lacks the write
 * capability or the write degraded. Never throws.
 *
 * Callers must record only REAL task inputs/outputs — never a fabricated memory.
 * The natural, gate-clean shape is the employee's OWN lived experience of the
 * run (`class: "episodic"`), which the §6 gate commits autonomously (owned,
 * reversible, low blast-radius) with no approval checkpoint.
 */
export async function rememberForTask(
  ctx: MemoryCapableContext,
  opts: RememberOpts,
): Promise<{ id: string | null; approvalRequired: boolean } | null> {
  if (!canUse(ctx, "remember")) return null;
  try {
    return await ctx.memory.remember(opts);
  } catch (err) {
    console.error(
      "[hq-runner-memory] remember degraded",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

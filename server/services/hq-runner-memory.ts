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

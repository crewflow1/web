import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEmbeddingProvider } from "@/lib/ai/embeddings";
import { governedEmbed } from "@/lib/ai/embeddings/governed";
import { hqBudgetOrgId } from "@/lib/ai/governor/attribution";
import {
  assertValidEmbedding,
  embeddingChecksum,
  embeddingCostUsd,
  estimateTokens,
  EmbeddingDimensionError,
} from "@/lib/ai/embeddings/versioning";

/**
 * Shared Memory — the embedding worker (CEO Directive 009 Module 1, PR4).
 *
 * The dedicated background worker that turns "pending" memories into searchable
 * vectors. The atomic queue mechanics (claim a lease, store atomically, retry
 * with backoff, dead-letter, recover crashed leases) live in SQL
 * (hq_embedding_* primitives) — supabase-js has no client transaction, and per
 * the spine's D1 we don't invent one. What CANNOT live in SQL is the embedding
 * itself: an external provider call must never run inside a Postgres
 * transaction. So this worker is the seam between the two:
 *
 *   claim a batch (SQL)  →  embed it (provider, in TS)  →  complete/fail (SQL)
 *
 * It NEVER throws — a provider hiccup must not break the cron run; failures are
 * recorded per-memory (retry/backoff/DLQ in SQL) and the run reports them.
 *
 * It is DARK by default and degrades gracefully:
 *   - gate off (memory_embedding.worker_enabled = false) → a single cheap RPC,
 *     no work.
 *   - no provider configured (getEmbeddingProvider() === null) → no work;
 *     recall keeps serving lexical/structural results. The app cannot tell.
 *
 * Resilience (all the CEO named): batch processing, retry + exponential backoff
 * + dead-letter (SQL), idempotency + crash recovery (lease + claimed_by guard),
 * concurrency control (FOR UPDATE SKIP LOCKED + per-run worker id), cost
 * limiting + a wall-clock deadline (here), cancellation (AbortSignal per call).
 */

// The embedding RPCs aren't in the generated Supabase types; cast past the
// typed client exactly as the spine + memory services do.
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

// --- Types -------------------------------------------------------------------

type ClaimRow = { id: string; embed_input: string };

export type EmbedRunSummary = {
  ok: boolean;
  /** Whether the worker kill-switch was on for this run. */
  enabled: boolean;
  /** The active provider's version, or null when no provider is configured. */
  provider: string | null;
  /** Leases freed from crashed runs before this run started claiming. */
  reclaimed: number;
  /** Memories claimed across all batches this run. */
  claimed: number;
  /** Memories successfully embedded + stored. */
  embedded: number;
  /** Memories whose attempt failed (retried or dead-lettered in SQL). */
  failed: number;
  /** Batches processed. */
  batches: number;
  /** Total USD spent this run (null components — unknown pricing — count as 0). */
  costUsd: number;
  /** Why the run stopped: 'queue_empty' | 'max_batches' | 'cost_cap' | 'deadline' | 'disabled' | 'no_provider'. */
  stopped: string;
  /** Set only when the run could not even start (never thrown). */
  error?: string;
};

export type EmbedRunOptions = {
  /** Memories per claim/embedding batch. Default 32. */
  batchSize?: number;
  /** Max batches per run (bounds a single cron invocation). Default 10. */
  maxBatches?: number;
  /** Lease length; a crashed worker's rows free after this. Default 300s. */
  leaseSeconds?: number;
  /** Attempts before a memory is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Stop claiming once this run's spend reaches this (USD). Default 5. */
  maxCostUsd?: number;
  /** Wall-clock budget for the run (ms); leaves headroom under maxDuration. Default 50_000. */
  maxRunMs?: number;
  /** Per-embedding-call timeout (ms). Default: the provider's own. */
  callTimeoutMs?: number;
};

// --- Gate + signals ----------------------------------------------------------

/** True iff the worker kill-switch is on. Fail-dark on any error. */
export async function isEmbedWorkerEnabled(): Promise<boolean> {
  try {
    const { data, error } = await rpc()("hq_memory_embed_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Read the embedding golden signals (queue depth, spend, throughput). */
export async function getEmbeddingGoldenSignals(
  targetVersion?: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await rpc()("hq_embedding_golden_signals", {
      p_target_version: targetVersion ?? null,
    });
    if (error || data == null) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- The worker --------------------------------------------------------------

function emptySummary(over: Partial<EmbedRunSummary>): EmbedRunSummary {
  return {
    ok: true,
    enabled: false,
    provider: null,
    reclaimed: 0,
    claimed: 0,
    embedded: 0,
    failed: 0,
    batches: 0,
    costUsd: 0,
    stopped: "disabled",
    ...over,
  };
}

/**
 * Run one embedding pass. The cron's entry point. Never throws.
 *
 * Short-circuits (a single cheap RPC) when the gate is off or no provider is
 * configured, so a dark deployment is nearly free.
 */
export async function runEmbeddingWorker(
  opts: EmbedRunOptions = {},
): Promise<EmbedRunSummary> {
  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const maxBatches = Math.max(1, opts.maxBatches ?? 10);
  const leaseSeconds = Math.max(1, opts.leaseSeconds ?? 300);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const maxCostUsd = opts.maxCostUsd ?? 5;
  const maxRunMs = Math.max(1_000, opts.maxRunMs ?? 50_000);
  const deadline = Date.now() + maxRunMs;

  try {
    // (1) Gate. Off → no work.
    if (!(await isEmbedWorkerEnabled())) {
      return emptySummary({ enabled: false, stopped: "disabled" });
    }

    // (2) Provider. None → graceful no-op (recall still serves lexical/structural).
    //     NOTE: the worker never calls provider.embed() itself any more — every
    //     embedding goes through the governed door (governedEmbed). The provider
    //     handle here answers "is there one" and supplies info for the SQL
    //     accounting rows, nothing else.
    const provider = getEmbeddingProvider();
    if (!provider) {
      return emptySummary({ enabled: true, stopped: "no_provider" });
    }

    // (2b) Attribution. A PAID provider spends CrewFlow's own budget
    //      (hqBudgetOrgId — HQ memories have no tenant), and a governed call
    //      with no org cannot be reserved against a ceiling. Fail dark, not
    //      unattributed. The deterministic provider spends nothing, so it
    //      needs no org.
    const budgetOrgId = hqBudgetOrgId();
    if (provider.info.provider !== "deterministic" && !budgetOrgId) {
      return emptySummary({ enabled: true, provider: provider.info.version, stopped: "no_budget_org" });
    }

    const workerId = `embed-${crypto.randomUUID()}`;
    const info = provider.info;
    const call = rpc();

    // (3) Crash recovery: free leases left by a worker that died mid-batch, so
    //     their rows are claimable again this run ("resume after restart").
    let reclaimed = 0;
    {
      const { data } = await call("hq_embedding_reclaim_stale", {
        p_lease_seconds: leaseSeconds,
        p_limit: batchSize * maxBatches,
      });
      reclaimed = typeof data === "number" ? data : 0;
    }

    let claimed = 0;
    let embedded = 0;
    let failed = 0;
    let batches = 0;
    let costUsd = 0;
    let stopped = "queue_empty";

    for (let b = 0; b < maxBatches; b++) {
      if (Date.now() > deadline) {
        stopped = "deadline";
        break;
      }
      if (costUsd >= maxCostUsd) {
        stopped = "cost_cap";
        break;
      }

      // (4) Claim a batch (SQL lease).
      const { data: claimData, error: claimErr } = await call("hq_embedding_claim_batch", {
        p_worker_id: workerId,
        p_limit: batchSize,
        p_lease_seconds: leaseSeconds,
      });
      if (claimErr) {
        // A claim error mid-run: stop cleanly, report what we did so far.
        return {
          ok: false,
          enabled: true,
          provider: info.version,
          reclaimed,
          claimed,
          embedded,
          failed,
          batches,
          costUsd,
          stopped: "claim_error",
          error: claimErr.message,
        };
      }
      const rows = parseClaim(claimData);
      if (rows.length === 0) {
        stopped = "queue_empty";
        break;
      }
      batches++;
      claimed += rows.length;

      // (5) Embed the batch — through the GOVERNED DOOR, the only external
      //     call, OUTSIDE any SQL transaction. One batch = one governed call =
      //     one reservation + one ledger row (vendors bill per request). A
      //     batch-level provider failure fails every row in it (each gets its
      //     own retry/backoff/DLQ accounting in SQL); a BUDGET refusal fails
      //     nobody — see below.
      const inputs = rows.map((r) => r.embed_input);
      const startedAt = Date.now();
      let vectors: number[][] | null = null;
      let batchTokens = 0;
      let failReason: string | null = null;
      let budgetRefused: string | null = null;
      {
        const signal = opts.callTimeoutMs
          ? AbortSignal.timeout(opts.callTimeoutMs)
          : undefined;
        const res = await governedEmbed({
          texts: inputs,
          feature: "memory.embedding_write",
          // Checked at (2b) for every paid provider; the deterministic
          // provider never reads it.
          orgId: budgetOrgId ?? "",
          userId: null,
          ...(signal ? { signal } : {}),
        });
        if (res.status === "embedded") {
          vectors = res.vectors;
          batchTokens = res.tokens;
        } else if (res.status === "refused") {
          budgetRefused = res.reason;
        } else {
          failReason = res.reason ?? "embed failed";
        }
      }
      const latencyMs = Date.now() - startedAt;

      if (budgetRefused) {
        // The governor said no — ceiling reached, reservation store down, or
        // an identical batch in flight. NOT the rows' fault: failing them
        // would burn retry attempts toward the dead-letter queue for a
        // condition that clears by itself. Leave the batch leased —
        // hq_embedding_reclaim_stale frees it for the next run — and stop
        // claiming more work.
        stopped = `budget_refused:${budgetRefused}`;
        break;
      }

      if (!vectors) {
        // Whole batch failed: record a failed attempt per claimed row.
        for (const row of rows) {
          const f = await failOne(call, row.id, workerId, info, failReason ?? "embed failed", maxAttempts);
          if (f) failed++;
        }
        continue;
      }

      // (6) Attribute the provider's authoritative batch tokens across rows
      //     (vendors bill per-request, not per-input), then store each.
      const estPerRow = inputs.map(estimateTokens);
      const estTotal = estPerRow.reduce((a, c) => a + c, 0) || 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const vec = vectors[i];
        if (!row) continue;
        const est = estPerRow[i] ?? 0;
        const rowTokens = Math.round(batchTokens * (est / estTotal));
        const rowCost = embeddingCostUsd(info, rowTokens);

        try {
          // Defensive corruption guard before we trust the vector (PR4b also checks).
          assertValidEmbedding(vec, info.dimension);
          const ok = await completeOne(call, row.id, workerId, vec as number[], info, {
            checksum: embeddingChecksum(row.embed_input),
            tokens: rowTokens,
            cost: rowCost,
            latencyMs,
          });
          if (ok) {
            embedded++;
            costUsd += rowCost ?? 0;
          } else {
            // Lease lost / already embedded elsewhere — not an error, not a duplicate.
          }
        } catch (e) {
          // A corrupt vector (e.g. dimension mismatch) → fail this row so it
          // retries / dead-letters; never poison the ANN index.
          const reason =
            e instanceof EmbeddingDimensionError ? `corrupt vector: ${e.message}` : String(e);
          const f = await failOne(call, row.id, workerId, info, reason, maxAttempts);
          if (f) failed++;
        }
      }

      if (rows.length < batchSize) {
        stopped = "queue_empty";
        break;
      }
      if (b === maxBatches - 1) stopped = "max_batches";
    }

    return {
      ok: true,
      enabled: true,
      provider: info.version,
      reclaimed,
      claimed,
      embedded,
      failed,
      batches,
      costUsd,
      stopped,
    };
  } catch (e) {
    // Absolute backstop — the worker must never throw into the cron.
    return {
      ok: false,
      enabled: true,
      provider: null,
      reclaimed: 0,
      claimed: 0,
      embedded: 0,
      failed: 0,
      batches: 0,
      costUsd: 0,
      stopped: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// --- Internals ---------------------------------------------------------------

function parseClaim(data: unknown): ClaimRow[] {
  if (!data || typeof data !== "object") return [];
  const claimed = (data as { claimed?: unknown }).claimed;
  if (!Array.isArray(claimed)) return [];
  return claimed.filter(
    (r): r is ClaimRow =>
      !!r &&
      typeof (r as ClaimRow).id === "string" &&
      typeof (r as ClaimRow).embed_input === "string",
  );
}

async function completeOne(
  call: Rpc,
  memoryId: string,
  workerId: string,
  vec: number[],
  info: { provider: string; model: string; dimension: number; version: string },
  meta: { checksum: string; tokens: number; cost: number | null; latencyMs: number },
): Promise<boolean> {
  const { data, error } = await call("hq_embedding_complete", {
    p_memory_id: memoryId,
    p_worker_id: workerId,
    p_embedding: vec,
    p_provider: info.provider,
    p_model: info.model,
    p_dimension: info.dimension,
    p_version: info.version,
    p_checksum: meta.checksum,
    p_tokens: meta.tokens,
    p_cost: meta.cost,
    p_latency_ms: meta.latencyMs,
  });
  if (error || !data || typeof data !== "object") return false;
  return (data as { ok?: boolean }).ok === true;
}

async function failOne(
  call: Rpc,
  memoryId: string,
  workerId: string,
  info: { provider: string; model: string },
  reason: string,
  maxAttempts: number,
): Promise<boolean> {
  try {
    const { data, error } = await call("hq_embedding_fail", {
      p_memory_id: memoryId,
      p_worker_id: workerId,
      p_provider: info.provider,
      p_model: info.model,
      p_error: reason,
      p_max_attempts: maxAttempts,
    });
    if (error || !data || typeof data !== "object") return false;
    return (data as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

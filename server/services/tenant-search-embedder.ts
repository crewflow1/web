import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { governedEmbed } from "@/lib/ai/embeddings/governed";
import { resolveModel } from "@/lib/ai/governor/registry";
import {
  assertValidEmbedding,
  embeddingChecksum,
  estimateTokens,
  EmbeddingDimensionError,
} from "@/lib/ai/embeddings/versioning";

/**
 * Tenant Semantic Search — the embedding worker.
 *
 * Turns "pending" corpus documents into searchable vectors. The atomic queue
 * mechanics (lease, atomic store, retry/backoff, dead-letter, crash recovery)
 * live in SQL (tenant_search_* primitives). This worker is the seam that runs
 * the one thing SQL cannot: the external embedding call, OUTSIDE any Postgres
 * transaction —
 *
 *   claim a batch (SQL) → embed it (the GOVERNED door, in TS) → complete/fail (SQL)
 *
 * It NEVER constructs a provider and NEVER calls provider.embed() directly: it
 * goes exclusively through `governedEmbed`, which applies the per-org ceiling,
 * the SHA-256 dedupe, and the immutable ledger. Crucially, each document carries
 * its OWN org_id, so the spend is billed to THAT TENANT's budget — never
 * CrewFlow's internal org. The provider identity needed for the SQL accounting
 * rows is READ BACK from governedEmbed's result, so this file touches no part of
 * the embeddings module except the governed door (the closure ratchet keeps the
 * provider handle private to lib/ai/embeddings/**).
 *
 * It NEVER throws — a provider hiccup is recorded per-document (retry/backoff/DLQ
 * in SQL) and reported in the summary. DARK by default: a single cheap gate RPC
 * when the worker switch is off.
 */

type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
function rpc(): Rpc {
  const admin = createAdminClient();
  return admin.rpc.bind(admin) as unknown as Rpc;
}

type ClaimRow = { id: string; org_id: string; embed_input: string };

export type TenantEmbedSummary = {
  ok: boolean;
  enabled: boolean;
  reclaimed: number;
  claimed: number;
  embedded: number;
  failed: number;
  batches: number;
  /** 'queue_empty' | 'max_batches' | 'deadline' | 'disabled' | 'budget_refused:*' | 'claim_error' | 'error' */
  stopped: string;
  error?: string;
};

export type TenantEmbedOptions = {
  batchSize?: number;
  maxBatches?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  maxRunMs?: number;
};

/** True iff the worker kill-switch is on. Fail-dark on any error. */
export async function isTenantSearchWorkerEnabled(): Promise<boolean> {
  try {
    const { data, error } = await rpc()("tenant_search_embed_enabled");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

function emptySummary(over: Partial<TenantEmbedSummary>): TenantEmbedSummary {
  return {
    ok: true,
    enabled: false,
    reclaimed: 0,
    claimed: 0,
    embedded: 0,
    failed: 0,
    batches: 0,
    stopped: "disabled",
    ...over,
  };
}

function parseClaim(data: unknown): ClaimRow[] {
  if (!data || typeof data !== "object") return [];
  const claimed = (data as { claimed?: unknown }).claimed;
  if (!Array.isArray(claimed)) return [];
  return claimed.filter(
    (r): r is ClaimRow =>
      !!r &&
      typeof (r as ClaimRow).id === "string" &&
      typeof (r as ClaimRow).org_id === "string" &&
      typeof (r as ClaimRow).embed_input === "string",
  );
}

/** Split rows into chunks that fit the bound model's reservation envelope. */
function chunkByEnvelope(rows: ClaimRow[]): ClaimRow[][] {
  const bound = resolveModel("embedding");
  if (!bound) return [rows];
  const chunks: ClaimRow[][] = [];
  let cur: ClaimRow[] = [];
  let curTokens = 0;
  for (const row of rows) {
    const t = estimateTokens(row.embed_input);
    if (cur.length > 0 && curTokens + t > bound.reserveInputTokens) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(row);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

async function completeOne(
  call: Rpc,
  documentId: string,
  workerId: string,
  vec: number[],
  info: { provider: string; model: string; dimension: number; version: string },
  checksum: string,
): Promise<boolean> {
  const { data, error } = await call("tenant_search_complete", {
    p_document_id: documentId,
    p_worker_id: workerId,
    p_embedding: vec,
    p_provider: info.provider,
    p_model: info.model,
    p_dimension: info.dimension,
    p_version: info.version,
    p_checksum: checksum,
  });
  if (error || !data || typeof data !== "object") return false;
  return (data as { ok?: boolean }).ok === true;
}

async function failOne(
  call: Rpc,
  documentId: string,
  workerId: string,
  reason: string,
  maxAttempts: number,
): Promise<boolean> {
  try {
    const { data, error } = await call("tenant_search_fail", {
      p_document_id: documentId,
      p_worker_id: workerId,
      p_error: reason,
      p_max_attempts: maxAttempts,
    });
    if (error || !data || typeof data !== "object") return false;
    return (data as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** Run one embedding pass. Never throws. */
export async function runTenantSearchEmbedder(
  opts: TenantEmbedOptions = {},
): Promise<TenantEmbedSummary> {
  const batchSize = Math.max(1, opts.batchSize ?? 32);
  const maxBatches = Math.max(1, opts.maxBatches ?? 10);
  const leaseSeconds = Math.max(1, opts.leaseSeconds ?? 300);
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const maxRunMs = Math.max(1_000, opts.maxRunMs ?? 50_000);
  const deadline = Date.now() + maxRunMs;

  try {
    if (!(await isTenantSearchWorkerEnabled())) {
      return emptySummary({ enabled: false, stopped: "disabled" });
    }

    const workerId = `tsearch-${crypto.randomUUID()}`;
    const call = rpc();

    let reclaimed = 0;
    {
      const { data } = await call("tenant_search_reclaim_stale", {
        p_lease_seconds: leaseSeconds,
        p_limit: batchSize * maxBatches,
      });
      reclaimed = typeof data === "number" ? data : 0;
    }

    let claimed = 0;
    let embedded = 0;
    let failed = 0;
    let batches = 0;
    let stopped = "queue_empty";

    for (let b = 0; b < maxBatches; b++) {
      if (Date.now() > deadline) {
        stopped = "deadline";
        break;
      }

      const { data: claimData, error: claimErr } = await call("tenant_search_claim_batch", {
        p_worker_id: workerId,
        p_limit: batchSize,
        p_lease_seconds: leaseSeconds,
      });
      if (claimErr) {
        return { ok: false, enabled: true, reclaimed, claimed, embedded, failed, batches, stopped: "claim_error", error: claimErr.message };
      }
      const rows = parseClaim(claimData);
      if (rows.length === 0) {
        stopped = "queue_empty";
        break;
      }
      batches++;
      claimed += rows.length;

      // Group by org so each governed call bills exactly one tenant's budget.
      const byOrg = new Map<string, ClaimRow[]>();
      for (const row of rows) {
        const list = byOrg.get(row.org_id) ?? [];
        list.push(row);
        byOrg.set(row.org_id, list);
      }

      let stopClaiming: string | null = null;
      for (const [orgId, orgRows] of byOrg) {
        if (stopClaiming) break;
        for (const chunk of chunkByEnvelope(orgRows)) {
          const inputs = chunk.map((r) => r.embed_input);
          const res = await governedEmbed({
            texts: inputs,
            feature: "memory.embedding_write",
            orgId,
            userId: null,
          });

          if (res.status === "refused") {
            if (res.reason === "batch_exceeds_envelope" && chunk.length === 1) {
              const f = await failOne(call, chunk[0]!.id, workerId, "embed input exceeds reservation envelope", maxAttempts);
              if (f) failed++;
              continue;
            }
            // Ceiling / store down / duplicate — not the rows' fault. Leave them
            // leased (reclaim frees them next run) and stop claiming.
            stopClaiming = res.reason;
            break;
          }
          if (res.status === "unavailable") {
            for (const row of chunk) {
              const f = await failOne(call, row.id, workerId, res.reason ?? "embed unavailable", maxAttempts);
              if (f) failed++;
            }
            continue;
          }

          // Embedded. Store each vector atomically; corruption dead-letters.
          const { vectors, info } = res;
          for (let i = 0; i < chunk.length; i++) {
            const row = chunk[i]!;
            const vec = vectors[i];
            try {
              assertValidEmbedding(vec, info.dimension);
              const ok = await completeOne(call, row.id, workerId, vec as number[], info, embeddingChecksum(row.embed_input));
              if (ok) embedded++;
            } catch (e) {
              const reason = e instanceof EmbeddingDimensionError ? `corrupt vector: ${e.message}` : String(e);
              const f = await failOne(call, row.id, workerId, reason, maxAttempts);
              if (f) failed++;
            }
          }
        }
      }

      if (stopClaiming) {
        stopped = `budget_refused:${stopClaiming}`;
        break;
      }
      if (rows.length < batchSize) {
        stopped = "queue_empty";
        break;
      }
      if (b === maxBatches - 1) stopped = "max_batches";
    }

    return { ok: true, enabled: true, reclaimed, claimed, embedded, failed, batches, stopped };
  } catch (e) {
    return { ok: false, enabled: true, reclaimed: 0, claimed: 0, embedded: 0, failed: 0, batches: 0, stopped: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

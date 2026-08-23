import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runEmbeddingWorker } from "@/server/services/memory-embedder";
import { isEmbeddingConfigured } from "@/lib/ai/embeddings";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Shared Memory embedding worker (CEO Directive 009 Module 1, PR4).
 *
 *   GET /api/cron/memory-embed
 *
 * Drives one bounded pass of the embedding worker: reclaim crashed leases,
 * claim pending memories, embed them via the configured provider, store the
 * vectors atomically. The worker is DARK by default (memory_embedding.
 * worker_enabled = false) and a no-op when no provider is configured, so this
 * cron is nearly free until the feature is switched on — at which point new
 * memories become semantically searchable with no application change.
 *
 * The worker NEVER throws: a provider hiccup is recorded per-memory (retry /
 * backoff / dead-letter in SQL) and reported in the summary, never raised.
 * Each invocation is bounded (batches, wall-clock, spend) so one run can never
 * run away.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A pass may embed several batches back to back; give it the full budget. The
// worker keeps its own wall-clock deadline (maxRunMs) under this ceiling.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // DARK-GATE BEFORE TELEMETRY (Wave A.4): embedding is the worker's whole job,
  // so with no embedding provider configured (the prod default — the `embedding`
  // tier is unbound) the worker is a guaranteed no-op. Short-circuit with a 204
  // BEFORE withCronTelemetry so a dark tick writes zero cron_runs rows, mirroring
  // push-drain/sms-drain. `isEmbeddingConfigured()` is a synchronous, side-effect
  // -free env/registry check (it does NOT add a getEmbeddingProvider outside-caller
  // — it wraps the in-module one). The moment a provider is bound this falls
  // through and full telemetry resumes automatically. No body on a 204.
  if (!isEmbeddingConfigured()) {
    return new NextResponse(null, { status: 204 });
  }
  const url = new URL(request.url);
  // `limit` bounds how many batches a single invocation may process — a manual
  // backfill kick can raise it; the scheduled tick uses the default.
  const limitRaw = Number(url.searchParams.get("limit"));
  const maxBatches =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;

  const { status, payload } = await withCronTelemetry("memory-embed", async () => {
    const summary = await runEmbeddingWorker({ maxBatches });
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}

import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { isEmbeddingConfigured } from "@/lib/ai/embeddings";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runTenantSearchBackfill } from "@/server/services/tenant-search-backfill";
import { runTenantSearchEmbedder } from "@/server/services/tenant-search-embedder";

/**
 * CrewFlow — Tenant Semantic Search cron.
 *
 *   GET /api/cron/tenant-search-embed
 *
 * One bounded pass: refresh the corpus from source tables (backfill), then
 * embed pending documents (worker). Both are additive and dark-safe; the whole
 * feature is useless without vectors, so the cron 204-DARKS when no embedding
 * provider is configured — writing zero cron_runs rows on a dark tick, exactly
 * like memory-embed/push-drain/sms-drain. The keyword search path in
 * app/api/search/route.ts is completely independent and keeps working whether or
 * not this cron ever runs.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // DARK-GATE BEFORE TELEMETRY: with no embedding provider configured (the prod
  // default — the `embedding` tier is unbound) there is nothing to embed and no
  // point populating a corpus nobody queries. Short-circuit with a 204 so a dark
  // tick writes zero cron_runs rows. The moment a provider is bound this falls
  // through and full telemetry resumes. (isEmbeddingConfigured is a synchronous,
  // side-effect-free env/registry check inside lib/ai/embeddings.)
  if (!isEmbeddingConfigured()) {
    return new NextResponse(null, { status: 204 });
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const maxBatches = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;

  const { status, payload } = await withCronTelemetry("tenant-search-embed", async () => {
    const backfill = await runTenantSearchBackfill();
    const embed = await runTenantSearchEmbedder({ maxBatches });
    return { ok: backfill.ok && embed.ok, backfill, embed };
  });
  return NextResponse.json(payload, { status });
}

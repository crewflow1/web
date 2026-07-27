import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runMemoryLifecycleWorker } from "@/server/services/memory-lifecycle";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Shared Memory lifecycle worker (CEO Directive 009 Module 1, PR5).
 *
 *   GET /api/cron/memory-lifecycle
 *
 * Drives one bounded pass of the lifecycle worker (Bible Volume X §9–§10):
 * expire/decay archival, near-duplicate supersession, and LLM summarisation of
 * long bodies. DARK by default (memory_lifecycle.worker_enabled = false) and a
 * graceful no-op when no text provider / no embeddings are configured, so this
 * cron is nearly free until the feature is switched on — at which point the
 * company brain starts pruning and compressing itself with no application change.
 *
 * The worker NEVER throws: a provider hiccup or one bad row is isolated and
 * reported in the summary, never raised. Each invocation is bounded (scan size,
 * supersede/summary caps, wall-clock, spend) so one run can never run away.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A pass may sweep, dedupe, and summarise back to back; give it the full budget.
// The worker keeps its own wall-clock deadline (maxRunMs) under this ceiling.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  // `limit` bounds how many rows each SQL pass may scan in a single invocation —
  // a manual catch-up kick can raise it; the scheduled tick uses the default.
  const limitRaw = Number(url.searchParams.get("limit"));
  const scanLimit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  const { status, payload } = await withCronTelemetry("memory-lifecycle", async () => {
    const summary = await runMemoryLifecycleWorker({ scanLimit });
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}

import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runRetentionPurge } from "@/server/services/retention-purge";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * GET /api/cron/retention-purge — daily data-retention pass.
 *
 * Runs every ENABLED per-org retention policy through the tenant-pinned,
 * allowlist-gated `retention_purge_run` primitive. DARK BY DEFAULT: while
 * FEATURE_RETENTION_PURGE is off (the default), every policy runs in DRY-RUN —
 * the pass records what WOULD be purged (audited) and deletes nothing. Turning
 * the flag on makes the same policies purge for real.
 *
 * Bearer-secret gated (isCronAuthorised) and wrapped in cron telemetry so a run
 * always returns JSON-safe output and lands a cron_runs row.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry(
    "retention-purge",
    async () => {
      const summary = await runRetentionPurge();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}

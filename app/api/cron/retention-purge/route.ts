import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runRetentionPurge } from "@/server/services/retention-purge";
import { purgeExpiredFormImports } from "@/server/services/document-autofill";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { drainDueDeletionRequests } from "@/server/services/privacy-deletion";

/**
 * GET /api/cron/retention-purge — daily data-retention pass.
 *
 * Two independent sweeps run here:
 *
 *  1. The per-org retention POLICIES, through the tenant-pinned, allowlist-gated
 *     `retention_purge_run` primitive. DARK BY DEFAULT: while
 *     FEATURE_RETENTION_PURGE is off (the default), every policy runs in DRY-RUN
 *     — the pass records what WOULD be purged (audited) and deletes nothing.
 *     Turning the flag on makes the same policies purge for real.
 *
 *  2. The document-import retention sweep (`purgeExpiredFormImports`) — ALWAYS
 *     on, not gated by the policy flag. It is a data-minimisation guarantee for
 *     the `form-imports` bucket: an uploaded document (a CV, a V5C, an insurance
 *     certificate — personal data) and its extraction draft are removed once
 *     past the AUTOFILL_RETENTION_DAYS window, and consumed/discarded drafts are
 *     cleared outright. Promised by migrations 20261264000000/20261265000000;
 *     this is where that promise is honoured. It is self-contained and
 *     fail-soft (logs and returns zero counts on error), so it can never fail
 *     the policy sweep.
 *
 *  3. Due DELETION REQUESTS (`drainDueDeletionRequests`) — company deletions
 *     whose 7-day cooling-off has ended, plus any interrupted or failed
 *     account / staff / company deletion, resumed from its recorded steps. DARK
 *     BY DEFAULT: inert while FEATURE_ACCOUNT_DELETION is off. Isolated so a
 *     failure here can never fail the two sweeps above (it is reported in the
 *     payload and retried on the next run — the ledger keeps the state).
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
      const formImports = await purgeExpiredFormImports();
      let deletions: unknown;
      try {
        deletions = await drainDueDeletionRequests({ limit: 10 });
      } catch (e) {
        console.error("[retention-purge] deletion drain failed", {
          name: e instanceof Error ? e.name : "unknown",
        });
        deletions = { enabled: true, error: "drain_failed" };
      }
      return { ok: true, summary, formImports, deletions };
    },
  );
  return NextResponse.json(payload, { status });
}

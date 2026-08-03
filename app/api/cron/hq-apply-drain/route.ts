import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runApplyOnApprovalDrain } from "@/server/services/hq-apply-drain";

/**
 * CrewFlow HQ — the apply-on-approval drain (CEO Directive #014 / D-04, Phase C, C3 rollout;
 * ADR 0009; Directive #016 Live Executor Rollout).
 *
 *   GET /api/cron/hq-apply-drain
 *
 * The out-of-band sweep that completes the approve → act loop: it applies APPROVED HQ
 * decisions/approvals EXACTLY ONCE, idempotently, through an EXISTING sanctioned authority (never a
 * bare tenant write). Each run is idempotent and safe to run as often as the schedule fires — a run
 * with nothing new is a no-op.
 *
 * SHIPS DARK, BY TWO GATES:
 *   1. The kill-switch `CREWFLOW_HQ_APPLY_ON_APPROVAL` is OFF by default, so
 *      `runApplyOnApprovalDrain` short-circuits before any read or apply (returns `enabled: false`).
 *   2. Even ON, live apply to real tenant data ADDITIONALLY requires the CEO authority per ADR 0009:
 *      the production sanctioned authority is UNBOUND, so the sweep applies nothing until a CEO
 *      cut-over binds a real authority. Binding it is a config/wiring flip, not an engineering task.
 *
 * The run's `cron_runs` row is the drain-health golden signal (`withCronTelemetry`).
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("hq-apply-drain", async () => {
    // Production deps by construction: default env kill-switch, durable store, UNBOUND authority
    // (live apply is the CEO cut-over per ADR 0009), service-role approved-only reader.
    const summary = await runApplyOnApprovalDrain();
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}

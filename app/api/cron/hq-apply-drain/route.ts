import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import {
  hqApplyOnApprovalEnabled,
  runApplyOnApprovalDrain,
} from "@/server/services/hq-apply-drain";

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
 *   2. Even ON, this route runs the PRODUCTION defaults, whose sanctioned authority is
 *      `createUnboundApplyAuthority` — it resolves EVERY approved item to `null`, so the sweep skips
 *      each one, applies nothing, and records nothing. This is a deliberate no-op, not a wired-live
 *      path awaiting a flag.
 *
 * WHAT "GOING LIVE" ACTUALLY TAKES (it is engineering, NOT just a config flip):
 *   (a) a production `ApplyAuthority.resolve()` that maps each approved descriptor to a
 *       boundary closure routed through the sanctioned executor (`executePlan` bound to a real
 *       `ToolImplementation` at each tool's SECURITY DEFINER entry point), with per-action-type
 *       coverage and refuse-before-effect for any unmapped type;
 *   (b) wiring the executor off `REFERENCE_EXECUTOR` (server/sdk/tasks.ts ~L684) to real tool
 *       implementations; and
 *   (c) the ADR 0009 CEO live cut-over authority — activating an autonomous apply-authority is a
 *       product/authority decision, not something switched on silently.
 * The apply SUBSTRATE below it (durable append-only store, exactly-once partial unique index,
 * idempotency key, kill-switch, approved-only reader, service-role-only write RPC) IS complete and
 * verified; the bound authority in (a)/(b) is the remaining, unbuilt work.
 *
 * The run's `cron_runs` row is the drain-health golden signal (`withCronTelemetry`). While unbound,
 * its summary reports `swept > 0, applied = 0, skipped = swept` — the visible no-op fingerprint.
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

  // Dark gate — the SAME synchronous env kill-switch `runApplyOnApprovalDrain`
  // short-circuits on (default-off, and prod today). Hoisted here so an OFF
  // deploy costs ZERO database work AND writes NO cron_runs telemetry row,
  // mirroring push-drain / webhook-dispatch. Nothing is stranded: OFF, the sweep
  // reads no approved rows and applies nothing, so an early return can only skip
  // work that would itself have been a total no-op. Flip the switch ON and full
  // telemetry (including the swept>0/applied=0 unbound-authority fingerprint)
  // resumes. No body on a 204.
  if (!hqApplyOnApprovalEnabled()) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("hq-apply-drain", async () => {
    // Production deps by construction: default env kill-switch, durable store, UNBOUND authority
    // (resolves every item to null → applies nothing; live apply is the ADR 0009 CEO cut-over plus
    // the bound-authority + real-executor engineering described above), service-role reader.
    const summary = await runApplyOnApprovalDrain();
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}

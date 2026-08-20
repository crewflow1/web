import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ApplyAuditEntry, ApplyAuditSink } from "@/server/sdk/autonomous-apply";

/**
 * CrewFlow HQ — the durable apply-attempt audit sink, service-layer write primitive
 * (P2 HQ Autonomous Apply; ADR 0009 Decisions 3, 8, 9).
 *
 * This is the production binding of the pure {@link ApplyAuditSink} seam (server/sdk/autonomous-apply.ts),
 * the direct analogue of `createDurableApplicationStore` (server/services/hq-application.ts): same
 * contract, real persistence. It writes through the validated SECURITY DEFINER function
 * `hq_record_apply_audit` (EXECUTE granted to service_role only) into `public.hq_apply_audit`
 * (migration 20261199000000) — the same hardening shape hq_application_records / the executor-shadow
 * store use: RLS:hq, append-only (UPDATE/DELETE blocked even under service-role), service_role-only
 * write RPC.
 *
 * PRODUCTION-INERT TODAY. The apply authorities resolve every descriptor to null while
 * FEATURE_HQ_AUTONOMOUS_APPLY is off, so this sink is never invoked in production. It exists so that
 * activating the capability (a CEO flag flip + injecting this sink and a bound tool registry) is a
 * config change, not an engineering one.
 *
 * BEST-EFFORT (unlike the apply-once ground truth). The audit is a forensic record, not the
 * idempotency truth: a lost audit write must never break or double an apply. So a persistence fault is
 * SWALLOWED (logged), never thrown — the caller (the authority) already wraps `record` in a
 * `.catch(() => {})`, and this keeps the same posture at the boundary.
 */

// hq_record_apply_audit isn't in the generated Supabase types; cast past the typed client (the same
// convention hq-application.ts / executor-shadow.ts use for their SECURITY DEFINER RPCs).
type RecordApplyAuditRpc = (
  fn: "hq_record_apply_audit",
  args: Record<string, unknown>,
) => Promise<{ data: number | string | null; error: { message: string } | null }>;

type AdminClient = ReturnType<typeof createAdminClient>;

/** Append one apply-audit entry durably through the SECURITY DEFINER RPC. Best-effort — never throws. */
async function recordApplyAudit(admin: AdminClient, entry: ApplyAuditEntry): Promise<void> {
  try {
    const rpc = admin.rpc.bind(admin) as unknown as RecordApplyAuditRpc;
    const { error } = await rpc("hq_record_apply_audit", {
      p_path: entry.path,
      p_tool_label: entry.toolLabel,
      p_action_id: entry.actionId,
      p_correlation_id: entry.correlationId,
      p_stage: entry.stage,
      p_detail: entry.detail,
      p_steps: entry.steps,
    });
    if (error) {
      console.error("[hq-apply-audit] record failed (best-effort, swallowed)", {
        actionId: entry.actionId,
        stage: entry.stage,
        message: error.message,
      });
    }
  } catch (err) {
    console.error("[hq-apply-audit] record threw (best-effort, swallowed)", {
      actionId: entry.actionId,
      stage: entry.stage,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The production {@link ApplyAuditSink} — binds the durable table into the audit seam the authorities
 * record through. The server-only counterpart of `createInMemoryApplyAuditSink` (the pure reference):
 * same contract, real persistence, append-only, and best-effort (it swallows faults, because it is a
 * forensic record, not the idempotency ground truth).
 */
export function createDurableApplyAuditSink(): ApplyAuditSink {
  const admin = createAdminClient();
  return Object.freeze({
    record: (entry: ApplyAuditEntry) => recordApplyAudit(admin, entry),
  });
}

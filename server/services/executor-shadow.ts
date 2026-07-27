import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ShadowObservationRecord,
  ShadowObservationStore,
  ShadowObservationWriteResult,
} from "@/server/sdk/shadow";

/**
 * CrewFlow HQ — the durable executor-shadow observation store, service-layer write
 * primitive (CEO Directive #016 / D-06, increment R2; ADR 0011; the Shadow
 * Truthfulness Rule — Kernel Contract Map §2, the thirtieth standard).
 *
 * `recordExecutorShadowObservation()` appends one row to
 * `public.hq_ai_executor_shadow_observations` through the validated SECURITY DEFINER
 * function `hq_record_executor_shadow` (EXECUTE granted to service_role only) — the
 * exact hardening shape the HQ Event Spine's `emitEvent` uses for `hq_emit_event`.
 *
 * This is the production binding of the pure {@link ShadowObservationStore} seam the
 * runner records through (the in-memory reference lives in `server/sdk/shadow.ts`).
 * It is a SHADOW write, never an application write: the row carries the unconditional
 * `kind: "executor_shadow"` label (hardcoded in the RPC AND pinned by a column CHECK),
 * has no `applied` / `failed` status, and lands in a table structurally separate from
 * any apply-once store — so it can never poison the idempotency ground truth a real
 * apply depends on (the Shadow Truthfulness Rule).
 *
 * BEST-EFFORT, like the audit emit it accompanies: a failed shadow persistence must
 * never break the run it observes (the shadow is an observer, not a participant), so
 * this returns a discriminated {@link ShadowObservationWriteResult} and NEVER throws.
 */

// hq_record_executor_shadow isn't in the generated Supabase types yet; cast past the
// typed client (the same convention event-spine.ts uses for hq_emit_event).
type RecordShadowRpc = (
  fn: "hq_record_executor_shadow",
  args: Record<string, unknown>,
) => Promise<{ data: number | string | null; error: { message: string } | null }>;

/**
 * Append one shadow observation durably through the SECURITY DEFINER RPC. Never
 * throws — a spine/store hiccup is logged and returned, never raised, so a shadow
 * write can never break the autonomous run it observes.
 */
export async function recordExecutorShadowObservation(
  record: ShadowObservationRecord,
): Promise<ShadowObservationWriteResult> {
  try {
    const admin = createAdminClient();
    const rpc = admin.rpc.bind(admin) as unknown as RecordShadowRpc;
    const { data, error } = await rpc("hq_record_executor_shadow", {
      p_outcome: record.outcome,
      p_source: record.source,
      p_correlation_id: record.correlationId,
      p_task_id: record.taskId,
      p_action_id: record.actionId,
      p_tool_label: record.toolLabel,
      p_idempotency_key: record.idempotencyKey,
      p_reason: record.reason,
      p_detail: record.detail,
    });

    if (error || data == null) {
      console.error("[executor-shadow] record failed", {
        outcome: record.outcome,
        correlationId: record.correlationId,
        actionId: record.actionId,
        error: error?.message,
      });
      return { ok: false, error: error?.message ?? "shadow record failed" };
    }

    // bigint comes back from PostgREST as a JS number (safe well past this horizon)
    // or, defensively, a numeric string — normalise to number (mirrors emitEvent).
    return { ok: true, id: Number(data) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[executor-shadow] record threw", {
      outcome: record.outcome,
      correlationId: record.correlationId,
      message,
    });
    return { ok: false, error: message };
  }
}

/**
 * The production {@link ShadowObservationStore} — binds the durable RPC primitive into
 * the append-only store seam the runner records through. This is the server-only
 * counterpart of `createInMemoryShadowObservationStore` (the pure reference): same
 * contract, real persistence. Write-only and best-effort by construction.
 */
export function createDurableShadowObservationStore(): ShadowObservationStore {
  return Object.freeze({
    record: recordExecutorShadowObservation,
  });
}

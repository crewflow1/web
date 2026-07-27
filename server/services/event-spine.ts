import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActorType, Severity, Verb, Visibility } from "@/lib/events/registry";

/**
 * The HQ Event Spine — service-layer write primitive (Module 1, PR1).
 *
 * `emitEvent()` appends one row to `public.hq_events` through the validated
 * SECURITY DEFINER function `hq_emit_event` (EXECUTE granted to service_role
 * only). It is the SERVICE-emitted half of the producer contract (Ch.04): the
 * logic-level path for events that have no owning table mutation — a cron that
 * ran, an alert raised, a webhook received. Events that DO accompany a state
 * change are written transactionally by AFTER triggers on the mutating table
 * (PR2), which is the path that gives the "state and narrative are inseparable"
 * guarantee (P1) without a client-side transaction layer (CEO decision D1).
 *
 * Each call to `hq_emit_event` is its own single-statement transaction, so a
 * standalone event is atomic in itself. There is deliberately NO `tx` parameter:
 * supabase-js has no client-side multi-statement transactions, and per D1 we do
 * not invent one — state-coupled atomicity lives in the trigger path.
 *
 * Returns a discriminated result; the caller decides whether a failed emit is
 * fatal. Emission failures are logged and never throw, so a spine hiccup can
 * never break the primary action that asked for the event.
 */

export type EmitEventInput = {
  actorType: ActorType;
  /** HqActor.id | employee slug | cron/job name | org id. */
  actorId?: string | null;
  /** Must be a registered verb (compile-time enforced via the registry union). */
  verb: Verb;
  objectType: string;
  objectId: string;
  targetType?: string | null;
  targetId?: string | null;
  /**
   * The trace. Every event in one end-to-end intent shares it. Omit to start a
   * fresh trace (a standalone event that begins its own intent).
   */
  correlationId?: string;
  /** The id of the event that directly caused this one (a causal chain). */
  causationId?: number | null;
  severity?: Severity;
  payload?: Record<string, unknown>;
  /** `hq` by default; the seam for per-role scoping later (Ch.14). */
  visibility?: Visibility;
};

export type EmitEventResult =
  | { ok: true; id: number }
  | { ok: false; error: string };

// hq_emit_event isn't in the generated Supabase types yet; cast past the typed
// client (the q<T>/untypedAdminTable convention used across the HQ services).
type EmitRpc = (
  fn: "hq_emit_event",
  args: Record<string, unknown>,
) => Promise<{ data: number | string | null; error: { message: string } | null }>;

export async function emitEvent(input: EmitEventInput): Promise<EmitEventResult> {
  const correlationId = input.correlationId ?? crypto.randomUUID();

  try {
    const admin = createAdminClient();
    const rpc = admin.rpc.bind(admin) as unknown as EmitRpc;
    const { data, error } = await rpc("hq_emit_event", {
      p_actor_type: input.actorType,
      p_actor_id: input.actorId ?? null,
      p_verb: input.verb,
      p_object_type: input.objectType,
      p_object_id: input.objectId,
      p_target_type: input.targetType ?? null,
      p_target_id: input.targetId ?? null,
      p_correlation_id: correlationId,
      p_causation_id: input.causationId ?? null,
      p_severity: input.severity ?? "info",
      p_payload: input.payload ?? {},
      p_visibility: input.visibility ?? "hq",
    });

    if (error || data == null) {
      console.error("[event-spine] emitEvent failed", {
        verb: input.verb,
        object: `${input.objectType}/${input.objectId}`,
        error: error?.message,
      });
      return { ok: false, error: error?.message ?? "emit failed" };
    }

    // bigint comes back from PostgREST as a JS number (safe well past Module 1's
    // horizon) or, defensively, a numeric string — normalise to number.
    return { ok: true, id: Number(data) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[event-spine] emitEvent threw", { verb: input.verb, message });
    return { ok: false, error: message };
  }
}

// --- Partition maintenance ----------------------------------------------------

export type EnsurePartitionsResult = {
  ok: boolean;
  /** Partition names ensured this run (idempotent — includes ones already present). */
  ensured: string[];
  errors: { monthsAhead: number; error: string }[];
};

type EnsurePartitionRpc = (
  fn: "hq_create_events_partition",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/**
 * Ensure the current month + `monthsAhead` monthly partitions of `hq_events`
 * exist (Ch.03 "partition-creator cron runs ahead of need"). Idempotent: the SQL
 * function is a no-op when the partition is already present. Driven by the daily
 * `spine-partitions` cron so the DEFAULT catch-all partition stays empty in
 * normal operation.
 *
 * Anchors are pinned to the 1st of each month (midday UTC) so adding months can
 * never overflow a short month (the Jan-31 + 1-month pitfall); the SQL truncates
 * to the UTC month regardless.
 */
export async function ensureSpinePartitions(
  monthsAhead = 2,
): Promise<EnsurePartitionsResult> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as EnsurePartitionRpc;

  const ensured: string[] = [];
  const errors: { monthsAhead: number; error: string }[] = [];

  const base = new Date();
  base.setUTCDate(1);
  base.setUTCHours(12, 0, 0, 0);

  for (let m = 0; m <= monthsAhead; m++) {
    const anchor = new Date(base);
    anchor.setUTCMonth(base.getUTCMonth() + m);
    const { data, error } = await rpc("hq_create_events_partition", {
      p_anchor: anchor.toISOString(),
    });
    if (error || !data) {
      errors.push({
        monthsAhead: m,
        error: error?.message ?? "no partition name returned",
      });
    } else {
      ensured.push(data);
    }
  }

  if (errors.length > 0) {
    console.error("[event-spine] ensureSpinePartitions had errors", errors);
  }
  return { ok: errors.length === 0, ensured, errors };
}

// Re-export the envelope vocabulary so callers can import everything spine-shaped
// from one place.
export type { ActorType, Severity, Verb, Visibility } from "@/lib/events/registry";
export { isVerb, VERBS, VERB_GROUPS, verbNamespace } from "@/lib/events/registry";

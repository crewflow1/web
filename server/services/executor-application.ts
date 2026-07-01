import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  appliedRecord,
  failedRecord,
  type ApplicationRecord,
  type ApplicationStore,
  type ApproverAttribution,
  type ExecutionIdentity,
} from "@/server/sdk/application";

/**
 * CrewFlow HQ — the durable application store, service-layer binding
 * (CEO Directive #016 / D-06, increment R3; ADR 0011 Decision 4; ADR 0009 Decisions 5, 6, 9;
 * the Application Atomicity Rule, the Executor Idempotency Rule, and the Shadow Isolation Rule —
 * Kernel Contract Map §2).
 *
 * This is the production binding of the pure {@link ApplicationStore} seam `applyOnce` records
 * through (the in-memory reference lives in `server/sdk/application.ts`). Reads flow through
 * `hq_get_application` and writes through `hq_put_application` — validated SECURITY DEFINER
 * functions with EXECUTE granted to service_role only — exactly the hardening shape the HQ Event
 * Spine's `emitEvent` and the R2 shadow store use.
 *
 * NOT AN OBSERVER — A PARTICIPANT. Unlike {@link import("./executor-shadow")}, which is
 * best-effort and NEVER throws (a lost shadow observation must not break the run it watches), the
 * application store is the idempotency GROUND TRUTH. `applyOnce` consults `get` BEFORE it crosses
 * the executor boundary and files the outcome with `put` after — so if a read or write fails, the
 * only safe thing is to SURFACE it: this module therefore THROWS on error rather than swallowing.
 * Crossing the boundary without a reliable prior-state read, or crossing it and failing to record
 * the result, is precisely how a double apply happens; a raised error fails the run (retryable)
 * instead of silently risking one.
 *
 * STRUCTURALLY ISOLATED FROM THE SHADOW STORE (the Shadow Isolation Rule). This binds the
 * `hq_ai_applications` table — keyed by the deterministic idempotency key, with an `applied` /
 * `failed` vocabulary — never `hq_ai_executor_shadow_observations` (synthetic id, `planned` /
 * `refused` / `error`). The two shapes do not overlap, so a shadow row and an applied row can
 * never be read as one another.
 */

// hq_get_application / hq_put_application aren't in the generated Supabase types yet; cast past
// the typed client (the same convention event-spine.ts and executor-shadow.ts use).
type GetApplicationRpc = (
  fn: "hq_get_application",
  args: Record<string, unknown>,
) => Promise<{ data: PersistedApplicationRow | null; error: { message: string } | null }>;

type PutApplicationRpc = (
  fn: "hq_put_application",
  args: Record<string, unknown>,
) => Promise<{ data: string | null; error: { message: string } | null }>;

/** The `hq_ai_applications` row as `to_jsonb` returns it — snake_case, discriminated by `status`. */
interface PersistedApplicationRow {
  idempotency_key: string;
  status: "applied" | "failed";
  identity: ExecutionIdentity;
  label: string;
  attempts: number;
  approver: ApproverAttribution | null;
  result: unknown;
  error: string | null;
  escalated: boolean | null;
  recorded_at: string;
  updated_at: string;
}

/**
 * Rebuild the frozen {@link ApplicationRecord} from a persisted row, through the pure contract's
 * own builders ({@link appliedRecord} / {@link failedRecord}) — so a revived record is identical
 * in shape and immutability to one the runner just wrote.
 */
function reviveApplicationRecord(row: PersistedApplicationRow): ApplicationRecord {
  const base = {
    key: row.idempotency_key,
    identity: row.identity,
    label: row.label,
    attempts: row.attempts,
    approver: row.approver ?? null,
  } as const;
  if (row.status === "applied") {
    return appliedRecord({ ...base, result: row.result ?? null });
  }
  return failedRecord({
    ...base,
    error: row.error ?? "",
    escalated: row.escalated ?? false,
  });
}

/**
 * Read the application record filed under `key`, or `undefined` — the no-op-success lookup
 * `applyOnce` consults before crossing the boundary. THROWS on a store error: an unreadable
 * ground truth must fail the run, never be treated as "no prior record" (which would risk a
 * double apply).
 */
export async function getApplication(key: string): Promise<ApplicationRecord | undefined> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as GetApplicationRpc;
  const { data, error } = await rpc("hq_get_application", { p_key: key });
  if (error) {
    throw new Error(`[executor-application] get failed: ${error.message}`);
  }
  if (data == null) return undefined;
  return reviveApplicationRecord(data);
}

/**
 * Persist (insert-or-progress) an application record under its own key. THROWS on a store error —
 * including the applied-terminal guard rejecting an upsert onto an already-applied row (a double
 * apply the DB refuses to record over the ground truth).
 */
export async function putApplication(record: ApplicationRecord): Promise<void> {
  const admin = createAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as PutApplicationRpc;
  const { data, error } = await rpc("hq_put_application", {
    p_key: record.key,
    p_status: record.status,
    p_identity: record.identity,
    p_label: record.label,
    p_attempts: record.attempts,
    p_approver: record.approver,
    p_result: record.status === "applied" ? (record.result ?? null) : null,
    p_error: record.status === "failed" ? record.error : null,
    p_escalated: record.status === "failed" ? record.escalated : null,
  });
  if (error || data == null) {
    throw new Error(
      `[executor-application] put failed: ${error?.message ?? "no key returned"}`,
    );
  }
}

/**
 * The production {@link ApplicationStore} — binds the durable RPC primitives into the apply-once
 * store seam `applyOnce` records through. The server-only counterpart of
 * `createInMemoryApplicationStore` (the pure reference): same contract, real persistence, and
 * ground-truth error propagation (never best-effort).
 */
export function createDurableApplicationStore(): ApplicationStore {
  return Object.freeze({
    get: getApplication,
    put: putApplication,
  });
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type AppliedApplicationRecord,
  type ApplicationPutResult,
  type ApplicationRecord,
  type ApplicationStore,
  type ExecutionIdentity,
} from "@/server/sdk/application";

/**
 * CrewFlow HQ — the durable apply-on-approval record store, service-layer write + read primitive
 * (CEO Directive #014 / D-04, Phase C, increment C3 rollout; ADR 0009 Decisions 4, 5, 6, 9; the
 * Executor Idempotency Rule — Kernel Contract Map §2).
 *
 * This is the production binding of the pure {@link ApplicationStore} seam
 * (`server/sdk/application.ts`), the direct analogue of `createDurableShadowObservationStore`
 * (`server/services/executor-shadow.ts`): same contract, real persistence. It writes through the
 * validated SECURITY DEFINER function `hq_record_application` (EXECUTE granted to service_role only)
 * into `public.hq_application_records` (migration 20261106000000) — the exact hardening shape the HQ
 * Event Spine and the executor-shadow store use.
 *
 * TWO STORES, NEVER ONE. A shadow write can never land here and an application write can never land
 * in the shadow store: the tables are structurally separate, and each has a `status`/`outcome` CHECK
 * over its OWN vocabulary, so the ground truth the apply-once guard reads can never be poisoned by a
 * shadow observation (the Shadow Truthfulness Rule).
 *
 * APPEND-ONLY, LATEST-WINS. The table blocks UPDATE/DELETE even under service-role, so the audit of
 * every attempt is permanent. Each attempt writes a NEW row under the same idempotency `key`; {@link
 * ApplicationStore.get} reads the LATEST row (id desc) as the live apply-once state. A prior
 * `applied` row makes a re-run a no-op success; a prior `escalated` failure stops the sweep's
 * auto-retry (`applyOnce`, `server/sdk/application.ts`).
 *
 * NOT BEST-EFFORT (unlike the shadow store). This IS the idempotency ground truth: a lost `put` on
 * an applied action would let the next sweep re-apply it. So a hard persistence fault THROWS at the
 * boundary rather than being swallowed — the sweep records the run as failed and re-attempts, which
 * (given the applied row DID land or DID NOT) the natural-key guard then reconciles.
 *
 * EXACTLY ONE `applied` MARKER PER KEY, UNDER CONCURRENCY (the P2 close-out). `get → applyOnce → put`
 * is a read-then-write with no mutual exclusion, so two concurrent drains could BOTH read `undefined`
 * and BOTH try to file an `applied` row. The table's partial unique index (`(key) WHERE status =
 * 'applied'`, migration 20261106000000) makes that structurally impossible: the loser's insert is
 * refused with Postgres 23505, which {@link putApplicationRecord} reconciles by re-reading the WINNING
 * `applied` row and returning `already_applied` — NOT an error and NOT a second apply. Non-applied
 * (failed/escalated) attempts are unconstrained, so latest-wins history is preserved; a NON-23505
 * fault still throws (this is the idempotency ground truth, not best-effort).
 */

// hq_record_application isn't in the generated Supabase types; cast past the typed client (the same
// convention executor-shadow.ts / event-spine.ts use for their SECURITY DEFINER RPCs).
type RecordApplicationRpc = (
  fn: "hq_record_application",
  args: Record<string, unknown>,
) => Promise<{
  data: number | string | null;
  // `code` carries the Postgres SQLSTATE PostgREST surfaces for an RPC fault — 23505 (unique_violation)
  // is the exactly-once signal from the partial `applied` unique index.
  error: { message: string; code?: string | null } | null;
}>;

/** Postgres unique_violation (SQLSTATE 23505) — the exactly-once signal from `hq_application_records_applied_uniq`. */
function isUniqueViolation(error: { code?: string | null; message?: string }): boolean {
  return error.code === "23505" || /duplicate key value|unique constraint/i.test(error.message ?? "");
}

type AdminClient = ReturnType<typeof createAdminClient>;

/** The append-only application-record table — the durable home for "applied" markers (RLS:hq). */
const RECORDS_TABLE = "hq_application_records";

/** The persisted row shape (service-role-only; not in the generated types). */
type ApplicationRow = {
  key: string;
  status: "applied" | "failed";
  source: "autonomous" | "approval";
  correlation_id: string;
  task_id: string | null;
  approval_id: string | null;
  tool_label: string;
  action_id: string;
  attempts: number;
  escalated: boolean;
  approver_id: string | null;
  approver_email: string | null;
  result: unknown;
  error: string | null;
};

// hq_application_records is a service-role-only HQ table, not in the generated Supabase types — cast
// past the typed client to the minimal read surface `get` needs (the `as unknown as` shim the
// executor-shadow lookup uses).
type LookupQuery = {
  select(columns: string): LookupQuery;
  eq(column: string, value: unknown): LookupQuery;
  order(column: string, options?: { ascending?: boolean }): LookupQuery;
  limit(count: number): LookupQuery;
} & PromiseLike<{ data: ApplicationRow[] | null; error: { message: string } | null }>;

/**
 * Rebuild the pure {@link ExecutionIdentity} from a persisted row. The discriminant is `source`;
 * each arm carries exactly the identity fields that path is keyed by (autonomous → task_id, approval
 * → approval_id), so the reconstructed identity is the same shape `deriveIdempotencyKey` consumes.
 */
function identityOf(row: ApplicationRow): ExecutionIdentity {
  if (row.source === "approval") {
    return {
      source: "approval",
      correlationId: row.correlation_id,
      approvalId: row.approval_id ?? "",
      toolLabel: row.tool_label,
      actionId: row.action_id,
    };
  }
  return {
    source: "autonomous",
    correlationId: row.correlation_id,
    taskId: row.task_id ?? "",
    toolLabel: row.tool_label,
    actionId: row.action_id,
  };
}

/** Rebuild an {@link ApplicationRecord} from a persisted row (the discriminated applied/failed marker). */
function recordOf(row: ApplicationRow): ApplicationRecord {
  const base = {
    key: row.key,
    identity: identityOf(row),
    label: row.tool_label,
    attempts: row.attempts,
    approver:
      row.approver_id || row.approver_email
        ? { approverId: row.approver_id, approverEmail: row.approver_email }
        : null,
  };
  if (row.status === "applied") {
    return { ...base, status: "applied", result: row.result };
  }
  return { ...base, status: "failed", error: row.error ?? "", escalated: row.escalated };
}

/**
 * The LATEST application record filed under `key` (id desc), or `undefined` when none exists — the
 * live apply-once state the guard reads (`applyOnce`). A read fault THROWS: unlike the shadow
 * lookup, treating a failed read as "no prior record" would let an applied action re-apply, which is
 * the exact failure the idempotency rule forbids.
 */
async function getApplicationRecord(
  admin: AdminClient,
  key: string,
): Promise<ApplicationRecord | undefined> {
  const query = admin.from(RECORDS_TABLE as never) as unknown as LookupQuery;
  const { data, error } = await query
    .select(
      "key, status, source, correlation_id, task_id, approval_id, tool_label, action_id, " +
        "attempts, escalated, approver_id, approver_email, result, error",
    )
    .eq("key", key)
    .order("id", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`hq-application: get("${key}") failed: ${error.message}`);
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.length > 0 ? recordOf(rows[0]!) : undefined;
}

/**
 * The single `applied` record filed under `key` (id desc), or `undefined`. Used to RECONCILE a
 * concurrent loser: after a 23505 on the partial unique index, this reads back the WINNER's `applied`
 * row so the loser reports `already_applied` with the winning record rather than a phantom second apply.
 * A read fault THROWS (same reasoning as {@link getApplicationRecord}).
 */
async function getAppliedRecord(
  admin: AdminClient,
  key: string,
): Promise<AppliedApplicationRecord | undefined> {
  const query = admin.from(RECORDS_TABLE as never) as unknown as LookupQuery;
  const { data, error } = await query
    .select(
      "key, status, source, correlation_id, task_id, approval_id, tool_label, action_id, " +
        "attempts, escalated, approver_id, approver_email, result, error",
    )
    .eq("key", key)
    .eq("status", "applied")
    .order("id", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`hq-application: get("${key}") failed: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data : [])[0];
  if (!row) return undefined;
  const record = recordOf(row);
  return record.status === "applied" ? record : undefined;
}

/**
 * Append one application record durably through the SECURITY DEFINER RPC.
 *
 * THROWS on a hard fault — this write is the idempotency ground truth, not a best-effort observation —
 * EXCEPT the one benign, expected concurrency outcome: an `applied` insert refused by the partial
 * unique index with Postgres 23505 (unique_violation) means a competing drain already won the SINGLE
 * `applied` row for this key. That is NOT a fault and NOT a second apply: we RECONCILE by re-reading
 * the winning `applied` row and returning `already_applied` (so {@link applyOnce} reports the same and
 * never files a second marker). A failed/escalated write is unconstrained and cannot take this path.
 */
async function putApplicationRecord(
  admin: AdminClient,
  record: ApplicationRecord,
): Promise<ApplicationPutResult> {
  const identity = record.identity;
  const rpc = admin.rpc.bind(admin) as unknown as RecordApplicationRpc;
  const { data, error } = await rpc("hq_record_application", {
    p_key: record.key,
    p_status: record.status,
    p_source: identity.source,
    p_correlation_id: identity.correlationId,
    p_tool_label: record.label,
    p_action_id: identity.actionId,
    p_task_id: identity.source === "autonomous" ? identity.taskId : null,
    p_approval_id: identity.source === "approval" ? identity.approvalId : null,
    p_attempts: record.attempts,
    p_escalated: record.status === "failed" ? record.escalated : false,
    p_approver_id: record.approver?.approverId ?? null,
    p_approver_email: record.approver?.approverEmail ?? null,
    p_result: record.status === "applied" ? (record.result ?? null) : null,
    p_error: record.status === "failed" ? record.error : null,
  });
  if (error) {
    // Exactly-once reconciliation: the losing drain of an `applied` race. Re-read the winning row and
    // report it — never throw, never re-apply. Only an `applied` insert can hit the partial index.
    if (record.status === "applied" && isUniqueViolation(error)) {
      const winner = await getAppliedRecord(admin, record.key);
      if (winner) {
        return { status: "already_applied", record: winner };
      }
      // The unique index fired but no `applied` row is readable — a genuine inconsistency; fail loud.
      throw new Error(
        `hq-application: put("${record.key}") hit a unique violation but the winning applied row was not found`,
      );
    }
    throw new Error(`hq-application: put("${record.key}") failed: ${error.message}`);
  }
  if (data == null) {
    throw new Error(`hq-application: put("${record.key}") failed: no id returned`);
  }
  return { status: "stored" };
}

/**
 * The production {@link ApplicationStore} — binds the durable table into the apply-once seam the
 * runtime records through. The server-only counterpart of `createInMemoryApplicationStore` (the pure
 * reference): same contract, real persistence, append-only + latest-wins, and NOT best-effort (it
 * throws on a hard fault, because it is the idempotency ground truth).
 */
export function createDurableApplicationStore(): ApplicationStore {
  const admin = createAdminClient();
  return Object.freeze({
    get: (key: string) => getApplicationRecord(admin, key),
    put: (record: ApplicationRecord) => putApplicationRecord(admin, record),
  });
}

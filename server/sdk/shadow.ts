import type { ExecutionRefusalReason } from "./executor";

/**
 * CrewFlow HQ — the durable executor-shadow observation
 * (CEO Directive #016 / D-06, increment R2; ADR 0011; the Shadow Truthfulness Rule — Kernel Contract
 * Map §2, the thirtieth standard).
 *
 * R1 composed the executor shadow into the runner's autonomous branch (default-off) and recorded what
 * it WOULD apply as an IN-BAND fragment on the `ai.action_permitted` audit event — durable on the
 * spine, but not a first-class, queryable record, and (rightly) NO application record at all:
 * `store.put` was deferred because, in shadow, no applied effect occurred to record. R2 gives that
 * observation a FIRST-CLASS durable home — this module — WITHOUT ever writing something a real apply
 * is indistinguishable from.
 *
 * EXPLICITLY SHADOW, NEVER AN APPLICATION (the Shadow Truthfulness Rule). A {@link
 * ShadowObservationRecord} carries an unconditional `kind: "executor_shadow"` label and an `outcome`
 * drawn from the shadow's own vocabulary (`planned` / `refused` / `error`) — it has NO `applied` /
 * `failed` status, so it is STRUCTURALLY impossible to confuse with an {@link
 * import("./application").ApplicationRecord}. The two live in separate modules and separate stores by
 * construction: a shadow write can never land where the real apply-once path reads, so it cannot
 * poison the idempotency ground truth a later real apply depends on. This is the rule made a matter of
 * type: *a shadow record persisted in a later phase must be explicitly labelled as shadow.*
 *
 * THE THREE-WAY DISTINCTION THE ROLLOUT PRESERVES — planned · shadow-observed · applied. `planned` is
 * the pure plan the executor produced (carried here with the idempotency key the real apply WOULD use,
 * so a future cut-over can compare a shadow-observed record to the applied record keyed identically);
 * `shadow-observed` is THIS durable record (`kind: "executor_shadow"`); `applied` is the {@link
 * import("./application").ApplicationRecord}, written ONLY by a real apply at cut-over — never by the
 * shadow.
 *
 * Pure + I/O-free (deliberately NO `server-only`): the only import is the sibling pure contract {@link
 * import("./executor")}, and only its {@link ExecutionRefusalReason} TYPE — so at runtime this module
 * imports nothing. Like {@link import("./application")}, the timeline / Boardroom UI may import these
 * types to render what a shadow observation IS. The DURABLE store (the table + the SECURITY DEFINER
 * write) is the injected seam `createDurableShadowObservationStore` binds in `server/services` — this
 * module ships only the contract and an in-memory reference, exactly as {@link
 * import("./application").createInMemoryApplicationStore} does for the application marker.
 */

// ---------------------------------------------------------------------
// The observation — what the executor shadow OBSERVED for one cleared action
// ---------------------------------------------------------------------

/**
 * A side-effect-free observation of what the executor WOULD do with a cleared autonomous action — the
 * shadow's only product (R1; observe-only). It is DATA, never an applied effect:
 *
 *   • `planned`  — the executor produced a plan; we carry the resolved tool label and the derived
 *                  idempotency key (the application-store KEYING contract, computed but NEVER written).
 *   • `refused`  — the executor declined at its own boundary (an {@link ExecutionRefusalReason}).
 *   • `error`    — observing threw; recorded, never raised (best-effort, like the audit emit).
 *
 * This is the canonical shape the runner's `observeExecutorShadow` returns and the durable {@link
 * ShadowObservationRecord} is built from — defined HERE (the pure contract) so the server-only runner
 * consumes it rather than owning it.
 */
export type ExecutorShadowObservation =
  | { readonly outcome: "planned"; readonly toolLabel: string; readonly idempotencyKey: string }
  | { readonly outcome: "refused"; readonly reason: ExecutionRefusalReason; readonly detail: string }
  | { readonly outcome: "error"; readonly detail: string };

/** What a shadow observation concluded — the shadow's OWN vocabulary, never `applied` / `failed`. */
export type ShadowObservationOutcome = ExecutorShadowObservation["outcome"];

// ---------------------------------------------------------------------
// The durable record — explicitly shadow-labelled, beside (never inside) the application marker
// ---------------------------------------------------------------------

/**
 * A durable executor-shadow observation — the `shadow-observed` record (the Shadow Truthfulness Rule).
 * EXPLICITLY shadow-labelled by the unconditional `kind` discriminant and an `outcome` that is never an
 * application status, so a reader (a later apply, an idempotency check, an audit) can NEVER mistake it
 * for a real {@link import("./application").AppliedApplicationRecord}. Frozen — a recorded observation
 * is immutable.
 *
 * `source` is `autonomous` only: R2 shadows the autonomous branch (the apply-by-accident surface),
 * never the approval path. `idempotencyKey` / `toolLabel` are populated for `planned` and `null`
 * otherwise; `reason` is populated for `refused` and `null` otherwise; `detail` carries the
 * refusal/error message (empty for `planned`).
 */
export interface ShadowObservationRecord {
  /** The unconditional shadow label — this record is a SHADOW observation, never an application. */
  readonly kind: "executor_shadow";
  /** What the shadow observed — the shadow's own vocabulary, never an application status. */
  readonly outcome: ShadowObservationOutcome;
  /** The apply path shadowed. R2: `autonomous` only (the approval path is not shadowed). */
  readonly source: "autonomous";
  /** The run's spine trace id — threads the observation to the originating run. */
  readonly correlationId: string;
  /** The originating task's id — the autonomous path is keyed by the task. */
  readonly taskId: string;
  /** The action's stable identity within the run (`subjectType:subjectId:type`). */
  readonly actionId: string;
  /** The resolved tool label (`planned` only), else `null`. */
  readonly toolLabel: string | null;
  /** The idempotency key the REAL apply would file under (`planned` only), else `null`. */
  readonly idempotencyKey: string | null;
  /** The executor's refusal reason (`refused` only), else `null`. */
  readonly reason: ExecutionRefusalReason | null;
  /** The refusal/error detail; empty string for `planned`. */
  readonly detail: string;
}

/** The identity context a {@link ShadowObservationRecord} is built with (the run + action it pertains to). */
export interface ShadowObservationContext {
  readonly source: "autonomous";
  readonly correlationId: string;
  readonly taskId: string;
  readonly actionId: string;
}

/**
 * Build a frozen {@link ShadowObservationRecord} from a shadow observation and its run/action context.
 * PURE and TOTAL: no clock, no randomness, no I/O — the durable `observed_at` is assigned by the store,
 * not the record (mirroring {@link import("./application").appliedRecord}, which carries no timestamp).
 * The `kind` label is stamped unconditionally; the per-outcome fields are populated from the
 * discriminated observation so a malformed record is unrepresentable.
 */
export function shadowObservationRecord(
  context: ShadowObservationContext,
  observation: ExecutorShadowObservation,
): ShadowObservationRecord {
  const base = {
    kind: "executor_shadow",
    outcome: observation.outcome,
    source: context.source,
    correlationId: context.correlationId,
    taskId: context.taskId,
    actionId: context.actionId,
  } as const;

  if (observation.outcome === "planned") {
    return Object.freeze({
      ...base,
      toolLabel: observation.toolLabel,
      idempotencyKey: observation.idempotencyKey,
      reason: null,
      detail: "",
    });
  }
  if (observation.outcome === "refused") {
    return Object.freeze({
      ...base,
      toolLabel: null,
      idempotencyKey: null,
      reason: observation.reason,
      detail: observation.detail,
    });
  }
  return Object.freeze({
    ...base,
    toolLabel: null,
    idempotencyKey: null,
    reason: null,
    detail: observation.detail,
  });
}

// ---------------------------------------------------------------------
// The persistence seam — an injected store, with an in-memory reference
// ---------------------------------------------------------------------

/**
 * The outcome of a durable shadow write — discriminated, mirroring the event spine's `EmitEventResult`.
 * The write is BEST-EFFORT: a failed shadow persistence must never break the run it observes (the
 * shadow is an observer, not a participant), so the store NEVER throws — it returns this instead.
 */
export type ShadowObservationWriteResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly error: string };

/**
 * The durable shadow observation store — an INJECTED seam. The real implementation is a DB-backed,
 * service-role-only table written through a SECURITY DEFINER function
 * (`createDurableShadowObservationStore`, `server/services/executor-shadow.ts`), mirroring the event
 * spine's `hq_emit_event`. This contract types the seam (so the runner can record without knowing
 * where it lands) and ships an in-memory reference ({@link createInMemoryShadowObservationStore}). It
 * is APPEND-ONLY: a shadow observation is a fact about one run, never updated.
 */
export interface ShadowObservationStore {
  /** Append a shadow observation durably. BEST-EFFORT — never throws (returns the outcome). */
  record(record: ShadowObservationRecord): Promise<ShadowObservationWriteResult>;
}

/**
 * An in-memory {@link ShadowObservationStore} — the reference implementation (no DB, no I/O). It exists
 * so the durable-shadow behaviour can be tested and driven end-to-end without a migration, exactly as
 * {@link import("./application").createInMemoryApplicationStore} does for the application marker. The
 * array is private to the closure; the facade is frozen. `recorded()` exposes what was appended (in
 * order) for assertions — the production interface stays write-only.
 */
export function createInMemoryShadowObservationStore(): ShadowObservationStore & {
  recorded(): readonly ShadowObservationRecord[];
} {
  const records: ShadowObservationRecord[] = [];
  let nextId = 1;
  return Object.freeze({
    async record(record: ShadowObservationRecord): Promise<ShadowObservationWriteResult> {
      records.push(record);
      return { ok: true, id: nextId++ };
    },
    recorded(): readonly ShadowObservationRecord[] {
      return records;
    },
  });
}

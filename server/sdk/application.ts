import type { ExecutionOutcome } from "./executor";

/**
 * CrewFlow HQ — the apply-on-approval marker
 * (CEO Directive #014 / D-04, Phase C, increment C3; ADR 0009 Decisions 4, 5, 6, 9, 10; Bible
 * Volume XIII §15).
 *
 * When the doorman routes an action to a human (a `needs_approval` verdict, Phase B) and a reviewer
 * later GRANTS it, something must apply that granted action exactly once, record that it was applied,
 * and never apply it twice — even though the Task Engine retries the whole task and the out-of-band
 * sweep may re-run. This module is the TYPED CONTRACT for that record and its idempotency — the
 * "applied" marker, the deterministic idempotency key it is filed under, the granular failure record,
 * and the persistence seam it lives behind — and nothing more.
 *
 * A SEPARATE RECORD, NEVER A SIXTH APPROVAL STATE (ADR 0009 Decision 5; the CEO's second ruling).
 * The Approval Engine is five terminal-immutable states (`lib/approvals/state.ts`), and `approved` is
 * frozen forever. "Applied" is therefore NOT a state transition — adding one would reopen frozen
 * contract #6, which the CEO forbade ("Do not reopen the Approval Engine state machine"). An {@link
 * ApplicationRecord} sits BESIDE `hq_approvals`, keyed by the application's idempotency key; it is the
 * executor's source of truth for what has already been applied and what is still unapplied. This
 * module imports nothing from the Approval Engine and names none of its states — the separation is
 * structural.
 *
 * IDEMPOTENT BY A DETERMINISTIC KEY, NEVER BY "PROBABLY ONCE" (the Executor Idempotency Rule —
 * Kernel Contract Map §2, set on the C2 review; ADR 0009 Decision 6). Every application carries a key
 * DERIVED from stable execution identity — `deriveIdempotencyKey` over a task id · approval id · tool
 * label · action id · correlation id ({@link ExecutionIdentity}) — so the same identity always yields
 * the same key, with no clock and no randomness. {@link applyOnce} consults the record store BEFORE it
 * crosses the boundary: an already-applied key is a NO-OP SUCCESS (the Approval Engine's own idiom —
 * "re-deciding a row already in the target terminal state is a no-op success",
 * `server/services/hq-approvals.ts`), so a retry or a second sweep re-applies nothing. This is the
 * phase's central guarantee — a task that applied A then failed on B must not re-apply A — made a
 * matter of source.
 *
 * GRANULAR FAILURE, ESCALATION ON EXHAUSTION (ADR 0009 Decision 9; the CEO's fourth ruling). A
 * cleared tool whose invocation then FAILS is captured as a {@link FailedApplicationRecord}, leaving
 * the action UNAPPLIED and safe to re-attempt on the next sweep, bounded by a retry ceiling; an action
 * that exhausts the ceiling ESCALATES (a human already owns it) rather than silently dropping or
 * retrying forever. The marker honours the approval's `edited_payload ?? proposed_payload` ({@link
 * resolveAppliedPayload}) and attributes the human approver ({@link ApproverAttribution}) — ADR 0009
 * Decisions 4 and 10.
 *
 * PERSISTENCE IS AN INJECTED SEAM (Decision 5). The record's physical table and the out-of-band sweep
 * that writes it are the executor ROLLOUT — deliberately out of C3's scope (the CEO's "no executor
 * rollout"). This contract defines the record, the key, and an {@link ApplicationStore} INTERFACE,
 * with an in-memory reference ({@link createInMemoryApplicationStore}) so the apply-once guarantee can
 * be proven end-to-end without a migration — exactly as C2 proved the executor through an injected
 * {@link import("./executor").ToolImplementation}, not a real runner.
 *
 * WHAT THIS INCREMENT IS NOT (the CEO's C3 scope, 2026-06-28). No executor rollout — no runner wiring
 * (`server/sdk/tasks.ts` is untouched), no out-of-band approved-row sweep or cron, no real DB-backed
 * store, and no migration; those compose this contract LATER. No API Gateway and no live cost metering
 * — Phase D. No Capability Registry — Directive #015. No employee migration. This file changes no
 * existing code.
 *
 * Pure + I/O-free (deliberately NO `server-only`): the only import is the sibling pure contract {@link
 * import("./executor")}, and only its {@link import("./executor").ExecutionOutcome} TYPE — so at
 * runtime this module imports nothing at all. Like {@link import("./tools")}, {@link
 * import("./gate")}, {@link import("./executor")} and {@link import("./output")}, the timeline /
 * Boardroom UI may import these types to render what an application is. It reaches for no server
 * module, no admin client, no facet, and no approval or task surface — the only effect ever performed
 * is the injected {@link ApplyOnceInput.apply}, and that belongs to the caller.
 */

// ---------------------------------------------------------------------
// Execution identity — what the idempotency key derives from (Decision 6)
// ---------------------------------------------------------------------

/**
 * The human approver an application is attributed to (ADR 0009 Decision 10 — "attributing the
 * approver"). Mirrors the Approval Engine's `Reviewer` shape (`server/services/hq-approvals.ts`):
 * both fields are nullable, because a system/autonomous application has no human approver (`null`),
 * while an approval-path application carries the reviewer who granted it.
 */
export interface ApproverAttribution {
  /** The approver's id (the spine `actor_id`), or `null` for a system/autonomous application. */
  readonly approverId: string | null;
  /** The approver's email (the reviewer gate's identity), or `null` when there is no human. */
  readonly approverEmail: string | null;
}

/**
 * The stable execution identity an idempotency key is derived from (ADR 0009 Decision 6; the Executor
 * Idempotency Rule). A discriminated union over the two apply paths, so each carries exactly the
 * fields that path is keyed by — the type makes a malformed identity unrepresentable:
 *
 *   • `autonomous` — the inline path: keyed by the run's `correlationId` + the action's identity
 *     (`taskId` + `actionId`), per Decision 6 ("the run's correlationId + the action's identity").
 *   • `approval` — the out-of-band apply-on-approval path: keyed by the `approvalId` + the action's
 *     identity, per Decision 6 ("for an approval, the approval id").
 *
 * Both carry the `toolLabel` (the capability applied) and a stable `actionId` (the action's identity
 * within the run). All fields are required, non-empty strings — {@link deriveIdempotencyKey} rejects an
 * empty segment, because a key derived from an incomplete identity would silently break the guarantee
 * the rule exists to make.
 */
export type ExecutionIdentity =
  | {
      /** The inline (autonomous) apply path. */
      readonly source: "autonomous";
      /** The run's spine trace id — threads the application into the originating run. */
      readonly correlationId: string;
      /** The originating task's id (the inline path is keyed by the task, not an approval). */
      readonly taskId: string;
      /** The registered tool's label — the capability being applied. */
      readonly toolLabel: string;
      /** The action's stable identity within the run — distinguishes sibling actions. */
      readonly actionId: string;
    }
  | {
      /** The out-of-band apply-on-approval path. */
      readonly source: "approval";
      /** The run's spine trace id — threads the application into the originating run. */
      readonly correlationId: string;
      /** The granted approval's id (the approval path is keyed by the approval). */
      readonly approvalId: string;
      /** The registered tool's label — the capability being applied. */
      readonly toolLabel: string;
      /** The action's stable identity within the run — distinguishes sibling actions. */
      readonly actionId: string;
    };

/** The delimiter joining the key's segments — the CEO's own notation (`a · b · c`). */
const KEY_DELIMITER = "·";

/**
 * Require a non-empty string segment, or throw. Deriving a key from an empty required field would let
 * two distinct applications collide on one key — silently re-applying or silently skipping — which is
 * exactly the "probably once" failure the Executor Idempotency Rule forbids. A contract violation, so
 * it throws loudly at the boundary (the house idiom — `createToolRegistry` throws on a duplicate
 * label), rather than returning a degraded key.
 */
function requireSegment(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`deriveIdempotencyKey: "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Derive the deterministic idempotency key for an application (the Executor Idempotency Rule; ADR 0009
 * Decision 6). PURE and TOTAL over a valid identity: same identity → same key, ALWAYS — no clock, no
 * randomness, no I/O. The key is the path discriminant followed by the identity's stable fields, each
 * `encodeURIComponent`-escaped (so no segment can ever contain the `·` delimiter — making the join
 * unambiguous and collision-free) and joined by {@link KEY_DELIMITER}. The two paths live in distinct
 * namespaces (`autonomous` vs `approval`), so an autonomous key and an approval key can never collide.
 * Throws on an empty required segment ({@link requireSegment}).
 */
export function deriveIdempotencyKey(identity: ExecutionIdentity): string {
  const segments =
    identity.source === "approval"
      ? [
          "approval",
          requireSegment(identity.approvalId, "approvalId"),
          requireSegment(identity.toolLabel, "toolLabel"),
          requireSegment(identity.actionId, "actionId"),
          requireSegment(identity.correlationId, "correlationId"),
        ]
      : [
          "autonomous",
          requireSegment(identity.taskId, "taskId"),
          requireSegment(identity.toolLabel, "toolLabel"),
          requireSegment(identity.actionId, "actionId"),
          requireSegment(identity.correlationId, "correlationId"),
        ];
  return segments.map(encodeURIComponent).join(KEY_DELIMITER);
}

// ---------------------------------------------------------------------
// edited_payload — honour the reviewer's revision (Decisions 4 & 10)
// ---------------------------------------------------------------------

/**
 * Resolve the payload an approved action is applied with — `edited_payload ?? proposed_payload` (ADR
 * 0009 Decisions 4 and 10; Volume XIII §15). A reviewer may revise a proposal before granting it
 * (`approveApproval`'s `editedPayload`, `server/services/hq-approvals.ts`), and the executor must
 * apply the REVISED payload when one exists, falling back to the original proposal otherwise. Pure:
 * `null`/`undefined` edited payload yields the proposal; any edited payload (including `{}`) yields the
 * edit. Mirrors the Approval Engine's nullable `edited_payload` column.
 */
export function resolveAppliedPayload(
  proposed: Record<string, unknown>,
  edited?: Record<string, unknown> | null,
): Record<string, unknown> {
  return edited ?? proposed;
}

// ---------------------------------------------------------------------
// The application record — the "applied" marker, beside hq_approvals
// ---------------------------------------------------------------------

/** The fields every application record carries, applied or failed. */
export interface ApplicationRecordBase {
  /** The idempotency key this record is filed under ({@link deriveIdempotencyKey}). */
  readonly key: string;
  /** The execution identity the key derived from — carried for audit and the sweep's queries. */
  readonly identity: ExecutionIdentity;
  /** The registered tool's label that was applied (from the {@link ExecutionOutcome}). */
  readonly label: string;
  /** How many times application has been ATTEMPTED, including the attempt this record captures. */
  readonly attempts: number;
  /** The human approver attributed (approval path), or `null` (autonomous/system path). */
  readonly approver: ApproverAttribution | null;
}

/** An action applied successfully — the marker that makes a re-attempt a no-op success. */
export interface AppliedApplicationRecord extends ApplicationRecordBase {
  readonly status: "applied";
  /** The implementation's result, captured from the {@link ExecutionOutcome}. */
  readonly result: unknown;
}

/**
 * An application ATTEMPT that failed — the granular failure record (ADR 0009 Decision 9). The action
 * stays unapplied and safe to re-attempt; once `escalated` is true the ceiling was exhausted and a
 * human owns it, so the sweep must stop auto-retrying.
 */
export interface FailedApplicationRecord extends ApplicationRecordBase {
  readonly status: "failed";
  /** The captured failure message (from the {@link ExecutionOutcome}). */
  readonly error: string;
  /** `true` once `attempts` reached the retry ceiling — escalated, not silently dropped. */
  readonly escalated: boolean;
}

/** The application record — a discriminated applied/failed marker, filed under the idempotency key. */
export type ApplicationRecord = AppliedApplicationRecord | FailedApplicationRecord;

/** The default retry ceiling for an out-of-band application — mirrors the Task Engine's `max_retries` default of 3. */
export const DEFAULT_APPLICATION_RETRY_CEILING = 3;

/**
 * Whether a failed application should ESCALATE rather than be re-attempted (ADR 0009 Decision 9). Pure:
 * `true` once the number of attempts has reached the ceiling. `ceiling` defaults to {@link
 * DEFAULT_APPLICATION_RETRY_CEILING}; the originating task is already terminal on the approval path, so
 * this bound — not the task's own retry — governs the out-of-band sweep.
 */
export function shouldEscalate(
  attempts: number,
  ceiling: number = DEFAULT_APPLICATION_RETRY_CEILING,
): boolean {
  return attempts >= ceiling;
}

/**
 * Build a frozen {@link AppliedApplicationRecord} — the "applied" marker. `attempts` defaults to 1 (a
 * first, successful application) and `approver` to `null` (no human). Frozen, like an {@link
 * import("./executor").ExecutionPlan}: a recorded application is immutable.
 */
export function appliedRecord(input: {
  key: string;
  identity: ExecutionIdentity;
  label: string;
  result: unknown;
  attempts?: number;
  approver?: ApproverAttribution | null;
}): AppliedApplicationRecord {
  return Object.freeze({
    status: "applied",
    key: input.key,
    identity: input.identity,
    label: input.label,
    result: input.result,
    attempts: input.attempts ?? 1,
    approver: input.approver ?? null,
  }) as AppliedApplicationRecord;
}

/**
 * Build a frozen {@link FailedApplicationRecord} — the granular failure marker. `escalated` is the
 * caller's decision ({@link shouldEscalate}); `attempts` defaults to 1 and `approver` to `null`.
 * Frozen — an attempt's record is immutable; the next attempt writes a new record under the same key.
 */
export function failedRecord(input: {
  key: string;
  identity: ExecutionIdentity;
  label: string;
  error: string;
  escalated: boolean;
  attempts?: number;
  approver?: ApproverAttribution | null;
}): FailedApplicationRecord {
  return Object.freeze({
    status: "failed",
    key: input.key,
    identity: input.identity,
    label: input.label,
    error: input.error,
    escalated: input.escalated,
    attempts: input.attempts ?? 1,
    approver: input.approver ?? null,
  }) as FailedApplicationRecord;
}

// ---------------------------------------------------------------------
// The persistence seam — an injected store, with an in-memory reference
// ---------------------------------------------------------------------

/**
 * The application record's persistence — an INJECTED seam (ADR 0009 Decision 5). The real
 * implementation is a DB-backed table beside `hq_approvals`, written by the out-of-band sweep — the
 * executor rollout, deliberately out of C3's scope. This contract types the seam (so {@link applyOnce}
 * can consult and persist records without knowing where they live) and ships an in-memory reference
 * ({@link createInMemoryApplicationStore}); like {@link import("./executor").ToolImplementation}, the
 * store is the one place an effect happens, and it belongs to the caller.
 */
export interface ApplicationStore {
  /** The record filed under `key`, or `undefined` — the no-op-success lookup ({@link applyOnce}). */
  get(key: string): Promise<ApplicationRecord | undefined>;
  /** Persist (insert-or-replace) a record under its own `key`. */
  put(record: ApplicationRecord): Promise<void>;
}

/**
 * An in-memory {@link ApplicationStore} — the reference implementation (no DB, no I/O). It exists so
 * the apply-once guarantee can be tested and the Reference Path (C4) can drive the marker end-to-end,
 * exactly as {@link import("./executor").REFERENCE_EXECUTOR} exists for the executor. The map is
 * private to the closure; the facade is frozen. Each call resolves immediately — there is no real
 * persistence here, only the contract's behaviour.
 */
export function createInMemoryApplicationStore(): ApplicationStore {
  const byKey = new Map<string, ApplicationRecord>();
  return Object.freeze({
    async get(key: string): Promise<ApplicationRecord | undefined> {
      return byKey.get(key);
    },
    async put(record: ApplicationRecord): Promise<void> {
      byKey.set(record.key, record);
    },
  });
}

// ---------------------------------------------------------------------
// applyOnce — apply exactly once, idempotently (the C3 centrepiece)
// ---------------------------------------------------------------------

/** What {@link applyOnce} did — a total, discriminated outcome the sweep / runner branches on. */
export type ApplyOnceResult =
  /** A prior application already succeeded — the boundary was NOT crossed again (no-op success). */
  | { readonly status: "already_applied"; readonly key: string; readonly record: AppliedApplicationRecord }
  /** This call applied the action for the first time. */
  | { readonly status: "applied"; readonly key: string; readonly record: AppliedApplicationRecord }
  /** This attempt failed but the ceiling is not yet reached — safe to re-attempt next sweep. */
  | { readonly status: "failed"; readonly key: string; readonly record: FailedApplicationRecord }
  /** The ceiling is exhausted (this attempt or a prior one) — a human owns it; do not auto-retry. */
  | { readonly status: "escalated"; readonly key: string; readonly record: FailedApplicationRecord };

/** The inputs to {@link applyOnce} — the store, the identity, the injected boundary, and the policy. */
export interface ApplyOnceInput {
  /** Where applications are recorded and looked up (the injected persistence seam). */
  readonly store: ApplicationStore;
  /** The execution identity the idempotency key derives from. */
  readonly identity: ExecutionIdentity;
  /**
   * Cross the execution boundary and return the typed outcome — INJECTED by the caller, never reached
   * through here. In the runner this is `() => executePlan(plan, invoke)` ({@link
   * import("./executor")}); in a test it is a pure stand-in. It is the ONE place an effect happens.
   */
  readonly apply: () => Promise<ExecutionOutcome>;
  /** The retry ceiling before a failure escalates ({@link DEFAULT_APPLICATION_RETRY_CEILING}). */
  readonly ceiling?: number;
  /** The human approver to attribute (approval path), or `null`/absent (autonomous path). */
  readonly approver?: ApproverAttribution | null;
}

/**
 * Apply an action EXACTLY ONCE, idempotently — the C3 centrepiece (ADR 0009 Decisions 5, 6, 9; the
 * Executor Idempotency Rule). It derives the deterministic key, consults the store BEFORE crossing the
 * boundary, and only then applies through the injected {@link ApplyOnceInput.apply}. The flow:
 *
 *   1. an already-`applied` key → `already_applied`, a NO-OP SUCCESS: the boundary is NEVER crossed
 *      again, so a retry or a second sweep re-applies nothing (the central no-double-apply guarantee);
 *   2. an already-`escalated` failure → `escalated` WITHOUT applying: a human already owns it, so the
 *      sweep must not auto-retry it (Decision 9);
 *   3. otherwise apply once and record the outcome — `applied` on success; on failure, a granular
 *      failure record (Decision 9), `escalated` once {@link shouldEscalate} (the action stays
 *      unapplied and, below the ceiling, `failed` — safe to re-attempt next sweep).
 *
 * Composition, not I/O: every effect is the caller's — the injected store and the injected `apply`.
 * It wires no runner, no sweep, and no real boundary; it is the apply-once CONTRACT the rollout will
 * compose, the direct analogue of the executor's {@link import("./executor").execute}.
 */
export async function applyOnce(input: ApplyOnceInput): Promise<ApplyOnceResult> {
  const { store, identity, apply } = input;
  const ceiling = input.ceiling ?? DEFAULT_APPLICATION_RETRY_CEILING;
  const approver = input.approver ?? null;
  const key = deriveIdempotencyKey(identity);

  const prior = await store.get(key);

  // 1. Already applied — a no-op success; the boundary is never crossed again (Decision 6).
  if (prior && prior.status === "applied") {
    return { status: "already_applied", key, record: prior };
  }

  // 2. Already escalated — a human owns it; do not auto re-attempt (Decision 9).
  if (prior && prior.status === "failed" && prior.escalated) {
    return { status: "escalated", key, record: prior };
  }

  const attempts = (prior ? prior.attempts : 0) + 1;

  // 3. Cross the boundary once, through the injected implementation, and record the outcome.
  const outcome = await apply();

  if (outcome.status === "applied") {
    const record = appliedRecord({
      key,
      identity,
      label: outcome.label,
      result: outcome.result,
      attempts,
      approver,
    });
    await store.put(record);
    return { status: "applied", key, record };
  }

  const escalated = shouldEscalate(attempts, ceiling);
  const record = failedRecord({
    key,
    identity,
    label: outcome.label,
    error: outcome.error,
    escalated,
    attempts,
    approver,
  });
  await store.put(record);
  return { status: escalated ? "escalated" : "failed", key, record };
}

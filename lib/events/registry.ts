/**
 * The canonical event-verb registry — Module 1 (HQ Event Spine), PR1.
 *
 * This is the SINGLE SOURCE of event names (Engineering Bible Ch.04). A producer
 * may only emit a verb listed here; `emitEvent()` types its `verb` against the
 * `Verb` union derived below, so an unregistered verb WILL NOT COMPILE — the
 * "one source" rule enforced by the type system (the spine's analogue of the way
 * 007 enforced the design tokens in ESLint).
 *
 * Adding or renaming a verb is an edit to this file + an ADR (Ch.20). Verbs are
 * stable contracts: renaming one is a breaking change handled like a schema
 * migration. Naming discipline: `domain.action`, PAST TENSE (events are facts
 * that happened). Commands ("do X") are never events.
 *
 * This module is intentionally free of `server-only` and of any I/O — it is pure
 * data + types, so the timeline/Pulse UI (PR5) can import the `Verb` union and
 * the domain groupings to build typed filters without pulling in server code.
 */

// Grouped exactly as the Ch.04 registry. Each group is `as const` so the flat
// `VERBS` tuple below preserves the literal union.
const ORG = [
  "org.created",
  "org.trial_started",
  "org.trial_converted",
  "org.trial_expired",
  "org.subscription_changed",
  "org.churned",
  "org.reactivated",
  "org.suspended",
  "org.unsuspended",
  "org.health_changed",
] as const;

const BILLING = [
  "invoice.created",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.paid",
  "invoice.voided",
  "billing.refund_issued",
  "billing.dunning_started",
  "billing.dunning_resolved",
  "billing.dispute_opened",
] as const;

// tenant operations, mirrored from activity_log.
const OPERATIONS = [
  "customer.created",
  "customer.updated",
  "job.created",
  "job.scheduled",
  "job.completed",
  "job.cancelled",
  "quote.sent",
  "quote.accepted",
] as const;

const SUPPORT = [
  "support.ticket_opened",
  "support.ticket_replied",
  "support.ticket_escalated",
  "support.ticket_resolved",
  "support.csat_recorded",
] as const;

// `ai.action_permitted` (the 11th) landed under ADR 0008 (Directive #014 / D-04,
// Phase B — the AI SDK envelope's doorman). It is the audit fact the RUNTIME emits when
// the pure gate (`server/sdk/gate.ts`) returns an `autonomous` verdict for a proposed
// action, so deny-by-default is auditable BOTH ways: a needs-approval verdict lands an
// `approval.requested` row (the Approval Engine), an autonomous one lands this. Past
// tense, a fact that happened — the doorman permitted the action without a human.
//
// `ai.handoff` (the 12th) is the deterministic employee-to-employee handoff fact:
// one AI employee delegated a bounded unit of work to another by ENQUEUING a child
// task (parent_task_id + depends_on lineage) assigned to the target. The RUNTIME
// emits it from the tasks SDK (`ctx.tasks.handoff`), like `ai.action_permitted` —
// it is an employee ACTION, not a `hq_ai_tasks` state transition, so it lives in
// the AI domain, never the (SQL-minted) task.* group. A handoff only enqueues
// work; it takes no irreversible external action, and the child task still runs
// under the full posture/approval floor. Past tense, a fact that happened.
const AI = [
  "ai.triggered",
  "ai.run_started",
  "ai.planned",
  "ai.tool_called",
  "ai.run_completed",
  "ai.run_failed",
  "ai.budget_warned",
  "ai.budget_exceeded",
  "ai.suspended",
  "ai.escalated",
  "ai.action_permitted",
  "ai.handoff",
] as const;

const APPROVAL = [
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.edited",
  "approval.expired",
  "approval.escalated",
] as const;

const MEMORY = [
  "memory.asserted",
  "memory.superseded",
  "memory.edge_added",
  "memory.access_granted",
  "memory.access_revoked",
] as const;

// Communication Layer (Directive 010, Phase 4). The DELIVERY lifecycle of an
// APPROVED draft handed to a replaceable provider — a new domain, not a duplicate
// vocabulary (cf. approval.*, memory.*). Past tense, facts that happened:
//   comm.sent       — a provider accepted the message for delivery
//   comm.delivered  — the recipient's server confirmed receipt (provider webhook)
//   comm.bounced    — the message bounced (provider webhook)
//   comm.complained — the recipient marked it as spam (provider webhook)
//   comm.failed     — delivery failed at the transport (no provider / rejection)
//   comm.suppressed — a send was blocked by the do-not-contact list
// There is no `comm.queued`: the send is synchronous, so there is no queued state.
const COMM = [
  "comm.sent",
  "comm.delivered",
  "comm.bounced",
  "comm.complained",
  "comm.failed",
  "comm.suppressed",
] as const;

// Generic Task Engine (Directive #012 / D-02, PR-B; ADR-0005). The LIFECYCLE of a
// durable, crash-safe unit of work that EVERY AI employee inherits — the spine
// projection of the `hq_ai_tasks` state machine. One verb per WIRED transition,
// emitted in-transaction from the SECURITY DEFINER entry points (not a trigger:
// only the function knows the honest actor and reason — see ADR-0005). Past tense,
// facts that happened:
//   task.created   — a task was enqueued (hq_ai_task_create)
//   task.claimed   — a worker leased the next ready task (hq_ai_task_claim)
//   task.completed — a task finished successfully (hq_ai_task_complete)
//   task.retried   — a task was re-queued for another attempt, after a worker
//                    reported a retryable failure OR the reaper recovered an
//                    expired lease (distinguished by actor + payload.reason)
//   task.failed    — a task reached terminal failure, worker-reported or
//                    retries-exhausted (distinguished by actor + payload.reason)
//   task.cancelled — a live task was cancelled from outside its worker, by an
//                    operator/parent/OS (hq_ai_task_cancel); payload.prev_status
//                    records whether queued or in-flight work was stopped
// `task.cancelled` landed under D-03 / #013 (the RunContext Runtime Contract): the
// guard has permitted *→cancelled since PR-A, and PR-B reserved the verb in words
// "registered when that function lands, never as dead vocabulary" — D-03 is that
// landing (the cancel entry point is the substrate behind RunContext's ctx.signal).
// Intentionally ABSENT (ADR-0005): no `task.heartbeated` (heartbeats are liveness,
// not facts — they would drown the spine); no `task.checkpointed` (a checkpoint is
// internal resumption state, evented only if a consumer ever needs it).
const TASK = [
  "task.created",
  "task.claimed",
  "task.completed",
  "task.retried",
  "task.failed",
  "task.cancelled",
] as const;

const PERMISSION = [
  "permission.role_granted",
  "permission.role_revoked",
  "permission.capability_used",
] as const;

const SYSTEM = [
  "system.cron_ran",
  "system.cron_failed",
  "system.webhook_received",
  "system.alert_raised",
  "system.alert_resolved",
  "system.flag_changed",
  "system.projection_rebuilt",
] as const;

const NOTIFICATION = [
  "notification.created",
  "notification.emailed",
  "notification.read",
] as const;

/**
 * The verb groups, keyed by Ch.04 section. Useful for the timeline filter UI and
 * for documentation; the flat `VERBS` tuple below is derived from these so there
 * is exactly one place to edit.
 */
export const VERB_GROUPS = {
  org: ORG,
  billing: BILLING,
  operations: OPERATIONS,
  support: SUPPORT,
  ai: AI,
  approval: APPROVAL,
  memory: MEMORY,
  comm: COMM,
  task: TASK,
  permission: PERMISSION,
  system: SYSTEM,
  notification: NOTIFICATION,
} as const;

export type VerbGroup = keyof typeof VERB_GROUPS;

/** Every canonical verb, flattened. THE single source of event names. */
export const VERBS = [
  ...ORG,
  ...BILLING,
  ...OPERATIONS,
  ...SUPPORT,
  ...AI,
  ...APPROVAL,
  ...MEMORY,
  ...COMM,
  ...TASK,
  ...PERMISSION,
  ...SYSTEM,
  ...NOTIFICATION,
] as const;

/** The union of all registered verbs. An unregistered string won't satisfy it. */
export type Verb = (typeof VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set(VERBS);

/** Runtime guard — true iff `value` is a registered verb. */
export function isVerb(value: unknown): value is Verb {
  return typeof value === "string" && VERB_SET.has(value);
}

/** The namespace before the first dot, e.g. `invoice.created` → `invoice`. */
export function verbNamespace(verb: Verb): string {
  return verb.slice(0, verb.indexOf("."));
}

// --- Event schema versions (the Event Spine versioning rule) ------------------
//
// Every registered event carries a STABLE schema version, starting at 1. This is
// the SINGLE SOURCE of those versions, kept registry-first by design: Volume XI
// §4.2 holds verb + payload-schema validity a PRODUCER contract (a TS registry +
// contract test), never a hot-path DB constraint — so a bad version can no more
// wedge the append-only log than a bad verb can. The rule, scope and rationale
// live in `docs/bible/substrate/event-versioning.md`; the per-event task contract
// in `docs/bible/substrate/task-event-contract.md`.
//
// The contract, in one line: a version is IMMUTABLE once shipped. A
// backward-incompatible payload change mints a NEW version (an override below) —
// it never edits or reuses an old one — because events are immutable history that
// must stay replayable forever (Volume XI §10). This is deliberately NOT a
// behavioural change: nothing about emission changes today. It is the stable
// identifier replay, analytics and schema evolution will key off tomorrow.
//
// Today every event is v1, so OVERRIDES is empty. Each future bump is one line:
// `"verb.name": 2,` — added in the same edit as the payload change and its ADR.

/** The version every registered event starts at. */
export const EVENT_SCHEMA_VERSION_BASELINE = 1 as const;

/**
 * Per-event version bumps. A verb appears here ONLY once its payload schema has
 * changed incompatibly; the value is the current version (always ≥ 2 — v1 is the
 * baseline, so an entry of 1 would be redundant). Absent ⇒ the event is v1.
 */
export const EVENT_SCHEMA_VERSION_OVERRIDES: Partial<Record<Verb, number>> = {};

/**
 * The stable payload-schema version of a registered event — the baseline (1)
 * unless the verb has been bumped in EVENT_SCHEMA_VERSION_OVERRIDES.
 */
export function eventSchemaVersion(verb: Verb): number {
  return EVENT_SCHEMA_VERSION_OVERRIDES[verb] ?? EVENT_SCHEMA_VERSION_BASELINE;
}

// --- Envelope enums (mirror the CHECK constraints on hq_events) ---------------

export const ACTOR_TYPES = ["human", "ai_employee", "system", "tenant"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const SEVERITIES = ["info", "success", "warn", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `hq` today; the seam for per-role visibility scoping later (Ch.14). */
export type Visibility = "hq" | (string & {});

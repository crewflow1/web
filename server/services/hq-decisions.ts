import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  composeDecisionDebate,
  isInsufficientDebate,
} from "@/lib/hq/decision-debate";

/**
 * CrewFlow HQ — The Decision Centre service (Master-Plan Phase 16 + the Layer-5 gap).
 *
 * The thin server API over the `hq_decisions` engine — the strategic-decision
 * analogue of the Approval Engine, adding the two outcomes the audit found missing
 * from Layer 5 (DELAY and DELEGATE) alongside approve/reject. It owns NO policy of
 * its own: the deterministic state machine, the write-once provenance, terminal
 * immutability and the append-only history are all enforced by the database
 * (migration 20261091000000); this layer drives them and adds the super-admin gate.
 *
 * The boundary, made explicit:
 *   • Raising a proposal (createDecision) and deciding one (decide) are BOTH gated on
 *     isSuperAdminEmail HERE, in code — because every write below uses the
 *     service-role admin client, which BYPASSES RLS, so the gate cannot live in an
 *     RLS policy (the same reason HQ access is a request-path gate). The reads are
 *     gated by the HQ page (requireHqPage), the shipped hq_approvals pattern.
 *   • The engine NEVER executes anything. Approving only marks a decision approved;
 *     acting on it is a human's job. No autonomous execution, ever.
 *
 * Every function returns a discriminated result; none throw on a business outcome.
 * Idempotency mirrors hq_approvals: re-deciding a row already in the target terminal
 * state is a no-op success, never a double-action.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

interface DecisionQuery<T> extends DbList<T> {
  select(columns: string): DecisionQuery<T>;
  insert(payload: unknown): DecisionQuery<T>;
  update(payload: unknown): DecisionQuery<T>;
  eq(column: string, value: unknown): DecisionQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): DecisionQuery<T>;
  order(column: string, options?: { ascending?: boolean }): DecisionQuery<T>;
  limit(count: number): DecisionQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

// hq_decisions / hq_decision_events are service-role-only HQ tables, not in the
// generated Supabase types — cast past the typed client (the same `as unknown as`
// shim the other HQ services use; a typing convenience, not logic).
function decisions<T>(admin: AdminClient): DecisionQuery<T> {
  return admin.from("hq_decisions" as never) as unknown as DecisionQuery<T>;
}
function decisionEvents<T>(admin: AdminClient): DecisionQuery<T> {
  return admin.from("hq_decision_events" as never) as unknown as DecisionQuery<T>;
}

export const DECISION_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "delayed",
  "delegated",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const TERMINAL_DECISION_STATUSES = [
  "approved",
  "rejected",
  "delayed",
  "delegated",
] as const;

const ROW_COLUMNS =
  "id, title, problem, business_impact, revenue_impact, demand, engineering_cost, risk, " +
  "timeline, ai_debate, recommendation, status, decided_by, decided_at, delegate_to, " +
  "delay_until, decision_reason, created_by, created_at, updated_at";

const EVENT_COLUMNS =
  "id, decision_id, event_type, from_status, to_status, actor_id, actor_email, reason, " +
  "delegate_to, delay_until, created_at";

/** One entry in the future AI-employee debate (empty today; the AI tier fills it). */
export type DebateEntry = Record<string, unknown>;

export type DecisionRow = {
  id: string;
  title: string;
  problem: string | null;
  business_impact: string | null;
  revenue_impact: string | null;
  demand: string | null;
  engineering_cost: string | null;
  risk: string | null;
  timeline: string | null;
  ai_debate: DebateEntry[];
  recommendation: string | null;
  status: DecisionStatus;
  decided_by: string | null;
  decided_at: string | null;
  delegate_to: string | null;
  delay_until: string | null;
  decision_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type DecisionEventRow = {
  id: string;
  decision_id: string;
  event_type: DecisionStatus;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  actor_email: string | null;
  reason: string | null;
  delegate_to: string | null;
  delay_until: string | null;
  created_at: string;
};

/** The human acting on a decision. Every mutation is gated on this email's HQ status. */
export type Decider = { id: string | null; email: string | null };

export type DecisionResult =
  | { ok: true; decision: DecisionRow }
  | { ok: false; error: string };

// ---------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------

/** A mutation is HQ-only. Returns null when allowed, an error result otherwise. */
function deciderGate(decider: Decider): { ok: false; error: string } | null {
  if (!isSuperAdminEmail(decider.email)) return { ok: false, error: "forbidden" };
  return null;
}

async function readDecision(admin: AdminClient, id: string): Promise<DecisionRow | null> {
  const { data, error } = await decisions<DecisionRow>(admin)
    .select(ROW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw readFailure("hq-decisions: decision row", error);
  return data ?? null;
}

// ---------------------------------------------------------------------
// 1. Create — a super-admin raises a strategic decision proposal.
// ---------------------------------------------------------------------

export type CreateDecisionInput = {
  creator: Decider;
  title: string;
  problem?: string | null;
  businessImpact?: string | null;
  revenueImpact?: string | null;
  demand?: string | null;
  engineeringCost?: string | null;
  risk?: string | null;
  timeline?: string | null;
  recommendation?: string | null;
  /** The AI-employee debate. Empty today; the AI tier fills it once a tier is bound. */
  aiDebate?: DebateEntry[];
};

/**
 * Land a new decision in the queue, born `proposed`. The INSERT trigger appends the
 * 'proposed' history row in the same transaction. Super-admin only.
 */
export async function createDecision(input: CreateDecisionInput): Promise<DecisionResult> {
  const denied = deciderGate(input.creator);
  if (denied) return denied;

  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "title_required" };

  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    title,
    problem: input.problem ?? null,
    business_impact: input.businessImpact ?? null,
    revenue_impact: input.revenueImpact ?? null,
    demand: input.demand ?? null,
    engineering_cost: input.engineeringCost ?? null,
    risk: input.risk ?? null,
    timeline: input.timeline ?? null,
    recommendation: input.recommendation ?? null,
    ai_debate: input.aiDebate ?? [],
    status: "proposed",
    created_by: input.creator.id,
  };

  const { data, error } = await decisions<DecisionRow>(admin)
    .insert(row)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-decisions] createDecision failed", error);
    return { ok: false, error: error?.message ?? "create_failed" };
  }
  await recordAdminActivity({
    actorId: input.creator.id,
    actorEmail: input.creator.email,
    action: "decision.proposed",
    targetTable: "hq_decisions",
    targetId: data.id,
    metadata: { title },
  });
  return { ok: true, decision: data };
}

// ---------------------------------------------------------------------
// 2. Decide — the four human outcomes: approve / reject / delay / delegate.
// ---------------------------------------------------------------------

export type DecisionOutcome = "approve" | "reject" | "delay" | "delegate";

export type DecideInput = {
  id: string;
  decider: Decider;
  outcome: DecisionOutcome;
  /** Required for reject / delay / delegate. */
  reason?: string;
  /** Required for delay — the date to revisit the decision. */
  delayUntil?: string | null;
  /** Required for delegate — the user the decision is assigned to. */
  delegateTo?: string | null;
};

const OUTCOME_TO_STATUS: Record<DecisionOutcome, DecisionStatus> = {
  approve: "approved",
  reject: "rejected",
  delay: "delayed",
  delegate: "delegated",
};

/**
 * Apply one of the four decision outcomes. Validates the outcome's required inputs
 * in code (the DB trigger enforces them again, unbypassably), then transitions with
 * an optimistic `status = 'proposed'` guard so a lost race becomes a clean re-read
 * rather than a trigger error. The AFTER trigger appends the immutable history row.
 */
export async function decide(input: DecideInput): Promise<DecisionResult> {
  const denied = deciderGate(input.decider);
  if (denied) return denied;

  const targetStatus = OUTCOME_TO_STATUS[input.outcome];
  if (!targetStatus) return { ok: false, error: "invalid_outcome" };

  const reason = (input.reason ?? "").trim();
  if (input.outcome !== "approve" && !reason) return { ok: false, error: "reason_required" };

  const delayUntil = (input.delayUntil ?? "").trim() || null;
  if (input.outcome === "delay" && !delayUntil) return { ok: false, error: "delay_until_required" };

  const delegateTo = (input.delegateTo ?? "").trim() || null;
  if (input.outcome === "delegate" && !delegateTo) {
    return { ok: false, error: "delegate_to_required" };
  }

  const admin = createAdminClient();
  const current = await readDecision(admin, input.id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status === targetStatus) return { ok: true, decision: current }; // idempotent
  if (current.status !== "proposed") return { ok: false, error: "not_active" };

  const patch: Record<string, unknown> = {
    status: targetStatus,
    decided_by: input.decider.id,
    decision_reason: input.outcome === "approve" ? (reason || null) : reason,
    delay_until: input.outcome === "delay" ? delayUntil : null,
    delegate_to: input.outcome === "delegate" ? delegateTo : null,
  };

  const { data, error } = await decisions<DecisionRow>(admin)
    .update(patch)
    .eq("id", input.id)
    .eq("status", "proposed")
    .select(ROW_COLUMNS);
  if (error) {
    console.error("[hq-decisions] decide failed", { id: input.id, error: error.message });
    return { ok: false, error: error.message };
  }
  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) {
    // No proposed row matched — re-read for a precise answer (idempotent terminal, or
    // genuinely missing).
    const after = await readDecision(admin, input.id);
    if (!after) return { ok: false, error: "not_found" };
    if (after.status === targetStatus) return { ok: true, decision: after };
    return { ok: false, error: "not_active" };
  }

  await recordAdminActivity({
    actorId: input.decider.id,
    actorEmail: input.decider.email,
    action: `decision.${targetStatus}`,
    targetTable: "hq_decisions",
    targetId: input.id,
    metadata: {
      outcome: input.outcome,
      reason: reason || null,
      delay_until: delayUntil,
      delegate_to: delegateTo,
    },
  });
  return { ok: true, decision: updated };
}

// ---------------------------------------------------------------------
// 2b. Produce the AI debate — the deterministic Decision-Centre producer.
// ---------------------------------------------------------------------

/**
 * Fill a proposed decision's reserved `ai_debate` slot from its REAL signals, deterministically
 * (P2 HQ AI Operating System). This is the producer the slot has always lacked: it composes a
 * structured pro/con debate (lib/hq/decision-debate.ts) from the decision's own revenue/demand/
 * cost/risk/timeline fields and writes it into the proposed row.
 *
 *   • FIRST-WRITE-WINS / idempotent: if a debate already exists, it is a no-op success — the
 *     producer never overwrites an existing debate (including a future generated one).
 *   • PROPOSED-ONLY: a decided decision is terminal and immutable (DB-enforced); the producer
 *     refuses with `not_active` rather than attempting a write the guard would reject.
 *   • HONEST: a decision with no structured signals gets the explicit `insufficient` entry, never
 *     a fabricated debate. Makes NO model call — the generative tier is dark.
 *
 * Super-admin gated, like every other Decision-Centre write.
 */
export async function produceDecisionDebate(
  id: string,
  actor: Decider,
): Promise<DecisionResult> {
  const denied = deciderGate(actor);
  if (denied) return denied;

  const admin = createAdminClient();
  const current = await readDecision(admin, id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.status !== "proposed") return { ok: false, error: "not_active" };

  // First-write-wins: never overwrite an existing debate (deterministic or, one day, generated).
  if (Array.isArray(current.ai_debate) && current.ai_debate.length > 0) {
    return { ok: true, decision: current };
  }

  const debate = composeDecisionDebate({
    problem: current.problem,
    businessImpact: current.business_impact,
    revenueImpact: current.revenue_impact,
    demand: current.demand,
    engineeringCost: current.engineering_cost,
    risk: current.risk,
    timeline: current.timeline,
  });

  const { data, error } = await decisions<DecisionRow>(admin)
    .update({ ai_debate: debate })
    .eq("id", id)
    .eq("status", "proposed")
    .select(ROW_COLUMNS);
  if (error) {
    console.error("[hq-decisions] produceDecisionDebate failed", { id, error: error.message });
    return { ok: false, error: error.message };
  }
  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) {
    // No proposed row matched — it raced to a terminal state or was filled concurrently.
    const after = await readDecision(admin, id);
    if (!after) return { ok: false, error: "not_found" };
    if (after.status !== "proposed") return { ok: false, error: "not_active" };
    return { ok: true, decision: after };
  }

  await recordAdminActivity({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "decision.debate_produced",
    targetTable: "hq_decisions",
    targetId: id,
    metadata: {
      entries: debate.length,
      source: "deterministic",
      insufficient: isInsufficientDebate(debate),
    },
  });
  return { ok: true, decision: updated };
}

// ---------------------------------------------------------------------
// 3. Reads — the proposal list, detail, and immutable history.
// ---------------------------------------------------------------------

export async function getDecision(id: string): Promise<DecisionRow | null> {
  return readDecision(createAdminClient(), id);
}

/**
 * List decisions, newest first. Pass a status to filter (e.g. 'proposed' for the
 * active queue); omit for every decision.
 */
export async function listDecisions(
  opts: { status?: DecisionStatus; limit?: number } = {},
): Promise<DecisionRow[]> {
  const admin = createAdminClient();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  let query = decisions<DecisionRow>(admin).select(ROW_COLUMNS);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw readFailure("hq-decisions: decisions", error);
  return Array.isArray(data) ? data : [];
}

/** The immutable history of one decision — every transition, oldest first. */
export async function listDecisionEvents(decisionId: string): Promise<DecisionEventRow[]> {
  const admin = createAdminClient();
  const { data, error } = await decisionEvents<DecisionEventRow>(admin)
    .select(EVENT_COLUMNS)
    .eq("decision_id", decisionId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw readFailure("hq-decisions: decision events", error);
  return Array.isArray(data) ? data : [];
}

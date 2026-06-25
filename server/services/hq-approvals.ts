import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  ACTIVE_STATES,
  isActive,
  isTerminal,
  type ApprovalState,
} from "@/lib/approvals/state";

/**
 * CrewFlow HQ — The Approval Engine service (CEO Directive 010, Phase 2).
 *
 * The thin server API over the `hq_approvals` engine — SHARED workforce
 * infrastructure every AI employee inherits (Sales, Customer Success, Finance,
 * Business Coach, Voice). It owns NO policy of its own: the deterministic state
 * machine, the write-once proposal, terminal immutability and the immutable audit
 * trail are all enforced by the database (migration 20260730000000); this layer
 * just drives them and adds the reviewer-permission gate.
 *
 * The boundary, made explicit (the load-bearing security property):
 *   • An AI employee may REQUEST an approval (requestApproval) — proposing is not
 *     gated; it only ever lands an item in the queue, awaiting a human.
 *   • A human DECISION (edit / escalate / approve / reject / recover) is gated on
 *     isSuperAdminEmail HERE, in code — because every write below uses the
 *     service-role admin client, which BYPASSES RLS, so the reviewer gate cannot
 *     live in an RLS policy (the same reason HQ access is a request-path gate, and
 *     the same lesson expense-drafts learned). "Reviewers have explicit
 *     permissions", enforced through architecture.
 *   • The engine NEVER sends, generates, or automates. approve() only marks an
 *     item approved; a separate, later phase reads `approved` rows and acts. expiry
 *     is a callable primitive, deliberately NOT wired to any cron here.
 *
 * Every function returns a discriminated result; none throw on a business outcome.
 * Idempotency mirrors expense-drafts: re-deciding a row already in the target
 * terminal state is a no-op success, never a double-action.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

interface ApprovalQuery<T> extends DbList<T> {
  select(columns: string): ApprovalQuery<T>;
  insert(payload: unknown): ApprovalQuery<T>;
  update(payload: unknown): ApprovalQuery<T>;
  eq(column: string, value: unknown): ApprovalQuery<T>;
  in(column: string, values: ReadonlyArray<unknown>): ApprovalQuery<T>;
  lt(column: string, value: unknown): ApprovalQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ApprovalQuery<T>;
  limit(count: number): ApprovalQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

// hq_approvals is a service-role-only HQ table, not in the generated Supabase
// types — cast past the typed client (the same `as unknown as` shim the other HQ
// services use for untyped hq_* tables; a typing convenience, not logic).
function approvals<T>(admin: AdminClient): ApprovalQuery<T> {
  return admin.from("hq_approvals" as never) as unknown as ApprovalQuery<T>;
}

const ROW_COLUMNS =
  "id, ai_employee_id, subject_type, subject_id, action, proposed_payload, edited_payload, " +
  "state, decision_reason, reviewer_id, reviewer_email, correlation_id, supersedes_id, " +
  "requested_at, decided_at, escalated_at, expires_at, created_at, updated_at";

export type ApprovalRow = {
  id: string;
  ai_employee_id: string;
  subject_type: string;
  subject_id: string;
  action: string;
  proposed_payload: Record<string, unknown>;
  edited_payload: Record<string, unknown> | null;
  state: ApprovalState;
  decision_reason: string | null;
  reviewer_id: string | null;
  reviewer_email: string | null;
  correlation_id: string;
  supersedes_id: string | null;
  requested_at: string;
  decided_at: string | null;
  escalated_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The human acting on an approval. Decisions are gated on this email's HQ status. */
export type Reviewer = { id: string | null; email: string | null };

export type ApprovalResult =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; error: string };

// ---------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------

async function readApproval(admin: AdminClient, id: string): Promise<ApprovalRow | null> {
  const { data } = await approvals<ApprovalRow>(admin)
    .select(ROW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return data ?? null;
}

/** A human decision is HQ-only. Returns null when allowed, an error result otherwise. */
function reviewerGate(reviewer: Reviewer): { ok: false; error: string } | null {
  if (!isSuperAdminEmail(reviewer.email)) return { ok: false, error: "forbidden" };
  return null;
}

/**
 * Apply a single state transition with optimistic concurrency: only the row still
 * in an ACTIVE state is updated (the DB trigger is the real enforcer; this `.in`
 * guard turns a lost race into a clean re-read rather than a trigger error). Maps
 * the result back through readApproval so callers always get the row's true state.
 */
async function transition(
  admin: AdminClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<ApprovalResult> {
  const { data, error } = await approvals<ApprovalRow>(admin)
    .update(patch)
    .eq("id", id)
    .in("state", ACTIVE_STATES as unknown as string[])
    .select(ROW_COLUMNS);
  if (error) {
    console.error("[hq-approvals] transition failed", { id, error: error.message });
    return { ok: false, error: error.message };
  }
  const updated = Array.isArray(data) ? data[0] : null;
  if (updated) return { ok: true, approval: updated };
  // No active row matched — re-read to give a precise answer (idempotent terminal,
  // or genuinely missing).
  const current = await readApproval(admin, id);
  if (!current) return { ok: false, error: "not_found" };
  return { ok: false, error: "not_active" };
}

// ---------------------------------------------------------------------
// 1. Request — an AI employee proposes an action (NOT gated; only queues it).
// ---------------------------------------------------------------------

export type RequestApprovalInput = {
  /** The proposing AI employee (FK → ai_employees.id). */
  aiEmployeeId: string;
  /** What kind of thing is being approved, e.g. 'outreach_email'. */
  subjectType: string;
  /** The thing's id. */
  subjectId: string;
  /** The proposed act, e.g. 'send'. */
  action: string;
  /** The employee's proposal (a draft's subject+body, a figure, …). */
  proposedPayload?: Record<string, unknown>;
  /** Thread this approval into a larger intent's trace; else a fresh trace begins. */
  correlationId?: string;
  /** Optional deadline for the expiry sweep. */
  expiresAt?: string | null;
  /** Set when this request recovers a prior terminal approval (see recoverApproval). */
  supersedesId?: string | null;
};

/**
 * Land a new approval in the queue, born `pending`. The only non-human entry
 * point — an employee runner calls this to submit work for review. The INSERT
 * trigger emits `approval.requested` in the same transaction.
 */
export async function requestApproval(input: RequestApprovalInput): Promise<ApprovalResult> {
  const subjectType = input.subjectType?.trim();
  const subjectId = input.subjectId?.trim();
  const action = input.action?.trim();
  if (!input.aiEmployeeId || !subjectType || !subjectId || !action) {
    return { ok: false, error: "invalid_input" };
  }
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    ai_employee_id: input.aiEmployeeId,
    subject_type: subjectType,
    subject_id: subjectId,
    action,
    proposed_payload: input.proposedPayload ?? {},
    state: "pending",
    expires_at: input.expiresAt ?? null,
    supersedes_id: input.supersedesId ?? null,
  };
  if (input.correlationId) row.correlation_id = input.correlationId;

  const { data, error } = await approvals<ApprovalRow>(admin)
    .insert(row)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-approvals] requestApproval failed", error);
    return { ok: false, error: error?.message ?? "request_failed" };
  }
  return { ok: true, approval: data };
}

// ---------------------------------------------------------------------
// 2. Edit — a reviewer revises the proposal without deciding it (tracked).
// ---------------------------------------------------------------------

export async function editApproval(input: {
  id: string;
  reviewer: Reviewer;
  editedPayload: Record<string, unknown>;
}): Promise<ApprovalResult> {
  const denied = reviewerGate(input.reviewer);
  if (denied) return denied;

  const admin = createAdminClient();
  const current = await readApproval(admin, input.id);
  if (!current) return { ok: false, error: "not_found" };
  if (isTerminal(current.state)) return { ok: false, error: "not_active" };

  // No state move; record the revised payload + who edited. The AFTER trigger
  // emits approval.edited because edited_payload changed.
  return transition(admin, input.id, {
    edited_payload: input.editedPayload,
    reviewer_id: input.reviewer.id,
    reviewer_email: input.reviewer.email,
  });
}

// ---------------------------------------------------------------------
// 3. Escalate — flag for higher attention (pending → escalated).
// ---------------------------------------------------------------------

export async function escalateApproval(input: {
  id: string;
  reviewer: Reviewer;
}): Promise<ApprovalResult> {
  const denied = reviewerGate(input.reviewer);
  if (denied) return denied;

  const admin = createAdminClient();
  const current = await readApproval(admin, input.id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.state === "escalated") return { ok: true, approval: current }; // idempotent
  if (current.state !== "pending") return { ok: false, error: "not_active" };

  return transition(admin, input.id, {
    state: "escalated",
    reviewer_id: input.reviewer.id,
    reviewer_email: input.reviewer.email,
  });
}

// ---------------------------------------------------------------------
// 4. Approve — a reviewer grants it (→ approved). Optionally edit-then-approve.
// ---------------------------------------------------------------------

export async function approveApproval(input: {
  id: string;
  reviewer: Reviewer;
  /** Optional final edit applied atomically before approval (emits edited, then granted). */
  editedPayload?: Record<string, unknown>;
}): Promise<ApprovalResult> {
  const denied = reviewerGate(input.reviewer);
  if (denied) return denied;

  const admin = createAdminClient();
  const current = await readApproval(admin, input.id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.state === "approved") return { ok: true, approval: current }; // idempotent
  if (!isActive(current.state)) return { ok: false, error: "not_active" };

  const patch: Record<string, unknown> = {
    state: "approved",
    reviewer_id: input.reviewer.id,
    reviewer_email: input.reviewer.email,
  };
  if (input.editedPayload !== undefined) patch.edited_payload = input.editedPayload;

  const res = await transition(admin, input.id, patch);
  if (res.ok) {
    await recordAdminActivity({
      actorId: input.reviewer.id,
      actorEmail: input.reviewer.email,
      action: "approval.granted",
      targetTable: "hq_approvals",
      targetId: input.id,
      metadata: { subject_type: current.subject_type, subject_id: current.subject_id, edited: input.editedPayload !== undefined },
    });
  }
  return res;
}

// ---------------------------------------------------------------------
// 5. Reject — a reviewer turns it down (→ rejected). Reason required.
// ---------------------------------------------------------------------

export async function rejectApproval(input: {
  id: string;
  reviewer: Reviewer;
  reason: string;
}): Promise<ApprovalResult> {
  const denied = reviewerGate(input.reviewer);
  if (denied) return denied;

  const reason = (input.reason ?? "").trim();
  if (!reason) return { ok: false, error: "reason_required" };

  const admin = createAdminClient();
  const current = await readApproval(admin, input.id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.state === "rejected") return { ok: true, approval: current }; // idempotent
  if (!isActive(current.state)) return { ok: false, error: "not_active" };

  const res = await transition(admin, input.id, {
    state: "rejected",
    decision_reason: reason,
    reviewer_id: input.reviewer.id,
    reviewer_email: input.reviewer.email,
  });
  if (res.ok) {
    await recordAdminActivity({
      actorId: input.reviewer.id,
      actorEmail: input.reviewer.email,
      action: "approval.rejected",
      targetTable: "hq_approvals",
      targetId: input.id,
      metadata: { subject_type: current.subject_type, subject_id: current.subject_id, reason },
    });
  }
  return res;
}

// ---------------------------------------------------------------------
// 6. Expire — the deadline passed (→ expired). A SYSTEM act: no reviewer gate.
//    A primitive only — deliberately NOT wired to any cron in Phase 2.
// ---------------------------------------------------------------------

export async function expireApproval(id: string): Promise<ApprovalResult> {
  const admin = createAdminClient();
  const current = await readApproval(admin, id);
  if (!current) return { ok: false, error: "not_found" };
  if (current.state === "expired") return { ok: true, approval: current }; // idempotent
  if (!isActive(current.state)) return { ok: false, error: "not_active" };
  return transition(admin, id, { state: "expired" });
}

export type ExpireDueResult = { ok: boolean; expired: number };

/**
 * Expire every active approval whose deadline has passed. A callable housekeeping
 * primitive (e.g. for a future, deliberately-decided cron) — it is NOT auto-wired
 * here. Bounded per call. Returns how many it expired.
 */
export async function expireDueApprovals(nowIso?: string, limit = 50): Promise<ExpireDueResult> {
  const admin = createAdminClient();
  const cutoff = nowIso ?? new Date().toISOString();
  const { data } = await approvals<{ id: string }>(admin)
    .select("id")
    .in("state", ACTIVE_STATES as unknown as string[])
    .lt("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 200));
  const ids = (Array.isArray(data) ? data : []).map((r) => r.id);
  let expired = 0;
  for (const id of ids) {
    const res = await expireApproval(id);
    if (res.ok) expired += 1;
  }
  return { ok: true, expired };
}

// ---------------------------------------------------------------------
// 7. Recover — re-open a turned-down item WITHOUT mutating the immutable record.
//    A terminal row is frozen forever; recovery is a fresh `pending` request that
//    `supersedes` it. The original rejection/expiry stays in the permanent record.
// ---------------------------------------------------------------------

export async function recoverApproval(input: {
  id: string;
  reviewer: Reviewer;
  /** Override the re-proposed payload; defaults to the prior proposal. */
  proposedPayload?: Record<string, unknown>;
}): Promise<ApprovalResult> {
  const denied = reviewerGate(input.reviewer);
  if (denied) return denied;

  const admin = createAdminClient();
  const prior = await readApproval(admin, input.id);
  if (!prior) return { ok: false, error: "not_found" };
  // Only a turned-down item is recoverable — a granted one needs no recovery, and
  // an active one is still in play.
  if (prior.state !== "rejected" && prior.state !== "expired") {
    return { ok: false, error: "not_recoverable" };
  }

  // A fresh request that supersedes the prior. New trace (a new attempt is a new
  // intent); the lineage link is supersedes_id.
  const created = await requestApproval({
    aiEmployeeId: prior.ai_employee_id,
    subjectType: prior.subject_type,
    subjectId: prior.subject_id,
    action: prior.action,
    proposedPayload: input.proposedPayload ?? prior.proposed_payload,
    expiresAt: prior.expires_at,
    supersedesId: prior.id,
  });
  if (created.ok) {
    await recordAdminActivity({
      actorId: input.reviewer.id,
      actorEmail: input.reviewer.email,
      action: "approval.recovered",
      targetTable: "hq_approvals",
      targetId: created.approval.id,
      metadata: { supersedes: prior.id, prior_state: prior.state },
    });
  }
  return created;
}

// ---------------------------------------------------------------------
// 8. Reads — the review queue + observability.
// ---------------------------------------------------------------------

export async function getApproval(id: string): Promise<ApprovalRow | null> {
  return readApproval(createAdminClient(), id);
}

/** The review queue: active items (pending + escalated), oldest first. */
export async function listPendingApprovals(limit = 50): Promise<ApprovalRow[]> {
  const admin = createAdminClient();
  const { data } = await approvals<ApprovalRow>(admin)
    .select(ROW_COLUMNS)
    .in("state", ACTIVE_STATES as unknown as string[])
    .order("requested_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 200));
  return Array.isArray(data) ? data : [];
}

/** Every approval ever raised for a subject — its full story (newest first). */
export async function listApprovalsForSubject(
  subjectType: string,
  subjectId: string,
  limit = 50,
): Promise<ApprovalRow[]> {
  const admin = createAdminClient();
  const { data } = await approvals<ApprovalRow>(admin)
    .select(ROW_COLUMNS)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("requested_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  return Array.isArray(data) ? data : [];
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getApproval } from "@/server/services/hq-approvals";
import { getDraft, type DraftRow } from "@/server/services/hq-drafts";
import { getEmailProvider, emailCostUsd, type EmailMessage } from "@/lib/comms";
import {
  canRetry,
  isValidEmail,
  normalizeAddress,
  plaintextToHtml,
  suppressionReasonForOutcome,
  type SuppressionReason,
} from "@/lib/comms/policy";
import type { CommState } from "@/lib/comms/state";
import { consume, type RateLimitConfig } from "@/lib/security/rate-limit";

/**
 * CrewFlow HQ — The Communication Layer service (CEO Directive 010, Phase 4).
 *
 * The thin server API over the `hq_communications` engine — SHARED workforce
 * infrastructure every AI employee inherits (Sales, Customer Success, Finance,
 * Business Coach, Voice). It owns NO policy of its own: the delivery state machine,
 * terminal immutability, the write-once routing, and — above all — the APPROVAL GATE
 * are enforced by the database (migration 20260801000000); the deterministic
 * decisions (address normalisation, suppression matching, retry/backoff, the
 * plaintext→HTML lift) are PURE (lib/comms/). This layer is the ORCHESTRATOR — it
 * resolves the draft + approval, checks suppression, rate-limits, calls the
 * replaceable provider (or records a failed attempt when none is configured), and
 * persists one immutable row. It is NOT the boundary.
 *
 * The boundary, made explicit (the load-bearing security property):
 *   • Every delivery requires an APPROVED action. deliverDraft fast-fails when the
 *     approval is not 'approved' (a clean mirror), and the DB trigger REFUSES the
 *     insert regardless of caller — so "every outbound communication still requires
 *     the Approval Engine" holds in architecture, not convention.
 *   • NOTHING sends autonomously. deliverDraft is a CALLABLE PRIMITIVE; nothing here
 *     calls it on a timer. There is no cron, no scheduler, no queue-drainer, no
 *     follow-up. A human decision and an explicit invocation are always upstream.
 *   • When no provider is configured (e.g. CI), deliverDraft records a terminal
 *     `failed`/no_provider attempt and SENDS NOTHING — the reproducible path the
 *     integration suite exercises end-to-end.
 *   • The recipient address + the draft prose never leave the RLS-locked row: the
 *     spine event the trigger emits carries identifiers + metadata only.
 *
 * Every function returns a discriminated result; none throw on a business outcome.
 */

// ---------------------------------------------------------------------
// Typed admin shims. hq_communications / hq_comms_suppressions are service-role-only
// HQ tables, not in the generated Supabase types — cast past the typed client (the
// same `as unknown as` shim the other HQ services use; a typing convenience, not logic).
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;
type DbList<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

interface CommQuery<T> extends DbList<T> {
  select(columns: string): CommQuery<T>;
  insert(payload: unknown): CommQuery<T>;
  update(payload: unknown): CommQuery<T>;
  eq(column: string, value: unknown): CommQuery<T>;
  order(column: string, options?: { ascending?: boolean }): CommQuery<T>;
  limit(count: number): CommQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

function comms<T>(admin: AdminClient): CommQuery<T> {
  return admin.from("hq_communications" as never) as unknown as CommQuery<T>;
}
function suppressionsTable<T>(admin: AdminClient): CommQuery<T> {
  return admin.from("hq_comms_suppressions" as never) as unknown as CommQuery<T>;
}

const ROW_COLUMNS =
  "id, ai_employee_id, draft_id, approval_id, subject_type, subject_id, channel, provider, " +
  "to_address, provider_message_id, status, failure_reason, attempt, cost_usd, latency_ms, " +
  "correlation_id, supersedes_id, sent_at, settled_at, created_at, updated_at";

const SUPPRESSION_COLUMNS =
  "id, address, channel, reason, source_communication_id, note, created_at";

/** One persisted delivery attempt (the artifact + its inline cost ledger). */
export type CommunicationRow = {
  id: string;
  ai_employee_id: string;
  draft_id: string;
  approval_id: string;
  subject_type: string;
  subject_id: string;
  channel: "email";
  provider: string;
  to_address: string;
  provider_message_id: string | null;
  status: CommState;
  failure_reason: string | null;
  attempt: number;
  cost_usd: number | null;
  latency_ms: number | null;
  correlation_id: string;
  supersedes_id: string | null;
  sent_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

/** One do-not-contact entry. */
export type SuppressionRow = {
  id: string;
  address: string;
  channel: "email";
  reason: SuppressionReason;
  source_communication_id: string | null;
  note: string | null;
  created_at: string;
};

export type DeliverResult =
  | { ok: true; communication: CommunicationRow }
  | { ok: false; error: string };

/** A per-employee send throttle (the existing limiter; in-memory off-prod). */
const RATE_LIMIT: RateLimitConfig = { limit: 60, windowSeconds: 60 };

// ---------------------------------------------------------------------
// 1. deliverDraft — deliver ONE approved draft through the configured provider.
// ---------------------------------------------------------------------

export type DeliverDraftInput = {
  /** The approved draft to deliver (FK → hq_drafts.id). */
  draftId: string;
  /** The approval that gates this delivery (FK → hq_approvals.id; must be 'approved'). */
  approvalId: string;
  /** The resolved recipient address — the caller owns recipient resolution. */
  to: string;
  /** Optional From / Reply-To overrides for this send. */
  from?: string;
  replyTo?: string;
  /** Thread the delivery into a larger intent's trace; else the draft's correlation. */
  correlationId?: string;
};

/**
 * Deliver an approved draft and persist the attempt as an immutable row.
 *
 * Resolve the draft + approval → fast-fail unless the approval is 'approved' (the DB
 * gate is the real enforcer) → check suppression → rate-limit → call the provider, or
 * record a terminal `failed`/no_provider attempt when none is configured. Returns the
 * persisted row; never throws on a business outcome. Nothing here runs on a timer —
 * this is a callable primitive, invoked explicitly.
 */
export async function deliverDraft(input: DeliverDraftInput): Promise<DeliverResult> {
  const draftId = input.draftId?.trim();
  const approvalId = input.approvalId?.trim();
  const to = input.to?.trim();
  if (!draftId || !approvalId || !to) return { ok: false, error: "invalid_input" };
  if (!isValidEmail(to)) return { ok: false, error: "invalid_recipient" };

  const draft = await getDraft(draftId);
  if (!draft) return { ok: false, error: "draft_not_found" };
  const approval = await getApproval(approvalId);
  if (!approval) return { ok: false, error: "approval_not_found" };

  // Fast-fail mirror of the DB gate: never even attempt delivery of an unapproved
  // action. The BEFORE INSERT trigger is the real boundary; this returns a clean
  // error before the database does.
  if (approval.state !== "approved") return { ok: false, error: "not_approved" };

  return attemptDelivery({
    draft,
    approvalId,
    to: normalizeAddress(to),
    from: input.from,
    replyTo: input.replyTo,
    correlationId: input.correlationId ?? draft.correlation_id,
    attempt: 1,
    supersedesId: null,
  });
}

// ---------------------------------------------------------------------
// The single attempt path — shared by deliverDraft and retryDelivery.
// ---------------------------------------------------------------------

type AttemptParams = {
  draft: DraftRow;
  approvalId: string;
  to: string; // already normalised
  from?: string;
  replyTo?: string;
  correlationId: string;
  attempt: number;
  supersedesId: string | null;
};

async function attemptDelivery(p: AttemptParams): Promise<DeliverResult> {
  const admin = createAdminClient();

  // (1) Suppression — never contact a do-not-contact address. Record a `suppressed`
  // attempt (auditable) and send NOTHING. Checked first, so a blocked address never
  // consumes the send budget.
  if (await addressIsSuppressed(admin, p.to)) {
    return insertCommunication(admin, {
      ...base(p),
      provider: "none",
      providerMessageId: null,
      status: "suppressed",
      failureReason: "suppressed",
      costUsd: null,
      latencyMs: null,
    });
  }

  // (2) Rate limit — a transient throttle, NOT a delivery outcome, so no row is
  // written; the caller backs off and retries.
  const gate = await consume("comms_send", p.draft.ai_employee_id, RATE_LIMIT);
  if (!gate.allowed) return { ok: false, error: "rate_limited" };

  // (3) Provider — null when unconfigured (the CI path). Record a terminal `failed`
  // attempt and send NOTHING — the deterministic, reproducible no-send path.
  const provider = getEmailProvider();
  if (!provider) {
    return insertCommunication(admin, {
      ...base(p),
      provider: "none",
      providerMessageId: null,
      status: "failed",
      failureReason: "no_provider",
      costUsd: null,
      latencyMs: null,
    });
  }

  // (4) Send. The provider THROWS on failure → record a terminal `failed` attempt with
  // the reason; the caller may retryDelivery (which supersedes, never mutates).
  const message = buildMessage(p.draft, p.to, p.from, p.replyTo);
  const startedAt = Date.now();
  try {
    const acceptance = await provider.send(message);
    return insertCommunication(admin, {
      ...base(p),
      provider: provider.info.provider,
      providerMessageId: acceptance.providerMessageId,
      status: "sent",
      failureReason: null,
      costUsd: emailCostUsd(provider.info),
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    return insertCommunication(admin, {
      ...base(p),
      provider: provider.info.provider,
      providerMessageId: null,
      status: "failed",
      failureReason: `provider_error: ${errMessage(err)}`,
      costUsd: null,
      latencyMs: Date.now() - startedAt,
    });
  }
}

/** The fields every attempt row shares, sourced from the draft + attempt params. */
function base(p: AttemptParams) {
  return {
    draft: p.draft,
    approvalId: p.approvalId,
    to: p.to,
    attempt: p.attempt,
    correlationId: p.correlationId,
    supersedesId: p.supersedesId,
  };
}

function buildMessage(
  draft: DraftRow,
  to: string,
  from?: string,
  replyTo?: string,
): EmailMessage {
  const { subject, body } = draft.content;
  return { to, subject, html: plaintextToHtml(body), text: body, from, replyTo };
}

type InsertParams = {
  draft: DraftRow;
  approvalId: string;
  to: string;
  attempt: number;
  correlationId: string;
  supersedesId: string | null;
  provider: string;
  providerMessageId: string | null;
  status: CommState;
  failureReason: string | null;
  costUsd: number | null;
  latencyMs: number | null;
};

async function insertCommunication(
  admin: AdminClient,
  p: InsertParams,
): Promise<DeliverResult> {
  const row: Record<string, unknown> = {
    ai_employee_id: p.draft.ai_employee_id,
    draft_id: p.draft.id,
    approval_id: p.approvalId,
    subject_type: p.draft.subject_type,
    subject_id: p.draft.subject_id,
    channel: "email",
    provider: p.provider,
    to_address: p.to,
    provider_message_id: p.providerMessageId,
    status: p.status,
    failure_reason: p.failureReason,
    attempt: p.attempt,
    cost_usd: p.costUsd,
    latency_ms: p.latencyMs,
    correlation_id: p.correlationId,
    supersedes_id: p.supersedesId,
  };
  const { data, error } = await comms<CommunicationRow>(admin)
    .insert(row)
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    console.error("[hq-comms] deliver insert failed", error);
    return { ok: false, error: error?.message ?? "persist_failed" };
  }
  return { ok: true, communication: data };
}

// ---------------------------------------------------------------------
// 2. recordDeliveryEvent — apply a provider's async outcome to a sent row.
// ---------------------------------------------------------------------

export type DeliveryOutcome = "delivered" | "bounced" | "complained";

/**
 * Apply a delivery webhook outcome (delivered / bounced / complained), correlated by
 * the provider's message id, to the matching `sent` row. A bounce or complaint also
 * adds the recipient to the do-not-contact list. Idempotent: a repeated webhook for an
 * already-terminal row is a no-op success when it matches, else a reported conflict.
 *
 * (Phase 4 ships this as a callable primitive; the live, signature-verified webhook
 * route that calls it is a deferred follow-up — see ADR 0003.)
 */
export async function recordDeliveryEvent(
  providerMessageId: string,
  outcome: DeliveryOutcome,
): Promise<DeliverResult> {
  const pmid = providerMessageId?.trim();
  if (!pmid) return { ok: false, error: "invalid_input" };

  const admin = createAdminClient();
  const existing = await readByProviderMessageId(admin, pmid);
  if (!existing) return { ok: false, error: "not_found" };

  // A terminal row is frozen. A repeated webhook is a no-op success if it already
  // reached this outcome, else a conflict we report rather than force.
  if (existing.status !== "sent") {
    if (existing.status === outcome) return { ok: true, communication: existing };
    return { ok: false, error: "not_active" };
  }

  const { data, error } = await comms<CommunicationRow>(admin)
    .update({ status: outcome, failure_reason: outcomeReason(outcome) })
    .eq("id", existing.id)
    .eq("status", "sent")
    .select(ROW_COLUMNS);
  if (error) {
    console.error("[hq-comms] recordDeliveryEvent failed", error);
    return { ok: false, error: error.message };
  }
  const updated = Array.isArray(data) ? data[0] : null;
  if (!updated) {
    const current = await readCommunication(admin, existing.id);
    return current ? { ok: false, error: "not_active" } : { ok: false, error: "not_found" };
  }

  // A bounce or complaint suppresses the address — the do-not-contact rule, applied.
  const reason = suppressionReasonForOutcome(updated.status);
  if (reason) {
    await upsertSuppression(admin, {
      address: updated.to_address,
      reason,
      sourceCommunicationId: updated.id,
      note: null,
    });
  }

  return { ok: true, communication: updated };
}

function outcomeReason(outcome: DeliveryOutcome): string | null {
  if (outcome === "bounced") return "hard_bounce";
  if (outcome === "complained") return "complaint";
  return null;
}

// ---------------------------------------------------------------------
// 3. retryDelivery — a NEW attempt that supersedes a prior failed one.
// ---------------------------------------------------------------------

/**
 * Retry a failed delivery by minting a NEW attempt that supersedes the prior row (the
 * prior stays in the permanent record — retry never mutates). Only a transport
 * `failed` attempt under the cap qualifies; a bounce/complaint/suppression is a
 * permanent stop, a `sent` row is in flight, a `delivered` row succeeded.
 */
export async function retryDelivery(communicationId: string): Promise<DeliverResult> {
  const id = communicationId?.trim();
  if (!id) return { ok: false, error: "invalid_input" };

  const admin = createAdminClient();
  const prior = await readCommunication(admin, id);
  if (!prior) return { ok: false, error: "not_found" };

  if (!canRetry(prior.status, prior.attempt)) return { ok: false, error: "not_retryable" };

  // Re-resolve the draft + re-verify the approval is STILL approved, then supersede.
  const draft = await getDraft(prior.draft_id);
  if (!draft) return { ok: false, error: "draft_not_found" };
  const approval = await getApproval(prior.approval_id);
  if (!approval || approval.state !== "approved") return { ok: false, error: "not_approved" };

  return attemptDelivery({
    draft,
    approvalId: prior.approval_id,
    to: prior.to_address,
    correlationId: prior.correlation_id,
    attempt: prior.attempt + 1,
    supersedesId: prior.id,
  });
}

// ---------------------------------------------------------------------
// 4. Suppression — the do-not-contact list.
// ---------------------------------------------------------------------

export type AddSuppressionInput = {
  address: string;
  reason: SuppressionReason;
  sourceCommunicationId?: string | null;
  note?: string | null;
};

/** Add an address to the do-not-contact list (idempotent — the first entry stands). */
export async function addSuppression(
  input: AddSuppressionInput,
): Promise<{ ok: boolean; error?: string }> {
  const address = normalizeAddress(input.address ?? "");
  if (!address) return { ok: false, error: "invalid_input" };
  const admin = createAdminClient();
  await upsertSuppression(admin, {
    address,
    reason: input.reason,
    sourceCommunicationId: input.sourceCommunicationId ?? null,
    note: input.note ?? null,
  });
  return { ok: true };
}

/** Is this address on the do-not-contact list? */
export async function isSuppressed(address: string): Promise<boolean> {
  if (!address?.trim()) return false;
  return addressIsSuppressed(createAdminClient(), address);
}

async function addressIsSuppressed(admin: AdminClient, address: string): Promise<boolean> {
  const { data } = await suppressionsTable<SuppressionRow>(admin)
    .select("id")
    .eq("address", normalizeAddress(address))
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

type UpsertSuppression = {
  address: string; // already normalised
  reason: SuppressionReason;
  sourceCommunicationId: string | null;
  note: string | null;
};

/**
 * Insert-if-absent. address is UNIQUE, so an existing suppression stands (its original
 * reason/source is the permanent record); a duplicate is a benign no-op. A lost race
 * on the unique index surfaces as a logged error, never a thrown one.
 */
async function upsertSuppression(admin: AdminClient, p: UpsertSuppression): Promise<void> {
  const { data: existing } = await suppressionsTable<SuppressionRow>(admin)
    .select("id")
    .eq("address", p.address)
    .limit(1);
  if (Array.isArray(existing) && existing.length > 0) return;

  const { error } = await suppressionsTable<SuppressionRow>(admin).insert({
    address: p.address,
    channel: "email",
    reason: p.reason,
    source_communication_id: p.sourceCommunicationId,
    note: p.note,
  });
  if (error) console.error("[hq-comms] suppression insert failed (benign on race)", error);
}

// ---------------------------------------------------------------------
// 5. Reads.
// ---------------------------------------------------------------------

async function readCommunication(admin: AdminClient, id: string): Promise<CommunicationRow | null> {
  const { data } = await comms<CommunicationRow>(admin).select(ROW_COLUMNS).eq("id", id).maybeSingle();
  return data ?? null;
}

async function readByProviderMessageId(
  admin: AdminClient,
  providerMessageId: string,
): Promise<CommunicationRow | null> {
  const { data } = await comms<CommunicationRow>(admin)
    .select(ROW_COLUMNS)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  return data ?? null;
}

export async function getCommunication(id: string): Promise<CommunicationRow | null> {
  if (!id?.trim()) return null;
  return readCommunication(createAdminClient(), id);
}

export async function listCommunicationsForDraft(
  draftId: string,
  limit = 50,
): Promise<CommunicationRow[]> {
  if (!draftId?.trim()) return [];
  const { data } = await comms<CommunicationRow>(createAdminClient())
    .select(ROW_COLUMNS)
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function listCommunicationsForSubject(
  subjectType: string,
  subjectId: string,
  limit = 50,
): Promise<CommunicationRow[]> {
  if (!subjectType?.trim() || !subjectId?.trim()) return [];
  const { data } = await comms<CommunicationRow>(createAdminClient())
    .select(ROW_COLUMNS)
    .eq("subject_type", subjectType)
    .eq("subject_id", subjectId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function listSuppressions(limit = 100): Promise<SuppressionRow[]> {
  const { data } = await suppressionsTable<SuppressionRow>(createAdminClient())
    .select(SUPPRESSION_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { getStripe } from "@/lib/stripe/client";
import { cleanupOrgStorage, type StorageApi } from "@/server/services/gdpr-erase";
import {
  USER_ERASE_ACCOUNT_GLOBAL_REFS,
  USER_ERASE_CONDITIONAL_REFS,
  USER_ERASE_DELETE_REFS,
  USER_ERASE_EMPLOYER_GLOBAL_REFS,
  USER_ERASE_RETAIN_REFS,
  USER_ERASE_SCRUB_REFS,
} from "@/lib/gdpr/user-erasure";

/**
 * ACCOUNT & DATA DELETION — the executor.
 *
 * Three flows, one resumable engine:
 *   • `user_account`  a person deletes their OWN account + profile;
 *   • `staff_erasure` an owner/admin removes a staff member and erases the
 *                     personal data the company holds about them;
 *   • `org`           the OWNER deletes the whole company.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A DELETION RUNS (and why it survives a crash).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every deletion is a row in `privacy_deletion_requests` (migration
 * 20261311000000) — the request, the job ledger and, once sealed, the tombstone.
 * `runDeletionRequest` CLAIMS the row (an atomic, leased, single-runner claim),
 * then walks an ordered list of steps. A step is either
 *   - a single-transaction, service_role-only SQL primitive that records itself
 *     in the ledger in the SAME transaction as its work, or
 *   - an external side effect (Stripe, Storage, Supabase Auth) that is
 *     idempotent by construction and is recorded in the ledger afterwards.
 * A step already recorded is never repeated. So a process that dies anywhere is
 * resumed by simply running the request again: finished steps are skipped,
 * the interrupted one is redone safely, and nothing is orphaned.
 *
 * THE TARGET NEVER COMES FROM THE CALLER. `runDeletionRequest` takes only a
 * request id; the SQL primitives read the org / user FROM THE LEDGER ROW. A
 * retry or a replay cannot be pointed at a different tenant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SERVICE-ROLE CLIENT.
 * ─────────────────────────────────────────────────────────────────────────────
 * The primitives are service_role-only (a destructive function must be
 * unreachable with the public anon key) and a deletion removes the very
 * memberships that would authorise a user-JWT. The AUTHZ boundary is therefore
 * the calling server action (feature flag + session + re-authentication + typed
 * confirmation) AND `privacy_request_create`, which independently re-proves the
 * actor's authority and the confirmation against the database under row locks.
 */

/** Server-only switch for the whole capability. DEFAULTS OFF (dark). */
export function accountDeletionEnabled(): boolean {
  return process.env.FEATURE_ACCOUNT_DELETION === "true";
}

/**
 * Cooling-off before a COMPANY deletion runs. The request can be cancelled by
 * any owner until then. See DELETION-DESIGN.md §4 for the trade-off.
 */
export const ORG_DELETION_COOLING_OFF_SECONDS = 7 * 24 * 60 * 60;

/** How long CrewFlow keeps its own minimised billing record of a deleted company. */
export const BILLING_RETENTION_YEARS = 6;

/** A request that has failed this many times waits for a human, not the cron. */
export const MAX_AUTOMATIC_ATTEMPTS = 8;

const FORM_IMPORTS_BUCKET = "form-imports";

// ─── types ───────────────────────────────────────────────────────────────────

type RpcError = { message: string; code?: string; details?: string | null };
type RpcResult = { data: unknown; error: RpcError | null };
type QueryResult<T> = { data: T | null; error: RpcError | null };

type LooseFilter<T> = PromiseLike<QueryResult<T[]>> & {
  eq(col: string, v: unknown): LooseFilter<T>;
  in(col: string, v: unknown[]): LooseFilter<T>;
  lte(col: string, v: unknown): LooseFilter<T>;
  lt(col: string, v: unknown): LooseFilter<T>;
  order(col: string, opts?: { ascending?: boolean }): LooseFilter<T>;
  limit(n: number): LooseFilter<T>;
  range(from: number, to: number): LooseFilter<T>;
  maybeSingle(): PromiseLike<QueryResult<T>>;
};

/** The narrow slice of the Supabase admin client this service uses. */
export type DeletionAdminClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  from(table: string): { select<T = Record<string, unknown>>(cols: string): LooseFilter<T> };
  storage: StorageApi;
  auth: {
    admin: {
      deleteUser(
        id: string,
        shouldSoftDelete?: boolean,
      ): Promise<{ error: { message: string; status?: number } | null }>;
    };
  };
};

/** The narrow slice of the Stripe SDK this service uses (mocked in tests). */
export type StripeSubscriptionsApi = {
  subscriptions: {
    retrieve(id: string): Promise<{ status: string }>;
    cancel(
      id: string,
      params?: { invoice_now?: boolean; prorate?: boolean },
      opts?: { idempotencyKey?: string },
    ): Promise<{ status: string }>;
  };
};

export type DeletionDeps = {
  admin?: DeletionAdminClient;
  /** `undefined` → the configured Stripe client; `null` → Stripe not configured. */
  stripe?: StripeSubscriptionsApi | null;
  now?: () => Date;
  /** Lease, in seconds, the claim holds while this run works. */
  leaseSeconds?: number;
  /**
   * TEST SEAM (fault injection): called after each step is durably recorded.
   * Throwing here simulates the process dying at that exact point.
   */
  afterStep?: (step: string) => void | Promise<void>;
};

export type DeletionKind = "user_account" | "staff_erasure" | "org";

export type DeletionRunResult =
  | { status: "completed"; requestId: string; kind: DeletionKind }
  | { status: "cancelled"; requestId: string; reason: string }
  | { status: "not_claimed"; requestId: string }
  | { status: "failed"; requestId: string; errorCode: string };

type Claim = {
  request_id: string;
  claimed: boolean;
  status: string;
  kind: DeletionKind;
  target_org_id: string | null;
  target_user_id: string | null;
  steps: Record<string, unknown>;
  work: Record<string, unknown>;
};

/** A step failure carrying a SYMBOLIC code — never a raw message (no row data). */
export class DeletionStepError extends Error {
  readonly code: string;
  constructor(step: string, reason: string, detail?: string) {
    super(`privacy deletion: step ${step} failed (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "DeletionStepError";
    this.code = `${step}:${reason}`;
  }
}

function resolveAdmin(deps?: DeletionDeps): DeletionAdminClient {
  return deps?.admin ?? (createAdminClient() as unknown as DeletionAdminClient);
}

function resolveStripe(deps?: DeletionDeps): StripeSubscriptionsApi | null {
  if (deps && "stripe" in deps && deps.stripe !== undefined) return deps.stripe;
  return getStripe() as unknown as StripeSubscriptionsApi | null;
}

async function rpc<T>(
  admin: DeletionAdminClient,
  step: string,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new DeletionStepError(step, error.code || "rpc_error", error.message);
  return data as T;
}

async function stepDone(
  admin: DeletionAdminClient,
  deps: DeletionDeps | undefined,
  requestId: string,
  step: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await rpc(admin, step, "privacy_request_step_done", {
    p_request_id: requestId,
    p_step: step,
    p_detail: detail,
  });
  await deps?.afterStep?.(step);
}

/** 31 December, BILLING_RETENTION_YEARS after the end of the current year. */
export function billingRetentionUntil(now: Date): string {
  return `${now.getUTCFullYear() + BILLING_RETENTION_YEARS}-12-31`;
}

// ─── request creation / cancellation (called by the gated server actions) ────

export type CreateOutcome =
  | { ok: true; requestId: string; status: string; scheduledFor: string; created: boolean }
  | { ok: false; code: "forbidden" | "confirmation" | "sole_owner" | "not_found" | "error"; message: string };

function mapCreateError(error: RpcError): CreateOutcome {
  if (error.details === "sole_owner") {
    return {
      ok: false,
      code: "sole_owner",
      message:
        "You are the only owner of a company. Delete the company, or have another owner added, before deleting your account.",
    };
  }
  if (error.code === "42501") {
    return { ok: false, code: "forbidden", message: "You are not allowed to do that." };
  }
  if (error.code === "23514") {
    return { ok: false, code: "confirmation", message: "The confirmation text does not match." };
  }
  if (error.code === "P0002") {
    return { ok: false, code: "not_found", message: "Nothing to delete was found." };
  }
  return { ok: false, code: "error", message: "The request could not be recorded. Nothing was deleted." };
}

async function createRequest(
  admin: DeletionAdminClient,
  args: {
    kind: DeletionKind;
    orgId: string | null;
    userId: string | null;
    actorUserId: string;
    confirm: string;
    coolingOffSeconds: number;
  },
): Promise<CreateOutcome> {
  const { data, error } = await admin.rpc("privacy_request_create", {
    p_kind: args.kind,
    p_target_org_id: args.orgId,
    p_target_user_id: args.userId,
    p_actor_user_id: args.actorUserId,
    p_confirm: args.confirm,
    p_cooling_off_seconds: args.coolingOffSeconds,
  });
  if (error) return mapCreateError(error);
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    requestId: String(row.request_id),
    status: String(row.status),
    scheduledFor: String(row.scheduled_for),
    created: row.created === true,
  };
}

/**
 * Record an OWNER's request to delete the whole company. Nothing is destroyed
 * now: the request becomes runnable after the cooling-off window and can be
 * cancelled until then. The caller MUST have re-authenticated the user.
 */
export async function requestOrgDeletion(
  params: { orgId: string; actorUserId: string; confirmName: string },
  deps?: DeletionDeps,
): Promise<CreateOutcome> {
  return createRequest(resolveAdmin(deps), {
    kind: "org",
    orgId: params.orgId,
    userId: null,
    actorUserId: params.actorUserId,
    confirm: params.confirmName,
    coolingOffSeconds: ORG_DELETION_COOLING_OFF_SECONDS,
  });
}

export type CancelOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; code: "forbidden" | "already_started" | "not_found" | "error"; message: string };

/** Cancel a company deletion that is still in its cooling-off window. */
export async function cancelOrgDeletion(
  params: { requestId: string; actorUserId: string },
  deps?: DeletionDeps,
): Promise<CancelOutcome> {
  const { data, error } = await resolveAdmin(deps).rpc("privacy_request_cancel", {
    p_request_id: params.requestId,
    p_actor_user_id: params.actorUserId,
  });
  if (error) {
    if (error.details === "already_started") {
      return {
        ok: false,
        code: "already_started",
        message: "The deletion has already started and can no longer be cancelled.",
      };
    }
    if (error.code === "42501") {
      return { ok: false, code: "forbidden", message: "Only an owner of the company can cancel its deletion." };
    }
    if (error.code === "P0002") {
      return { ok: false, code: "not_found", message: "That deletion request no longer exists." };
    }
    return { ok: false, code: "error", message: "The request could not be cancelled." };
  }
  return { ok: true, changed: (data as { changed?: boolean } | null)?.changed === true };
}

/**
 * Delete the caller's OWN account, now. The caller MUST have re-authenticated
 * the user. Refused (nothing recorded) while they are the sole owner of a
 * company.
 */
export async function requestAccountDeletion(
  params: { userId: string; confirmEmail: string },
  deps?: DeletionDeps,
): Promise<CreateOutcome & { run?: DeletionRunResult }> {
  const admin = resolveAdmin(deps);
  const created = await createRequest(admin, {
    kind: "user_account",
    orgId: null,
    userId: params.userId,
    actorUserId: params.userId,
    confirm: params.confirmEmail,
    coolingOffSeconds: 0,
  });
  if (!created.ok) return created;
  const run = await runDeletionRequest(created.requestId, { ...deps, admin });
  return { ...created, run };
}

/**
 * Remove a staff member from ONE company and erase the personal data that
 * company holds about them, now. Their login is NOT deleted — it is theirs.
 */
export async function requestStaffErasure(
  params: { orgId: string; actorUserId: string; staffUserId: string; confirmEmail: string },
  deps?: DeletionDeps,
): Promise<CreateOutcome & { run?: DeletionRunResult }> {
  const admin = resolveAdmin(deps);
  const created = await createRequest(admin, {
    kind: "staff_erasure",
    orgId: params.orgId,
    userId: params.staffUserId,
    actorUserId: params.actorUserId,
    confirm: params.confirmEmail,
    coolingOffSeconds: 0,
  });
  if (!created.ok) return created;
  const run = await runDeletionRequest(created.requestId, { ...deps, admin });
  return { ...created, run };
}

export type LiveOrgDeletion = {
  requestId: string;
  status: "scheduled" | "running" | "failed";
  scheduledFor: string;
  createdAt: string;
};

/**
 * The live (not yet finished) company-deletion request for `orgId`, if any.
 * `orgId` MUST be the caller's authorised active org — the pin below is the
 * only tenant boundary on this service-role read.
 */
export async function getLiveOrgDeletion(
  orgId: string,
  deps?: DeletionDeps,
): Promise<LiveOrgDeletion | null> {
  const { data, error } = await resolveAdmin(deps)
    .from("privacy_deletion_requests")
    .select<{ id: string; status: LiveOrgDeletion["status"]; scheduled_for: string; created_at: string }>(
      "id, status, scheduled_for, created_at",
    )
    .eq("kind", "org")
    .eq("target_org_id", orgId)
    .in("status", ["scheduled", "running", "failed"])
    .maybeSingle();
  if (error) throw new Error(`privacy deletion: live request read failed: ${error.message}`);
  if (!data) return null;
  return {
    requestId: data.id,
    status: data.status,
    scheduledFor: data.scheduled_for,
    createdAt: data.created_at,
  };
}

// ─── the engine ──────────────────────────────────────────────────────────────

/**
 * Claim and run one deletion request to completion, resuming from whatever
 * steps are already recorded. Safe to call repeatedly and concurrently: only
 * one caller holds the claim; the rest get `not_claimed`.
 */
export async function runDeletionRequest(
  requestId: string,
  deps?: DeletionDeps,
): Promise<DeletionRunResult> {
  const admin = resolveAdmin(deps);

  const { data: claimData, error: claimError } = await admin.rpc("privacy_request_claim", {
    p_request_id: requestId,
    p_lease_seconds: deps?.leaseSeconds ?? 300,
  });
  if (claimError) throw new Error(`privacy deletion: claim failed: ${claimError.message}`);
  const claim = claimData as Claim | null;
  if (!claim) return { status: "not_claimed", requestId };
  if (!claim.claimed) {
    return { status: "cancelled", requestId, reason: "requester_not_owner" };
  }

  try {
    if (claim.kind === "org") {
      await runOrgDeletion(admin, deps, claim);
    } else if (claim.kind === "user_account") {
      const cancelled = await runAccountDeletion(admin, deps, claim);
      if (cancelled) return { status: "cancelled", requestId, reason: cancelled };
    } else {
      await runStaffErasure(admin, deps, claim);
    }
    return { status: "completed", requestId, kind: claim.kind };
  } catch (e) {
    const errorCode = e instanceof DeletionStepError ? e.code : "executor:unexpected";
    // Operator-facing log line: the symbolic code only — no row data.
    console.error("[privacy-deletion] request failed", { requestId, errorCode });
    const { error: failError } = await admin.rpc("privacy_request_fail", {
      p_request_id: requestId,
      p_error_code: errorCode,
    });
    if (failError) {
      console.error("[privacy-deletion] could not record failure", { requestId, code: failError.code });
    }
    return { status: "failed", requestId, errorCode };
  }
}

async function readRequestWork(
  admin: DeletionAdminClient,
  requestId: string,
): Promise<{ steps: Record<string, unknown>; work: Record<string, unknown> }> {
  const { data, error } = await admin
    .from("privacy_deletion_requests")
    .select<{ steps: Record<string, unknown>; work: Record<string, unknown> }>("steps, work")
    .eq("id", requestId)
    .maybeSingle();
  if (error || !data) {
    throw new DeletionStepError("ledger", error?.code || "read_failed", error?.message);
  }
  return data;
}

// ─── company deletion ────────────────────────────────────────────────────────

async function runOrgDeletion(
  admin: DeletionAdminClient,
  deps: DeletionDeps | undefined,
  claim: Claim,
): Promise<void> {
  const requestId = claim.request_id;
  const orgId = claim.target_org_id as string;
  const done = (step: string) => step in claim.steps;

  // 1. Stripe FIRST — a company is never torn down while still being billed.
  if (!done("stripe_cancel")) {
    const detail = await cancelOrgSubscriptions(admin, resolveStripe(deps), requestId, orgId);
    await stepDone(admin, deps, requestId, "stripe_cancel", detail);
  }

  // 2. Lock the doors: memberships + API keys gone, member ids captured.
  if (!done("lockout")) {
    await rpc(admin, "lockout", "privacy_org_lockout", { p_request_id: requestId });
    await deps?.afterStep?.("lockout");
  }

  // 3. Storage bytes (Storage API — a SQL row delete would orphan the objects).
  if (!done("storage")) {
    let removed: number;
    try {
      removed = await cleanupOrgStorage(admin.storage, orgId);
    } catch (e) {
      throw new DeletionStepError("storage", "storage_error", e instanceof Error ? e.message : undefined);
    }
    await stepDone(admin, deps, requestId, "storage", { objects: removed });
  }

  // 4. The teardown cascade (archives minimal billing first; catalogue-verified).
  if (!done("teardown")) {
    await rpc(admin, "teardown", "privacy_org_teardown", {
      p_request_id: requestId,
      p_retention_until: billingRetentionUntil(deps?.now?.() ?? new Date()),
    });
    await deps?.afterStep?.("teardown");
  }

  // 5. Accounts left with no company at all.
  if (!done("identities")) {
    const { work } = await readRequestWork(admin, requestId);
    const memberIds = Array.isArray(work.member_ids) ? (work.member_ids as string[]) : [];
    const tally = { hard_deleted: 0, anonymised_placeholder: 0, kept_other_membership: 0, already_gone: 0 };
    for (const userId of memberIds) {
      const disposition = await eraseIdentity(admin, requestId, userId);
      tally[disposition] += 1;
    }
    await stepDone(admin, deps, requestId, "identities", tally);
  }

  await rpc(admin, "complete", "privacy_request_complete", {
    p_request_id: requestId,
    p_required_steps: ["stripe_cancel", "lockout", "storage", "teardown", "identities"],
    p_retention_until: null,
  });
}

/**
 * Cancel every Stripe subscription recorded for the org. Idempotent: an
 * already-cancelled or no-longer-existing subscription counts as done. The
 * Stripe CUSTOMER is deliberately NOT deleted — its invoices are CrewFlow's own
 * accounting records (see DELETION-DESIGN.md §6).
 *
 * FAIL-CLOSED: if the org has a subscription id but Stripe is not configured,
 * the step fails and the deletion does not proceed — otherwise a company could
 * be erased while its card keeps being charged.
 */
async function cancelOrgSubscriptions(
  admin: DeletionAdminClient,
  stripe: StripeSubscriptionsApi | null,
  requestId: string,
  orgId: string,
): Promise<Record<string, unknown>> {
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select<{ stripe_subscription_id: string | null }>("stripe_subscription_id")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw new DeletionStepError("stripe_cancel", orgError.code || "read_failed", orgError.message);
  if (!org) return { subscriptions: 0, org_present: false };

  const { data: subs, error: subsError } = await admin
    .from("org_subscriptions")
    .select<{ stripe_subscription_id: string | null }>("stripe_subscription_id")
    .eq("org_id", orgId)
    .limit(50);
  if (subsError) throw new DeletionStepError("stripe_cancel", subsError.code || "read_failed", subsError.message);

  const ids = new Set<string>();
  if (org.stripe_subscription_id) ids.add(org.stripe_subscription_id);
  for (const s of subs ?? []) if (s.stripe_subscription_id) ids.add(s.stripe_subscription_id);
  if (ids.size === 0) return { subscriptions: 0, org_present: true };

  if (!stripe) throw new DeletionStepError("stripe_cancel", "stripe_unconfigured");

  let cancelled = 0;
  let already = 0;
  for (const id of ids) {
    try {
      const current = await stripe.subscriptions.retrieve(id);
      if (current.status === "canceled") {
        already += 1;
        continue;
      }
      await stripe.subscriptions.cancel(
        id,
        { invoice_now: false, prorate: false },
        { idempotencyKey: `privacy-deletion-${requestId}-${id}` },
      );
      cancelled += 1;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === "resource_missing") {
        already += 1; // the subscription no longer exists at Stripe
        continue;
      }
      throw new DeletionStepError("stripe_cancel", "stripe_error");
    }
  }
  return { subscriptions: ids.size, cancelled, already_cancelled: already, org_present: true };
}

// ─── identity ────────────────────────────────────────────────────────────────

type IdentityDisposition =
  | "hard_deleted"
  | "anonymised_placeholder"
  | "kept_other_membership"
  | "already_gone";

/**
 * Destroy one person's login identity. The SQL primitive blanks the profile,
 * clears user-keyed personal rows and reports what still references the user;
 * then Supabase Auth either HARD-deletes the user (nothing references them) or
 * SOFT-deletes it (retained records still need a row to point at: credentials,
 * sessions, email and metadata are destroyed and an anonymous placeholder
 * remains). Either way every session and refresh token is revoked.
 */
async function eraseIdentity(
  admin: DeletionAdminClient,
  requestId: string,
  userId: string,
): Promise<IdentityDisposition> {
  const scrub = await rpc<{ outcome: string; footprint_total: number | null }>(
    admin,
    "identity",
    "privacy_user_identity_scrub",
    {
      p_request_id: requestId,
      p_user_id: userId,
      p_global_delete: [...USER_ERASE_ACCOUNT_GLOBAL_REFS],
    },
  );
  if (scrub.outcome === "has_memberships") return "kept_other_membership";
  if (scrub.outcome === "already_gone") {
    // public.users is gone; make sure no auth row lingers (idempotent).
    await deleteAuthUser(admin, userId, false);
    return "already_gone";
  }
  const hard = Number(scrub.footprint_total ?? 0) === 0;
  await deleteAuthUser(admin, userId, !hard);
  return hard ? "hard_deleted" : "anonymised_placeholder";
}

async function deleteAuthUser(
  admin: DeletionAdminClient,
  userId: string,
  soft: boolean,
): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId, soft);
  if (!error) return;
  // Already deleted (a resumed run) is success, not failure.
  if (error.status === 404 || /not found/i.test(error.message)) return;
  throw new DeletionStepError("identity", `auth_${error.status ?? "error"}`);
}

// ─── one person ──────────────────────────────────────────────────────────────

/** Remove the stored files behind document-import drafts the person uploaded. */
async function removeUserFormImportFiles(
  admin: DeletionAdminClient,
  orgId: string,
  userId: string,
): Promise<number> {
  const { data, error } = await fetchAllRows<{ id: string; storage_path: string | null }>((from, to) =>
    admin
      .from("form_import_drafts")
      .select<{ id: string; storage_path: string | null }>("id, storage_path")
      .eq("org_id", orgId)
      .eq("created_by", userId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) {
    throw new DeletionStepError("user_files", "read_failed");
  }
  // Only paths under this org's own prefix are ever removed.
  const paths = data
    .map((d) => d.storage_path)
    .filter((p): p is string => typeof p === "string" && p.startsWith(`${orgId}/`));
  if (paths.length === 0) return 0;
  const { error: removeError } = await admin.storage.from(FORM_IMPORTS_BUCKET).remove(paths);
  if (removeError) throw new DeletionStepError("user_files", "storage_error");
  return paths.length;
}

async function eraseUserInOrg(
  admin: DeletionAdminClient,
  deps: DeletionDeps | undefined,
  requestId: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await removeUserFormImportFiles(admin, orgId, userId);
  await rpc(admin, "erase_org", "privacy_user_erase_in_org", {
    p_request_id: requestId,
    p_org_id: orgId,
    p_delete: [...USER_ERASE_DELETE_REFS],
    p_scrub: [...USER_ERASE_SCRUB_REFS],
    p_conditional: [...USER_ERASE_CONDITIONAL_REFS],
    p_retain: [...USER_ERASE_RETAIN_REFS],
    p_employer_global: [...USER_ERASE_EMPLOYER_GLOBAL_REFS],
  });
  await deps?.afterStep?.(`erase_org:${orgId}`);
}

/** Returns a cancellation reason when the run-time sole-owner re-check refuses. */
async function runAccountDeletion(
  admin: DeletionAdminClient,
  deps: DeletionDeps | undefined,
  claim: Claim,
): Promise<string | null> {
  const requestId = claim.request_id;
  const userId = claim.target_user_id as string;

  if (!("lockout" in claim.steps)) {
    const lock = await rpc<{ cancelled?: boolean; reason?: string }>(
      admin,
      "lockout",
      "privacy_user_lockout",
      { p_request_id: requestId },
    );
    if (lock?.cancelled) return lock.reason ?? "sole_owner";
    await deps?.afterStep?.("lockout");
  }

  const { steps, work } = await readRequestWork(admin, requestId);
  const orgIds = Array.isArray(work.org_ids) ? (work.org_ids as string[]) : [];
  for (const orgId of orgIds) {
    if (`erase_org:${orgId}` in steps) continue;
    await eraseUserInOrg(admin, deps, requestId, orgId, userId);
  }

  if (!("identity" in steps)) {
    const disposition = await eraseIdentity(admin, requestId, userId);
    await stepDone(admin, deps, requestId, "identity", { disposition });
  }

  await rpc(admin, "complete", "privacy_request_complete", {
    p_request_id: requestId,
    p_required_steps: ["lockout", "identity", ...orgIds.map((o) => `erase_org:${o}`)],
    p_retention_until: null,
  });
  return null;
}

async function runStaffErasure(
  admin: DeletionAdminClient,
  deps: DeletionDeps | undefined,
  claim: Claim,
): Promise<void> {
  const requestId = claim.request_id;
  const orgId = claim.target_org_id as string;
  const userId = claim.target_user_id as string;
  if (!(`erase_org:${orgId}` in claim.steps)) {
    await eraseUserInOrg(admin, deps, requestId, orgId, userId);
  }
  await rpc(admin, "complete", "privacy_request_complete", {
    p_request_id: requestId,
    p_required_steps: [`erase_org:${orgId}`],
    p_retention_until: null,
  });
}

// ─── scheduled drain (cooling-off expiry + automatic retry) ──────────────────

export type DrainSummary = {
  enabled: boolean;
  considered: number;
  results: Array<{ requestId: string; status: DeletionRunResult["status"] }>;
};

/**
 * Run every deletion request that is due: company deletions whose cooling-off
 * has ended, and interrupted or failed requests of any kind. Called by the
 * daily retention cron. Inert while the capability is dark.
 */
export async function drainDueDeletionRequests(
  opts: { limit?: number } = {},
  deps?: DeletionDeps,
): Promise<DrainSummary> {
  if (!accountDeletionEnabled()) return { enabled: false, considered: 0, results: [] };
  const admin = resolveAdmin(deps);
  const nowIso = (deps?.now?.() ?? new Date()).toISOString();
  const { data, error } = await admin
    .from("privacy_deletion_requests")
    .select<{ id: string }>("id")
    .in("status", ["scheduled", "failed", "running"])
    .lte("scheduled_for", nowIso)
    .lt("attempts", MAX_AUTOMATIC_ATTEMPTS)
    .order("scheduled_for", { ascending: true })
    .limit(Math.min(Math.max(opts.limit ?? 10, 1), 50));
  if (error) throw new Error(`privacy deletion: due-request read failed: ${error.message}`);

  const results: DrainSummary["results"] = [];
  for (const row of data ?? []) {
    const r = await runDeletionRequest(row.id, { ...deps, admin });
    results.push({ requestId: row.id, status: r.status });
  }
  return { enabled: true, considered: results.length, results };
}

// ─── backup restore: re-apply tombstones ─────────────────────────────────────

export type Tombstone = {
  id: string;
  kind: DeletionKind;
  target_org_id: string | null;
  target_user_id: string | null;
  completed_at: string;
  retention_until?: string | null;
};

/** Every sealed tombstone (opaque ids + timestamps) — for the off-platform backup. */
export async function exportTombstones(
  since: string | null,
  deps?: DeletionDeps,
): Promise<Tombstone[]> {
  const { data, error } = await resolveAdmin(deps).rpc("privacy_tombstone_export", {
    p_since: since,
  });
  if (error) throw new Error(`privacy deletion: tombstone export failed: ${error.message}`);
  return (data ?? []) as Tombstone[];
}

export type ReapplySummary = Array<{
  tombstoneId: string;
  outcome: "already_applied" | "nothing_to_reapply" | "resumed" | "reapply_scheduled";
  run?: DeletionRunResult["status"];
}>;

/**
 * AFTER A RESTORE, before the application is reopened: for every tombstone the
 * restored database no longer honours, record a re-application and run it. A
 * restored backup can therefore never silently resurrect an erased person or
 * company. Operator-run (see docs/programme/deletion/DELETION-DESIGN.md §7).
 */
export async function reapplyTombstones(
  tombstones: Tombstone[],
  deps?: DeletionDeps,
): Promise<ReapplySummary> {
  const admin = resolveAdmin(deps);
  const out: ReapplySummary = [];
  for (const t of tombstones) {
    const { data, error } = await admin.rpc("privacy_tombstone_reapply", { p_tombstone: t });
    if (error) throw new Error(`privacy deletion: tombstone re-apply failed: ${error.message}`);
    const res = (data ?? {}) as { outcome: ReapplySummary[number]["outcome"]; request_id?: string };
    if ((res.outcome === "reapply_scheduled" || res.outcome === "resumed") && res.request_id) {
      const run = await runDeletionRequest(res.request_id, { ...deps, admin });
      out.push({ tombstoneId: t.id, outcome: res.outcome, run: run.status });
    } else {
      out.push({ tombstoneId: t.id, outcome: res.outcome });
    }
  }
  return out;
}

import "server-only";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE AI COST GOVERNOR — the one seam every AI call passes through.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS BEFORE ANYTHING GENERATIVE IS LIVE
 * --------------------------------------------------
 * CrewFlow's subscription is ~£500/month/org. The AI budget carries a HARD
 * CEILING of £100/month/org — a SAFETY LIMIT, not a target. Nothing generative
 * is switched on today: every cost tier maps to NO model (see
 * ./governor/registry.ts). This module is deliberately built and wired FIRST, so
 * that on the day a provider is authorised, governance is already in the path
 * rather than being retrofitted around a system that has learned to spend.
 *
 * THE EVENT-DRIVEN DOCTRINE
 * -------------------------
 * **AI wakes on meaningful change, never on page load.**
 *
 * This is the single most important cost rule in the system, and it is a rule
 * about WHERE calls are made, which no wrapper can enforce on its own. A page
 * that asks a model to summarise something every time it renders will burn a
 * month's ceiling on a single operator refreshing a dashboard, and every one of
 * those calls will look individually reasonable in the ledger. So:
 *
 *   - A governed call belongs on an EVENT — a receipt uploaded, a message
 *     received, a job completed, a record changed. Something happened that did
 *     not happen before.
 *   - A governed call does NOT belong in a render path, a `useEffect`, a poll,
 *     a page-load server component, or anything that runs again when nothing
 *     has changed.
 *   - If the same answer would do, do not ask again. That is what the recent-
 *     duplicate check below is for; it is a backstop for the doctrine, not a
 *     substitute for following it. It is now a DB-level guarantee rather than a
 *     hopeful read — but a backstop that cannot be raced is still a backstop.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   1. REFUSAL. A deterministic task never reaches a model. An org over its
 *      ceiling gets no further calls until the month rolls.
 *   2. ACCOUNTING. Every call that reaches a provider is recorded — successes
 *      AND failures, with tokens, latency and an estimated cost.
 *   3. TRANSPARENCY. HQ can see spend by org and by feature, and a spike is
 *      flagged against the org's own history.
 *   4. ATOMICITY UNDER CONCURRENCY. See below — this is the one that was
 *      missing, and it is the one that made the ceiling a suggestion.
 *
 * THE RESERVATION — WHY THE CEILING USED TO BE A SUGGESTION
 * --------------------------------------------------------
 * The first version of this module read the month's total, ran the call, then
 * recorded the cost. That is a READ-THEN-ACT decision, and it failed in exactly
 * the two ways read-then-act always fails:
 *
 *   - N calls issued in the same tick all read the SAME pre-spend total, all
 *     found themselves under the ceiling, and all spent. Overshoot was bounded
 *     only by (in-flight x per-call cost). Sequential traffic was exact, which
 *     is why it looked fine.
 *   - The duplicate probe raced identically: ten SIMULTANEOUS identical submits
 *     all missed and all paid. One impatient double-click cost ten times.
 *
 * Both were measured, pinned as findings, and are now fixed by moving the
 * decision into ONE SQL statement under a per-org advisory lock
 * (supabase/migrations/20261070000000). The shape is RESERVE, then SETTLE:
 *
 *   1. RESERVE — `ai_reserve_invocation` re-reads committed + live-reserved
 *      inside a lock and conditionally inserts a claim only if this call's
 *      pessimistic cost still fits. The claim is visible to every other caller
 *      the instant it commits, which is the property a post-hoc ledger row can
 *      never have. No set of concurrent callers can exceed the ceiling.
 *   2. CALL the provider. The lock is NOT held across it.
 *   3. SETTLE — `ai_settle_reservation` writes the immutable ledger row and
 *      frees the claim in one transaction, so there is no window in which the
 *      spend is recorded but the claim still stands (over-blocking) or the claim
 *      is freed but the spend is not (under-counting).
 *
 * A crashed process cannot hold budget hostage: a claim carries a TTL and every
 * arithmetic path counts only unexpired claims, so the headroom comes back by
 * itself with no cron in the refusal path.
 *
 * ONE RESIDUE, STATED RATHER THAN HIDDEN. The ceiling holds exactly while each
 * call's true cost is no greater than the claim it was admitted on. A call that
 * costs MORE than its own worst-case envelope can push committed spend past the
 * ceiling by the shortfall. That is why the envelope lives on the model binding
 * as a required field, and why `ai_reservations_month_totals.overrun_count`
 * exists: a non-zero count means the envelope is too tight for the bound model.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not swallow provider errors. A failure is RECORDED and RETHROWN, so
 * every existing caller's own try/catch — and therefore its existing degraded
 * behaviour — is preserved byte for byte. The governor observes and refuses; it
 * never silently changes what a feature returns.
 *
 * THE DARK SHORT-CIRCUIT (why wiring this in changed nothing)
 * ----------------------------------------------------------
 * When no tier is bound to a model, `invokeWithGovernor` runs the caller's
 * function immediately and returns — no reservation, no ledger write, not one
 * extra database round trip. Wiring a dark seam through the governor therefore
 * costs nothing and changes nothing observable, which is the only honest way to
 * install a control ahead of the thing it controls. That is still true with the
 * reservation in place: it sits BEHIND the short-circuit, so today's production
 * behaviour is byte-identical and `ai_cost_reservations` stays empty.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  featureDefinition,
  reservationEnvelopeOf,
  resolveModel,
  tierFor,
  type AiFeature,
  type AiTaskClass,
} from "./governor/registry";
import { isTierActivated } from "./governor/readiness";
import {
  AI_MONTHLY_CEILING_PENCE,
  DEDUPE_WINDOW_MS,
  RESERVATION_TTL_MS,
  SPIKE_BASELINE_MONTHS,
  detectSpike,
  estimateCostPence,
  evaluateBudget,
  invocationHash,
  reservationClaimPence,
  settlementCostPence,
  trailingAverage,
  trailingMonths,
  ukMonthKeyOf,
  ukMonthWindow,
  type BudgetStatus,
  type MonthKey,
} from "./governor/policy";

export type { BudgetStatus, MonthKey } from "./governor/policy";
export {
  AI_MONTHLY_CEILING_PENCE,
  FAILURE_FLOOR_PENCE,
  MIN_RESERVATION_PENCE,
  RESERVATION_TTL_MS,
  budgetPercent,
  budgetPermits,
  detectSpike,
  estimateCostPence,
  evaluateBudget,
  formatPence,
  invocationHash,
  reservationClaimPence,
  settlementCostPence,
  trailingAverage,
  ukMonthKeyOf,
  ukMonthWindow,
} from "./governor/policy";
export { AI_FEATURES, AI_FEATURE_KEYS, AI_TIERS, TIER_MODEL } from "./governor/registry";
export type { AiFeature, AiTaskClass, AiTier } from "./governor/registry";
export {
  AI_UNGOVERNED_INFERENCE_ENTRY_POINTS,
  getAiGovernorReadiness,
  isGovernorActivated,
} from "./governor/readiness";
export { hqBudgetOrgId } from "./governor/attribution";

const LEDGER = "ai_invocations";
const RESERVE_FN = "ai_reserve_invocation";
const SETTLE_FN = "ai_settle_reservation";
const RELEASE_FN = "ai_release_reservation";

/**
 * The ledger table is newer than the checked-in generated types
 * (lib/supabase/types.ts), which are regenerated on a separate cadence. The
 * codebase's established idiom for that gap is a narrow structural cast at the
 * call site rather than a types regeneration inside a feature branch — see
 * `expense_drafts` in server/services/expense-drafts.ts for the same shape.
 */
type LedgerRow = Record<string, unknown>;
type Db = {
  from(table: string): {
    insert(row: LedgerRow): PromiseLike<{ error: { message: string } | null }>;
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
const db = (client: unknown) => client as unknown as Db;

// ═══════════════════════════════════════════════════════════════════════════
// 1. checkBudget — is this org allowed to spend more this month?
// ═══════════════════════════════════════════════════════════════════════════

export type BudgetSnapshot = {
  orgId: string;
  /** The Europe/London budget month, `YYYY-MM`. */
  month: MonthKey;
  /** COMMITTED spend so far this month, integer pence. Ledger rows only. */
  spentPence: number;
  /**
   * Budget claimed by calls that are IN FLIGHT right now, integer pence.
   *
   * Not spend — a claim, which either becomes spend or is given back. It is
   * reported separately from `spentPence` because conflating the two would make
   * the ledger's own totals unreconcilable, and counted in `status` because
   * whether the NEXT call is permitted depends on both.
   */
  reservedPence: number;
  /** The ceiling in force. */
  ceilingPence: number;
  status: BudgetStatus;
};

/**
 * Read one org's spend for a budget month and evaluate it against the ceiling.
 *
 * The month defaults to the CURRENT Europe/London month (see ukMonthKeyOf) —
 * not the UTC month, so the first hour of a BST month is spent from the right
 * budget. Aggregation is delegated to the SQL rollup
 * (`ai_invocations_month_totals`), which applies the identical UK window; the
 * two definitions are pinned against each other in the integration suite.
 *
 * FAIL-SAFE, NOT FAIL-OPEN in one specific way: if the ledger cannot be read at
 * all, this returns `allowed` with `spentPence: 0`. That is a deliberate choice
 * for a system where AI is an ENHANCEMENT over a working deterministic path — a
 * database blip must not silently disable receipt extraction for every tenant.
 * The exposure is bounded by the fact that the read failing is itself an
 * incident that surfaces elsewhere. If AI ever becomes load-bearing rather than
 * additive, this is the line to revisit.
 *
 * THAT FAIL-OPEN IS PRESERVED AND IT IS NO LONGER THE CEILING. This function is
 * now an OBSERVATION — it feeds the HQ view, the spike baseline and the
 * warning bands. The ceiling itself is enforced by `reserveBudget`, which is a
 * WRITE and therefore fails CLOSED: see its own note for why the two postures
 * differ rather than contradict.
 */
export async function checkBudget(orgId: string, month?: MonthKey): Promise<BudgetSnapshot> {
  const monthKey = month ?? ukMonthKeyOf(new Date());
  const ceilingPence = AI_MONTHLY_CEILING_PENCE;

  const [spentPence, reservedPence] = await Promise.all([
    readMonthSpendPence(orgId, monthKey),
    readMonthReservedPence(orgId, monthKey),
  ]);
  return {
    orgId,
    month: monthKey,
    spentPence,
    reservedPence,
    ceilingPence,
    // Committed AND claimed: the honest answer to "is there room for another
    // call", which is what a budget status is for.
    status: evaluateBudget(spentPence + reservedPence, ceilingPence),
  };
}

/**
 * Live (unexpired) claims for one org in one UK budget month, in pence.
 *
 * 0 on any read failure, mirroring `readMonthSpendPence` — this read feeds the
 * advisory surfaces, never the refusal, so the same reasoning applies. The
 * refusal path never calls it: `ai_reserve_invocation` recomputes the figure
 * itself, inside its lock, where it cannot be stale.
 */
async function readMonthReservedPence(orgId: string, month: MonthKey): Promise<number> {
  const { startMs } = ukMonthWindow(month);
  if (!Number.isFinite(startMs)) return 0;
  try {
    const { data, error } = await db(createAdminClient()).rpc("ai_reservations_month_totals", {
      p_org_id: orgId,
      p_month: new Date(startMs + 86_400_000).toISOString().slice(0, 10),
    });
    if (error) {
      console.error("[ai/governor] reservation totals read failed", error);
      return 0;
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    return num(rows[0]?.live_pence);
  } catch (e) {
    console.error("[ai/governor] reservation totals read threw", e);
    return 0;
  }
}

/** A DB numeric (which arrives as a string for bigint) as a finite number. 0 otherwise. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Total spend for one org in one UK budget month, in pence. 0 on any read failure. */
async function readMonthSpendPence(orgId: string, month: MonthKey): Promise<number> {
  const { startMs } = ukMonthWindow(month);
  if (!Number.isFinite(startMs)) return 0;
  try {
    const { data, error } = await db(createAdminClient()).rpc("ai_invocations_month_totals", {
      p_org_id: orgId,
      // Any date inside the month; the function truncates to the UK month start.
      p_month: new Date(startMs + 86_400_000).toISOString().slice(0, 10),
    });
    if (error) {
      console.error("[ai/governor] month totals read failed", error);
      return 0;
    }
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const total = rows[0]?.total_cost_pence;
    return typeof total === "number" ? total : Number(total ?? 0) || 0;
  } catch (e) {
    console.error("[ai/governor] month totals read threw", e);
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. recordInvocation — the service-role write
// ═══════════════════════════════════════════════════════════════════════════

export type InvocationUsage = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type RecordInvocationInput = {
  orgId: string;
  /** Null for system jobs — a cron sweep or a webhook-driven turn has no human. */
  userId?: string | null;
  feature: AiFeature;
  taskClass: Exclude<AiTaskClass, "deterministic">;
  usage: InvocationUsage;
  latencyMs: number;
  success: boolean;
  /** Required when `success` is false; the database refuses an unexplained failure. */
  errorCode?: string | null;
  /** The request fingerprint, when the caller supplied dedupe content. */
  contentHash?: string | null;
  /** Pre-computed cost; omitted ⇒ derived from the tier's price metadata. */
  estimatedCostPence?: number;
};

/**
 * Append one invocation to the ledger. Service-role write — a tenant client has
 * no INSERT policy and structurally cannot forge a row.
 *
 * BEST-EFFORT BY DESIGN: a ledger write failure is logged and swallowed, never
 * propagated. Losing a telemetry row is a measurement gap; turning it into a
 * thrown error would mean an accounting problem could break a customer-facing
 * feature that had already succeeded. Returns whether the row landed, so the
 * caller (and the tests) can tell the difference.
 */
export async function recordInvocation(input: RecordInvocationInput): Promise<boolean> {
  const binding = resolveModel(input.taskClass);
  const costPence =
    input.estimatedCostPence ??
    estimateCostPence(binding, {
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
    });

  try {
    const { error } = await db(createAdminClient())
      .from(LEDGER)
      .insert({
        org_id: input.orgId,
        user_id: input.userId ?? null,
        feature: input.feature,
        task_class: input.taskClass,
        provider: input.usage.provider,
        model: input.usage.model,
        input_tokens: Math.max(0, Math.round(input.usage.inputTokens || 0)),
        output_tokens: Math.max(0, Math.round(input.usage.outputTokens || 0)),
        estimated_cost_pence: Math.max(0, Math.round(costPence)),
        latency_ms: Math.max(0, Math.round(input.latencyMs || 0)),
        success: input.success,
        // The ledger's CHECK requires a code on failure and none on success.
        error_code: input.success ? null : (input.errorCode ?? "unknown_error"),
        content_hash: input.contentHash ?? null,
      });
    if (error) {
      console.error("[ai/governor] invocation record failed", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ai/governor] invocation record threw", e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2b. The atomic reservation — reserve, settle, release
// ═══════════════════════════════════════════════════════════════════════════

/** Why a request was refused as a duplicate. Both mean "we did not pay twice". */
export type DuplicateReason =
  /** An identical request is running RIGHT NOW and has not settled yet. */
  | "in_flight"
  /** An identical request SUCCEEDED inside the dedupe window. */
  | "recent_success";

/** Why the governor refused to let a call reach a provider. */
export type BlockReason =
  /** The org has no headroom left this month for a call of this size. */
  | "ceiling"
  /** The reservation itself could not be taken. Fails CLOSED — see `reserveBudget`. */
  | "reservation_unavailable";

export type ReservationResult =
  | {
      outcome: "reserved";
      reservationId: string;
      committedPence: number;
      reservedPence: number;
      ceilingPence: number;
      claimPence: number;
    }
  | {
      outcome: "blocked";
      committedPence: number;
      reservedPence: number;
      ceilingPence: number;
      reason: BlockReason;
    }
  | {
      outcome: "duplicate";
      reason: DuplicateReason;
      committedPence: number;
      reservedPence: number;
      ceilingPence: number;
    };

/**
 * Claim budget for ONE call, atomically.
 *
 * Everything load-bearing happens inside `ai_reserve_invocation`: the month's
 * committed + live-reserved total is re-read under a per-org advisory lock and
 * the claim is written by a conditional insert, so the check and the write are
 * one indivisible act. This function is a thin, honest translator — it holds NO
 * decision of its own, because a decision here would be a decision outside the
 * lock, which is the defect being fixed.
 *
 * IT FAILS CLOSED, and that is a deliberate departure from `checkBudget`'s
 * fail-open. The two are not in tension:
 *
 *   - `checkBudget` is a READ feeding an advisory status. Failing open costs a
 *     wrong number on a dashboard; the call still runs and is still recorded, so
 *     any consequence is visible.
 *   - This is the AUTHORISATION. Failing open would mean the ceiling is not
 *     enforced whenever the database hiccups — "the control is bypassed on
 *     error" is not a control, and it is precisely the property this lane
 *     exists to install. Failing closed costs exactly the documented degraded
 *     path each governed feature already has and already tests (an empty draft,
 *     a deterministic extraction, a fixed acknowledgement, "AI drafting is
 *     off"). A degraded AI answer against unbounded money is not a close call.
 */
export async function reserveBudget(input: {
  orgId: string;
  userId?: string | null;
  feature: string;
  taskClass: Exclude<AiTaskClass, "deterministic">;
  claimPence: number;
  contentHash?: string | null;
  ceilingPence?: number;
}): Promise<ReservationResult> {
  const ceilingPence = input.ceilingPence ?? AI_MONTHLY_CEILING_PENCE;
  try {
    const { data, error } = await db(createAdminClient()).rpc(RESERVE_FN, {
      p_org_id: input.orgId,
      p_feature: input.feature,
      p_task_class: input.taskClass,
      p_estimate_pence: Math.max(1, Math.round(input.claimPence || 1)),
      p_user_id: input.userId ?? null,
      p_content_hash: input.contentHash ?? null,
      p_ceiling_pence: ceilingPence,
      p_ttl_seconds: Math.max(1, Math.round(RESERVATION_TTL_MS / 1000)),
      p_dedupe_window_seconds: Math.max(0, Math.round(DEDUPE_WINDOW_MS / 1000)),
    });
    if (error) {
      console.error("[ai/governor] RESERVATION FAILED — refusing the call", error);
      return {
        outcome: "blocked",
        committedPence: 0,
        reservedPence: 0,
        ceilingPence,
        reason: "reservation_unavailable",
      };
    }
    const row = (Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined) ?? {};
    const committedPence = num(row.committed_pence);
    const reservedPence = num(row.reserved_pence);
    const outcome = String(row.outcome ?? "");

    if (outcome === "reserved" && typeof row.reservation_id === "string") {
      return {
        outcome: "reserved",
        reservationId: row.reservation_id,
        committedPence,
        reservedPence,
        ceilingPence: num(row.ceiling_pence) || ceilingPence,
        claimPence: Math.max(1, Math.round(input.claimPence || 1)),
      };
    }
    if (outcome === "duplicate") {
      return {
        outcome: "duplicate",
        reason: row.duplicate_reason === "recent_success" ? "recent_success" : "in_flight",
        committedPence,
        reservedPence,
        ceilingPence: num(row.ceiling_pence) || ceilingPence,
      };
    }
    // `blocked`, and anything unrecognised. An outcome this build does not know
    // is refused rather than assumed benign — a renamed SQL outcome must not
    // silently become "go ahead".
    if (outcome !== "blocked") {
      console.error(`[ai/governor] unrecognised reservation outcome "${outcome}" — refusing`);
    }
    return {
      outcome: "blocked",
      committedPence,
      reservedPence,
      ceilingPence: num(row.ceiling_pence) || ceilingPence,
      reason: outcome === "blocked" ? "ceiling" : "reservation_unavailable",
    };
  } catch (e) {
    console.error("[ai/governor] RESERVATION THREW — refusing the call", e);
    return {
      outcome: "blocked",
      committedPence: 0,
      reservedPence: 0,
      ceilingPence,
      reason: "reservation_unavailable",
    };
  }
}

/**
 * Settle a claim: write the immutable ledger row and free the claim, in ONE
 * database transaction.
 *
 * BEST-EFFORT AT THIS LAYER, exactly like `recordInvocation` and for the same
 * reason: the customer-facing call has already happened, and an accounting
 * problem must not become a feature outage. Returns whether the settlement
 * landed so the caller (and the tests) can tell.
 *
 * If the claim has vanished — an org torn down mid-flight — this falls back to
 * the ordinary ledger write, so the spend is still recorded. If the claim is
 * already settled, nothing is written twice: the SQL function is idempotent on
 * `state = 'reserved'`, so a retry after a network blip cannot double-charge.
 *
 * A settlement that fails outright leaves the claim standing until its TTL
 * lapses. That errs towards over-blocking for ten minutes rather than
 * under-counting spend, which is the safe direction for a safety limit.
 */
export async function settleReservation(input: {
  reservationId: string;
  success: boolean;
  costPence: number;
  usage: InvocationUsage;
  latencyMs: number;
  errorCode?: string | null;
  /** Used only if the reservation has vanished, so the spend is still recorded. */
  fallback: RecordInvocationInput;
}): Promise<boolean> {
  try {
    const { data, error } = await db(createAdminClient()).rpc(SETTLE_FN, {
      p_reservation_id: input.reservationId,
      p_success: input.success,
      p_cost_pence: Math.max(0, Math.round(input.costPence || 0)),
      p_provider: input.usage.provider,
      p_model: input.usage.model,
      p_input_tokens: Math.max(0, Math.round(input.usage.inputTokens || 0)),
      p_output_tokens: Math.max(0, Math.round(input.usage.outputTokens || 0)),
      p_latency_ms: Math.max(0, Math.round(input.latencyMs || 0)),
      p_error_code: input.success ? null : (input.errorCode ?? "unknown_error"),
    });
    if (error) {
      console.error("[ai/governor] settlement failed", error);
      return false;
    }
    const row = (Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined) ?? {};
    const outcome = String(row.outcome ?? "");
    if (outcome === "settled") return true;
    if (outcome === "already_settled") {
      // Idempotent: the first settlement already wrote the ledger row.
      return true;
    }
    // 'not_found' — the reservation is gone. Record the spend anyway.
    console.error(`[ai/governor] reservation ${input.reservationId} vanished (${outcome})`);
    return await recordInvocation(input.fallback);
  } catch (e) {
    console.error("[ai/governor] settlement threw", e);
    return false;
  }
}

/**
 * Give a claim back without recording anything.
 *
 * The `usage: null` path: the governed function took its own degraded leg and
 * never reached a provider, so there is nothing to account for. Recording a
 * phantom invocation is exactly what `GovernedCall.usage === null` exists to
 * prevent; leaving the claim to time out would hold headroom for ten minutes
 * against a call that never happened.
 */
export async function releaseReservation(
  reservationId: string,
  reason = "no_provider_call",
): Promise<boolean> {
  try {
    const { error } = await db(createAdminClient()).rpc(RELEASE_FN, {
      p_reservation_id: reservationId,
      p_reason: reason,
    });
    if (error) {
      console.error("[ai/governor] release failed", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ai/governor] release threw", e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. invokeWithGovernor — the wrapper every AI call passes through
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What a governed function hands back.
 *
 * `usage: null` is the load-bearing case: it means NO PROVIDER CALL HAPPENED —
 * the function took its own degraded path and there is nothing to account for.
 * The governor records nothing. This is what lets an existing dark seam be
 * wrapped without inventing phantom invocations.
 */
export type GovernedCall<T> = {
  value: T;
  usage: InvocationUsage | null;
};

export type GovernorOutcome<T> =
  /** The function ran. `recorded` says whether an invocation landed in the ledger. */
  | { status: "ran"; value: T; budget: BudgetStatus; recorded: boolean; dark: boolean }
  /**
   * No claim on the budget could be taken, so the function was NOT called.
   *
   * `reason` distinguishes "the org has no headroom" from "the reservation
   * itself could not be taken" — operationally very different, identically
   * degraded. Every caller's existing `blocked` handling is correct for both,
   * which is why this is one status rather than two.
   */
  | {
      status: "blocked";
      budget: "blocked";
      spentPence: number;
      ceilingPence: number;
      reason: BlockReason;
    }
  /**
   * An identical request is in flight or recently succeeded. The function was
   * NOT called and nothing was charged.
   *
   * The loser is told plainly rather than handed the winner's result. Returning
   * the winner's output would need either a cache of model outputs — a new
   * store of customer prose in a subsystem that deliberately keeps only a
   * SHA-256 fingerprint — or a wait on another request, which turns a cost
   * control into a latency coupling with its own timeout failures. "An identical
   * request is already running" is the honest answer and the callers already
   * degrade correctly on it.
   */
  | { status: "duplicate"; contentHash: string; reason: DuplicateReason };

export type InvokeWithGovernorInput = {
  orgId: string;
  /** Null for system jobs. */
  userId?: string | null;
  /**
   * Optional dedupe content. When supplied, an identical recent request for the
   * same org+feature refuses without calling the provider. Never stored — only
   * its SHA-256 digest reaches the ledger.
   */
  dedupeContent?: string | null;
};

/**
 * Run one AI call under governance.
 *
 * Order of decisions, and why each is where it is:
 *
 *   0. UNREGISTERED FEATURE → throw. The registry is the closed set; an
 *      unregistered key means a new AI surface reached a provider without the
 *      review that adding it to the registry forces.
 *   1. DECLARED CLASS vs REGISTRY → throw on disagreement. The registry is the
 *      authority; a call site cannot promote itself from `cheap` to `high`.
 *   2. DETERMINISTIC → throw, LOUDLY, and before anything else costs anything.
 *      A deterministic task is one whose answer is computable — a regex, a sum,
 *      a SQL query. Sending it to a model is slower, less reliable and costs
 *      money for an answer that was already available. This is a programming
 *      error, not a runtime condition, so it fails the same way in every
 *      environment rather than degrading quietly in production.
 *   3. NOT ACTIVATED → run the function and return. No reads, no writes. This
 *      is the state today, and it is why wiring the dark seams changed nothing.
 *   4. RESERVE — ONE atomic SQL call that decides the ceiling AND the duplicate
 *      question together, under a lock, and claims the budget if it fits. Both
 *      refusals happen WITHOUT calling the function. The whole point, and the
 *      reason steps 4 and 5 used to be two racy reads and are now one write.
 *   5. RUN, timing it. On throw: settle the claim as a FAILURE, then RETHROW so
 *      the caller's existing catch behaves exactly as before.
 *   6. `usage: null` ⇒ the function degraded internally; RELEASE the claim and
 *      record nothing.
 *   7. Otherwise SETTLE: the ledger row and the claim, in one transaction.
 */
export async function invokeWithGovernor<T>(
  feature: AiFeature,
  taskClass: AiTaskClass,
  fn: () => Promise<GovernedCall<T>>,
  input: InvokeWithGovernorInput,
): Promise<GovernorOutcome<T>> {
  // 0/1. The registry is the authority.
  const definition = featureDefinition(feature);
  if (!definition) {
    throw new Error(
      `[ai/governor] feature "${feature}" is not in the registry — add it to AI_FEATURES ` +
        `(lib/ai/governor/registry.ts) so it is reviewed before it can spend money.`,
    );
  }
  if (definition.taskClass !== taskClass) {
    throw new Error(
      `[ai/governor] feature "${feature}" is registered as "${definition.taskClass}" but was ` +
        `invoked as "${taskClass}". The registry is the authority — change it there, in a diff.`,
    );
  }

  // 2. The deterministic refusal.
  if (taskClass === "deterministic" || tierFor(taskClass) === null) {
    throw new Error(
      `[ai/governor] REFUSED: "${feature}" was invoked with task class "${taskClass}", which ` +
        `reaches no model by definition. Deterministic work must be computed, not generated — ` +
        `compute the answer directly instead of calling invokeWithGovernor.`,
    );
  }

  // 3. THE DARK SHORT-CIRCUIT — PER TIER, not global. THIS call's tier must be
  //    able to reach a provider; that some OTHER tier is bound is irrelevant
  //    and, before the embedding tier existed, was a latent gap: a build with
  //    one modality armed would have sent every other class through the
  //    reservation path with a null binding (a 1p floor claim for a call that
  //    reaches nothing). Tier-dark ⇒ run the caller's function exactly as it
  //    would have run without this wrapper: no reads, no writes.
  const tier = tierFor(taskClass);
  if (tier === null || !isTierActivated(tier)) {
    const call = await fn();
    return { status: "ran", value: call.value, budget: "allowed", recorded: false, dark: true };
  }

  // 4. THE ATOMIC RESERVATION. The ceiling and the duplicate question, decided
  //    together inside one lock, with the budget claimed if the answer is yes.
  const contentHash =
    typeof input.dedupeContent === "string" && input.dedupeContent.length > 0
      ? invocationHash(feature, taskClass, input.dedupeContent)
      : null;

  const binding = resolveModel(taskClass);
  const claimPence = reservationClaimPence(binding, reservationEnvelopeOf(binding));

  const reservation = await reserveBudget({
    orgId: input.orgId,
    userId: input.userId ?? null,
    feature,
    taskClass,
    claimPence,
    contentHash,
  });

  if (reservation.outcome === "blocked") {
    console.warn(
      `[ai/governor] BLOCKED ${feature} for org ${input.orgId} (${reservation.reason}): ` +
        `${reservation.committedPence}p committed + ${reservation.reservedPence}p in flight, ` +
        `claim ${claimPence}p, ceiling ${reservation.ceilingPence}p.`,
    );
    return {
      status: "blocked",
      budget: "blocked",
      // `spentPence` keeps its meaning — committed spend — so every existing
      // caller that surfaces it to an operator still shows a real figure.
      spentPence: reservation.committedPence,
      ceilingPence: reservation.ceilingPence,
      reason: reservation.reason,
    };
  }
  if (reservation.outcome === "duplicate") {
    return { status: "duplicate", contentHash: contentHash!, reason: reservation.reason };
  }

  // The advisory status the caller sees: the position BEFORE this call's own
  // claim, which is exactly what it meant before the reservation existed.
  const budgetStatus = evaluateBudget(
    reservation.committedPence + reservation.reservedPence,
    reservation.ceilingPence,
  );
  const fallbackUsage = {
    provider: binding?.provider ?? "unknown",
    model: binding?.model ?? "unknown",
    inputTokens: 0,
    outputTokens: 0,
  };

  // 5/6/7. Run it, time it, account for it.
  const startedAt = Date.now();
  let call: GovernedCall<T>;
  try {
    call = await fn();
  } catch (err) {
    const errorCode = errorCodeOf(err);
    const latencyMs = Date.now() - startedAt;
    // A FAILURE IS SETTLED, NOT RELEASED. A call that reached a provider and
    // then failed has, on most vendors, already billed its input tokens — see
    // FAILURE_FLOOR_PENCE for why recording that as free would make a retry
    // storm invisible to the very ceiling that exists to stop one. Tokens are
    // recorded as 0 because we genuinely did not get a usage report.
    await settleReservation({
      reservationId: reservation.reservationId,
      success: false,
      costPence: settlementCostPence(false, binding, { inputTokens: 0, outputTokens: 0 }),
      usage: fallbackUsage,
      latencyMs,
      errorCode,
      fallback: {
        orgId: input.orgId,
        userId: input.userId ?? null,
        feature,
        taskClass,
        usage: fallbackUsage,
        latencyMs,
        success: false,
        errorCode,
        contentHash,
        estimatedCostPence: settlementCostPence(false, binding, {
          inputTokens: 0,
          outputTokens: 0,
        }),
      },
    });
    // RETHROW: the caller's existing catch owns the degraded path.
    throw err;
  }
  const latencyMs = Date.now() - startedAt;

  // The function took its own degraded path — no provider was reached, so the
  // claim is given back immediately and nothing is recorded.
  if (!call.usage) {
    await releaseReservation(reservation.reservationId, "no_provider_call");
    return { status: "ran", value: call.value, budget: budgetStatus, recorded: false, dark: false };
  }

  const costPence = settlementCostPence(true, binding, {
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
  });
  const recorded = await settleReservation({
    reservationId: reservation.reservationId,
    success: true,
    costPence,
    usage: call.usage,
    latencyMs,
    fallback: {
      orgId: input.orgId,
      userId: input.userId ?? null,
      feature,
      taskClass,
      usage: call.usage,
      latencyMs,
      success: true,
      contentHash,
      estimatedCostPence: costPence,
    },
  });

  return { status: "ran", value: call.value, budget: budgetStatus, recorded, dark: false };
}

/** A short, stable, PII-free code for the ledger's `error_code`. */
function errorCodeOf(err: unknown): string {
  const raw = err instanceof Error ? err.name || err.message : String(err);
  const code = raw.trim().slice(0, 120);
  return code.length > 0 ? code : "unknown_error";
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Spike detection against an org's own history
// ═══════════════════════════════════════════════════════════════════════════

export type SpikeAssessment = {
  orgId: string;
  month: MonthKey;
  currentPence: number;
  trailingAveragePence: number;
  spiking: boolean;
};

/**
 * Compare this month's spend against the org's own trailing average. A brand-new
 * org with no history never spikes — see `detectSpike` for why a zero baseline
 * must not flag.
 */
export async function assessSpike(orgId: string, month?: MonthKey): Promise<SpikeAssessment> {
  const monthKey = month ?? ukMonthKeyOf(new Date());
  const currentPence = await readMonthSpendPence(orgId, monthKey);
  const history = await Promise.all(
    trailingMonths(monthKey, SPIKE_BASELINE_MONTHS).map((m) => readMonthSpendPence(orgId, m)),
  );
  const avg = trailingAverage(history);
  return {
    orgId,
    month: monthKey,
    currentPence,
    trailingAveragePence: avg,
    spiking: detectSpike(currentPence, avg),
  };
}

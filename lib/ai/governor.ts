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
 *     substitute for following it.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 *   1. REFUSAL. A deterministic task never reaches a model. An org over its
 *      ceiling gets no further calls until the month rolls.
 *   2. ACCOUNTING. Every call that reaches a provider is recorded — successes
 *      AND failures, with tokens, latency and an estimated cost.
 *   3. TRANSPARENCY. HQ can see spend by org and by feature, and a spike is
 *      flagged against the org's own history.
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
 * function immediately and returns — no budget read, no dedupe read, no ledger
 * write, not one extra database round trip. Wiring a dark seam through the
 * governor therefore costs nothing and changes nothing observable, which is the
 * only honest way to install a control ahead of the thing it controls.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  featureDefinition,
  resolveModel,
  tierFor,
  type AiFeature,
  type AiTaskClass,
} from "./governor/registry";
import { isGovernorActivated } from "./governor/readiness";
import {
  AI_MONTHLY_CEILING_PENCE,
  DEDUPE_WINDOW_MS,
  SPIKE_BASELINE_MONTHS,
  budgetPermits,
  detectSpike,
  estimateCostPence,
  evaluateBudget,
  invocationHash,
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
  budgetPercent,
  budgetPermits,
  detectSpike,
  estimateCostPence,
  evaluateBudget,
  formatPence,
  invocationHash,
  trailingAverage,
  ukMonthKeyOf,
  ukMonthWindow,
} from "./governor/policy";
export { AI_FEATURES, AI_FEATURE_KEYS, AI_TIERS, TIER_MODEL } from "./governor/registry";
export type { AiFeature, AiTaskClass, AiTier } from "./governor/registry";
export { getAiGovernorReadiness, isGovernorActivated } from "./governor/readiness";

const LEDGER = "ai_invocations";

/**
 * The ledger table is newer than the checked-in generated types
 * (lib/supabase/types.ts), which are regenerated on a separate cadence. The
 * codebase's established idiom for that gap is a narrow structural cast at the
 * call site rather than a types regeneration inside a feature branch — see
 * `expense_drafts` in server/services/expense-drafts.ts for the same shape.
 */
type LedgerRow = Record<string, unknown>;
type Filter = {
  eq(column: string, value: unknown): Filter;
  gte(column: string, value: unknown): Filter;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
};
type Db = {
  from(table: string): {
    insert(row: LedgerRow): PromiseLike<{ error: { message: string } | null }>;
    select(columns: string): Filter;
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
  /** Spend so far this month, integer pence. */
  spentPence: number;
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
 */
export async function checkBudget(orgId: string, month?: MonthKey): Promise<BudgetSnapshot> {
  const monthKey = month ?? ukMonthKeyOf(new Date());
  const ceilingPence = AI_MONTHLY_CEILING_PENCE;

  const spentPence = await readMonthSpendPence(orgId, monthKey);
  return {
    orgId,
    month: monthKey,
    spentPence,
    ceilingPence,
    status: evaluateBudget(spentPence, ceilingPence),
  };
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
  /** The org is at or over its ceiling. The function was NOT called. */
  | { status: "blocked"; budget: "blocked"; spentPence: number; ceilingPence: number }
  /** An identical request ran within the dedupe window. The function was NOT called. */
  | { status: "duplicate"; contentHash: string };

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
 *   4. BUDGET → blocked refuses WITHOUT calling the function. The whole point.
 *   5. DEDUPE → an identical recent request refuses without calling.
 *   6. RUN, timing it. On throw: record the failure, then RETHROW so the
 *      caller's existing catch behaves exactly as before.
 *   7. `usage: null` ⇒ the function degraded internally; record nothing.
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

  // 3. THE DARK SHORT-CIRCUIT. No provider is reachable, so there is nothing to
  //    budget, nothing to deduplicate and nothing to record. Run the caller's
  //    function exactly as it would have run without this wrapper.
  if (!isGovernorActivated()) {
    const call = await fn();
    return { status: "ran", value: call.value, budget: "allowed", recorded: false, dark: true };
  }

  // 4. The ceiling.
  const budget = await checkBudget(input.orgId);
  if (!budgetPermits(budget.status)) {
    console.warn(
      `[ai/governor] BLOCKED ${feature} for org ${input.orgId}: ` +
        `${budget.spentPence}p spent of a ${budget.ceilingPence}p monthly ceiling.`,
    );
    return {
      status: "blocked",
      budget: "blocked",
      spentPence: budget.spentPence,
      ceilingPence: budget.ceilingPence,
    };
  }

  // 5. Recent-duplicate refusal.
  const contentHash =
    typeof input.dedupeContent === "string" && input.dedupeContent.length > 0
      ? invocationHash(feature, taskClass, input.dedupeContent)
      : null;
  if (contentHash && (await hasRecentIdentical(input.orgId, feature, contentHash))) {
    return { status: "duplicate", contentHash };
  }

  // 6/7. Run it, time it, account for it.
  const startedAt = Date.now();
  let call: GovernedCall<T>;
  try {
    call = await fn();
  } catch (err) {
    const binding = resolveModel(taskClass);
    await recordInvocation({
      orgId: input.orgId,
      userId: input.userId ?? null,
      feature,
      taskClass,
      usage: {
        provider: binding?.provider ?? "unknown",
        model: binding?.model ?? "unknown",
        // A failed call still billed its input on most vendors, but we did not
        // get a usage report — recording 0 is honest about what we know.
        inputTokens: 0,
        outputTokens: 0,
      },
      latencyMs: Date.now() - startedAt,
      success: false,
      errorCode: errorCodeOf(err),
      contentHash,
    });
    // RETHROW: the caller's existing catch owns the degraded path.
    throw err;
  }
  const latencyMs = Date.now() - startedAt;

  // The function took its own degraded path — no provider was reached.
  if (!call.usage) {
    return { status: "ran", value: call.value, budget: budget.status, recorded: false, dark: false };
  }

  const recorded = await recordInvocation({
    orgId: input.orgId,
    userId: input.userId ?? null,
    feature,
    taskClass,
    usage: call.usage,
    latencyMs,
    success: true,
    contentHash,
  });

  return { status: "ran", value: call.value, budget: budget.status, recorded, dark: false };
}

/** Has an identical request for this org+feature run inside the dedupe window? */
async function hasRecentIdentical(
  orgId: string,
  feature: string,
  contentHash: string,
): Promise<boolean> {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  try {
    const { data, error } = await db(createAdminClient())
      .from(LEDGER)
      .select("id")
      .eq("org_id", orgId)
      .eq("feature", feature)
      .eq("content_hash", contentHash)
      .eq("success", true)
      .gte("created_at", since)
      .limit(1);
    if (error) {
      // A dedupe read failure must not block real work — fall through and call.
      console.error("[ai/governor] dedupe probe failed", error);
      return false;
    }
    return (data ?? []).length > 0;
  } catch (e) {
    console.error("[ai/governor] dedupe probe threw", e);
    return false;
  }
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

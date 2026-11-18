import "server-only";

/**
 * AI Cost Governor — the VELOCITY (burn-rate) limiter.
 *
 * WHY THIS EXISTS ON TOP OF THE CEILING
 * -------------------------------------
 * The atomic reservation (`ai_reserve_invocation`) bounds HOW MUCH an org can
 * spend in a month. It says nothing about HOW FAST. Before this module the
 * whole monthly ceiling could be claimed in minutes by one signed-in user
 * calling a governed route or server action in a loop — every call individually
 * legitimate, individually under the ceiling, and individually un-deduplicated
 * the moment the input varies by a character. The only speed limits in front of
 * a model were two per-IP, per-lambda-instance in-memory counters on two HTTP
 * routes (which a serverless fleet does not share), and nothing at all on the
 * server actions, webhooks and crons that make up the other twenty call sites.
 *
 * So the limit lives HERE — inside `invokeWithGovernor`, the one seam all of
 * them already pass through — rather than being re-implemented (or forgotten)
 * per route. A new governed feature inherits it by construction.
 *
 * WHAT IT LIMITS
 * --------------
 * Two fixed-window counters per governed call, both keyed per FEATURE:
 *
 *   - per ORG      — every call, including system / webhook / cron work that has
 *                    no human (`userId` null). Bounds a runaway job or a flood
 *                    of inbound messages.
 *   - per USER     — only when the call is attributed to a person. Bounds one
 *                    account (or one stolen session) so it cannot burn the
 *                    firm's whole AI budget on its own.
 *
 * The limits are DERIVED FROM MONEY, not picked per feature: a window may admit
 * at most a fixed share of the default monthly ceiling, measured in the call's
 * own worst-case claim. An expensive tier therefore gets proportionally fewer
 * calls per hour than a cheap one, automatically, and re-pricing a tier
 * re-derives its limit with no second table to keep in step.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not the ceiling and it does not replace it: the reservation remains the
 * only authority on whether money may be spent. This is a rate limit placed
 * BEFORE the reservation, so a refused call takes no claim and writes no ledger
 * row. It is also not a provider-side control — it runs in this application and
 * protects nothing if the application is bypassed (a leaked vendor key). The
 * provider-side spend limit is a separate, founder-configured backstop.
 *
 * IT FAILS CLOSED, for the same reason `reserveBudget` does: a speed limit that
 * disappears whenever the database hiccups is not a limit. The cost of a false
 * refusal is the degraded path every governed caller already has and tests.
 *
 * DURABILITY. `consume()` uses the shared Postgres counter (`rate_limit_hit`,
 * one atomic upsert, service-role only) in production, so the limit holds
 * across lambda instances and cold starts. Outside production it uses the
 * in-process counter — there is no fleet to coordinate in dev/test.
 */

import { consume, type RateLimitConfig } from "@/lib/security/rate-limit";
import { AI_MONTHLY_CEILING_PENCE } from "./policy";

/** The window both counters use, in seconds. One hour. */
export const AI_VELOCITY_WINDOW_SECONDS = 3600;

/**
 * The share of the DEFAULT monthly ceiling one org may CLAIM, per feature, per
 * window. A quarter: no single feature can take an org from zero to its ceiling
 * in under four hours, however the calls are issued.
 */
export const AI_VELOCITY_ORG_SHARE = 0.25;

/**
 * The share one USER may claim, per feature, per window. A tenth: a single
 * account needs ten hours of sustained maximum-rate calls on one feature to
 * exhaust a default ceiling — long enough for the spike surface to show it.
 */
export const AI_VELOCITY_USER_SHARE = 0.1;

/**
 * Floors, so a very expensive claim can never derive a limit of zero (which
 * would switch the feature off) or one so low that ordinary interactive use
 * trips it.
 */
export const AI_VELOCITY_MIN_ORG_CALLS = 20;
export const AI_VELOCITY_MIN_USER_CALLS = 10;

export type AiVelocityLimits = { orgCallsPerWindow: number; userCallsPerWindow: number };

/**
 * Derive the two limits from a call's worst-case claim. Pure.
 *
 * `claimPence` is the same pessimistic figure the reservation uses, so "how many
 * calls per hour" and "how much budget per hour" are one statement. A
 * non-positive or non-finite claim is treated as the 1p floor — the same floor
 * the reservation applies — so an unpriced model cannot derive an unbounded rate.
 */
export function velocityLimitsFor(claimPence: number): AiVelocityLimits {
  const claim = Number.isFinite(claimPence) && claimPence >= 1 ? Math.round(claimPence) : 1;
  return {
    orgCallsPerWindow: Math.max(
      AI_VELOCITY_MIN_ORG_CALLS,
      Math.floor((AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_ORG_SHARE) / claim),
    ),
    userCallsPerWindow: Math.max(
      AI_VELOCITY_MIN_USER_CALLS,
      Math.floor((AI_MONTHLY_CEILING_PENCE * AI_VELOCITY_USER_SHARE) / claim),
    ),
  };
}

export type AiVelocityDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Which counter refused. */
      scope: "org" | "user";
      limit: number;
      /** Epoch seconds at which the refusing window resets. */
      resetAtEpochSec: number;
    };

/**
 * Count one governed call against its org (and its user, when there is one) and
 * say whether it may proceed.
 *
 * The USER counter is consulted first: when one account is the cause, the
 * refusal names the account rather than the org, and — more importantly — the
 * refused call does not consume a slot of the org counter that the rest of the
 * firm shares.
 *
 * Never throws. A limiter that cannot be consulted refuses (see the module
 * note); `consume(..., { failClosed: true })` already returns `allowed: false`
 * on a store fault, and the catch below covers anything outside it.
 */
export async function consumeAiVelocity(input: {
  orgId: string;
  /** The acting human, already normalised (null for system / webhook / cron work). */
  userId: string | null;
  feature: string;
  claimPence: number;
}): Promise<AiVelocityDecision> {
  const limits = velocityLimitsFor(input.claimPence);
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    if (input.userId) {
      const cfg: RateLimitConfig = {
        limit: limits.userCallsPerWindow,
        windowSeconds: AI_VELOCITY_WINDOW_SECONDS,
      };
      const user = await consume(
        `ai_velocity_user:${input.feature}`,
        `${input.orgId}:${input.userId}`,
        cfg,
        { failClosed: true },
      );
      if (!user.allowed) {
        return {
          allowed: false,
          scope: "user",
          limit: cfg.limit,
          resetAtEpochSec: user.reset_at_epoch_sec,
        };
      }
    }
    const cfg: RateLimitConfig = {
      limit: limits.orgCallsPerWindow,
      windowSeconds: AI_VELOCITY_WINDOW_SECONDS,
    };
    const org = await consume(`ai_velocity_org:${input.feature}`, input.orgId, cfg, {
      failClosed: true,
    });
    if (!org.allowed) {
      return {
        allowed: false,
        scope: "org",
        limit: cfg.limit,
        resetAtEpochSec: org.reset_at_epoch_sec,
      };
    }
    return { allowed: true };
  } catch (e) {
    console.error("[ai/governor] VELOCITY CHECK THREW — refusing the call", e);
    return {
      allowed: false,
      scope: "org",
      limit: limits.orgCallsPerWindow,
      resetAtEpochSec: nowSec + AI_VELOCITY_WINDOW_SECONDS,
    };
  }
}

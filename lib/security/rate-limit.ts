import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 7 — Lightweight in-memory rate limiter.
 *
 * Per-instance fixed-window counter keyed by `{route}:{identifier}`.
 * The identifier should be the IP (or a hash of it) for public
 * endpoints, or the user id for authenticated ones.
 *
 * Known limitations:
 *   - Memory-only. Each Lambda invocation has its own counters; a
 *     spammer hitting many cold starts will leak through. For v1
 *     this still blocks 90%+ of casual abuse and capped requests
 *     stay cheap. Upgrade target: Vercel KV or Upstash Redis.
 *   - Fixed-window (not sliding) — slightly burstier at window
 *     edges but simpler and cheaper.
 *
 * The limiter ALWAYS fails open: if `check()` throws (e.g. clock
 * skew, corrupted entry), it returns `{ allowed: true }` so a bug
 * in this module can't take down a route.
 */

type Bucket = {
  count: number;
  reset_at: number;
};

const STORE = new Map<string, Bucket>();

export type RateLimitConfig = {
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Epoch seconds at which the window resets. */
  reset_at_epoch_sec: number;
};

export const DEFAULT_LIMITS = {
  /** Public demo booking — abuse-prone form. */
  demo_booking: { limit: 5, windowSeconds: 600 } as RateLimitConfig,
  /** Portal token routes — generous, since one customer hits them
   *  many times. Tuned to allow normal browsing. */
  portal: { limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Portal POSTs (message + upload) — narrower. */
  portal_write: { limit: 10, windowSeconds: 60 } as RateLimitConfig,
  /** AI question — slow + LLM cost concern. */
  ai_question: { limit: 20, windowSeconds: 3600 } as RateLimitConfig,
  /** Generic API fallback. */
  api: { limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Unauthenticated auth email-send (magic link) — keyed by IP+email.
   *  Tight: blocks email-bomb / Supabase cost abuse. */
  auth: { limit: 5, windowSeconds: 600 } as RateLimitConfig,
  /** Public quote accept/decline — keyed by token+IP. Blocks token-guessing
   *  and state-change spam while allowing a customer's normal retries. */
  quote_action: { limit: 20, windowSeconds: 600 } as RateLimitConfig,
} as const;

/**
 * Check + record one request. Returns `allowed: false` when the
 * current window is exhausted.
 */
export function check(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
): RateLimitResult {
  try {
    const now = Math.floor(Date.now() / 1000);
    const key = `${route}:${identifier}`;
    const bucket = STORE.get(key);

    if (!bucket || bucket.reset_at <= now) {
      const reset_at = now + cfg.windowSeconds;
      STORE.set(key, { count: 1, reset_at });
      return {
        allowed: true,
        remaining: cfg.limit - 1,
        reset_at_epoch_sec: reset_at,
      };
    }

    if (bucket.count >= cfg.limit) {
      return {
        allowed: false,
        remaining: 0,
        reset_at_epoch_sec: bucket.reset_at,
      };
    }

    bucket.count++;
    return {
      allowed: true,
      remaining: Math.max(0, cfg.limit - bucket.count),
      reset_at_epoch_sec: bucket.reset_at,
    };
  } catch (e) {
    // Fail open — a bug here mustn't take down a route.
    console.error("[rate-limit] check failed", e);
    return {
      allowed: true,
      remaining: cfg.limit,
      reset_at_epoch_sec: Math.floor(Date.now() / 1000) + cfg.windowSeconds,
    };
  }
}

/**
 * Extract a stable identifier from a Request. Prefers the
 * x-forwarded-for header (set by Vercel) and falls back to a
 * generic key when missing — public routes always need SOME limit.
 */
export function identifyRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // Trust the first comma-separated entry — Vercel sets it
    // to the originating IP.
    return xff.split(",")[0]!.trim();
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "anonymous";
}

/** Build the standard `429` response from a (blocked) result. */
function rateLimitedResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "rate_limited",
      reset_at: result.reset_at_epoch_sec,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(
          Math.max(1, result.reset_at_epoch_sec - Math.floor(Date.now() / 1000)),
        ),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(result.reset_at_epoch_sec),
      },
    },
  );
}

/**
 * Convenience wrapper — returns a JSON `429` body and headers when
 * rate-limited; null otherwise. Callers do
 *   const limited = enforce(req, "ai_question", DEFAULT_LIMITS.ai_question);
 *   if (limited) return limited;
 *
 * NOTE: this is the *in-memory* path (sync). For unauthenticated abuse
 * surfaces prefer {@link enforcePersistent}, which uses the shared store.
 */
export function enforce(
  req: Request,
  route: string,
  cfg: RateLimitConfig,
): Response | null {
  const id = identifyRequest(req);
  const result = check(route, id, cfg);
  if (result.allowed) return null;
  return rateLimitedResponse(result);
}

/**
 * Identify a caller from a Headers object — for the server-action context,
 * where there is no Request. Mirrors {@link identifyRequest}.
 */
export function identifyHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real;
  return "anonymous";
}

/**
 * Whether to use the durable, cross-instance Postgres store. Active only in
 * production (real Supabase + service role). Local `next dev`, the dummy-env
 * preview, and the test runner fall back to the in-memory {@link check} so they
 * stay fast, self-contained, and never reach across to a real database.
 */
function persistentStoreEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Durable check-and-record against the shared Postgres counter via the
 * `rate_limit_hit` RPC (service-role admin client). ALWAYS fails open: if the
 * RPC errors (DB blip, misconfig) the request is allowed, so a fault in the
 * limiter can never take down auth/login. Exported for direct testing.
 */
export async function checkPersistent(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_key: `${route}:${identifier}`,
      p_limit: cfg.limit,
      p_window_seconds: cfg.windowSeconds,
    });
    const row = data?.[0];
    if (error || !row) {
      throw error ?? new Error("rate_limit_hit returned no row");
    }
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      reset_at_epoch_sec: Math.floor(new Date(row.reset_at).getTime() / 1000),
    };
  } catch (e) {
    console.error("[rate-limit] persistent check failed — failing open", e);
    return {
      allowed: true,
      remaining: cfg.limit,
      reset_at_epoch_sec: now + cfg.windowSeconds,
    };
  }
}

/**
 * Unified entry point. Uses the durable store in production and the in-memory
 * store everywhere else. Route handlers should prefer {@link enforcePersistent};
 * server actions call this with an IP from {@link identifyHeaders} and branch on
 * `allowed` themselves (they redirect/return rather than emit a Response).
 */
export async function consume(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
): Promise<RateLimitResult> {
  if (persistentStoreEnabled()) {
    return checkPersistent(route, identifier, cfg);
  }
  return check(route, identifier, cfg);
}

/**
 * Async sibling of {@link enforce} for route handlers — uses the durable store
 * in production. Returns a 429 Response when limited, else null.
 */
export async function enforcePersistent(
  req: Request,
  route: string,
  cfg: RateLimitConfig,
): Promise<Response | null> {
  const result = await consume(route, identifyRequest(req), cfg);
  if (result.allowed) return null;
  return rateLimitedResponse(result);
}

/** Test-only — clear the store between runs. NOT exported in prod
 *  bundles via the `server-only` import above. */
export function _resetForTests(): void {
  STORE.clear();
}

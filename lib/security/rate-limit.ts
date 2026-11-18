import "server-only";

import { createHash, createHmac } from "node:crypto";

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
  /**
   * Public API v1 (Bearer api-key routes) — identifier is the KEY ID, not the
   * IP, so one tenant's integration cannot starve another's behind a shared
   * NAT, and one key cannot dodge its budget by rotating IPs. 120 req/min per
   * key, shared across every v1 route (read and write).
   *
   * TWO FAILURE POSTURES, BY DELIBERATE, REVIEWED DESIGN — pinned by
   * __tests__/security/api-keys.test.ts so the trade stays flagged, not silent:
   *
   *   READS fail OPEN. A fault in the limiter can never take a read route down:
   *   {@link enforceIdentified} calls {@link consume} without failClosed, so an
   *   internal error returns `allowed: true`. A broken limiter means an
   *   over-budget key briefly gets through — never that a paying integration
   *   goes dark reading its own data.
   *
   *   WRITES fail CLOSED. The write API (POST/PATCH) mutates tenant data, so an
   *   unmetered flood is worse than a refusal: {@link enforceIdentifiedStrict}
   *   calls {@link consume} with `failClosed`, so if the DURABLE limiter cannot
   *   be consulted the request is REFUSED (429), not admitted. This is the
   *   "future write-capable API surface must revisit it EXPLICITLY" clause the
   *   read-only substrate reserved — now honoured. The durable path is fair
   *   across cold starts (Postgres rate_limit_counters via `rate_limit_hit`);
   *   the in-memory path is used only in dev/test where there is no DB.
   */
  api_v1: { limit: 120, windowSeconds: 60 } as RateLimitConfig,
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
 * How a durable check behaves when the store cannot be consulted.
 *   failClosed:false (default) — a DB blip ALLOWS the request (fail open). The
 *     right trade for reads/auth: a limiter fault must never black out a route.
 *   failClosed:true — a DB blip REFUSES the request (fail closed). The right
 *     trade for the write API: an unmetered mutation flood is worse than a 429.
 */
export type RateLimitOptions = { failClosed?: boolean };

/**
 * The key a DURABLE counter is stored under: `<route>:h1_<digest>`.
 *
 * DATA MINIMISATION / SECRET HYGIENE. Callers identify a client by whatever is
 * natural for the surface: the visitor's IP address (public forms, quote
 * links), the email address being signed in (auth), or the customer-portal
 * bearer token itself (portal writes). The in-memory store may hold those
 * verbatim — it lives and dies with the process. The durable store must not:
 * `rate_limit_counters` is a Postgres table that is backed up off-platform, so
 * a verbatim key would persist raw IPs, email addresses and live portal access
 * tokens long after the window that needed them closed.
 *
 * So the identifier is replaced by a keyed one-way digest before it leaves the
 * process. Equal identifiers still map to equal keys (the limiter behaves
 * identically); the table can no longer be read back into an address or a
 * usable token. HMAC with a server-side secret rather than a bare hash, because
 * the IPv4 space and a list of known email addresses are both small enough to
 * brute-force an unkeyed digest. The route prefix stays readable so the table
 * remains diagnosable ("which surface is being hammered?").
 *
 * Exported for direct testing (__tests__/security/rate-limit.test.ts).
 */
export function durableKey(route: string, identifier: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const digest = secret
    ? createHmac("sha256", secret).update(identifier).digest("hex")
    : // No secret ⇒ the admin client cannot be built either, so this branch
      // never reaches the database; it only keeps the function total.
      createHash("sha256").update(identifier).digest("hex");
  return `${route}:h1_${digest.slice(0, 40)}`;
}

/**
 * Durable check-and-record against the shared Postgres counter via the
 * `rate_limit_hit` RPC (service-role admin client). On an RPC error (DB blip,
 * misconfig) the outcome depends on {@link RateLimitOptions.failClosed}: open
 * by default (request allowed), or closed for write surfaces (request refused).
 * Exported for direct testing.
 */
export async function checkPersistent(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
  opts?: RateLimitOptions,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_key: durableKey(route, identifier),
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
    if (opts?.failClosed) {
      // Fail CLOSED — refuse rather than admit an unmetered write.
      console.error("[rate-limit] persistent check failed — failing CLOSED", e);
      return {
        allowed: false,
        remaining: 0,
        reset_at_epoch_sec: now + cfg.windowSeconds,
      };
    }
    console.error("[rate-limit] persistent check failed — failing open", e);
    return {
      allowed: true,
      remaining: cfg.limit,
      reset_at_epoch_sec: now + cfg.windowSeconds,
    };
  }
}

/**
 * Delete durable counters whose window closed more than a day ago, via the
 * service-role-only `rate_limit_sweep()` function (migration 20260707000000).
 *
 * RETENTION: that function has existed since the durable limiter shipped but
 * nothing ever called it, so expired counters accumulated without bound. A
 * closed window has no further use — the next hit on the same key starts a new
 * window in place — so keeping it is storage with no purpose. Called once a day
 * from /api/cron/cron-runs-prune alongside the other ops-housekeeping pass.
 *
 * Never throws: a failed sweep is housekeeping telemetry, not an outage, and it
 * must not fail the cron that hosts it.
 */
export async function sweepExpiredCounters(): Promise<{ ok: boolean; error?: string }> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("rate_limit_sweep");
    if (error) {
      console.error("[rate-limit] sweep failed", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[rate-limit] sweep threw", message);
    return { ok: false, error: message };
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
  opts?: RateLimitOptions,
): Promise<RateLimitResult> {
  if (persistentStoreEnabled()) {
    return checkPersistent(route, identifier, cfg, opts);
  }
  // In-memory path (dev/test): no external store to fail, so failClosed has no
  // effect here — the counter is always consultable in-process.
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

/**
 * Sibling of {@link enforcePersistent} for routes whose caller identity is NOT
 * the IP — e.g. the public API v1, where the identifier is the resolved API
 * key's id (see DEFAULT_LIMITS.api_v1). Uses the durable store in production.
 * Returns a 429 Response when limited, else null.
 */
export async function enforceIdentified(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
): Promise<Response | null> {
  const result = await consume(route, identifier, cfg);
  if (result.allowed) return null;
  return rateLimitedResponse(result);
}

/**
 * Fail-CLOSED sibling of {@link enforceIdentified} for MUTATING surfaces — the
 * public API v1 WRITE routes. Identical durable, key-id-keyed metering, but if
 * the durable store cannot be consulted the request is REFUSED (429) rather
 * than admitted, so a limiter fault can never wave through an unmetered write
 * flood (see DEFAULT_LIMITS.api_v1). Returns a 429 Response when limited or on
 * a store fault, else null.
 */
export async function enforceIdentifiedStrict(
  route: string,
  identifier: string,
  cfg: RateLimitConfig,
): Promise<Response | null> {
  const result = await consume(route, identifier, cfg, { failClosed: true });
  if (result.allowed) return null;
  return rateLimitedResponse(result);
}

/** Test-only — clear the store between runs. NOT exported in prod
 *  bundles via the `server-only` import above. */
export function _resetForTests(): void {
  STORE.clear();
}

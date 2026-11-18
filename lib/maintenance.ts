/**
 * Maintenance-window gate — release-support only.
 *
 * Zero-dependency and DB-free by design, so it is safe to call from the Edge
 * middleware, ordinary server routes, cron auth, and webhook handlers — and,
 * crucially, safe to serve while the database schema is mid-migration (it never
 * touches the DB).
 *
 * Toggled entirely by environment variables set/unset on the Vercel production
 * project during a controlled cutover (see docs/RC3-MAINTENANCE-CUTOVER-RUNBOOK):
 *   - MAINTENANCE_MODE=on      → customer/app routes return a retry-safe 503,
 *                                crons are suppressed, webhooks return 503 so the
 *                                provider re-delivers after the window.
 *   - MAINTENANCE_BYPASS=<tok> → operators/smoke-tests bypass the 503 via a
 *                                `?maint_bypass=<tok>` query param, an
 *                                `x-maintenance-bypass` header, or a
 *                                `maint_bypass=<tok>` cookie.
 *
 * The bypass token must be at least 16 URL-safe characters (e.g. `openssl rand
 * -hex 24`); a shorter configured token is ignored (fail closed).
 *
 * When MAINTENANCE_MODE is unset (the default in every environment), every
 * function here is inert and the app behaves exactly as before.
 */

import { constantTimeEqualEdge } from "@/lib/security/constant-time-edge";

export function isMaintenanceMode(): boolean {
  return process.env.MAINTENANCE_MODE === "on";
}

/**
 * Bypass-token shape. A configured token shorter than 16 characters is treated
 * as unset (fail closed — a guessable operator credential must never open the
 * gate); presented values must have the same URL-safe shape and are bounded at
 * 256 characters BEFORE any comparison.
 */
const BYPASS_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,256}$/;

function presentedTokens(request: Request): string[] {
  const out: string[] = [];
  try {
    const q = new URL(request.url).searchParams.get("maint_bypass");
    if (q) out.push(q);
  } catch {
    // non-absolute URL (shouldn't happen in middleware) — fall through
  }
  const h = request.headers.get("x-maintenance-bypass");
  if (h) out.push(h);
  for (const part of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
    if (part.startsWith("maint_bypass=")) out.push(part.slice("maint_bypass=".length));
  }
  return out;
}

/**
 * True when the caller presents the operator bypass token (query param, header
 * or cookie). Constant-time comparison through the shared Edge-safe helper;
 * nothing here ever echoes the token.
 */
export function isMaintenanceBypassed(request: Request): boolean {
  const token = process.env.MAINTENANCE_BYPASS;
  if (!token || !BYPASS_TOKEN_SHAPE.test(token)) return false;
  let matched = false;
  for (const candidate of presentedTokens(request)) {
    if (!BYPASS_TOKEN_SHAPE.test(candidate)) continue;
    // No early exit: every well-formed candidate is compared.
    if (constantTimeEqualEdge(candidate, token)) matched = true;
  }
  return matched;
}

/**
 * A retry-safe 503. `Retry-After` tells browsers and — importantly — webhook
 * providers (Stripe, Meta) to re-deliver after the window rather than treat the
 * event as handled. `no-store` prevents any cache from pinning the 503.
 */
export function maintenanceResponse(kind: "html" | "json" = "json"): Response {
  const body =
    kind === "html"
      ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>CrewFlow — scheduled maintenance</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:16vh auto;padding:0 1.5rem;text-align:center;color:#0f172a"><h1 style="font-size:1.5rem;margin:0 0 .5rem">Back shortly</h1><p style="color:#475569">CrewFlow is undergoing a brief scheduled upgrade. Please try again in a few minutes — no action is needed.</p></body></html>`
      : JSON.stringify({
          ok: false,
          maintenance: true,
          message: "CrewFlow is undergoing scheduled maintenance. Please retry shortly.",
        });
  return new Response(body, {
    status: 503,
    headers: {
      "content-type": kind === "html" ? "text/html; charset=utf-8" : "application/json",
      "retry-after": "120",
      "cache-control": "no-store",
    },
  });
}

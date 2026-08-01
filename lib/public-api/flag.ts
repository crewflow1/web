import "server-only";
import { env } from "@/lib/env";

/**
 * The public jobs read API's ON/OFF switch (Train K / Mission 9).
 *
 * DARK BY DEFAULT. When this returns false the /api/v1/jobs routes must behave
 * as if they do not exist — a 404, never a 401/403 — because exposing tenant
 * data through a public key-authenticated API is a CEO / product decision that
 * this train builds AROUND but does not make. Flipping FEATURE_PUBLIC_API_JOBS
 * to "true" in the deployment env is that decision, and the only thing between
 * the (fully built, org-pinned, scope-checked, rate-limited) code and a live
 * public data plane.
 *
 * Server-only: the flag never rides into a client bundle.
 */
export function isPublicApiJobsEnabled(): boolean {
  return env.FEATURE_PUBLIC_API_JOBS === "true";
}

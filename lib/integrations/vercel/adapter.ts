import "server-only";

/**
 * Vercel deployment feed — a DARK provider adapter (L9a / P7 CTO AI).
 *
 * The CTO AI's roadmap contract includes deploy monitoring. Deployment history
 * lives in Vercel behind a credential, so — like the GitHub adapter beside it
 * and the banking adapters that set the house pattern — this is a typed seam
 * that REFUSES BEFORE FETCH. Activation is only ever "supply the credential",
 * never a code change to the CTO board that consumes the mapped shape.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * `isAvailable()` is false whenever `VERCEL_TOKEN` is absent — which is ALWAYS,
 * today. When unavailable, `listDeployments` returns a typed `not_configured`
 * result WITHOUT any network request. There is no code path from "no
 * credential" to `fetch`; the tests prove it with a fetch spy.
 *
 * READ-ONLY BY CONSTRUCTION. Only a deployments GET lives here. TRIGGERING a
 * deploy is an IRREVERSIBLE act and deliberately does NOT live in this adapter
 * — it is registered as descriptive executor-tool metadata
 * (lib/hq/cto-tools.ts, `reversibilityClass: "irreversible"`) so it can only
 * ever route through the approval engine behind the executor gates, which
 * remain dark.
 *
 * Optional scoping: `VERCEL_PROJECT_ID` narrows the listing to one project and
 * `VERCEL_TEAM_ID` addresses a team scope. Both are refinements, not gates —
 * the token alone decides availability.
 */

const VERCEL_API = "https://api.vercel.com";

/** Bounded window — the CTO board needs the recent picture, not the archive. */
const MAX_DEPLOYMENTS = 25;

export type VercelDeployment = {
  uid: string;
  state: string;
  target: string | null;
  createdAt: string | null;
  readyAt: string | null;
};

export type VercelResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "not_configured" | "unauthorized" | "error";
      message: string;
    };

/** The typed dark outcome — the ONLY result the unconfigured path may produce. */
export function vercelNotConfigured<T>(): VercelResult<T> {
  return {
    ok: false,
    reason: "not_configured",
    message: "Vercel is not connected. Set VERCEL_TOKEN to enable deployment telemetry.",
  };
}

/** Pure env probe — no network, never throws. */
export function isVercelConfigured(): boolean {
  const token = process.env.VERCEL_TOKEN;
  return typeof token === "string" && token.length > 0;
}

export class VercelAdapter {
  isAvailable(): boolean {
    return isVercelConfigured();
  }

  /**
   * List recent deployments. Returns `not_configured` — no network — when
   * dark. The ONLY fetch lives strictly AFTER the guard.
   */
  async listDeployments(): Promise<VercelResult<VercelDeployment[]>> {
    // DARK GUARD FIRST. With no credential we return without touching the network.
    if (!this.isAvailable()) return vercelNotConfigured();

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────
    const params = new URLSearchParams({ limit: String(MAX_DEPLOYMENTS) });
    const projectId = process.env.VERCEL_PROJECT_ID;
    if (projectId) params.set("projectId", projectId);
    const teamId = process.env.VERCEL_TEAM_ID;
    if (teamId) params.set("teamId", teamId);

    let res: Response;
    try {
      res = await fetch(`${VERCEL_API}/v6/deployments?${params.toString()}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
          accept: "application/json",
        },
      });
    } catch (e) {
      return {
        ok: false,
        reason: "error",
        message: `Vercel fetch failed: ${e instanceof Error ? e.message : "network error"}`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        message: `Vercel rejected the token (${res.status}).`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `Vercel /deployments returned ${res.status}`,
      };
    }

    const json = (await res.json()) as {
      deployments?: Array<{
        uid?: string;
        state?: string;
        readyState?: string;
        target?: string | null;
        createdAt?: number;
        ready?: number;
      }>;
    };
    const rows = (json.deployments ?? [])
      .filter((d): d is typeof d & { uid: string } => typeof d.uid === "string")
      .map((d) => ({
        uid: d.uid,
        state: (d.readyState ?? d.state ?? "unknown").toUpperCase(),
        target: d.target ?? null,
        createdAt: typeof d.createdAt === "number" ? new Date(d.createdAt).toISOString() : null,
        readyAt: typeof d.ready === "number" ? new Date(d.ready).toISOString() : null,
      }));
    return { ok: true, data: rows };
  }
}

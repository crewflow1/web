import "server-only";

/**
 * GitHub engineering feed — a DARK provider adapter (L9a / P7 CTO AI).
 *
 * The CTO AI's roadmap contract includes reviewing pull requests and reading
 * engineering telemetry. That is EXTERNAL data behind a credential, so it is
 * built to the house dark-adapter pattern (lib/integrations/banking/adapters):
 * a typed seam that REFUSES BEFORE FETCH. Activation is only ever "supply the
 * credentials", never a code change to the CTO board or the PR-review handler
 * that consume the mapped shapes.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * The adapter reports `isAvailable()` false whenever EITHER gate is absent
 * (`GITHUB_TOKEN` — a fine-grained PAT or app token; `GITHUB_REPO` — the
 * `owner/repo` this deployment is allowed to read) — which is ALWAYS, today.
 * When unavailable, every fetch method returns a typed `not_configured` result
 * WITHOUT constructing a client and WITHOUT making any network request. There
 * is no code path from "no credentials" to `fetch`; the tests prove it with a
 * fetch spy.
 *
 * READ-ONLY BY CONSTRUCTION. This adapter holds ONLY GETs: PR list, one PR,
 * one PR diff. Merging a PR is an IRREVERSIBLE act and deliberately does NOT
 * live here — it is registered as descriptive executor-tool metadata
 * (lib/hq/cto-tools.ts, `reversibilityClass: "irreversible"`) so it can only
 * ever route through the approval engine behind the executor gates, which
 * remain dark. A credential alone must never be able to merge.
 */

const GITHUB_API = "https://api.github.com";

/** Bounded PR window — the CTO board needs a picture, not the archive. */
const MAX_PR_PAGE = 30;

export type GithubPullRequest = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type GithubResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "not_configured" | "unauthorized" | "error";
      message: string;
    };

/** The typed dark outcome — the ONLY result the unconfigured path may produce. */
export function githubNotConfigured<T>(): GithubResult<T> {
  return {
    ok: false,
    reason: "not_configured",
    message:
      "GitHub is not connected. Set GITHUB_TOKEN and GITHUB_REPO (owner/repo) to enable PR telemetry and diff review.",
  };
}

/** Pure env probe — no network, never throws. Drives readiness and the dark gate. */
export function isGithubConfigured(): boolean {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  return (
    typeof token === "string" &&
    token.length > 0 &&
    typeof repo === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(repo)
  );
}

export class GithubAdapter {
  isAvailable(): boolean {
    return isGithubConfigured();
  }

  /**
   * List pull requests (open by default). Returns `not_configured` — no
   * network — when dark. The ONLY fetch lives strictly AFTER the guard.
   */
  async listPullRequests(
    state: "open" | "closed" | "all" = "open",
  ): Promise<GithubResult<GithubPullRequest[]>> {
    // DARK GUARD FIRST. With no credentials we return without touching the network.
    if (!this.isAvailable()) return githubNotConfigured();

    // ── LIVE PATH (unreachable dark) ─────────────────────────────────────
    const repo = process.env.GITHUB_REPO!;
    let res: Response;
    try {
      res = await this.get(
        `/repos/${repo}/pulls?state=${state}&per_page=${MAX_PR_PAGE}&sort=updated&direction=desc`,
      );
    } catch (e) {
      return this.networkError(e);
    }
    const auth = this.authFailure(res.status);
    if (auth) return auth;
    if (!res.ok) {
      return { ok: false, reason: "error", message: `GitHub /pulls returned ${res.status}` };
    }
    const json = (await res.json()) as Array<{
      number?: number;
      title?: string;
      state?: string;
      draft?: boolean;
      user?: { login?: string } | null;
      created_at?: string;
      updated_at?: string;
    }>;
    const prs = (Array.isArray(json) ? json : [])
      .filter((p): p is typeof p & { number: number } => typeof p.number === "number")
      .map((p) => ({
        number: p.number,
        title: p.title ?? "",
        state: p.state ?? "unknown",
        draft: p.draft === true,
        author: p.user?.login ?? null,
        createdAt: p.created_at ?? null,
        updatedAt: p.updated_at ?? null,
      }));
    return { ok: true, data: prs };
  }

  /**
   * Fetch one PR's unified diff (the input to the deterministic review
   * checklist). Returns `not_configured` — no network — when dark.
   */
  async fetchPullRequestDiff(prNumber: number): Promise<GithubResult<string>> {
    if (!this.isAvailable()) return githubNotConfigured();
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, reason: "error", message: `Invalid PR number: ${prNumber}` };
    }

    const repo = process.env.GITHUB_REPO!;
    let res: Response;
    try {
      res = await this.get(`/repos/${repo}/pulls/${prNumber}`, "application/vnd.github.v3.diff");
    } catch (e) {
      return this.networkError(e);
    }
    const auth = this.authFailure(res.status);
    if (auth) return auth;
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        message: `GitHub PR #${prNumber} diff returned ${res.status}`,
      };
    }
    return { ok: true, data: await res.text() };
  }

  /** One authenticated GET against the GitHub API. No secret is logged. */
  private get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    return fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept,
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  /** Map a 401/403 to the `unauthorized` outcome; else null. */
  private authFailure(
    status: number,
  ): { ok: false; reason: "unauthorized"; message: string } | null {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        reason: "unauthorized",
        message: `GitHub rejected the token (${status}).`,
      };
    }
    return null;
  }

  private networkError(e: unknown): { ok: false; reason: "error"; message: string } {
    return {
      ok: false,
      reason: "error",
      message: `GitHub fetch failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
}

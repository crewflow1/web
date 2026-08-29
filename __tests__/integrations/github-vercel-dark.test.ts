import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  GithubAdapter,
  isGithubConfigured,
} from "@/lib/integrations/github/adapter";
import {
  VercelAdapter,
  isVercelConfigured,
} from "@/lib/integrations/vercel/adapter";

/**
 * GITHUB + VERCEL DARK ADAPTERS (L9a / P7) — hermetic proofs.
 *
 * The house dark-adapter invariant (set by lib/integrations/banking): an
 * unconfigured adapter REFUSES BEFORE FETCH — a typed `not_configured` result,
 * zero network. And the live path (mocked HTTP only — no real GitHub/Vercel is
 * ever contacted) authenticates with a bearer header and maps 401/403 to
 * `unauthorized` so the caller can distinguish a dead token from darkness.
 */

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "VERCEL_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
] as const;

const saved: Record<string, string | undefined> = {};
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchSpy = vi.fn(async () => {
    throw new Error("network must not be touched");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub adapter — DARK: refuse-before-fetch", () => {
  it("is unavailable with no env at all", () => {
    expect(isGithubConfigured()).toBe(false);
    expect(new GithubAdapter().isAvailable()).toBe(false);
  });

  it("a token WITHOUT the repo gate stays dark (two-key gate)", () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(isGithubConfigured()).toBe(false);
  });

  it("a malformed repo stays dark", () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "not-a-repo-path";
    expect(isGithubConfigured()).toBe(false);
  });

  it("listPullRequests returns typed not_configured and NEVER calls fetch", async () => {
    const result = await new GithubAdapter().listPullRequests();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetchPullRequestDiff returns typed not_configured and NEVER calls fetch", async () => {
    const result = await new GithubAdapter().fetchPullRequestDiff(42);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GitHub adapter — LIVE path (mocked HTTP; unreachable dark)", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "crewflow1/web";
  });

  it("lists PRs from the configured repo with a bearer header, mapped lean", async () => {
    fetchSpy.mockResolvedValueOnce(
      json([
        {
          number: 7,
          title: "Fix nav race",
          state: "open",
          draft: false,
          user: { login: "moe" },
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        },
        { title: "no number — dropped" },
      ]),
    );
    const result = await new GithubAdapter().listPullRequests();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        {
          number: 7,
          title: "Fix nav race",
          state: "open",
          draft: false,
          author: "moe",
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
        },
      ]);
    }
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.github\.com\/repos\/crewflow1\/web\/pulls\?/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
  });

  it("fetches a PR diff with the diff media type", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("diff --git a/x b/x", { status: 200 }));
    const result = await new GithubAdapter().fetchPullRequestDiff(9);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("diff --git");
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/crewflow1/web/pulls/9");
    expect((init.headers as Record<string, string>).accept).toBe(
      "application/vnd.github.v3.diff",
    );
  });

  it("maps 401 to `unauthorized` (a dead token is not darkness)", async () => {
    fetchSpy.mockResolvedValueOnce(json({ message: "Bad credentials" }, 401));
    const result = await new GithubAdapter().listPullRequests();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });

  it("rejects an invalid PR number without a network call", async () => {
    const result = await new GithubAdapter().fetchPullRequestDiff(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Vercel adapter — DARK: refuse-before-fetch", () => {
  it("is unavailable with no token", () => {
    expect(isVercelConfigured()).toBe(false);
    expect(new VercelAdapter().isAvailable()).toBe(false);
  });

  it("listDeployments returns typed not_configured and NEVER calls fetch", async () => {
    const result = await new VercelAdapter().listDeployments();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Vercel adapter — LIVE path (mocked HTTP; unreachable dark)", () => {
  beforeEach(() => {
    process.env.VERCEL_TOKEN = "vc_test";
  });

  it("lists deployments with a bearer header, mapped lean", async () => {
    fetchSpy.mockResolvedValueOnce(
      json({
        deployments: [
          {
            uid: "dpl_1",
            readyState: "READY",
            target: "production",
            createdAt: 1756425600000,
            ready: 1756425700000,
          },
          { readyState: "no uid — dropped" },
        ],
      }),
    );
    const result = await new VercelAdapter().listDeployments();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({ uid: "dpl_1", state: "READY", target: "production" });
      expect(result.data[0]!.createdAt).toBe(new Date(1756425600000).toISOString());
    }
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.vercel\.com\/v6\/deployments\?limit=25$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer vc_test");
  });

  it("scopes by project and team when the refinement vars are set", async () => {
    process.env.VERCEL_PROJECT_ID = "prj_1";
    process.env.VERCEL_TEAM_ID = "team_1";
    fetchSpy.mockResolvedValueOnce(json({ deployments: [] }));
    await new VercelAdapter().listDeployments();
    const [url] = fetchSpy.mock.calls[0]! as [string];
    expect(url).toContain("projectId=prj_1");
    expect(url).toContain("teamId=team_1");
  });

  it("maps 403 to `unauthorized`", async () => {
    fetchSpy.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    const result = await new VercelAdapter().listDeployments();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unauthorized");
  });
});

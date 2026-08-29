import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { computeCtoBoard, computePrReviewChecklist, type CtoInput } from "@/lib/hq/cto";
import {
  CTO_TOOL_REGISTRY,
  githubMergePrTool,
  vercelDeployTool,
} from "@/lib/hq/cto-tools";
import {
  isReversibleTool,
  estimateToolCostMicros,
  parseToolArgs,
} from "@/server/sdk/tools";

/**
 * HQ CTO AI — the P7 engineering contract (L9a).
 *
 *   A. The board's engineering section — honest dark-adapter state when the
 *      GitHub/Vercel inputs are absent; real telemetry facts when present; the
 *      existing metric contract is untouched either way.
 *   B. computePrReviewChecklist — deterministic string analysis of a unified
 *      diff: counts, migration/credential/test/dependency/TODO flags, honest
 *      insufficient on an empty diff.
 *   C. The merge/deploy TOOLS — registered as IRREVERSIBLE descriptive
 *      metadata only: they carry no invocation body and bias to approval, which
 *      is what keeps "merge/deploy" built AND dark behind the sanctioned
 *      authority.
 *   D. The cto_pr_review handler — dark adapter ⇒ an honest not-configured
 *      COMPLETION with zero network.
 */

const NOW = new Date("2026-08-26T12:00:00Z");

const EMPTY_INPUT: CtoInput = {
  launch: null,
  reliability: null,
  shadow: null,
  aiCost: null,
  health: null,
};

describe("A. the engineering section — dark adapters vs real telemetry", () => {
  it("is honest about BOTH adapters being dark, naming the activation switches", () => {
    const board = computeCtoBoard(EMPTY_INPUT, NOW);
    expect(board.engineering.github).toBeNull();
    expect(board.engineering.vercel).toBeNull();
    expect(board.engineering.basis).toContain("GITHUB_TOKEN + GITHUB_REPO");
    expect(board.engineering.basis).toContain("VERCEL_TOKEN");
    expect(board.engineering.basis).toMatch(/no .* figure is fabricated/i);
  });

  it("folds real PR + deployment telemetry to facts when the adapters are connectable", () => {
    const board = computeCtoBoard(
      {
        ...EMPTY_INPUT,
        github: {
          pulls: [
            { number: 5, title: "A", author: "moe", draft: false, updatedAt: null },
            { number: 6, title: "B", author: null, draft: true, updatedAt: null },
          ],
        },
        vercel: {
          deployments: [
            { state: "READY", target: "production", createdAt: "2026-08-25T00:00:00Z" },
            { state: "ERROR", target: "production", createdAt: "2026-08-24T00:00:00Z" },
            { state: "BUILDING", target: null, createdAt: null },
          ],
        },
      },
      NOW,
    );
    expect(board.engineering.github).toMatchObject({ openPrs: 2, draftPrs: 1 });
    expect(board.engineering.vercel).toMatchObject({
      total: 3,
      errored: 1,
      building: 1,
      production: 2,
      latestState: "READY",
      latestAt: "2026-08-25T00:00:00Z",
    });
    expect(board.engineering.basis).toMatch(/read live/);
  });

  it("the existing metric contract is untouched (no key drift from the new section)", () => {
    const keys = computeCtoBoard(EMPTY_INPUT, NOW).metrics.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "active_retry_pressure",
        "ai_blocked_orgs",
        "ai_overruns",
        "ai_spend_committed",
        "ai_spend_reserved",
        "ci_pass_rate",
        "customer_health_critical",
        "customer_health_unscored",
        "deploy_frequency",
        "launch_blockers",
        "launch_warnings",
        "platform_uptime",
        "shadow_divergence",
        "shadow_observations",
        "stale_leases",
        "task_failure_ratio",
      ].sort(),
    );
  });
});

describe("B. computePrReviewChecklist — deterministic diff review", () => {
  const DIFF = [
    "diff --git a/supabase/migrations/20261230000000_new_table.sql b/supabase/migrations/20261230000000_new_table.sql",
    "--- /dev/null",
    "+++ b/supabase/migrations/20261230000000_new_table.sql",
    "+create table public.things (id uuid primary key);",
    "diff --git a/lib/feature.ts b/lib/feature.ts",
    "--- a/lib/feature.ts",
    "+++ b/lib/feature.ts",
    "+const key = process.env.SUPER_PROVIDER_API_KEY;",
    "+// TODO: wire the provider",
    "-const old = 1;",
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "+  \"newdep\": \"^1.0.0\",",
  ].join("\n");

  it("counts files and lines exactly from the diff headers", () => {
    const r = computePrReviewChecklist({ prNumber: 12, title: "T", author: "a", diff: DIFF }, NOW);
    expect(r.signals.filesChanged).toBe(3);
    expect(r.signals.additions).toBe(4);
    expect(r.signals.deletions).toBe(1);
    expect(r.insufficient).toBe(false);
    expect(r.confidence).toBe(1);
  });

  it("flags migrations, credential-shaped identifiers, missing tests, dependencies, TODOs", () => {
    const r = computePrReviewChecklist({ prNumber: 12, title: null, author: null, diff: DIFF }, NOW);
    expect(r.signals.migrationsTouched).toEqual([
      "supabase/migrations/20261230000000_new_table.sql",
    ]);
    expect(r.signals.credentialShapedAdditions).toEqual(["SUPER_PROVIDER_API_KEY"]);
    expect(r.signals.testFilesTouched).toBe(0);
    expect(r.signals.dependencyManifestTouched).toBe(true);
    expect(r.signals.todoAdditions).toBe(1);
    // A credential-shaped introduction is the worst finding — critical.
    expect(r.severity).toBe("critical");
    const byKey = Object.fromEntries(r.checklist.map((c) => [c.key, c.status]));
    expect(byKey).toMatchObject({
      migrations: "attention",
      credentials: "attention",
      tests: "attention",
      dependencies: "attention",
      todos: "attention",
      size: "pass",
    });
  });

  it("a clean diff with tests passes every check", () => {
    const clean = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+const a = 1;",
      "diff --git a/__tests__/x.test.ts b/__tests__/x.test.ts",
      "+it('works');",
    ].join("\n");
    const r = computePrReviewChecklist({ prNumber: 3, title: null, author: null, diff: clean }, NOW);
    expect(r.severity).toBe("ok");
    expect(r.checklist.every((c) => c.status === "pass")).toBe(true);
    expect(r.signals.testFilesTouched).toBe(1);
  });

  it("an empty diff is honestly insufficient — never a clean pass from absent data", () => {
    const r = computePrReviewChecklist({ prNumber: 8, title: null, author: null, diff: "  " }, NOW);
    expect(r.insufficient).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.checklist).toEqual([]);
  });

  it("reviews, never merges: approvalRequired is structurally true", () => {
    const r = computePrReviewChecklist({ prNumber: 1, title: null, author: null, diff: "x" }, NOW);
    expect(r.approvalRequired).toBe(true);
    expect(r.reasoning).toContain("Nothing is approved or merged here");
  });
});

describe("C. merge/deploy — IRREVERSIBLE executor-tool metadata, dormant by construction", () => {
  it("both tools are registered in the CTO catalogue", () => {
    expect(CTO_TOOL_REGISTRY.labels()).toEqual(["github.merge_pr", "vercel.deploy"]);
    expect(CTO_TOOL_REGISTRY.has("github.merge_pr")).toBe(true);
    expect(CTO_TOOL_REGISTRY.has("vercel.deploy")).toBe(true);
  });

  it("both are classified irreversible — the autonomy test biases them to approval", () => {
    for (const tool of [githubMergePrTool, vercelDeployTool]) {
      expect(tool.reversibilityClass).toBe("irreversible");
      expect(isReversibleTool(tool)).toBe(false);
    }
  });

  it("they are pure metadata: frozen, no invocation body, costless estimates", () => {
    for (const tool of [githubMergePrTool, vercelDeployTool]) {
      expect(Object.isFrozen(tool)).toBe(true);
      expect(estimateToolCostMicros(tool, {})).toBe(0);
      // No callable apply/invoke/execute surface exists on the tool.
      const keys = Object.keys(tool);
      expect(keys).not.toContain("invoke");
      expect(keys).not.toContain("apply");
      expect(keys).not.toContain("execute");
    }
  });

  it("merge args are typed: PR number, human-approved strategy, and the reviewed head SHA", () => {
    const ok = parseToolArgs(githubMergePrTool, {
      prNumber: 12,
      method: "squash",
      expectedHeadSha: "abc1234",
    });
    expect(ok.ok).toBe(true);
    const bad = parseToolArgs(githubMergePrTool, { prNumber: 12, method: "yolo" });
    expect(bad.ok).toBe(false);
  });

  it("deploy args are typed: ref + target", () => {
    expect(parseToolArgs(vercelDeployTool, { ref: "main", target: "production" }).ok).toBe(true);
    expect(parseToolArgs(vercelDeployTool, { ref: "", target: "production" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. The cto_pr_review handler — dark adapter ⇒ honest completion, no network.
// ---------------------------------------------------------------------------

describe("D. cto_pr_review handler — dark adapter is a COMPLETION with zero network", () => {
  const ENV_KEYS = ["GITHUB_TOKEN", "GITHUB_REPO"] as const;
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

  it("completes with the honest not-configured envelope; fetch is never called", async () => {
    const { ctoReviewHandler } = await import("@/server/services/hq-cto-review-runner");
    const result = (await ctoReviewHandler({
      task: { id: "t1", payload: { pr_number: 42 } },
    } as never)) as Record<string, unknown>;

    expect(result.kind).toBe("cto_pr_review");
    expect(result.insufficient).toBe(true);
    expect(result.confidence).toBe(0);
    expect(String(result.summary)).toContain("not configured");
    expect(String(result.reasoning)).toContain("GITHUB_TOKEN + GITHUB_REPO");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

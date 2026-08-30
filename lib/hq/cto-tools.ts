import { z } from "zod";
import {
  createToolRegistry,
  defineTool,
  type RegisteredTool,
  type ToolRegistry,
} from "@/server/sdk/tools";

/**
 * CrewFlow HQ — the CTO AI's MERGE / DEPLOY tools, registered as DATA (L9a / P7).
 *
 * The CTO roadmap contract names "merge PRs" and "deploy". Both are IRREVERSIBLE
 * external acts, so they are deliberately NOT built as autonomous adapter
 * methods — the read-only GitHub/Vercel adapters (lib/integrations/{github,
 * vercel}/adapter.ts) hold no write call at all. Instead each act is registered
 * here as descriptive executor-tool METADATA on the sanctioned authority chain
 * (server/sdk/tools.ts; ADR 0009 Decision 2):
 *
 *   • `reversibilityClass: "irreversible"` — P4 atom 1 fails, so the autonomy
 *     test biases the action to APPROVAL: it can only ever route through the
 *     Approval Engine, never apply autonomously.
 *   • The tools carry NO invocation body (the registry contract: describe, never
 *     execute). The executor that could someday apply them sits behind the
 *     executor gates, which remain dark — and even armed, the capability
 *     registry's deny floor (`can_execute` FALSE, `requires_approval` TRUE on
 *     every grant) refuses the proposal at the doorman.
 *
 * This is "merge/deploy BUILT + DARK", honestly: the contract, argument schema,
 * permission token, cost estimate and blast-radius classification all exist and
 * are pinned by tests; no code path can merge a PR or trigger a deploy today,
 * and a credential alone can never change that.
 *
 * Tools are CODE-REGISTERED (pure frozen data over server/sdk/tools.ts —
 * inspected before building; no DB seeding or migration is involved), so
 * registering them here requires no migration slot.
 */

/**
 * `github.merge_pr` — merge a reviewed pull request. IRREVERSIBLE: a merged
 * commit lands on the target branch and cannot be unmade (a revert is a NEW
 * commit, not an undo), so the gate biases it to approval.
 */
export const githubMergePrTool: RegisteredTool = defineTool({
  label: "github.merge_pr",
  description:
    "Merge a pull request on the configured GitHub repository — irreversible once merged; approval-gated by classification, and dormant behind the dark executor gates.",
  permission: "engineering.merge",
  argSchema: z.object({
    prNumber: z.number().int().positive(),
    /** The merge strategy the human approved — never chosen autonomously. */
    method: z.enum(["merge", "squash", "rebase"]),
    /** The reviewed head SHA the approval was granted against (staleness guard). */
    expectedHeadSha: z.string().min(7),
  }),
  costEstimator: () => 0, // no metered spend; the cost is blast radius, not money
  reversibilityClass: "irreversible",
});

/**
 * `vercel.deploy` — trigger a production deployment. IRREVERSIBLE: a deploy
 * changes what every tenant is served the moment it promotes (a rollback is a
 * NEW deploy), so the gate biases it to approval.
 */
export const vercelDeployTool: RegisteredTool = defineTool({
  label: "vercel.deploy",
  description:
    "Trigger a deployment on the configured Vercel project — irreversible once promoted; approval-gated by classification, and dormant behind the dark executor gates.",
  permission: "engineering.deploy",
  argSchema: z.object({
    /** The git ref the human approved for deployment. */
    ref: z.string().min(1),
    target: z.enum(["production", "preview"]),
  }),
  costEstimator: () => 0,
  reversibilityClass: "irreversible",
});

/**
 * The CTO tool catalogue — a frozen, label-sorted, read-only index. Resolving a
 * tool from it tells you what merging/deploying WOULD look like; it grants
 * nothing and runs nothing (the Executor Boundary Rule).
 */
export const CTO_TOOL_REGISTRY: ToolRegistry = createToolRegistry([
  githubMergePrTool,
  vercelDeployTool,
]);

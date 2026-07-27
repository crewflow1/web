import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  REFERENCE_TOOL_REGISTRY,
  memoryWriteTool,
  commSendTool,
  isReversibleTool,
  estimateToolCostMicros,
  type RegisteredTool,
  type ToolArgs,
} from "@/server/sdk/tools";
import { evaluateAction, type EmploymentPosture, type ProposedAction } from "@/server/sdk/gate";

/**
 * CrewFlow HQ — tool registry trust-boundary invariants
 * (CEO Directive #014 / D-04, Phase C, increment C1; ADR 0009 Decision 2; the Executor Boundary Rule).
 *
 * The typed tool registry (server/sdk/tools.ts) DESCRIBES capability. By canon it must NOT
 * authorise it, and must NOT execute it (ADR 0009 Decision 2: "The Tool Registry must never
 * become the authorisation system"; the Executor Boundary Rule: the executor — not the registry —
 * applies, and even it applies only what the gate already cleared). C1 proves this as a matter of
 * SOURCE, not discipline, exactly as the doorman's purity is proven by source.
 *
 * Each fact below, and what breaks if it silently flips:
 *   • The module imports ONLY `zod` — no admin/service client, no facet (events/comms/memory), no
 *     gate, no Approval Engine, no Task Engine, and no `server-only`. A single such import would
 *     turn a description into a reach for a side effect (and break UI-importability).
 *   • The executable source names no execution or authorisation construct — no `.rpc(`/`.from(`,
 *     no `fetch(`, no client factory, no `requestApproval`, no `invoke`. Describing a tool must
 *     not be able to RUN one.
 *   • The registry and its tools expose no invoke/execute/apply/authorise member — the catalogue
 *     resolves and lists; it does not call.
 *   • Behaviourally: resolving a tool and reading its `permission` grants NO autonomy. The gate
 *     (not the registry) decides — the posture floor still routes a fully-described, in-scope tool
 *     to approval, and a `permission` the employee does not hold still misses scope.
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract (which names "invoke",
 * "execute", "approval", etc. to explain what the module does NOT do) can neither satisfy a
 * positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

/** Every module specifier the source imports — `from "x"` and bare `import "x"`. */
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  while ((m = bareRe.exec(code))) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

const TOOLS = "server/sdk/tools.ts";

// =====================================================================
// 0. The C1 contract file exists.
// =====================================================================

describe("tool registry — the contract exists", () => {
  it("ships server/sdk/tools.ts", () => {
    expect(existsSync(resolve(ROOT, TOOLS)), TOOLS).toBe(true);
  });
});

// =====================================================================
// 1. It imports ONLY zod — no client, no facet, no gate, no engine.
// =====================================================================

describe("tool registry — imports describe, they do not reach", () => {
  const code = codeOf(read(TOOLS));

  it("imports nothing but zod", () => {
    const specs = importSpecifiers(code);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec, `unexpected import: ${spec}`).toBe("zod");
    }
  });

  it("does not import server-only — the UI may import the contract (the output.ts discipline)", () => {
    expect(code).not.toContain("server-only");
  });

  it("reaches for no authorisation, approval, task, or facet module", () => {
    // belt-and-braces over the import-set assertion: name the boundaries explicitly.
    for (const forbidden of [
      "./gate",
      "./tasks",
      "hq-approvals",
      "hq-tasks",
      "supabase",
      "/facets",
      "admin",
    ]) {
      expect(code, `must not import ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 2. The executable source names no execution/authorisation construct.
// =====================================================================

describe("tool registry — the source cannot run or authorise a tool", () => {
  const code = codeOf(read(TOOLS));

  it("contains no execution or authorisation verb", () => {
    for (const forbidden of [
      ".rpc(", // a SECURITY DEFINER call
      ".from(", // a table read/write
      "fetch(", // an external call (Phase D's gateway, not here)
      "createClient", // a Supabase client
      "createServiceClient",
      "supabaseAdmin",
      "requestApproval", // the Approval Engine
      "invoke", // ctx.tools.invoke — the executor, C2
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 3. The registry and tools expose no invoke/execute/authorise member.
// =====================================================================

describe("tool registry — the catalogue resolves, it does not call", () => {
  it("the registry exposes only lookup members", () => {
    const keys = Object.keys(REFERENCE_TOOL_REGISTRY).sort();
    expect(keys).toEqual(["has", "labels", "list", "resolve"]);
    for (const forbidden of ["invoke", "execute", "apply", "authorise", "authorize", "approve"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("a tool exposes only descriptive members (no behaviour)", () => {
    const keys = Object.keys(memoryWriteTool);
    for (const forbidden of ["invoke", "execute", "apply", "run", "handler", "call"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

// =====================================================================
// 4. Behaviour — describing a tool authorises nothing; the gate decides.
// =====================================================================

const permits: EmploymentPosture = { canExecute: true, requiresApproval: false };
const locked: EmploymentPosture = { canExecute: false, requiresApproval: true };
const caps = (tokens: readonly string[] = []) => ({ tokens, source: "ai_employees" as const });

const actionFromTool = (tool: RegisteredTool, args: ToolArgs): ProposedAction => ({
  type: tool.label,
  capability: tool.permission,
  subjectType: "lead",
  subjectId: "lead_1",
  reversible: isReversibleTool(tool),
  typedTarget: true,
  estimatedCostMicros: estimateToolCostMicros(tool, args),
});

describe("tool registry — resolving a tool grants no autonomy", () => {
  it("a fully-described, in-scope tool STILL routes to approval under the locked floor", () => {
    // The registry resolves memory.write and the employee holds its permission — yet the gate's
    // posture floor (the Built default) is decisive. The registry authorised nothing.
    const resolved = REFERENCE_TOOL_REGISTRY.resolve("memory.write");
    expect(resolved).toBe(memoryWriteTool);
    const v = evaluateAction(
      actionFromTool(memoryWriteTool, { verdict: "qualified", score: 87 }),
      locked,
      caps(["memory.write"]),
      1_000,
    );
    expect(v.decision).toBe("needs_approval");
  });

  it("the tool's `permission` is descriptive — holding it is sourced elsewhere, not granted here", () => {
    // Permitting posture, but the employee holds NO capability token: the gate misses scope. The
    // registry's `permission` field names the requirement; it does not confer the token.
    const v = evaluateAction(
      actionFromTool(memoryWriteTool, { verdict: "qualified" }),
      permits,
      caps([]),
      1_000,
    );
    expect(v.decision).toBe("needs_approval");
    expect(v.reasons).toContain("scope.missing_capability");
  });

  it("tools are frozen — descriptive data, immutable", () => {
    expect(Object.isFrozen(memoryWriteTool)).toBe(true);
    expect(Object.isFrozen(commSendTool)).toBe(true);
  });
});

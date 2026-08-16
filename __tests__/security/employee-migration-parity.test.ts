import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Employee-migration parity invariants (Directive #012 / D-02, PR-G).
 *
 * The Reference Employee Rule (Volume XIII) says the first migrated employee is the
 * canonical migration reference, and every later migration CONFORMS to the execution
 * model it proved. The per-employee suites (research-ai-invariants /
 * lead-qualification-invariants, each §8) already pin that ONE employee runs on the
 * generic engine. THIS suite pins the thing that makes them a *platform* rather than
 * two coincidences: the migrated employees are INDISTINGUISHABLE on the engine —
 * the same enqueue path, the same runner SDK surface, the same retired wall clock,
 * the same shed bespoke queue. If a future migration drifts — reaches the engine a
 * different way, keeps a private queue, re-introduces STUCK_RUNNING_MS — this fails,
 * which is the rule with teeth. To migrate employee #N, add a row to MIGRATED; it
 * must satisfy the SAME contract, by construction.
 *
 * Source-analysis only (no DB); checks run over `code` (TS comments stripped) so the
 * prose documenting the contract can neither satisfy nor trip an assertion. The live
 * cross-type behaviour is proven in the integration tier
 * (__tests__/integration/tasks/task-queue-read-model.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip TS block + line comments so a negative match can't be tripped by prose in a
// doc comment, while preserving the `://` of any URL.
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// The migrated employees + the durable task_type each owns. Adding the next migrated
// employee here forces it through the SAME contract — that is the whole point.
const MIGRATED = [
  {
    name: "research-ai",
    runner: "server/services/hq-research.ts",
    taskType: "research_company",
  },
  {
    name: "lead-qualification",
    runner: "server/services/hq-qualification.ts",
    taskType: "qualify_company",
  },
  // MP Wave R3 — the deterministic roster runners. Each reaches the engine the SAME way,
  // proving the pattern generalises beyond the sales pipeline (the Reference Employee Rule).
  {
    name: "analytics-ai",
    runner: "server/services/hq-analytics-runner.ts",
    taskType: "analytics_snapshot",
  },
  {
    name: "monitoring-incident-ai",
    runner: "server/services/hq-monitoring-runner.ts",
    taskType: "monitoring_sweep",
  },
  {
    name: "notification-ai",
    runner: "server/services/hq-notification-runner.ts",
    taskType: "notification_digest",
  },
] as const;

// The canonical engine surface every migrated employee reaches the engine through.
const ENQUEUE_PATH = "@/server/services/hq-tasks";
const RUNNER_SDK = "@/server/sdk/tasks";
const RUNNER_SYMBOLS = ["registerTaskHandler", "runReadyTask", "drainTaskType"] as const;
// enqueue + the three runner verbs = the full canonical surface, sorted.
const CANONICAL_SURFACE = ["enqueueTask", ...RUNNER_SYMBOLS].sort();

describe("employee-migration parity — every migrated employee exists", () => {
  for (const e of MIGRATED) {
    it(`${e.runner} exists`, () => {
      expect(existsSync(resolve(ROOT, e.runner))).toBe(true);
    });
  }
});

describe("employee-migration parity — every migrated employee runs on the ONE engine, the SAME way (Reference Employee Rule)", () => {
  for (const e of MIGRATED) {
    const code = codeOf(read(e.runner));

    it(`${e.name}: ENQUEUES through the sanctioned service path (enqueueTask from hq-tasks)`, () => {
      expect(code).toMatch(
        new RegExp(
          `import\\s*\\{[^}]*\\benqueueTask\\b[^}]*\\}\\s*from\\s*["']${reEscape(ENQUEUE_PATH)}["']`,
        ),
      );
      expect(code).toMatch(/\benqueueTask\s*\(/);
    });

    it(`${e.name}: EXECUTES through the canonical runner SDK — register + claim-one + drain`, () => {
      expect(code).toMatch(new RegExp(`from\\s*["']${reEscape(RUNNER_SDK)}["']`));
      for (const sym of RUNNER_SYMBOLS) {
        expect(code).toMatch(new RegExp(`\\b${sym}\\s*\\(`));
      }
    });

    it(`${e.name}: binds to its durable task_type contract (${e.taskType})`, () => {
      expect(code).toMatch(new RegExp(`TASK_TYPE\\s*=\\s*["']${reEscape(e.taskType)}["']`));
    });

    it(`${e.name}: has RETIRED the bespoke wall clock — STUCK_RUNNING_MS is gone`, () => {
      expect(code).not.toMatch(/STUCK_RUNNING_MS/);
    });

    it(`${e.name}: has SHED its old bespoke queue — never names hq_sales_ai_tasks`, () => {
      expect(code).not.toMatch(/hq_sales_ai_tasks/);
    });

    it(`${e.name}: never raw-writes the generic queue (reads only)`, () => {
      const oneLine = code.replace(/\s+/g, " ");
      expect(oneLine).not.toMatch(
        /\.from\(\s*["'`]hq_ai_tasks["'`](\s+as\s+never)?\s*\)\s*\.(insert|update|delete|upsert)\b/,
      );
    });
  }
});

// The parity assertion proper: the SET of engine entry points each employee uses is
// the SAME set — not merely "each uses some engine API", but "they use the IDENTICAL
// surface", so no employee is special. This is the machine-checkable form of "from
// the operating system's perspective, indistinguishable from every other employee".
describe("employee-migration parity — the engine surface is IDENTICAL across employees (indistinguishable)", () => {
  function surfaceOf(runner: string): string[] {
    const code = codeOf(read(runner));
    const used = new Set<string>();
    if (/\benqueueTask\s*\(/.test(code)) used.add("enqueueTask");
    for (const sym of RUNNER_SYMBOLS) {
      if (new RegExp(`\\b${sym}\\s*\\(`).test(code)) used.add(sym);
    }
    return [...used].sort();
  }

  it("every migrated employee calls the exact same set of engine entry points", () => {
    const surfaces = MIGRATED.map((e) => ({ name: e.name, surface: surfaceOf(e.runner) }));
    const reference = surfaces[0]!;
    for (const s of surfaces.slice(1)) {
      expect(
        s.surface,
        `${s.name} must use the same engine surface as the reference (${reference.name})`,
      ).toEqual(reference.surface);
    }
  });

  it("and that shared surface is the full canonical one (enqueue + register + claim-one + drain)", () => {
    for (const e of MIGRATED) {
      expect(surfaceOf(e.runner), `${e.name} surface`).toEqual(CANONICAL_SURFACE);
    }
  });
});

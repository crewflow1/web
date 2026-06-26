import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERBS } from "@/lib/events/registry";

/**
 * CrewFlow HQ — task-runner SDK trust-boundary invariants (Directive #012 / D-02, PR-C).
 *
 * PR-A pins the QUEUE (RLS:hq, the guard, the seven entry points); PR-B pins the
 * EMITTER (every wired transition writes one registered task.* event in-transaction).
 * These pin the RUNNER — the TypeScript surface every AI employee inherits — as a
 * matter of SOURCE, not discipline. The six runner/handler rules (Volume XIII §21):
 *   1. no employee claims from SQL      — only the runner's claimTask dequeues;
 *   2. no employee writes its own runner — there is one run-loop, here;
 *   3. no handler completes/fails itself — ctx.tasks is create + checkpoint ONLY;
 *   4. the runner owns the lifecycle mechanism;
 *   5. handlers own business logic only;
 *   6. handler purity — a handler takes ctx and returns or throws; nothing else.
 *
 * Each fact below, and what breaks if it silently flips:
 *   • The service layer mutates the queue ONLY through the seven SECURITY DEFINER
 *     RPCs — it never names `.from('hq_ai_tasks')` at all. A raw write would bypass
 *     the guard + the in-transaction spine emission.
 *   • The handler-facing facet type (BoundTasks) offers create + checkpoint and NOT
 *     complete/fail (rule 3) — and the facet factory never calls the terminal funcs.
 *   • Neither file emits task.* to the spine from TypeScript (no double-emit — the
 *     entry points already emit in-transaction, ADR-0005).
 *   • The runner mints its OWN lease owner; the handler type takes only `ctx` — there
 *     is no actor parameter a caller could spoof (XIII §8, "no API to set actor").
 *   • The reaper cron is a SYSTEM actor and emits only its own system.cron_ran (a
 *     registered verb), never a task.* verb.
 *
 * Comment text is stripped first, so the prose that DOCUMENTS the contract can
 * neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip block + line comments so only executable source is matched. */
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `://` in URLs)
}

const SERVICE = "server/services/hq-tasks.ts";
const SDK = "server/sdk/tasks.ts";
const REAPER = "app/api/cron/task-reaper/route.ts";

const ENTRY_POINTS = [
  "hq_ai_task_create",
  "hq_ai_task_claim",
  "hq_ai_task_heartbeat",
  "hq_ai_task_checkpoint",
  "hq_ai_task_complete",
  "hq_ai_task_fail",
  "hq_ai_task_reap",
] as const;

// =====================================================================
// 0. The PR-C files exist.
// =====================================================================

describe("task-runner SDK — the layer exists", () => {
  it("ships the service layer, the runner, and the reaper cron", () => {
    expect(existsSync(resolve(ROOT, SERVICE)), SERVICE).toBe(true);
    expect(existsSync(resolve(ROOT, SDK)), SDK).toBe(true);
    expect(existsSync(resolve(ROOT, REAPER)), REAPER).toBe(true);
  });
});

// =====================================================================
// 1. The service layer touches the queue ONLY through the seven RPCs.
// =====================================================================

describe("service layer — RPC-only, never a raw table write", () => {
  const code = codeOf(read(SERVICE));

  it("names NONE of `.from('hq_ai_tasks')` — every queue op is an entry-point RPC", () => {
    expect(code).not.toMatch(/\.from\(\s*["'`]hq_ai_tasks["'`]\s*\)/);
    // In fact it never reaches for the table builder at all — pure rpc().
    expect(code).not.toMatch(/\.from\(/);
  });

  it("calls each of the seven SECURITY DEFINER entry points", () => {
    for (const fn of ENTRY_POINTS) {
      expect(code, `service must wrap ${fn}`).toContain(fn);
    }
  });

  it("does NOT emit task.* to the spine from TypeScript (no double-emit)", () => {
    expect(code).not.toMatch(/emitEvent/);
    expect(code).not.toMatch(/hq_emit_event/);
    expect(code).not.toMatch(/'task\.[a-z_]+'|"task\.[a-z_]+"/);
  });
});

// =====================================================================
// 2. RULE 3 — the handler-facing facet is create + checkpoint ONLY.
// =====================================================================

describe("runner — ctx.tasks exposes create + checkpoint, never complete/fail (rule 3)", () => {
  const code = codeOf(read(SDK));

  it("the BoundTasks interface declares create + checkpoint and NOT complete/fail", () => {
    const m = code.match(/export interface BoundTasks \{([\s\S]*?)\n\}/);
    expect(m, "BoundTasks interface not found").toBeTruthy();
    const body = m![1]!;
    expect(body).toMatch(/\bcreate\s*\(/);
    expect(body).toMatch(/\bcheckpoint\s*\(/);
    expect(body).not.toMatch(/\bcomplete\s*\(/);
    expect(body).not.toMatch(/\bfail\s*\(/);
  });

  it("the facet factory (createTasks) never calls completeTask/failTask", () => {
    const m = code.match(/function createTasks\([\s\S]*?\n\}/);
    expect(m, "createTasks factory not found").toBeTruthy();
    const body = m![0]!;
    expect(body).not.toMatch(/completeTask\s*\(/);
    expect(body).not.toMatch(/failTask\s*\(/);
    // It DOES use the two permitted primitives.
    expect(body).toMatch(/enqueueTask\s*\(/);
    expect(body).toMatch(/checkpointTask\s*\(/);
  });

  it("RunContext carries the tasks facet (the SDK surface this PR builds)", () => {
    const m = code.match(/export interface RunContext \{([\s\S]*?)\n\}/);
    expect(m, "RunContext interface not found").toBeTruthy();
    expect(m![1]!).toMatch(/tasks:\s*BoundTasks/);
  });
});

// =====================================================================
// 3. No-spoof — the runner owns the actor; the handler cannot set one.
// =====================================================================

describe("runner — identity is the runner's, not a handler parameter (no spoofing)", () => {
  const code = codeOf(read(SDK));

  it("mints its own opaque lease owner per invocation", () => {
    expect(code).toMatch(/function mintLeaseOwner/);
    expect(code).toMatch(/crypto\.randomUUID\(\)/);
  });

  it("the handler signature receives ONLY ctx — there is no actor argument to spoof", () => {
    expect(code).toMatch(/type TaskHandler\s*=\s*\(ctx: RunContext\)\s*=>/);
  });

  it("does NOT emit task.* from TypeScript (the entry points emit in-transaction)", () => {
    expect(code).not.toMatch(/'task\.[a-z_]+'|"task\.[a-z_]+"/);
  });
});

// =====================================================================
// 4. The reaper cron is a SYSTEM actor, separate from employee runners.
// =====================================================================

describe("reaper cron — a system actor that emits only its own telemetry", () => {
  const code = codeOf(read(REAPER));

  it("is cron-authorised and wrapped in cron telemetry", () => {
    expect(code).toMatch(/isCronAuthorised/);
    expect(code).toMatch(/withCronTelemetry\(\s*["'`]task-reaper["'`]/);
  });

  it("reaps via the service wrapper (reapTasks), not a raw query", () => {
    expect(code).toMatch(/reapTasks\(/);
    expect(code).not.toMatch(/\.from\(/);
  });

  it("emits as a SYSTEM actor with the registered system.cron_ran verb — and no task.* verb", () => {
    expect(code).toMatch(/actorType:\s*["'`]system["'`]/);
    expect(code).toMatch(/verb:\s*["'`]system\.cron_ran["'`]/);
    expect(VERBS as readonly string[]).toContain("system.cron_ran");
    expect(code).not.toMatch(/verb:\s*["'`]task\.[a-z_]+["'`]/);
  });
});

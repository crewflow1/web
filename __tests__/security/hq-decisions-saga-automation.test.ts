import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Decision-Centre auto-proposal + autonomous saga-drain: source
 * contracts.
 *
 * The runtime behaviour is proven in __tests__/hq/decision-autoproposal.test.ts and
 * __tests__/hq/workflow-saga-drain.test.ts; these pin the load-bearing SAFETY rules
 * at the source so a regression fails CI:
 *
 *   • the auto-proposer OPENS proposals and NEVER decides/executes;
 *   • the migration is additive (no RLS change, no state-machine rewrite) and pins
 *     idempotency structurally (partial-unique signal key) + write-once provenance;
 *   • the saga-drain HALTS at approval-gated steps and takes no irreversible action;
 *   • both crons are CRON_SECRET-gated and registered in vercel.json.
 *
 * Checks run over `code` (comments stripped) / `exec` (SQL line-comments stripped) so
 * documenting prose can neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Slice one top-level function body: from its marker to the next top-level export. */
function sliceFn(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) return "";
  const rest = src.slice(start + marker.length);
  const nextExport = rest.search(/\nexport (async function|function|type|const) /);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const execOf = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const MIGRATION = "supabase/migrations/20261162000000_hq_decisions_saga.sql";
const AUTOPROPOSAL_SERVICE = "server/services/hq-decision-autoproposal.ts";
const AUTOPROPOSAL_MAPPER = "lib/hq/decision-autoproposal.ts";
const WORKFLOW_SERVICE = "server/services/hq-workflow.ts";
const MODEL = "lib/hq/workflow/model.ts";
const AUTOPROPOSE_CRON = "app/api/cron/hq-decision-autopropose/route.ts";
const SAGA_DRAIN_CRON = "app/api/cron/saga-drain/route.ts";
const VERCEL = "vercel.json";

const mig = read(MIGRATION);
const exec = execOf(mig);

// =====================================================================
// 1. The migration is ADDITIVE — no RLS change, no state-machine rewrite.
// =====================================================================

describe("migration — additive only (existing HQ invariants untouched)", () => {
  it("adds provenance columns idempotently", () => {
    expect(exec).toMatch(/add column if not exists source text not null default 'human'/);
    expect(exec).toMatch(/add column if not exists source_signal_key text/);
  });

  it("does NOT create or drop any RLS policy, and does not re-enable RLS", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(/drop policy/i);
    // It must not touch the shipped state-machine guard function.
    expect(exec).not.toMatch(/create or replace function public\.hq_decisions_guard\b/);
  });

  it("does not weaken the append-only history (no block-mutation trigger is dropped)", () => {
    expect(exec).not.toMatch(/drop trigger[^\n]*hq_decision_events/i);
  });
});

// =====================================================================
// 2. Idempotency + write-once provenance are DB-enforced.
// =====================================================================

describe("migration — idempotency + write-once provenance", () => {
  it("a partial-unique index makes one auto-proposal per signal, ever", () => {
    expect(exec).toMatch(
      /create unique index if not exists hq_decisions_source_signal_key_uidx[\s\S]*?on public\.hq_decisions \(source_signal_key\)[\s\S]*?where source_signal_key is not null/,
    );
  });

  it("source is CHECK-constrained to human|deterministic", () => {
    expect(exec).toMatch(/check \(source in \('human','deterministic'\)\)/);
  });

  it("a write-once BEFORE-UPDATE trigger pins source / source_signal_key", () => {
    expect(exec).toMatch(/create or replace function public\.hq_decisions_source_writeonce\(\)/);
    expect(exec).toMatch(/before update on public\.hq_decisions/);
    expect(exec).toMatch(/source \/ source_signal_key are write-once/);
  });
});

// =====================================================================
// 3. The auto-proposer OPENS proposals and NEVER decides or executes.
// =====================================================================

describe("auto-proposal — opens a DRAFT, never decides", () => {
  const svc = codeOf(read(AUTOPROPOSAL_SERVICE));
  const decisions = codeOf(read("server/services/hq-decisions.ts"));
  const mapper = codeOf(read(AUTOPROPOSAL_MAPPER));

  it("the service delegates to the single decisions authority (no direct table access)", () => {
    expect(svc).toMatch(/openDeterministicProposal\(/);
    expect(svc).not.toMatch(/from\(["']hq_decision/);
  });

  it("the service never calls the decide path", () => {
    expect(svc).not.toMatch(/\bdecide\s*\(/);
  });

  it("the sanctioned system-path insert is born 'proposed' (never a terminal state)", () => {
    const fn = sliceFn(decisions, "export async function openDeterministicProposal");
    expect(fn).toMatch(/status:\s*["']proposed["']/);
    expect(fn).not.toMatch(/status:\s*["'](approved|rejected|delayed|delegated)["']/);
    // System-raised proposals set NO decider — a decision is a human act.
    expect(fn).toMatch(/created_by:\s*null/);
    expect(fn).not.toMatch(/decided_by:/);
  });

  it("stamps deterministic source + a signal key for idempotency", () => {
    const fn = sliceFn(decisions, "export async function openDeterministicProposal");
    expect(fn).toMatch(/source:\s*["']deterministic["']/);
    expect(fn).toMatch(/source_signal_key:\s*signalKey/);
  });

  it("the mapper only maps CRITICAL signals and fabricates nothing (source is fixed)", () => {
    expect(mapper).toMatch(/severity !== ["']critical["']/);
    expect(mapper).toMatch(/source:\s*["']deterministic["']/);
    // No model / provider call in the deterministic tier.
    expect(mapper).not.toMatch(/invokeWithGovernor|openai|anthropic|fetch\(/i);
  });
});

// =====================================================================
// 4. The saga-drain HALTS at approval-gated steps + takes no irreversible action.
// =====================================================================

describe("saga-drain — respects the approval gate", () => {
  const svc = codeOf(read(WORKFLOW_SERVICE));
  const model = codeOf(read(MODEL));

  it("the drain checks stepRequiresApproval and holds gated steps", () => {
    expect(svc).toMatch(/drainReadySagaSteps/);
    expect(svc).toMatch(/stepRequiresApproval\(step\)/);
    expect(svc).toMatch(/held_for_approval/);
  });

  it("a step with no department is gated (fail-safe) in the pure model", () => {
    expect(model).toMatch(/export function stepRequiresApproval/);
    expect(model).toMatch(/if \(!dept\) return true/);
  });

  it("dispatch goes through the Task-Engine entry point with a stable dedupe key (no bare insert)", () => {
    expect(svc).toMatch(/enqueueTask\(/);
    expect(svc).toMatch(/dedupeKey:\s*`saga_step:\$\{step\.id\}`/);
    // No bare write to the tasks table.
    expect(svc).not.toMatch(/from\(["']hq_ai_tasks["']\)[\s\S]{0,40}\.insert/);
  });

  it("the drain never decides an approval or abandons a saga autonomously", () => {
    // The autonomous path opens internal work only — it must not flip approvals or
    // perform the human-only terminal act.
    const drainBody = sliceFn(svc, "export async function drainReadySagaSteps");
    expect(drainBody).not.toMatch(/\.update\(\s*\{\s*status:\s*["']abandoned["']/);
    expect(drainBody).not.toMatch(/hq_approvals/);
  });
});

// =====================================================================
// 5. Both crons are CRON_SECRET-gated and registered in vercel.json.
// =====================================================================

describe("crons — authorised + registered", () => {
  it("saga-drain is gated by isCronAuthorised", () => {
    const code = codeOf(read(SAGA_DRAIN_CRON));
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
    expect(code).toMatch(/drainReadySagaSteps/);
  });

  it("hq-decision-autopropose is gated by isCronAuthorised", () => {
    const code = codeOf(read(AUTOPROPOSE_CRON));
    expect(code).toMatch(/isCronAuthorised\(request\)/);
    expect(code).toMatch(/status:\s*401/);
    expect(code).toMatch(/runDecisionAutoProposal/);
  });

  it("both are registered in vercel.json", () => {
    const vercel = read(VERCEL);
    expect(vercel).toMatch(/\/api\/cron\/saga-drain/);
    expect(vercel).toMatch(/\/api\/cron\/hq-decision-autopropose/);
  });
});

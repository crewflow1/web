import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Roster-worker execution paths, security source-contracts (HQ roster
 * completion). Three things this wave adds must never regress silently:
 *
 *   1. The defensive grant-ensure migration keeps every worker at the default-deny FLOOR
 *      (can_execute=false, requires_approval=true, read+draft+memory only, NO model) and is
 *      provably additive + idempotent — it adds no table/policy/function/trigger and clobbers
 *      no existing operator-authored grant.
 *
 *   2. The twelve deterministic runners take NO irreversible action and make NO model call:
 *      they COMPUTE and REPORT. No governor/model import, no send/commit, and the only
 *      Task-Engine write is the sanctioned enqueue entry point (never a raw queue write).
 *
 *   3. The cron driver is auth-gated and telemetry-wrapped.
 *
 * Source-analysis only (no DB). SQL checks run over `exec` (line-comments stripped) and TS
 * checks over `code` (comments stripped) so the prose documenting the contract can neither
 * satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------
// 1. The migration — defensive deny-floor re-ensure, additive + idempotent.
// ---------------------------------------------------------------------

const MIGRATION = "supabase/migrations/20261205000000_hq_roster_workers.sql";
const exec = execOf(read(MIGRATION));

const WORKERS = [
  "security-ai",
  "devops-ai",
  "database-ai",
  "api-ai",
  "documentation-ai",
  "onboarding-ai",
  "hr-ai",
  "legal-compliance-ai",
  "design-ai",
  "orchestrator-ai",
  "workflow-ai",
  "memory-manager-ai",
] as const;

describe("roster-workers migration — every worker's deny-floor grant is re-ensured", () => {
  for (const slug of WORKERS) {
    it(`names ${slug}`, () => {
      expect(exec).toContain(`'${slug}'`);
    });
  }
});

describe("roster-workers migration — DARK by construction (deny floor, no model)", () => {
  it("re-ensures at the default-deny floor: read+draft+memory, can_execute FALSE, requires_approval TRUE", () => {
    expect(exec).toMatch(/array\['read','draft','memory'\],\s*false,\s*true/);
    expect(exec).toMatch(
      /\(scope_level,\s*scope_key,\s*tokens,\s*can_execute,\s*requires_approval,\s*memory_scope\)/,
    );
  });

  it("grants NO send / commit / book / dispatch / execute token — safety by ABSENCE", () => {
    for (const forbidden of ["send", "commit", "book", "dispatch", "execute"]) {
      expect(exec).not.toMatch(new RegExp(`'${forbidden}'`));
    }
  });

  it("wires NO model — never references model_provider / model_name", () => {
    expect(exec).not.toMatch(/model_provider|model_name/);
  });
});

describe("roster-workers migration — provably additive + idempotent", () => {
  it("adds NO table, policy, function, or trigger", () => {
    expect(exec).not.toMatch(/create\s+table/i);
    expect(exec).not.toMatch(/create\s+policy/i);
    expect(exec).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(exec).not.toMatch(/create\s+trigger/i);
  });
  it("drops NO column and alters no table", () => {
    expect(exec).not.toMatch(/drop\s+column/i);
    expect(exec).not.toMatch(/alter\s+table/i);
  });
  it("every write is conflict-guarded (never clobbers an operator grant)", () => {
    expect(exec).toMatch(/on conflict \(token\) do nothing/);
    expect(exec).toMatch(/where not exists/);
  });
});

// ---------------------------------------------------------------------
// 2. The runners — deterministic, no model, no irreversible action.
// ---------------------------------------------------------------------

const RUNNERS = [
  "server/services/hq-security-runner.ts",
  "server/services/hq-devops-runner.ts",
  "server/services/hq-database-runner.ts",
  "server/services/hq-api-runner.ts",
  "server/services/hq-documentation-runner.ts",
  "server/services/hq-onboarding-runner.ts",
  "server/services/hq-hr-runner.ts",
  "server/services/hq-legal-compliance-runner.ts",
  "server/services/hq-design-runner.ts",
  "server/services/hq-orchestrator-runner.ts",
  "server/services/hq-workflow-runner.ts",
  "server/services/hq-memory-manager-runner.ts",
] as const;

const PURE_LIB = "lib/hq/roster-workers.ts";
const KIT = "server/services/hq-worker-runner-kit.ts";

describe("roster-workers — DETERMINISTIC: no model / governor / generative call", () => {
  for (const r of RUNNERS) {
    const code = codeOf(read(r));
    it(`${r}: imports no model provider or AI governor`, () => {
      expect(code).not.toMatch(/@\/lib\/ai\/governor/);
      expect(code).not.toMatch(/@anthropic-ai|from\s+["']openai["']|generateText|streamText/);
    });
  }

  it(`${PURE_LIB}: the pure derivations import no Supabase / server-only / model surface`, () => {
    const code = codeOf(read(PURE_LIB));
    expect(code).not.toMatch(/server-only/);
    expect(code).not.toMatch(/@\/lib\/supabase/);
    expect(code).not.toMatch(/@\/lib\/ai\/governor|@anthropic-ai|openai/);
  });

  it(`${KIT}: the shared kit imports no model surface`, () => {
    const code = codeOf(read(KIT));
    expect(code).not.toMatch(/@\/lib\/ai\/governor|@anthropic-ai|openai|generateText|streamText/);
  });
});

describe("roster-workers — take NO irreversible action (compute + report only)", () => {
  for (const r of RUNNERS) {
    const code = codeOf(read(r));
    const oneLine = code.replace(/\s+/g, " ");

    it(`${r}: never raw-writes the generic queue (SELECT-only reads)`, () => {
      expect(oneLine).not.toMatch(
        /\.from\(\s*["'`]hq_ai_tasks["'`](\s+as\s+never)?\s*\)\s*\.(insert|update|delete|upsert)\b/,
      );
    });

    it(`${r}: reaches the queue only through the sanctioned enqueue entry point`, () => {
      expect(code).toMatch(
        /import\s*\{[^}]*\benqueueTask\b[^}]*\}\s*from\s*["']@\/server\/services\/hq-tasks["']/,
      );
    });

    it(`${r}: writes to no table (no .insert/.update/.delete/.upsert anywhere)`, () => {
      expect(oneLine).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
    });
  }
});

describe("roster-workers — cron driver is auth-gated and telemetry-wrapped", () => {
  const cron = codeOf(read("app/api/cron/hq-roster-workers-tick/route.ts"));
  it("rejects unauthorised callers", () => {
    expect(cron).toMatch(/isCronAuthorised/);
    expect(cron).toMatch(/status:\s*401/);
  });
  it("wraps the tick in cron telemetry", () => {
    expect(cron).toMatch(/withCronTelemetry\(\s*["']hq-roster-workers-tick["']/);
  });
  it("drives all twelve workers", () => {
    for (const label of [
      "security",
      "devops",
      "database",
      "api",
      "documentation",
      "onboarding",
      "hr",
      "legal_compliance",
      "design",
      "orchestrator",
      "workflow",
      "memory_manager",
    ]) {
      expect(cron).toContain(`"${label}"`);
    }
  });

  // 4. REGISTRATION: the tick endpoint must actually be SCHEDULED in vercel.json — an
  //    unscheduled cron never runs in prod, silently disabling all twelve roster workers.
  //    (This is the guard the original wave lacked, which let the schedule gap ship.)
  it("hq-roster-workers-tick is registered as a scheduled cron in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "vercel.json"), "utf8"));
    const paths = (vercel.crons ?? []).map((c: { path: string }) => c.path);
    expect(paths).toContain("/api/cron/hq-roster-workers-tick");
    const entry = (vercel.crons ?? []).find(
      (c: { path: string }) => c.path === "/api/cron/hq-roster-workers-tick",
    );
    // A real cron expression, not an empty/placeholder string.
    expect(typeof entry.schedule).toBe("string");
    expect(entry.schedule.trim().split(/\s+/).length).toBe(5);
  });
});

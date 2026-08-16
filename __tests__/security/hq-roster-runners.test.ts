import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Roster runners, security source-contracts (MP Wave R3).
 *
 * Two things this wave adds must never regress silently:
 *
 *   1. The two NEW employee identities (customer-success-ai, eng-manager-ai) are DARK by
 *      construction — mirrored EXACTLY on 20261128000000: deny-floor grant
 *      (can_execute=false, requires_approval=true), read+draft+memory tokens only, NO
 *      model, additive + idempotent.
 *
 *   2. The three deterministic runners take NO irreversible action and make NO model
 *      call: they COMPUTE and REPORT. No governor/model import, no send/commit, and the
 *      only Task-Engine write is the sanctioned enqueue entry point (never a raw queue
 *      write).
 *
 * Source-analysis only (no DB). SQL checks run over `exec` (line-comments stripped) and
 * TS checks over `code` (comments stripped) so the prose documenting the contract can
 * neither satisfy a positive match nor trip a negative one.
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
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ---------------------------------------------------------------------
// 1. The migration — two new identities, DARK by construction.
// ---------------------------------------------------------------------

const MIGRATION = "supabase/migrations/20261158000000_hq_roster_runners.sql";
const exec = execOf(read(MIGRATION));

const NEW_EMPLOYEES = ["customer-success-ai", "eng-manager-ai"] as const;

const ALLOWED_DEPARTMENTS = new Set([
  "executive",
  "engineering",
  "sales",
  "marketing",
  "design",
  "quality",
  "documentation",
  "product",
  "finance",
  "support",
  "operations",
]);

describe("roster runners migration — both new employees are present with a grant", () => {
  for (const slug of NEW_EMPLOYEES) {
    it(`seeds ${slug}`, () => {
      expect(exec).toContain(`'${slug}'`);
    });
    it(`seeds a deny-floor grant for ${slug}`, () => {
      expect(exec).toMatch(
        new RegExp(`\\('${slug}',\\s*'(global|organization|department|employee|isolated)'\\)`),
      );
    });
  }
});

describe("roster runners migration — every new employee is DARK (deny floor, no model)", () => {
  it("grants at the default-deny floor: read+draft+memory, can_execute FALSE, requires_approval TRUE", () => {
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

  it("wires NO model — the identity insert omits model_provider / model_name", () => {
    expect(exec).toMatch(
      /insert into public\.ai_employees\s*\(\s*name,\s*slug,\s*role,\s*department,\s*description,\s*icon,\s*accent,\s*status,\s*memory_scope,\s*sort_order\s*\)/,
    );
    expect(exec).not.toMatch(/model_provider|model_name/);
  });

  it("uses only departments the ai_employees CHECK admits", () => {
    for (const d of ["support", "engineering"]) {
      expect(ALLOWED_DEPARTMENTS.has(d)).toBe(true);
      expect(exec).toContain(`'${d}'`);
    }
  });
});

describe("roster runners migration — provably additive + idempotent", () => {
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
  it("every write is conflict-guarded", () => {
    expect(exec).toMatch(/on conflict \(slug\) do nothing/);
    expect(exec).toMatch(/on conflict \(token\) do nothing/);
    expect(exec).toMatch(/where not exists/);
  });
});

// ---------------------------------------------------------------------
// 2. The runners — deterministic, no model, no irreversible action.
// ---------------------------------------------------------------------

const RUNNERS = [
  "server/services/hq-analytics-runner.ts",
  "server/services/hq-monitoring-runner.ts",
  "server/services/hq-notification-runner.ts",
] as const;

const PURE_LIB = "lib/hq/roster-runners.ts";

describe("roster runners — DETERMINISTIC: no model / governor / generative call", () => {
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
});

describe("roster runners — take NO irreversible action (compute + report only)", () => {
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

    it(`${r}: writes to no other table (no .insert/.update/.delete/.upsert anywhere)`, () => {
      expect(oneLine).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
    });
  }
});

describe("roster runners — cron driver is auth-gated and telemetry-wrapped", () => {
  const cron = codeOf(read("app/api/cron/hq-runners-tick/route.ts"));
  it("rejects unauthorised callers", () => {
    expect(cron).toMatch(/isCronAuthorised/);
    expect(cron).toMatch(/status:\s*401/);
  });
  it("wraps the tick in cron telemetry", () => {
    expect(cron).toMatch(/withCronTelemetry\(\s*["']hq-runners-tick["']/);
  });
});

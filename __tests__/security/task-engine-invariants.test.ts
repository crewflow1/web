import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Generic Task Engine security invariants (Directive #012 / D-02, PR-A).
 *
 * D-02 is the first plank of the architectural spine the CEO ratified: ONE durable,
 * crash-safe, audited work queue that EVERY AI employee inherits — "employee #42
 * inherits exactly the same architecture as employee #3." It is shared operating-system
 * infrastructure, not an Outreach/Sales/per-employee runner. Because the whole workforce
 * inherits it, its trust boundary is pinned here, exhaustively, against SOURCE TEXT.
 *
 * The load-bearing facts these pin, and what breaks if one silently flips:
 *   • The queue is RLS:hq (RLS enabled, ZERO policies) and the ONLY way to touch it is
 *     the seven SECURITY DEFINER entry points (create/claim/heartbeat/checkpoint/
 *     complete/fail/reap), each with a pinned empty search_path and service-role-only
 *     EXECUTE. If a JWT role could reach the queue, or a function lost its hardening,
 *     a tenant could read or drive HQ work.
 *   • The lifecycle is a DB-enforced state machine — a BEFORE guard the service-role
 *     admin client cannot bypass (it BYPASSES RLS). Terminal rows are frozen, the task
 *     definition is write-once, illegal transitions are rejected. If that weakened, the
 *     "permissioned + audited" promise (Constitution §1.3) would be a lie.
 *   • The atomic dequeue is FOR UPDATE SKIP LOCKED — concurrent workers each take a
 *     DISTINCT row. If that regressed to a plain UPDATE, two workers could run the same
 *     task (the exact race the sales TypeScript runner left open).
 *   • PR-A is the THINNEST correct slice: the table + guard + entry points, with NOTHING
 *     routed to it and NO spine emission. The spine verbs/emitter are PR-B; the runner
 *     is PR-C. If this PR quietly grew a spine write or a second queue, the sequenced,
 *     independently-reversible PR plan the CEO ratified would be void.
 *
 * SQL checks run over `exec` (-- comments stripped) so the prose that DOCUMENTS the
 * contract can neither satisfy a positive match nor trip a negative one.
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

const MIGRATION = "supabase/migrations/20260802000000_hq_ai_tasks.sql";

// The seven sanctioned entry points — the SOLE API to the queue (Volume XII §11.1).
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
// 0. The migration ships ONE generic queue table — RLS:hq, no second store.
// =====================================================================

describe("task engine — the migration ships one generic, employee-agnostic queue", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("creates exactly ONE table — hq_ai_tasks — and no second audit/queue/log store", () => {
    const creates = exec.match(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi) ?? [];
    expect(creates).toHaveLength(1);
    expect(exec).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.hq_ai_tasks/i);
    expect(exec).not.toMatch(/create\s+table[^;]*\b(audit|event|log|history|queue)\b/i);
  });

  it("is RLS:hq — RLS enabled, ZERO policies (service-role only; no JWT client)", () => {
    expect(exec).toMatch(/alter\s+table\s+public\.hq_ai_tasks\s+enable\s+row\s+level\s+security/i);
    expect(exec).not.toMatch(/create\s+policy/i);
  });

  it("mints NO enum type — the lifecycle/priority are inline CHECK constraints", () => {
    expect(exec).not.toMatch(/create\s+type/i);
  });

  it("is GENERIC shared infrastructure — the DDL names no employee or workload", () => {
    // execOf strips the -- prose (which legitimately references hq_sales_ai_tasks as the
    // reuse source); the DDL/functions themselves are employee-agnostic.
    expect(exec).not.toMatch(/outreach/i);
    expect(exec).not.toMatch(/\bsales\b/i);
    expect(exec).not.toMatch(/research/i);
    expect(exec).not.toMatch(/qualification/i);
    expect(exec).not.toMatch(/\blead\b/i);
  });

  it("references ai_employees (optional assignee) — reuses existing identity", () => {
    expect(exec).toMatch(/assigned_employee_id\s+uuid\s+references\s+public\.ai_employees\s*\(\s*id\s*\)/i);
  });

  it("the subject is polymorphic with NO foreign key — generic over kinds it cannot enumerate", () => {
    // subject_kind/subject_id carry no `references` — the accepted cost of genericity (ADR-0004 R2).
    expect(exec).toMatch(/subject_kind\s+text\s+not\s+null\s+default\s+'none'/i);
    expect(exec).toMatch(/subject_id\s+uuid\s*,/i);
    expect(exec).not.toMatch(/subject_id\s+uuid\s+references/i);
  });
});

// =====================================================================
// 1. The lifecycle is a DB-enforced state machine no caller can bypass.
// =====================================================================

describe("task engine — the state machine is enforced by a guard the admin client cannot bypass", () => {
  const exec = execOf(read(MIGRATION));

  it("a BEFORE INSERT and BEFORE UPDATE guard wraps every write", () => {
    expect(exec).toMatch(/before\s+insert\s+on\s+public\.hq_ai_tasks/i);
    expect(exec).toMatch(/before\s+update\s+on\s+public\.hq_ai_tasks/i);
    expect(exec).toMatch(/execute\s+function\s+public\.hq_ai_tasks_guard\(\)/i);
  });

  it("a task is BORN pending — any other insert status is rejected", () => {
    expect(exec).toMatch(/new\.status\s*<>\s*'pending'/i);
    expect(exec).toMatch(/raise\s+exception/i);
  });

  it("TERMINAL rows are immutable — completed/failed/cancelled are frozen forever", () => {
    expect(exec).toMatch(
      /old\.status\s+in\s*\(\s*'completed'\s*,\s*'failed'\s*,\s*'cancelled'\s*\)/i,
    );
    expect(exec).toMatch(/terminal/i); // the raised message names the rule
    expect(exec).toMatch(/restrict_violation/i);
  });

  it("the task DEFINITION is write-once — type, subject, payload, DAG shape, trace cannot change", () => {
    for (const col of [
      "task_type",
      "subject_kind",
      "subject_id",
      "payload",
      "parent_task_id",
      "depends_on",
      "correlation_id",
      "dedupe_key",
    ]) {
      expect(exec).toMatch(new RegExp(`new\\.${col}\\s+is\\s+distinct\\s+from\\s+old\\.${col}`, "i"));
    }
  });

  it("only the D-02 transitions are legal — illegal moves raise (e.g. pending⇒completed is impossible)", () => {
    expect(exec).toMatch(/old\.status\s*=\s*'pending'\s+and\s+new\.status\s+in\s*\(\s*'running'\s*,\s*'cancelled'\s*\)/i);
    expect(exec).toMatch(
      /old\.status\s*=\s*'running'\s+and\s+new\.status\s+in\s*\(\s*'completed'\s*,\s*'failed'\s*,\s*'pending'\s*,\s*'cancelled'\s*\)/i,
    );
    expect(exec).toMatch(/illegal\s+transition/i);
    expect(exec).toMatch(/check_violation/i);
  });

  it("the status enum reserves the future seams (blocked/claimed/waiting_approval/verifying) without wiring them", () => {
    expect(exec).toMatch(
      /status\s+text[\s\S]*?check\s*\(\s*status\s+in\s*\(\s*'pending'\s*,\s*'running'\s*,\s*'completed'\s*,\s*'failed'\s*,\s*'cancelled'\s*,\s*'blocked'\s*,\s*'claimed'\s*,\s*'waiting_approval'\s*,\s*'verifying'\s*\)/i,
    );
  });
});

// =====================================================================
// 2. The atomic dequeue + lease are real — the net-new crash-recovery capability.
// =====================================================================

describe("task engine — atomic dequeue and worker-declared liveness", () => {
  const exec = execOf(read(MIGRATION));

  it("claims with FOR UPDATE SKIP LOCKED — concurrent workers take DISTINCT rows", () => {
    expect(exec).toMatch(/for\s+update\s+skip\s+locked/i);
  });

  it("carries the lease — owner, expiry, heartbeat (replaces the TypeScript wall clock)", () => {
    expect(exec).toMatch(/lease_owner\s+text/i);
    expect(exec).toMatch(/lease_expires_at\s+timestamptz/i);
    expect(exec).toMatch(/heartbeat_at\s+timestamptz/i);
  });

  it("dedupes LIVE work — a partial-unique index over pending/running only", () => {
    expect(exec).toMatch(
      /create\s+unique\s+index[\s\S]*?on\s+public\.hq_ai_tasks\s*\(\s*dedupe_key\s*\)[\s\S]*?where\s+dedupe_key\s+is\s+not\s+null\s+and\s+status\s+in\s*\(\s*'pending'\s*,\s*'running'\s*\)/i,
    );
  });

  it("retries with bounded exponential backoff — least(3600, 30 · 2^retry_count)", () => {
    expect(exec).toMatch(/least\s*\(\s*3600\s*,\s*\(\s*30\s*\*\s*power\s*\(\s*2\s*,\s*[a-z_.]*retry_count\s*\)/i);
  });
});

// =====================================================================
// 3. The seven entry points are the SOLE API — each SECURITY DEFINER + hardened.
// =====================================================================

describe("task engine — the entry points are the only door, and every one is locked down", () => {
  const exec = execOf(read(MIGRATION));

  it("defines exactly the SEVEN sanctioned entry points", () => {
    for (const fn of ENTRY_POINTS) {
      expect(exec).toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i"));
    }
    // Count only hardened definer clauses (security definer + pinned search_path), so the
    // documentation that legitimately names "SECURITY DEFINER" in a comment/string is ignored.
    const definers = exec.match(/security\s+definer\s+set\s+search_path\s*=\s*''/gi) ?? [];
    expect(definers).toHaveLength(ENTRY_POINTS.length); // the guard is NOT security definer
  });

  it("every entry point is SECURITY DEFINER with a pinned empty search_path", () => {
    for (const fn of ENTRY_POINTS) {
      const re = new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*returns[\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*''`,
        "i",
      );
      expect(exec).toMatch(re);
    }
    const pinned = exec.match(/set\s+search_path\s*=\s*''/gi) ?? [];
    expect(pinned).toHaveLength(ENTRY_POINTS.length);
  });

  it("EXECUTE is revoked from public/anon/authenticated and granted ONLY to service_role, per function", () => {
    for (const fn of ENTRY_POINTS) {
      expect(exec).toMatch(
        new RegExp(
          `revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`,
          "i",
        ),
      );
      expect(exec).toMatch(
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+to\\s+service_role`,
          "i",
        ),
      );
    }
    // No entry point is granted to a JWT role anywhere.
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });

  it("uses NO dynamic SQL anywhere (no execute format / execute '…')", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 4. PR-A boundary — the thinnest slice: NOTHING routes to the spine yet.
// =====================================================================

describe("task engine — PR-A ships the queue alone; the spine integration is PR-B", () => {
  const exec = execOf(read(MIGRATION));

  it("emits NO spine event — no hq_emit_event call, no direct hq_events write", () => {
    expect(exec).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
  });

  it("mints NO task.* (or any) verb vocabulary — verbs arrive with the emitter in PR-B", () => {
    expect(exec).not.toMatch(/'task\.[a-z_]+'/i);
    expect(exec).not.toMatch(/'ai\.[a-z_]+'/i);
  });

  it("routes to no employee service — the table is the entire deliverable", () => {
    // PR-A is schema + entry points only; the runner (server/sdk/tasks.ts) is PR-C.
    expect(exec).not.toMatch(/hq_sales_ai_tasks/i);
  });
});

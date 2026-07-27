import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERBS } from "@/lib/events/registry";

/**
 * CrewFlow HQ — task cancellation security invariants (CEO Directive #013 / D-03; ADR 0007).
 *
 * The Generic Task Engine's spine tests pin the SEVEN entry points PR-A/B brought up;
 * this pins the EIGHTH and final one — `hq_ai_task_cancel` — that D-03 binds onto the
 * cancellation seam #012 reserved (the 'cancelled' status + the guard's pending→cancelled
 * / running→cancelled transitions, both already present). It is the one entry point that
 * legitimately mutates a row WITHOUT holding its lease, so its hardening matters most.
 * Each fact, and what breaks if it silently flips:
 *   • The migration is purely additive — one function, no schema/guard/other-entry-point
 *     change. The cancellation seam already exists; D-03 only supplies its door.
 *   • The function is SECURITY DEFINER with a pinned empty search_path and service-role-
 *     only EXECUTE — identical lockdown to every entry point; never a public door.
 *   • Cancel is NOT lease-guarded: it targets a task by id + cancellable status, never by
 *     a worker's opaque lease token (it acts ON a task from OUTSIDE its worker). It must
 *     therefore name NO p_lease_owner — the very absence is the contract.
 *   • It CLEARS the lease (lease_owner = null) — the cooperative-cancel seam: the running
 *     worker's next heartbeat (status='running' AND lease_owner=token) then matches zero
 *     rows, returns false, and the SDK runner aborts ctx.signal. No new polling query.
 *   • Only {pending, running} are cancellable; an already-terminal row returns
 *     {ok:false, reason:'not_cancellable'} WITHOUT an UPDATE (idempotent no-op — never
 *     trips the guard's terminal-immutability exception).
 *   • Emission goes through the shared hq_ai_task_emit helper (never a raw hq_events
 *     INSERT), minting EXACTLY one task.* verb — task.cancelled — which the live registry
 *     declares, so the DB and the TypeScript source cannot drift (ADR 0005).
 *
 * SQL checks run over `exec` (-- comments stripped) so the prose that DOCUMENTS the
 * contract — which deliberately names lease_owner, heartbeat, p_lease_owner, etc. —
 * can neither satisfy a positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip `--` line comments so only executable SQL is matched (no block comments here). */
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const MIGRATION = "supabase/migrations/20260805000000_hq_ai_task_cancel.sql";
const FN = "hq_ai_task_cancel";

// The other entry points + the guard trigger function this migration must NOT touch.
const OTHER_ENTRY_POINTS = [
  "hq_ai_task_create",
  "hq_ai_task_claim",
  "hq_ai_task_heartbeat",
  "hq_ai_task_checkpoint",
  "hq_ai_task_complete",
  "hq_ai_task_fail",
  "hq_ai_task_reap",
  "hq_ai_task_emit",
] as const;

// =====================================================================
// 0. The migration exists and is additive — one function, nothing else.
// =====================================================================

describe("task cancel — the migration binds the seam without touching the schema", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("is purely additive — no table/type creation, no alter, no drop, no dynamic SQL", () => {
    expect(exec).not.toMatch(/create\s+table/i);
    expect(exec).not.toMatch(/create\s+type/i);
    expect(exec).not.toMatch(/alter\s+(table|type)/i);
    expect(exec).not.toMatch(/drop\s+(table|function|trigger|type|index)/i);
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });

  it("defines EXACTLY ONE function — hq_ai_task_cancel — and redefines no other entry point or the guard", () => {
    const defs = exec.match(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi) ?? [];
    expect(defs).toHaveLength(1);
    expect(exec).toMatch(
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${FN}\\s*\\(`, "i"),
    );
    for (const other of OTHER_ENTRY_POINTS) {
      expect(
        exec,
        `cancel migration must not redefine ${other}`,
      ).not.toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${other}\\b`, "i"));
    }
    // It touches NO trigger (the guard already wires pending|running → cancelled).
    expect(exec).not.toMatch(/create\s+(or\s+replace\s+)?trigger/i);
  });
});

// =====================================================================
// 1. Cancel acts from OUTSIDE the worker — by id + status, never by lease.
// =====================================================================

describe("task cancel — not lease-guarded; targets a cancellable task by id + status", () => {
  const exec = execOf(read(MIGRATION));

  it("names NO p_lease_owner anywhere — cancel never proves a lease it does not hold", () => {
    // Unlike heartbeat/checkpoint/complete/fail, cancel carries no lease parameter and
    // never guards on `lease_owner = p_lease_owner`. The absence IS the contract.
    expect(exec).not.toMatch(/p_lease_owner/i);
    expect(exec).not.toMatch(/lease_owner\s*=\s*p_lease_owner/i);
  });

  it("carries an explicit caller-declared actor (p_actor_type / p_actor_id) for the audit", () => {
    expect(exec).toMatch(/p_actor_type\s+text/i);
    expect(exec).toMatch(/p_actor_id\s+text/i);
  });

  it("only {pending, running} are cancellable, the row is locked, and a miss is a quiet no-op", () => {
    expect(exec).toMatch(/status\s+in\s*\(\s*'pending'\s*,\s*'running'\s*\)/i);
    expect(exec).toMatch(/for\s+update/i); // lock + decide cancellability in one read
    expect(exec).toMatch(/'not_cancellable'/); // idempotent: already-terminal → no UPDATE
  });

  it("transitions to the terminal 'cancelled' state AND clears the lease (the cooperative-cancel seam)", () => {
    expect(exec).toMatch(/status\s*=\s*'cancelled'/i);
    expect(exec).toMatch(/lease_owner\s*=\s*null/i);
    expect(exec).toMatch(/finished_at\s*=\s*now\(\)/i);
  });
});

// =====================================================================
// 2. Emission — one registered task.cancelled, through the shared helper.
// =====================================================================

describe("task cancel — emits exactly one registered task.cancelled via the spine helper", () => {
  const exec = execOf(read(MIGRATION));

  it("emits through hq_ai_task_emit (the one mapping primitive), never a raw hq_events write", () => {
    expect(exec).toMatch(/perform\s+public\.hq_ai_task_emit\s*\(/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
    expect(exec).not.toMatch(/update\s+public\.hq_events/i);
    // Only the helper itself reaches hq_emit_event; cancel routes through the helper.
    expect(exec).not.toMatch(/hq_emit_event/i);
  });

  it("mints EXACTLY the task.cancelled verb — no stray task.* vocabulary", () => {
    const minted = [...new Set([...exec.matchAll(/'(task\.[a-z_]+)'/gi)].map((m) => m[1]!.toLowerCase()))];
    expect(minted).toEqual(["task.cancelled"]);
  });

  it("task.cancelled is REGISTERED in lib/events/registry — the DB cannot drift from the source", () => {
    expect(VERBS as readonly string[]).toContain("task.cancelled");
  });

  it("emits at warn severity and records prev_status (the fact lost once the row is terminal)", () => {
    expect(exec).toMatch(/'warn'/);
    expect(exec).toMatch(/'prev_status'/);
  });
});

// =====================================================================
// 3. Locked down — SECURITY DEFINER, pinned search_path, service-role only.
// =====================================================================

describe("task cancel — the entry point is hardened like every other (P5)", () => {
  const exec = execOf(read(MIGRATION));

  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(
      new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+public\\.${FN}\\s*\\([^)]*\\)\\s*returns[\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*''`,
        "i",
      ),
    );
    // Exactly one hardened definer clause — nothing else is defined here.
    const definers = exec.match(/security\s+definer\s+set\s+search_path\s*=\s*''/gi) ?? [];
    expect(definers).toHaveLength(1);
  });

  it("revokes EXECUTE from public/anon/authenticated and grants ONLY to service_role", () => {
    expect(exec).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${FN}\\s*\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`,
        "i",
      ),
    );
    expect(exec).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${FN}\\s*\\([^)]*\\)\\s+to\\s+service_role`,
        "i",
      ),
    );
    // Never granted to a JWT role.
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });
});

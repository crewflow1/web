import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { VERBS, VERB_GROUPS } from "@/lib/events/registry";

/**
 * CrewFlow HQ — Task Engine spine-emission security invariants (Directive #012 / D-02, PR-B).
 *
 * PR-A's invariants pin the QUEUE (RLS:hq, the guard, the seven entry points). These
 * pin the EMITTER PR-B adds — the contract that every WIRED transition writes one
 * canonical, registered `task.*` event, in-transaction, through the single validated
 * spine primitive, with no new write path and no dead vocabulary. Each fact, and what
 * breaks if it silently flips:
 *   • Emission goes through hq_emit_event (the one validated spine write), NEVER a raw
 *     hq_events INSERT — so every task event passes the envelope CHECKs. A raw insert
 *     would let a malformed/unattributed event onto the spine.
 *   • The migration mints ONLY its five task verbs — created/claimed/completed/
 *     retried/failed — and NEITHER the deferred ones (heartbeated/checkpointed) NOR
 *     task.cancelled, which is a registered verb minted by its OWN migration (D-03 /
 *     #013), never the spine. A stray verb here would violate the registry's "one
 *     source of event names" (ADR 0005) and ship vocabulary with no transition.
 *   • The emitted verbs are a SUBSET of the actual registry (imported live), so the DB
 *     and the TypeScript source cannot drift.
 *   • The emit helper and the five redefined entry points are SECURITY DEFINER with a
 *     pinned empty search_path and service-role-only EXECUTE — the helper is HQ
 *     plumbing, not a public door.
 *   • heartbeat and checkpoint are NOT redefined (they stay silent), and the migration
 *     is additive — no schema change, no drop, no dynamic SQL.
 *   • No application code raw-writes the queue: the only sanctioned path stays the
 *     SECURITY DEFINER functions, so "every transition is on the spine" cannot be
 *     bypassed by a stray .from("hq_ai_tasks").update().
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

const MIGRATION = "supabase/migrations/20260803000000_hq_ai_tasks_spine.sql";

// The five verbs the SPINE migration (PR-B) brings to life — one per WIRED transition
// it owns (ADR 0005).
const TASK_VERBS = [
  "task.created",
  "task.claimed",
  "task.completed",
  "task.retried",
  "task.failed",
] as const;

// The full REGISTERED task group after D-03: the spine's five + task.cancelled (minted
// by its OWN migration, 20260805 — proven in the cancel-migration security test).
const REGISTERED_TASK_GROUP = [...TASK_VERBS, "task.cancelled"] as const;

// Absent from THIS (spine) migration: heartbeat/checkpoint are deferred (no transition
// emits them); task.cancelled is live but minted by the cancel migration, never here —
// the spine must not double-mint it.
const ABSENT_VERBS = ["task.heartbeated", "task.checkpointed", "task.cancelled"] as const;

// The helper + the five entry points PR-B (re)defines. heartbeat/checkpoint are NOT here.
const HELPER = "hq_ai_task_emit";
const EMITTING_ENTRY_POINTS = [
  "hq_ai_task_create",
  "hq_ai_task_claim",
  "hq_ai_task_complete",
  "hq_ai_task_fail",
  "hq_ai_task_reap",
] as const;
const REDEFINED = [HELPER, ...EMITTING_ENTRY_POINTS] as const;

// =====================================================================
// 0. The migration exists and is additive — functions + grants only.
// =====================================================================

describe("task spine — the migration adds emission without touching the schema", () => {
  it(`${MIGRATION} exists`, () => {
    expect(existsSync(resolve(ROOT, MIGRATION))).toBe(true);
  });

  const exec = execOf(read(MIGRATION));

  it("is purely additive — no table/type creation, no alter, no drop", () => {
    expect(exec).not.toMatch(/create\s+table/i);
    expect(exec).not.toMatch(/create\s+type/i);
    expect(exec).not.toMatch(/alter\s+table/i);
    expect(exec).not.toMatch(/drop\s+(table|function|trigger|type|index)/i);
  });

  it("redefines exactly the helper + the five EMITTING entry points (create/claim/complete/fail/reap)", () => {
    const defs = exec.match(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi) ?? [];
    expect(defs).toHaveLength(REDEFINED.length);
    for (const fn of REDEFINED) {
      expect(exec).toMatch(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i"));
    }
  });

  it("does NOT redefine heartbeat or checkpoint — they stay silent (liveness / internal state)", () => {
    expect(exec).not.toMatch(/create\s+or\s+replace\s+function\s+public\.hq_ai_task_heartbeat/i);
    expect(exec).not.toMatch(/create\s+or\s+replace\s+function\s+public\.hq_ai_task_checkpoint/i);
  });

  it("uses NO dynamic SQL (no execute format / execute '…')", () => {
    expect(exec).not.toMatch(/\bexecute\s+format\s*\(/i);
    expect(exec).not.toMatch(/\bexecute\s+'/i);
  });
});

// =====================================================================
// 1. Emission goes through the ONE validated spine write — never a raw insert.
// =====================================================================

describe("task spine — emits through hq_emit_event, the single validated spine primitive", () => {
  const exec = execOf(read(MIGRATION));

  it("calls hq_emit_event and writes NO raw hq_events row", () => {
    expect(exec).toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
    expect(exec).not.toMatch(/update\s+public\.hq_events/i);
  });

  it("routes every emission through the single hq_ai_task_emit helper (one envelope, one place)", () => {
    // The five entry points emit via `perform public.hq_ai_task_emit(...)`; only the
    // helper itself names hq_emit_event, so the envelope is assembled in exactly one place.
    const helperToSpine = exec.match(/hq_emit_event\s*\(/gi) ?? [];
    expect(helperToSpine).toHaveLength(1);
    const viaHelper = exec.match(/perform\s+public\.hq_ai_task_emit\s*\(/gi) ?? [];
    // create, claim, complete, and two branches each in fail + reap = 7 emit sites.
    expect(viaHelper.length).toBeGreaterThanOrEqual(7);
  });
});

// =====================================================================
// 2. Only the five REGISTERED verbs — no stray, no deferred, no drift.
// =====================================================================

describe("task spine — mints exactly the five registered task verbs, and no dead vocabulary", () => {
  const exec = execOf(read(MIGRATION));

  it("emits exactly the five task.* verbs — created/claimed/completed/retried/failed", () => {
    const minted = [...exec.matchAll(/'(task\.[a-z_]+)'/gi)].map((m) => m[1]!.toLowerCase());
    const unique = [...new Set(minted)].sort();
    expect(unique).toEqual([...TASK_VERBS].sort());
  });

  it("mints NONE of the deferred verbs (heartbeated/checkpointed/cancelled)", () => {
    for (const verb of ABSENT_VERBS) {
      expect(exec).not.toMatch(new RegExp(`'${verb.replace(".", "\\.")}'`, "i"));
    }
  });

  it("every emitted verb is REGISTERED in lib/events/registry — the DB cannot drift from the source", () => {
    const minted = [...new Set([...exec.matchAll(/'(task\.[a-z_]+)'/gi)].map((m) => m[1]!.toLowerCase()))];
    for (const verb of minted) {
      expect(VERBS as readonly string[]).toContain(verb);
    }
  });

  it("the registry's task group is exactly the spine's five + task.cancelled (D-03) — no dead vocabulary", () => {
    // The registry graduated to SIX under D-03; task.cancelled's mint is proven against
    // its own migration in the cancel-migration security test, so the registry still
    // carries no verb without a transition.
    expect([...VERB_GROUPS.task].sort()).toEqual([...REGISTERED_TASK_GROUP].sort());
  });
});

// =====================================================================
// 3. The helper and the redefined entry points are locked down (P5).
// =====================================================================

describe("task spine — the emit helper and every redefined entry point are hardened", () => {
  const exec = execOf(read(MIGRATION));

  it("the helper + five entry points are each SECURITY DEFINER with a pinned empty search_path", () => {
    for (const fn of REDEFINED) {
      const re = new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s*returns[\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*''`,
        "i",
      );
      expect(exec).toMatch(re);
    }
    // Exactly REDEFINED.length hardened definer clauses — nothing else is defined here.
    const definers = exec.match(/security\s+definer\s+set\s+search_path\s*=\s*''/gi) ?? [];
    expect(definers).toHaveLength(REDEFINED.length);
  });

  it("EXECUTE is revoked from public/anon/authenticated and granted ONLY to service_role, per function", () => {
    for (const fn of REDEFINED) {
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
    // No function is granted to a JWT role anywhere.
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });
});

// =====================================================================
// 4. Completeness — the queue is written ONLY through the functions.
//    "Every transition is on the spine" holds exactly as long as no application
//    code raw-writes the queue behind the functions' back.
// =====================================================================

describe("task spine — no application code raw-writes the queue (emission cannot be bypassed)", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("no file under server/ or app/ calls .from('hq_ai_tasks').{insert|update|delete|upsert}", () => {
    const dirs = ["server", "app"].map((d) => resolve(ROOT, d)).filter((d) => existsSync(d));
    const offenders: string[] = [];
    const rawWrite = /\.from\(\s*["'`]hq_ai_tasks["'`]\s*\)\s*\.(insert|update|delete|upsert)\b/;
    for (const dir of dirs) {
      for (const file of walk(dir)) {
        const normalized = readFileSync(file, "utf8").replace(/\s+/g, " ");
        if (rawWrite.test(normalized)) offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders, `raw queue writes must go through the entry points: ${offenders.join(", ")}`).toEqual([]);
  });
});

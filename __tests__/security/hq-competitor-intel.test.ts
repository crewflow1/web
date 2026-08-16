import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Competitor Intelligence + task-lifecycle security source-contracts.
 *
 * Migration 20261161000000 is ADDITIVE over the shipped HQ engine:
 *   • it WIDENS the pipeline_stage vocabulary (three SQL surfaces) to a strict superset
 *     — no existing row can be orphaned, and the base engine guard is NOT redefined;
 *   • it adds hq_competitor_notes — an append-friendly, RLS:hq (enabled, zero policies →
 *     service-role only) operator-authored store, tied to the seeded `competitor`
 *     memory_type — plus a single hardened SECURITY DEFINER writer.
 *
 * SQL checks run over `exec` (-- comments stripped) so prose can neither satisfy a
 * positive match nor trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261161000000_hq_task_lifecycle_and_competitor.sql";

function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const exec = execOf(read(MIGRATION));

const NEW_STAGES = ["architecture", "approval", "monitoring", "continuous-improvement"];

// =====================================================================
// 1. The stage widening is a non-breaking SUPERSET; the base guard is untouched.
// =====================================================================

describe("stage widening — additive superset, minimal blast radius", () => {
  it("widens the column CHECK by drop-then-recreate to a superset", () => {
    expect(exec).toMatch(/drop constraint if exists hq_ai_tasks_pipeline_stage_check/);
    expect(exec).toMatch(/add constraint hq_ai_tasks_pipeline_stage_check/);
    for (const s of NEW_STAGES) expect(exec, `new stage ${s}`).toMatch(new RegExp(`'${s}'`));
  });

  it("widens the append-only stage-event to_stage CHECK to the same superset", () => {
    expect(exec).toMatch(/drop constraint if exists hq_ai_task_stage_events_to_stage_check/);
    expect(exec).toMatch(/add constraint hq_ai_task_stage_events_to_stage_check/);
  });

  it("keeps the shipped stages (marketing + sales are NOT dropped)", () => {
    expect(exec).toMatch(/'marketing'/);
    expect(exec).toMatch(/'sales'/);
  });

  it("does NOT redefine the base engine guard, and touches no immutability trigger", () => {
    expect(exec).not.toMatch(/create or replace function public\.hq_ai_tasks_guard\(\)/);
    expect(exec).not.toMatch(/hq_ai_task_stage_events_block_mutation/);
    expect(exec).not.toMatch(/hq_ai_task_stage_emit/);
  });

  it("drops no table/function/type/index (only additive CHECK drop-recreate)", () => {
    expect(exec).not.toMatch(/drop\s+(table|function|type|index)/i);
  });
});

// =====================================================================
// 2. The widened set_stage mover stays hardened (service-role only).
// =====================================================================

describe("hq_ai_task_set_stage — re-created and still hardened", () => {
  it("is SECURITY DEFINER with a pinned empty search_path, active-status only", () => {
    expect(exec).toMatch(
      /create or replace function public\.hq_ai_task_set_stage\s*\([\s\S]*?\)[\s\S]{0,400}security definer[\s\S]{0,120}set search_path = ''/,
    );
    expect(exec).toMatch(/status in \('pending','running','blocked','claimed','waiting_approval','verifying'\)/);
    expect(exec).toMatch(/not_updatable/);
  });

  it("EXECUTE revoked from public/anon/authenticated, granted only to service_role", () => {
    expect(exec).toMatch(
      /revoke all on function public\.hq_ai_task_set_stage\(uuid, text\) from public, anon, authenticated/,
    );
    expect(exec).toMatch(/grant execute on function public\.hq_ai_task_set_stage\(uuid, text\) to service_role/);
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });
});

// =====================================================================
// 3. The competitor store is RLS:hq (enabled, ZERO policies).
// =====================================================================

describe("hq_competitor_notes — RLS:hq (service-role only)", () => {
  it("enables RLS on the table", () => {
    expect(exec).toMatch(/alter table public\.hq_competitor_notes\s+enable row level security/);
  });

  it("creates NO policy and GRANTs no table rights to a JWT role", () => {
    expect(exec).not.toMatch(/create policy/i);
    expect(exec).not.toMatch(
      /grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.hq_competitor_notes/i,
    );
  });

  it("is the competitor memory-type ingestion path (FK → hq_memory_types, seeded type)", () => {
    expect(exec).toMatch(/memory_type\s+text\s+not null default 'competitor'/);
    expect(exec).toMatch(/references public\.hq_memory_types\(slug\)/);
    expect(exec).toMatch(/insert into public\.hq_memory_types[\s\S]{0,200}'competitor'/);
    expect(exec).toMatch(/on conflict \(slug\) do nothing/);
  });
});

// =====================================================================
// 4. The competitor writer is the ONE sanctioned write path — hardened.
// =====================================================================

describe("hq_competitor_note_add — hardened SECURITY DEFINER writer", () => {
  it("is SECURITY DEFINER with a pinned empty search_path", () => {
    expect(exec).toMatch(
      /create or replace function public\.hq_competitor_note_add\s*\([\s\S]*?\)[\s\S]{0,400}security definer[\s\S]{0,120}set search_path = ''/,
    );
  });

  it("validates inputs and returns the house {ok} envelope (deterministic, no model)", () => {
    expect(exec).toMatch(/name_required/);
    expect(exec).toMatch(/headline_required/);
    expect(exec).toMatch(/jsonb_build_object\('ok', true/);
  });

  it("EXECUTE revoked from public/anon/authenticated, granted only to service_role", () => {
    expect(exec).toMatch(
      /revoke all on function public\.hq_competitor_note_add\([\s\S]*?\)\s*from public, anon, authenticated/,
    );
    expect(exec).toMatch(
      /grant execute on function public\.hq_competitor_note_add\([\s\S]*?\)\s*to service_role/,
    );
    expect(exec).not.toMatch(/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i);
  });
});

// =====================================================================
// 5. The service reads loudly and never raw-writes the store.
// =====================================================================

describe("hq-competitor-intel service — gated writer, loud reader", () => {
  const raw = read("server/services/hq-competitor-intel.ts");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("is server-only and super-admin-gated on the write", () => {
    expect(raw).toMatch(/server-only/);
    expect(code).toMatch(/isSuperAdminEmail/);
  });

  it("writes ONLY through the SECURITY DEFINER RPC (no bare insert/update/delete)", () => {
    expect(code).toMatch(/hq_competitor_note_add/);
    expect(code).not.toMatch(/\.from\(\s*["'`]hq_competitor_notes["'`][\s\S]{0,60}\.(insert|update|delete|upsert)\b/);
  });

  it("fails the briefing read LOUDLY (never masks an error as an empty store)", () => {
    expect(code).toMatch(/readFailure/);
  });
});

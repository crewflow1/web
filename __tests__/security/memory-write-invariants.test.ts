import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * Shared Memory — AI write-path invariants (Volume X §6/§12; Directive 009
 * Module 1, PR2).
 *
 * CI has no database in this tier (the live behaviour is proven in the
 * integration tier), so — exactly like the spine invariant suites — we pin the
 * `hq_memory_write` migration's security contract against its source text.
 * These are the assertions that, if they ever silently flipped, would be a
 * hole: the company brain becoming writable without an approval checkpoint, a
 * write that bypassed the validated event entry point, a JWT-callable engine
 * primitive, an un-hardened SECURITY DEFINER function, or a migration that
 * stopped being additive/dark.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the contract can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260723000000_hq_memory_write.sql";
const mig = read(MIG_REL);

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE
// statements, not the prose that documents the write contract.
const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

/** The header of a CREATE FUNCTION (signature → `as $$`), where hardening lives. */
function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

/** The full source of a CREATE FUNCTION (signature → closing `$$;`). */
function fnSource(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, `function ${name} end not found`).toBeGreaterThan(start);
  return exec.slice(start, end);
}

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("memory write — migration is present", () => {
  it("the PR2 AI write-path migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Additive & dark — no destructive change, no caller, no JWT exposure
// =====================================================================

describe("memory write — the migration is additive and dark", () => {
  it("drops or retypes nothing (production-safe)", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|index)/i);
    expect(exec).not.toMatch(/alter\s+table[\s\S]*?drop\s+/i);
  });

  it("does NOT enable pgvector or write an embedding column (semantic search stays dormant)", () => {
    // Embeddings are a plug-in landing in PR4 — this write path must be
    // byte-identical with or without them.
    expect(exec).not.toMatch(/create\s+extension[\s\S]*?vector/i);
    expect(exec).not.toMatch(/embedding/i);
  });

  it("seeds the AI-employee provenance source idempotently (re-application is a no-op)", () => {
    expect(exec).toMatch(
      /insert into public\.hq_memory_sources[\s\S]*?'ai_employee'[\s\S]*?on conflict \(slug\) do nothing/i,
    );
  });
});

// =====================================================================
// 2. §6 — the company brain cannot be written without an approval checkpoint
// =====================================================================

describe("memory write — §6 write rules are enforced in SQL", () => {
  const src = fnSource("hq_memory_write");

  it("resolves the employee's capability scopes from ai_employees.permissions", () => {
    expect(src).toMatch(/from public\.ai_employees/i);
    expect(src).toMatch(/permissions\s*->\s*'scopes'/i);
  });

  it("gates shared-knowledge writes on the memory.write.shared capability scope", () => {
    expect(src).toMatch(/\?\s*'memory\.write\.shared'/i);
  });

  it("DENIES system memory and another employee's private memory", () => {
    expect(src).toMatch(/p_visibility = 'system' then 'denied'/i);
    expect(src).toMatch(
      /not v_is_owner[\s\S]*?p_visibility in \('private', 'restricted'\) then 'denied'/i,
    );
  });

  it("WITHHOLDS a shared-knowledge proposal — returns the NULL sentinel, no insert", () => {
    // The approval_required branch must return before the INSERT, so the
    // company brain is never touched without the capability or an approval.
    const approvalIdx = src.indexOf("approval_required");
    const insertIdx = src.indexOf("insert into public.hq_memories");
    expect(approvalIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(approvalIdx);
    expect(src).toMatch(/if v_outcome = 'approval_required' then\s+return null;/i);
  });

  it("raises (not silently commits) on a §6 denial", () => {
    expect(src).toMatch(/if v_outcome = 'denied' then\s+raise exception/i);
    expect(src).toMatch(/errcode = 'insufficient_privilege'/i);
  });
});

// =====================================================================
// 3. The write goes THROUGH the validated event entry point (one primitive)
// =====================================================================

describe("memory write — emits through hq_emit_event, atomically", () => {
  const src = fnSource("hq_memory_write");

  it("emits via the validated entry point, not a raw INSERT into hq_events", () => {
    expect(src).toMatch(/perform public\.hq_emit_event\(/i);
    expect(src).not.toMatch(/insert into public\.hq_events/i);
  });

  it("emits the REGISTERED write verb memory.asserted", () => {
    expect(src).toMatch(/p_verb\s*=>\s*'memory\.asserted'/i);
    expect(isVerb("memory.asserted"), "memory.asserted must be registered").toBe(true);
    expect(new Set<string>(VERB_GROUPS.memory).has("memory.asserted")).toBe(true);
  });

  it("attributes the event to the AI employee (actor_type ai_employee)", () => {
    expect(src).toMatch(/p_actor_type\s*=>\s*'ai_employee'/i);
  });

  it("snapshots a version and writes the per-memory timeline event (atomic write)", () => {
    expect(src).toMatch(/insert into public\.hq_memory_versions/i);
    expect(src).toMatch(/insert into public\.hq_memory_events/i);
    expect(src).toMatch(/'ai_employee'/); // provenance source on the row
  });
});

// =====================================================================
// 4. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory write — the function is hardened", () => {
  it("hq_memory_write is SECURITY DEFINER with an empty search_path", () => {
    const header = fnHeader("hq_memory_write");
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = ''/i);
  });
});

// =====================================================================
// 5. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory write — EXECUTE revoked from JWT roles, granted only to service_role", () => {
  it("revokes from public, anon AND authenticated", () => {
    expect(exec).toMatch(
      /revoke all on function\s+public\.hq_memory_write\([\s\S]*?\)\s*from public, anon, authenticated/i,
    );
  });

  it("grants execute only to service_role", () => {
    expect(exec).toMatch(
      /grant execute on function\s+public\.hq_memory_write\([\s\S]*?\)\s*to service_role/i,
    );
  });

  it("never grants EXECUTE/privilege to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

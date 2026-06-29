import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { VERB_GROUPS, isVerb } from "@/lib/events/registry";

/**
 * Shared Memory — AI write-path invariants (Volume X §6/§12; Directive 009
 * Module 1, PR2; CEO Directive #015 / D-05, LR5.4A).
 *
 * CI has no database in this tier (the live behaviour is proven in the
 * integration tier), so — exactly like the spine invariant suites — we pin the
 * write gate's security contract against its source text. These are the
 * assertions that, if they ever silently flipped, would be a hole: the company
 * brain becoming writable without an approval checkpoint, a write that bypassed
 * the validated event entry point, a JWT-callable engine primitive, an
 * un-hardened SECURITY DEFINER function, or a migration that stopped being
 * additive/dark.
 *
 * TWO migrations define this gate. The original (20260723000000) created it and
 * resolved the `memory.write.shared` capability from `ai_employees.permissions
 * -> 'scopes'` — a `security definer` read path the LR5.2 census missed. LR5.4A
 * (20260811000000) is the AUTHORITATIVE definition: it `create or replace`s the
 * gate to resolve that capability from the Capability Registry via the new
 * `hq_employee_has_capability` oracle, with NO schema deletion (the column drop
 * is LR5.4B). This suite pins the LIVE contract on LR5.4A, asserts the hidden
 * read path is gone, and keeps the original migration's read path pinned as the
 * historical record of what was migrated (the Hidden Read Path Rule — Kernel
 * Contract Map §2).
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so the prose that documents the contract can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// The original write-path migration (historical) and the LR5.4A migration that
// `create or replace`s the gate onto the registry (authoritative).
const MIG_REL = "supabase/migrations/20260723000000_hq_memory_write.sql";
const MIG_A_REL = "supabase/migrations/20260811000000_lr5_4a_memory_write_registry_authority.sql";

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE
// statements, not the prose that documents the write contract.
const stripComments = (sql: string): string =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const exec = stripComments(read(MIG_REL)); // original (historical)
const execA = stripComments(read(MIG_A_REL)); // LR5.4A (authoritative)

/** The header of a CREATE FUNCTION (signature → `as $$`), where hardening lives. */
function fnHeader(execText: string, name: string): string {
  const start = execText.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = execText.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return execText.slice(start, bodyAt);
}

/** The full source of a CREATE FUNCTION (signature → closing `$$;`). */
function fnSource(execText: string, name: string): string {
  const start = execText.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = execText.indexOf("$$;", start);
  expect(end, `function ${name} end not found`).toBeGreaterThan(start);
  return execText.slice(start, end);
}

// =====================================================================
// 0. The migrations ship
// =====================================================================

describe("memory write — migrations are present", () => {
  it("the PR2 AI write-path migration exists (historical)", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it("the LR5.4A registry-authority migration exists (authoritative)", () => {
    expect(existsSync(resolve(ROOT, MIG_A_REL))).toBe(true);
  });
});

// =====================================================================
// 1. Additive & dark — no destructive change, no embeddings
// =====================================================================

describe("memory write — the migrations are additive and dark", () => {
  it("the original migration drops or retypes nothing (production-safe)", () => {
    expect(exec).not.toMatch(/drop\s+(table|column|function|index)/i);
    expect(exec).not.toMatch(/alter\s+table[\s\S]*?drop\s+/i);
  });

  it("LR5.4A drops or retypes nothing — NO schema deletion (the increment's premise)", () => {
    // LR5.4A migrates the reader only; the legacy column comes down in LR5.4B.
    expect(execA).not.toMatch(/drop\s+(table|column|function|index)/i);
    expect(execA).not.toMatch(/alter\s+table[\s\S]*?drop\s+/i);
  });

  it("neither migration enables pgvector or writes an embedding column", () => {
    for (const e of [exec, execA]) {
      expect(e).not.toMatch(/create\s+extension[\s\S]*?vector/i);
      expect(e).not.toMatch(/embedding/i);
    }
  });

  it("the original migration seeds the AI-employee provenance source idempotently", () => {
    expect(exec).toMatch(
      /insert into public\.hq_memory_sources[\s\S]*?'ai_employee'[\s\S]*?on conflict \(slug\) do nothing/i,
    );
  });
});

// =====================================================================
// 2. §6 — the capability authority now resolves from the registry (LR5.4A)
// =====================================================================

describe("memory write — §6 capability authority resolves from the registry (LR5.4A)", () => {
  const src = fnSource(execA, "hq_memory_write");

  it("gates shared-knowledge writes via hq_employee_has_capability('memory.write.shared')", () => {
    expect(src).toMatch(
      /hq_employee_has_capability\(\s*p_employee_id\s*,\s*'memory\.write\.shared'\s*\)/i,
    );
  });

  it("no longer reads the legacy ai_employees.permissions -> 'scopes' column (the hidden read path is migrated)", () => {
    expect(src).not.toMatch(/permissions\s*->\s*'scopes'/i);
    expect(src).not.toMatch(/\?\s*'memory\.write\.shared'/i);
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
// 3. The capability oracle — hq_employee_has_capability (LR5.4A)
// =====================================================================

describe("capability resolution — hq_employee_has_capability mirrors the inheritance law (LR5.4A)", () => {
  const src = fnSource(execA, "hq_employee_has_capability");

  it("reads the registry grants, never the legacy authority columns", () => {
    expect(src).toMatch(/from public\.hq_capability_grants/i);
    expect(src).not.toMatch(/permissions\s*->/i);
    expect(src).not.toMatch(/tools_allowed/i);
  });

  it("resolves grants by the global / department / employee scopes (organization never applies)", () => {
    expect(src).toMatch(/scope_level = 'global'/i);
    expect(src).toMatch(/scope_level = 'department' and g\.scope_key = v_dept/i);
    expect(src).toMatch(/scope_level = 'employee'\s+and g\.scope_key = v_slug/i);
    expect(src).not.toMatch(/scope_level = 'organization'/i);
  });

  it("tests token membership across the applicable grants (the resolved token UNION)", () => {
    expect(src).toMatch(/p_token = any\s*\(\s*g\.tokens\s*\)/i);
  });

  it("denies by default — an unknown employee holds nothing", () => {
    expect(src).toMatch(/if v_slug is null then\s+return false;/i);
    expect(src).toMatch(/return coalesce\(v_has, false\)/i);
  });
});

// =====================================================================
// 4. The write goes THROUGH the validated event entry point (LR5.4A gate)
// =====================================================================

describe("memory write — emits through hq_emit_event, atomically (LR5.4A)", () => {
  const src = fnSource(execA, "hq_memory_write");

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
// 5. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory write — the functions are hardened (LR5.4A)", () => {
  it("hq_memory_write is SECURITY DEFINER with an empty search_path", () => {
    const header = fnHeader(execA, "hq_memory_write");
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = ''/i);
  });

  it("hq_employee_has_capability is SECURITY DEFINER with an empty search_path", () => {
    const header = fnHeader(execA, "hq_employee_has_capability");
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = ''/i);
  });
});

// =====================================================================
// 6. Privilege model — service_role-only (L-4), never a JWT role (LR5.4A)
// =====================================================================

describe("memory write — EXECUTE revoked from JWT roles, granted only to service_role (LR5.4A)", () => {
  it("revokes hq_memory_write from public, anon AND authenticated", () => {
    expect(execA).toMatch(
      /revoke all on function\s+public\.hq_memory_write\([\s\S]*?\)\s*from public, anon, authenticated/i,
    );
  });

  it("grants hq_memory_write execute only to service_role", () => {
    expect(execA).toMatch(
      /grant execute on function\s+public\.hq_memory_write\([\s\S]*?\)\s*to service_role/i,
    );
  });

  it("revokes hq_employee_has_capability from public, anon AND authenticated", () => {
    expect(execA).toMatch(
      /revoke all on function\s+public\.hq_employee_has_capability\(uuid, text\)\s*from public, anon, authenticated/i,
    );
  });

  it("grants hq_employee_has_capability execute only to service_role", () => {
    expect(execA).toMatch(
      /grant execute on function\s+public\.hq_employee_has_capability\(uuid, text\)\s*to service_role/i,
    );
  });

  it("never grants EXECUTE/privilege to a JWT role (anon/authenticated/public)", () => {
    expect(execA).not.toMatch(/\bto\s+anon\b/i);
    expect(execA).not.toMatch(/\bto\s+authenticated\b/i);
    expect(execA).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

// =====================================================================
// 7. Historical record — the read path LR5.4A migrated
// =====================================================================

describe("memory write — the original migration's legacy read path (historical, superseded by LR5.4A)", () => {
  it("the original gate resolved the capability from ai_employees.permissions -> 'scopes' (the hidden read path)", () => {
    // Preserved as the evidence of WHAT LR5.4A migrated: the original migration's
    // text is immutable history (the Single Source of Authority / migration-history
    // discipline). The LIVE contract is pinned on LR5.4A in §2 above.
    const src = fnSource(exec, "hq_memory_write");
    expect(src).toMatch(/from public\.ai_employees/i);
    expect(src).toMatch(/permissions\s*->\s*'scopes'/i);
    expect(src).toMatch(/\?\s*'memory\.write\.shared'/i);
  });
});

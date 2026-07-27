import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_TYPES } from "@/lib/memory/model";

/**
 * Shared Memory — the AI `forget()` primitive: security invariants
 * (Volume X §12.2/§14; CEO Directive 009 Module 1, PR6 — SDK Integration).
 *
 * CI has no database in this tier (live behaviour is proven in the integration
 * tier), so — exactly like the lifecycle/write/recall invariant suites — we pin
 * `hq_memory_forget`'s contract against its source text. These are the
 * assertions that, if they ever silently flipped, would be a hole: an employee
 * forgetting memory it does NOT own (the permission re-assertion in SQL), a
 * forget becoming a HARD DELETE (memory must stay an audit subject), the version
 * snapshot or audit row disappearing, a forget leaking onto The Pulse (there is
 * no forget verb in the frozen registry), an un-hardened or JWT-callable
 * SECURITY DEFINER primitive, or an external AI call inside the transaction.
 *
 * Load-bearing checks run over `exec` (executable SQL with `--` comments
 * stripped) so prose can't satisfy a positive match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260728000000_hq_memory_forget.sql";
const mig = read(MIG_REL);

const exec = mig
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  })
  .join("\n");

const FN = "hq_memory_forget";

function fnHeader(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const bodyAt = exec.indexOf("as $$", start);
  expect(bodyAt, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, bodyAt);
}

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

describe("memory forget — migration is present", () => {
  it("the PR6 forget migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it(`defines ${FN}(p_employee_id, p_memory_id, p_reason)`, () => {
    const header = fnHeader(FN);
    expect(header).toMatch(/p_employee_id\s+uuid/i);
    expect(header).toMatch(/p_memory_id\s+uuid/i);
    expect(header).toMatch(/p_reason\s+text\s+default/i);
  });
});

// =====================================================================
// 1. Permission re-asserted in SQL (defence in depth, P5) — THE security gate
// =====================================================================

describe("memory forget — an employee may forget ONLY memory it owns", () => {
  const src = fnSource(FN);

  it("refuses up front when the owner is not the calling employee", () => {
    // The early guard: owner != caller → refuse (cannot forget another's memory
    // or the owner-less company brain).
    expect(src).toMatch(
      /v_owner\s+is\s+distinct\s+from\s+p_employee_id/i,
    );
    expect(src).toMatch(/'not_owner'/);
  });

  it("re-asserts ownership in the UPDATE itself (not just the pre-check)", () => {
    // Even past the guard, the write only touches a row that is BOTH active AND
    // owned by the caller — a TOCTOU-safe second assertion.
    expect(src).toMatch(
      /update\s+public\.hq_memories[\s\S]*?owner_employee_id\s*=\s*p_employee_id/i,
    );
  });

  it("only ever archives an ACTIVE row (idempotent; no double archival)", () => {
    expect(src).toMatch(/where\s+m\.id\s*=\s*p_memory_id[\s\S]*?m\.status\s*=\s*'active'/i);
    expect(src).toMatch(/'already_inactive'/);
  });
});

// =====================================================================
// 2. Never a hard delete — memory stays an audit subject (Bible §14)
// =====================================================================

describe("memory forget — archives, never deletes", () => {
  const src = fnSource(FN);

  it("sets status='archived' rather than deleting the row", () => {
    expect(src).toMatch(/set\s+status\s*=\s*'archived'/i);
  });

  it("NEVER issues a DELETE against the memory tables", () => {
    expect(src).not.toMatch(/delete\s+from\s+public\.hq_memories/i);
    expect(src).not.toMatch(/delete\s+from\s+public\.hq_memory_versions/i);
    expect(src).not.toMatch(/\btruncate\b/i);
  });

  it("bumps the version and writes a version snapshot (archives + versions)", () => {
    expect(src).toMatch(/version\s*=\s*m\.version\s*\+\s*1/i);
    expect(src).toMatch(/insert\s+into\s+public\.hq_memory_versions/i);
  });
});

// =====================================================================
// 3. Audited as a deliberate, employee-attributed act
// =====================================================================

describe("memory forget — audited with the acting employee stamped", () => {
  const src = fnSource(FN);

  it("writes a per-memory audit row carrying the ai_employee_id", () => {
    expect(src).toMatch(
      /insert\s+into\s+public\.hq_memory_events\s*\([^)]*ai_employee_id[^)]*\)/i,
    );
    expect(src).toMatch(/'archived'\s*,\s*p_employee_id/i);
  });

  it("records the action + reason in the audit detail", () => {
    expect(src).toMatch(/'action'\s*,\s*'forget'/i);
    expect(src).toMatch(/'reason'/i);
  });

  it("reuses the existing 'archived' audit vocabulary (no CHECK widen needed)", () => {
    // The emitted kind is an already-registered audit type, so the migration
    // needs no event_type CHECK widen (additive-safe).
    expect((EVENT_TYPES as readonly string[]).includes("archived")).toBe(true);
    // And the migration never DROPs/re-adds the events CHECK constraint.
    expect(exec).not.toMatch(/hq_memory_events_event_type_check/i);
    expect(exec).not.toMatch(/alter\s+table[\s\S]*?check\s*\(/i);
  });
});

// =====================================================================
// 4. Nothing on The Pulse — forget is not a business event (XI)
// =====================================================================

describe("memory forget — emits nothing on The Pulse", () => {
  const src = fnSource(FN);

  it("never emits a bus event and never touches hq_events", () => {
    expect(src).not.toMatch(/hq_emit_event/i);
    expect(exec).not.toMatch(/insert\s+into\s+public\.hq_events/i);
    expect(exec).not.toMatch(/'memory\.[a-z_]+'/i);
  });
});

// =====================================================================
// 5. No external AI call ever runs inside Postgres (CEO rule)
// =====================================================================

describe("memory forget — no external AI call inside Postgres", () => {
  it("the SQL never reaches out to a model provider or the network", () => {
    expect(exec).not.toMatch(/\bopenai\b/i);
    expect(exec).not.toMatch(/\banthropic\b/i);
    expect(exec).not.toMatch(/\bhttp\b/i);
    expect(exec).not.toMatch(/pg_net|net\.http|extensions\.http/i);
  });
});

// =====================================================================
// 6. Function hardening — SECURITY DEFINER + pinned empty search_path
// =====================================================================

describe("memory forget — the function is hardened", () => {
  it(`${FN} is SECURITY DEFINER with an empty search_path`, () => {
    const header = fnHeader(FN);
    expect(header).toMatch(/security definer/i);
    expect(header).toMatch(/set search_path = ''/i);
  });
});

// =====================================================================
// 7. Privilege model — service_role-only (L-4), never a JWT role
// =====================================================================

describe("memory forget — EXECUTE granted only to service_role", () => {
  it("is revoked from JWT roles and granted only to service_role", () => {
    expect(exec).toMatch(
      new RegExp(
        `revoke all on function\\s+public\\.${FN}\\([\\s\\S]*?\\)\\s*from public, anon, authenticated`,
        "i",
      ),
    );
    expect(exec).toMatch(
      new RegExp(
        `grant execute on function\\s+public\\.${FN}\\([\\s\\S]*?\\)\\s*to service_role`,
        "i",
      ),
    );
  });

  it("never grants EXECUTE to a JWT role (anon/authenticated/public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

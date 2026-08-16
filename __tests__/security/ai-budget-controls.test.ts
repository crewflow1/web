import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_MONTHLY_CEILING_PENCE,
  AI_MONTHLY_CEILING_HARD_MAX_PENCE,
} from "@/lib/ai/governor/policy";
import orgTables from "@/lib/gdpr/org-tables.json";

/**
 * AI budget CONTROLS — trust-boundary invariants (slot 20261147).
 *
 * The editable per-org ceiling and the per-employee limit change how much money
 * the governor will authorise, so the tables that hold them are exactly as
 * dangerous as the ledger and the reservation: a forged ceiling is a
 * spend-authorisation primitive, a forged (low) limit is a denial-of-service
 * primitive, and a limit change with no audit is an accountability hole. These
 * are proven against SOURCE TEXT (the migrations), because — like the governor
 * itself — the behaviour is deliberately "nothing happens" while every tier is
 * dark, so there is nothing to observe at runtime.
 *
 * SQL is checked over `exec` (-- comments stripped) so prose cannot satisfy or
 * trip a pin.
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

const CONTROLS = "supabase/migrations/20261147000000_ai_budget_controls.sql";
const RESERVE = "supabase/migrations/20261147000001_ai_reserve_effective_ceiling.sql";

const HARD_MAX = String(AI_MONTHLY_CEILING_HARD_MAX_PENCE); // "50000"

describe("both migrations exist and are additive", () => {
  it("the controls migration and the reserve replacement are present", () => {
    expect(execOf(read(CONTROLS)).length).toBeGreaterThan(0);
    expect(execOf(read(RESERVE)).length).toBeGreaterThan(0);
  });
});

describe("the control tables carry the ledger's trust boundary", () => {
  const exec = () => execOf(read(CONTROLS));

  it("every control table is org-scoped and cascades on org teardown", () => {
    for (const decl of [
      /create table if not exists public\.ai_org_budget_ceilings[\s\S]*?org_id uuid[\s\S]*?references public\.organizations\(id\) on delete cascade/,
      /create table if not exists public\.ai_employee_budget_limits[\s\S]*?org_id uuid not null references public\.organizations\(id\) on delete cascade/,
      /create table if not exists public\.ai_budget_control_audit[\s\S]*?org_id uuid not null references public\.organizations\(id\) on delete cascade/,
    ]) {
      expect(exec()).toMatch(decl);
    }
  });

  it("ceiling and limit are bounded [0, hard max] by CHECK", () => {
    expect(exec()).toMatch(
      new RegExp(`ceiling_pence integer not null\\s*\\n?\\s*check \\(ceiling_pence >= 0 and ceiling_pence <= ${HARD_MAX}\\)`),
    );
    expect(exec()).toMatch(
      new RegExp(`limit_pence integer not null\\s*\\n?\\s*check \\(limit_pence >= 0 and limit_pence <= ${HARD_MAX}\\)`),
    );
  });

  it("RLS is enabled on all three tables", () => {
    for (const t of [
      "ai_org_budget_ceilings",
      "ai_employee_budget_limits",
      "ai_budget_control_audit",
    ]) {
      expect(exec()).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    }
  });

  it("the ONLY policy on each table is admin-read (is_org_admin); no tenant write path", () => {
    const e = exec();
    // Each table has exactly one select policy gated on is_org_admin(org_id).
    for (const t of [
      "ai_org_budget_ceilings",
      "ai_employee_budget_limits",
      "ai_budget_control_audit",
    ]) {
      expect(e).toMatch(
        new RegExp(`create policy ${t}_select on public\\.${t}\\s+for select using \\(public\\.is_org_admin\\(org_id\\)\\)`),
      );
    }
    // No write policy exists anywhere in the migration — writes are service-role.
    expect(e).not.toMatch(/for\s+insert/i);
    expect(e).not.toMatch(/for\s+delete\b/i);
    // The only "update" is the audit trigger's BEFORE UPDATE OR DELETE, never a policy.
    expect(e).not.toMatch(/create policy[\s\S]*?for\s+update/i);
  });
});

describe("the audit trail is append-only and written atomically with the change", () => {
  const exec = () => execOf(read(CONTROLS));

  it("the audit table has a BEFORE UPDATE OR DELETE append-only guard", () => {
    expect(exec()).toMatch(
      /create trigger ai_budget_control_audit_append_only\s+before update or delete on public\.ai_budget_control_audit/,
    );
    expect(exec()).toMatch(/append-only/);
  });

  it("every set/clear RPC writes an ai_budget_control_audit row", () => {
    const e = exec();
    for (const fn of [
      "ai_set_org_ceiling",
      "ai_clear_org_ceiling",
      "ai_set_employee_limit",
      "ai_clear_employee_limit",
    ]) {
      const start = e.indexOf(`function public.${fn}`);
      expect(start, `${fn} must exist`).toBeGreaterThan(-1);
      const body = e.slice(start, start + 2500);
      expect(body, `${fn} must write the audit row`).toMatch(
        /insert into public\.ai_budget_control_audit/,
      );
    }
  });

  it("the set RPCs CLAMP to the hard safety max (defence in depth behind the CHECK)", () => {
    const e = exec();
    expect(e).toMatch(new RegExp(`greatest\\(0, least\\(p_ceiling_pence, ${HARD_MAX}\\)\\)`));
    expect(e).toMatch(new RegExp(`greatest\\(0, least\\(p_limit_pence, ${HARD_MAX}\\)\\)`));
  });

  it("the write RPCs are service-role only (revoked from public, granted to service_role)", () => {
    const e = exec();
    for (const fn of [
      "ai_set_org_ceiling",
      "ai_clear_org_ceiling",
      "ai_set_employee_limit",
      "ai_clear_employee_limit",
    ]) {
      expect(e).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`));
      expect(e).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`));
    }
  });

  it("the RPCs are SECURITY INVOKER (no security definer back door)", () => {
    expect(exec()).not.toMatch(/security\s+definer/i);
  });
});

describe("the reservation resolves the effective ceiling and enforces the employee limit", () => {
  const exec = () => execOf(read(RESERVE));

  it("replaces ai_reserve_invocation (drop + create, return-type change)", () => {
    expect(exec()).toMatch(/drop function if exists public\.ai_reserve_invocation/);
    expect(exec()).toMatch(/create function public\.ai_reserve_invocation/);
    expect(exec()).toMatch(/block_reason\s+text/);
  });

  it("resolves override ?? default and CLAMPS to the hard safety max, under the lock", () => {
    const e = exec();
    // The advisory lock is acquired before the override read.
    const lockIdx = e.indexOf("pg_advisory_xact_lock");
    const overrideIdx = e.indexOf("from public.ai_org_budget_ceilings");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(lockIdx);
    // override ?? default, then least(..., hardMax).
    expect(e).toMatch(new RegExp(`least\\(coalesce\\(v_override, p_ceiling_pence\\), ${HARD_MAX}\\)`));
  });

  it("enforces the per-employee limit as an ADDITIONAL fail-closed gate", () => {
    const e = exec();
    // The employee's own committed + reserved is read, and the conditional
    // insert requires the claim to fit under the limit too.
    expect(e).toMatch(/from public\.ai_employee_budget_limits/);
    expect(e).toMatch(
      /v_emp_limit is null\s*\n?\s*or v_user_committed \+ v_user_reserved \+ v_claim <= v_emp_limit/,
    );
  });

  it("the org ceiling gates are preserved exactly (band < and reserve <=)", () => {
    const e = exec();
    expect(e).toMatch(/v_committed \+ v_reserved < v_ceiling/); // band
    expect(e).toMatch(/v_committed \+ v_reserved \+ v_claim <= v_ceiling/); // reserve
  });

  it("distinguishes the block reason (employee_limit vs org_ceiling)", () => {
    const e = exec();
    expect(e).toMatch(/'employee_limit'/);
    expect(e).toMatch(/'org_ceiling'/);
  });

  it("stays SECURITY INVOKER and service-role only", () => {
    const e = exec();
    expect(e).not.toMatch(/security\s+definer/i);
    expect(e).toMatch(/grant execute on function public\.ai_reserve_invocation\([^)]*\)\s*\n?\s*to service_role/);
  });
});

describe("the SQL hard max agrees with the TypeScript constant", () => {
  it("50000 in the SQL is exactly AI_MONTHLY_CEILING_HARD_MAX_PENCE", () => {
    expect(AI_MONTHLY_CEILING_HARD_MAX_PENCE).toBe(50_000);
    expect(execOf(read(CONTROLS))).toContain(HARD_MAX);
    expect(execOf(read(RESERVE))).toContain(HARD_MAX);
  });

  it("the hard max can raise the ceiling above the default (else an override is pointless)", () => {
    expect(AI_MONTHLY_CEILING_HARD_MAX_PENCE).toBeGreaterThan(AI_MONTHLY_CEILING_PENCE);
  });
});

describe("the control tables are registered in the GDPR catalogue as governance internals", () => {
  const tables = [
    "ai_org_budget_ceilings",
    "ai_employee_budget_limits",
    "ai_budget_control_audit",
  ];
  it("each is in KNOWN (so the reverse drift guard is satisfied)", () => {
    for (const t of tables) expect(orgTables.known).toContain(t);
  });
  it("each is EXCLUDED from the DSAR export (governance internals, not tenant data)", () => {
    for (const t of tables) {
      expect(Object.keys(orgTables.excluded)).toContain(t);
    }
  });
});

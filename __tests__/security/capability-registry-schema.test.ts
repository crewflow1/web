import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Capability Registry — R1 (Registry Schema) security invariants.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 *
 * CI has no database here (live behaviour is proven in the integration tier), so —
 * exactly like the event-spine and activity-log-retention suites — we pin the
 * migration's STRUCTURAL and SECURITY contract against its source text. These are the
 * assertions that, if they ever silently flipped, would be a hole: a grant readable
 * by anon, a mutable audit trail, a posture floor that defaults open, a grant token
 * with no definition behind it, or R1 quietly growing into the resolver/SDK/legacy
 * work the CEO fenced out of this slice.
 *
 * The load-bearing checks run over `exec` (executable SQL with `--` comments stripped)
 * so the prose that NAMES ai_employees / the legacy columns can't satisfy a positive
 * match or trip a negative one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG_REL = "supabase/migrations/20260806000000_capability_registry.sql";
const mig = read(MIG_REL);

// The table this registry consolidates — used to prove the scope vocabularies mirror
// the existing canonical enums (no new hierarchy concept; no drift).
const AI_EMPLOYEES = read("supabase/migrations/20260712000000_ai_employees.sql");

// Strip SQL line comments (-- … EOL) so assertions test the EXECUTABLE statements,
// not the prose that documents the model.
const stripComments = (sql: string) =>
  sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const exec = stripComments(mig);

/** The header of a CREATE FUNCTION (signature → `as $$`), where the guard logic lives. */
function fnBody(name: string): string {
  const start = exec.indexOf(`create or replace function public.${name}()`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const end = exec.indexOf("$$;", start);
  expect(end, `function ${name} body not found`).toBeGreaterThan(start);
  return exec.slice(start, end);
}

// The canonical vocabularies (ADR 0010 Decision 5).
const SCOPE_LEVELS = ["global", "organization", "department", "employee"];
const MEMORY_SCOPES = ["isolated", "department", "organization", "global"];
const DEPARTMENTS = [
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
];

// =====================================================================
// 0. The migration ships
// =====================================================================

describe("capability registry R1 — migration is present", () => {
  it("the R1 schema migration exists", () => {
    expect(existsSync(resolve(ROOT, MIG_REL))).toBe(true);
  });

  it("creates exactly the two tables the CEO scoped — definition + grant", () => {
    expect(exec).toMatch(/create table if not exists public\.hq_capabilities/i);
    expect(exec).toMatch(/create table if not exists public\.hq_capability_grants/i);
  });
});

// =====================================================================
// 1. hq_capabilities — the definition catalogue
// =====================================================================

describe("capability registry R1 — hq_capabilities definition table", () => {
  it("the token is unique and format-checked (opaque, matched-not-interpreted)", () => {
    expect(exec).toMatch(/token\s+text\s+not null\s+unique/i);
    expect(exec).toMatch(/check \(token ~ '\^\[a-z0-9\]\+\(\[\._-\]\[a-z0-9\]\+\)\*\$'/i);
  });

  it("classifies tokens (tool_permission / scope / api_scope) — gateway-ready", () => {
    expect(exec).toMatch(/kind\s+text\s+not null\s+default 'tool_permission'\s+check \(kind in \(/i);
    for (const k of ["tool_permission", "scope", "api_scope"]) {
      expect(exec).toMatch(new RegExp(`'${k}'`));
    }
  });
});

// =====================================================================
// 2. The inheritance scope model (ADR 0010 Decision 5)
// =====================================================================

describe("capability registry R1 — inheritance scope model", () => {
  it("scope_level is the four nested levels, mirroring memory_scope", () => {
    expect(exec).toMatch(/scope_level\s+text\s+not null\s+check \(scope_level in \(/i);
    for (const lvl of SCOPE_LEVELS) expect(exec).toMatch(new RegExp(`'${lvl}'`));
  });

  it("scope_key shape is enforced — global carries none, every other level names its scope", () => {
    expect(exec).toMatch(/constraint hq_capability_grants_scope_key_shape check \(/i);
    expect(exec).toMatch(/scope_level = 'global' and scope_key is null/i);
    expect(exec).toMatch(/scope_level <> 'global' and scope_key is not null/i);
  });

  it("a department-scope key must be a known department (mirrors ai_employees.department)", () => {
    expect(exec).toMatch(/constraint hq_capability_grants_department_key check \(/i);
    for (const d of DEPARTMENTS) {
      expect(exec, `registry missing department '${d}'`).toMatch(new RegExp(`'${d}'`));
      expect(AI_EMPLOYEES, `ai_employees missing department '${d}'`).toMatch(new RegExp(`'${d}'`));
    }
  });

  it("an employee-scope key must look like an EmployeeIdentity.slug", () => {
    expect(exec).toMatch(/constraint hq_capability_grants_employee_key check \(/i);
    // Mirrors the ai_employees.slug format exactly.
    expect(exec).toMatch(/scope_key ~ '\^\[a-z0-9-\]\{1,60\}\$'/i);
    expect(AI_EMPLOYEES).toMatch(/slug\s+text not null unique check \(slug ~ '\^\[a-z0-9-\]\{1,60\}\$'\)/i);
  });

  it("registration metadata is confined to the employee scope", () => {
    expect(exec).toMatch(/constraint hq_capability_grants_registration_scope check \(/i);
    expect(exec).toMatch(/scope_level = 'employee' or registration = '\{\}'::jsonb/i);
  });
});

// =====================================================================
// 3. The default-deny floor — mirrored as column defaults
// =====================================================================

describe("capability registry R1 — default-deny floor", () => {
  it("posture defaults LOCKED — can_execute=false, requires_approval=true", () => {
    expect(exec).toMatch(/can_execute\s+boolean\s+not null\s+default false/i);
    expect(exec).toMatch(/requires_approval\s+boolean\s+not null\s+default true/i);
  });

  it("tokens default to the empty set — the floor grants nothing", () => {
    expect(exec).toMatch(/tokens\s+text\[\]\s+not null\s+default '\{\}'/i);
  });

  it("memory_scope defaults to the safe 'isolated' and is enum-checked", () => {
    expect(exec).toMatch(/memory_scope\s+text\s+not null\s+default 'isolated'\s+check \(memory_scope in \(/i);
    for (const s of MEMORY_SCOPES) expect(exec).toMatch(new RegExp(`'${s}'`));
  });

  it("budget_default is a non-negative number or NULL (a ceiling, not a meter)", () => {
    expect(exec).toMatch(/budget_default\s+numeric\(12, 2\)\s+check \(budget_default is null or budget_default >= 0\)/i);
  });

  it("registration is a jsonb object", () => {
    expect(exec).toMatch(/registration\s+jsonb\s+not null\s+default '\{\}'::jsonb/i);
    expect(exec).toMatch(/check \(jsonb_typeof\(registration\) = 'object'\)/i);
  });
});

// =====================================================================
// 4. Uniqueness — one grant per scope
// =====================================================================

describe("capability registry R1 — one grant per scope", () => {
  it("at most ONE global grant (partial unique index, NULL-key portable)", () => {
    expect(exec).toMatch(
      /create unique index if not exists hq_capability_grants_global_uniq\s+on public\.hq_capability_grants \(scope_level\)\s+where scope_level = 'global'/i,
    );
  });

  it("at most ONE grant per (scope_level, scope_key) otherwise", () => {
    expect(exec).toMatch(
      /create unique index if not exists hq_capability_grants_scoped_uniq\s+on public\.hq_capability_grants \(scope_level, scope_key\)\s+where scope_level <> 'global'/i,
    );
  });
});

// =====================================================================
// 5. Token referential integrity (grants ⊆ definitions)
// =====================================================================

describe("capability registry R1 — token referential integrity", () => {
  it("a BEFORE INSERT OR UPDATE trigger validates grant tokens against the catalogue", () => {
    expect(exec).toMatch(
      /before insert or update on public\.hq_capability_grants\s+for each row execute function public\.hq_capability_grants_validate_tokens/i,
    );
  });

  it("the validator REJECTS an undefined token rather than silently storing it", () => {
    const body = fnBody("hq_capability_grants_validate_tokens");
    expect(body).toMatch(/not exists \(select 1 from public\.hq_capabilities c where c\.token = t\)/i);
    expect(body).toMatch(/raise exception 'unknown capability token %/i);
    expect(body).toMatch(/errcode = 'foreign_key_violation'/i);
  });

  it("the validator normalises tokens to sorted-distinct (deterministic, parity-ready)", () => {
    const body = fnBody("hq_capability_grants_validate_tokens");
    expect(body).toMatch(/array_agg\(distinct t order by t\)/i);
  });

  it("a defined capability cannot be deleted while a grant references it", () => {
    expect(exec).toMatch(
      /before delete on public\.hq_capabilities\s+for each row execute function public\.hq_capabilities_block_referenced_delete/i,
    );
    const body = fnBody("hq_capabilities_block_referenced_delete");
    expect(body).toMatch(/old\.token = any\(g\.tokens\)/i);
    expect(body).toMatch(/errcode = 'restrict_violation'/i);
  });
});

// =====================================================================
// 6. Immutable audit fields
// =====================================================================

describe("capability registry R1 — immutable audit fields", () => {
  it("both tables carry created_at / created_by_id / created_by_email + updated_at", () => {
    // Two occurrences (one per table).
    expect((exec.match(/created_by_email\s+text/gi) ?? []).length).toBe(2);
    expect((exec.match(/updated_at\s+timestamptz not null default now\(\)/gi) ?? []).length).toBe(2);
  });

  it("the grant guard freezes the audit trail AND the scope identity, then touches updated_at", () => {
    expect(exec).toMatch(
      /before update on public\.hq_capability_grants\s+for each row execute function public\.hq_capability_grants_guard/i,
    );
    const body = fnBody("hq_capability_grants_guard");
    expect(body).toMatch(/new\.scope_level is distinct from old\.scope_level/i);
    expect(body).toMatch(/new\.created_at is distinct from old\.created_at/i);
    expect(body).toMatch(/new\.created_by_email is distinct from old\.created_by_email/i);
    expect(body).toMatch(/raise exception 'hq_capability_grants audit fields are immutable'/i);
    expect(body).toMatch(/errcode = 'restrict_violation'/i);
    expect(body).toMatch(/new\.updated_at := now\(\)/i);
  });

  it("the capability guard freezes the token + audit trail, then touches updated_at", () => {
    expect(exec).toMatch(
      /before update on public\.hq_capabilities\s+for each row execute function public\.hq_capabilities_guard/i,
    );
    const body = fnBody("hq_capabilities_guard");
    expect(body).toMatch(/new\.token is distinct from old\.token/i);
    expect(body).toMatch(/raise exception 'hq_capabilities\.token is immutable/i);
    expect(body).toMatch(/new\.updated_at := now\(\)/i);
  });
});

// =====================================================================
// 7. RLS:hq — both tables are service-role only
// =====================================================================

describe("capability registry R1 — RLS:hq", () => {
  for (const table of ["hq_capabilities", "hq_capability_grants"]) {
    it(`${table} enables row level security`, () => {
      expect(exec).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
    });
  }

  it("declares NO policies anywhere — service_role (BYPASSRLS) is the only reader", () => {
    expect(exec).not.toMatch(/create policy/i);
  });

  it("never grants to a JWT role (anon / authenticated / public)", () => {
    expect(exec).not.toMatch(/\bto\s+anon\b/i);
    expect(exec).not.toMatch(/\bto\s+authenticated\b/i);
    expect(exec).not.toMatch(/grant[\s\S]*?\bto\s+public\b/i);
  });
});

// =====================================================================
// 8. R1 boundary — schema only (no resolver, no SDK wiring, no legacy migration)
// =====================================================================

describe("capability registry R1 — stays inside the authorised slice", () => {
  it("does NOT touch the legacy ai_employees columns (no backfill / no migration away)", () => {
    // The header prose may name them; the EXECUTABLE SQL must not.
    expect(exec).not.toMatch(/ai_employees/i);
    expect(exec).not.toMatch(/tools_allowed/i);
    expect(exec).not.toMatch(/\bpermissions\b/i);
  });

  it("ships NO seed / backfill data — the tables ship empty (R2 populates)", () => {
    expect(exec).not.toMatch(/insert\s+into/i);
  });

  it("introduces NO resolver / SDK surface — it is storage only", () => {
    expect(exec).not.toMatch(/resolvedcapabilityset/i);
    expect(exec).not.toMatch(/resolveemployee/i);
  });
});

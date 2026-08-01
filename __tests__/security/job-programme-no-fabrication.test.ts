import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildPlannedProgress } from "@/lib/job-programme/planned";

/**
 * Job Programme Baseline — the two boundaries this train lives or dies by,
 * pinned at the source (the works-quality suite discipline: runtime behaviour
 * is proven against real Postgres in
 * __tests__/integration/rls/job-programme.test.ts; these make a regression a
 * red build).
 *
 * BOUNDARY 1 — NO FABRICATED PLANNED LINE. The planned curve exists ONLY when
 * a current baseline is fully weighted and sums to 100. Everything less is
 * null: the pre-programme panel's refusal ("a straight line from 0% to 100%
 * would look like a plan and measure nothing") survives the arrival of the
 * table that could tempt someone to relax it.
 *
 * BOUNDARY 2 — NO MONEY, ANYWHERE IN THE TRAIN. A milestone weight is a
 * dimensionless share; milestone-valued billing is the application-for-payment
 * lane the 20261078 migration (decision 4) explicitly kept out of the progress
 * domain, and it stays a CEO decision. No programme source file imports a
 * money module, no programme table carries a money column, and the migration
 * touches no money table or function.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "20261085000000_job_programme_baseline.sql";

/** Every file the programme feature owns. */
const PROGRAMME_SOURCES = [
  "lib/job-programme/planned.ts",
  "lib/job-programme/portal.ts",
  "server/services/job-progress.ts",
  "app/(app)/jobs/[id]/programme-actions.ts",
  "app/(app)/jobs/[id]/_job-programme.tsx",
  "app/(app)/jobs/[id]/_job-progress.tsx",
];

/** Tables and functions that move, hold or represent money (the 20261078 list). */
const MONEY_TABLES = [
  "finances",
  "invoices",
  "invoice_payments",
  "invoice_line_items",
  "payments",
  "job_billing_plans",
  "job_billing_stages",
  "retention_releases",
  "supplier_bills",
  "supplier_payments",
  "expenses",
];
const MONEY_FUNCTIONS = [
  "generate_stage_invoice",
  "allocate_payment",
  "next_invoice_number",
];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** Source with comments removed — prose ABOUT the boundary never trips a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*--.*$/gm, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

// ---------------------------------------------------------------------------
describe("planned line · null on anything less than a fully-weighted baseline", () => {
  const b = {
    id: "b1",
    revision: 1,
    planned_start: "2026-06-01",
    planned_end: "2026-06-21",
  };
  const m = (planned_end: string, weight: number | null, id: string) => ({
    id,
    title: id,
    planned_start: null,
    planned_end,
    weight,
    customer_visible: false,
    sort: 1,
  });

  it("no baseline / no milestones / unweighted / partial / Σ≠100 all yield NULL", () => {
    expect(buildPlannedProgress(null, [m("2026-06-10", 100, "a")])).toBeNull();
    expect(buildPlannedProgress(b, [])).toBeNull();
    expect(buildPlannedProgress(b, [m("2026-06-10", null, "a")])).toBeNull();
    expect(
      buildPlannedProgress(b, [m("2026-06-08", 60, "a"), m("2026-06-15", null, "c")]),
    ).toBeNull();
    expect(
      buildPlannedProgress(b, [m("2026-06-08", 60, "a"), m("2026-06-15", 60, "c")]),
    ).toBeNull();
  });

  it("the lib exports NO function that draws a line without weights", () => {
    // The straight-line temptation must have no entry point: the only curve
    // builders are the weighted one and the geometry adapter it feeds.
    const code = stripComments(read("lib/job-programme/planned.ts"));
    const exported = [...code.matchAll(/export function (\w+)/g)].map((x) => x[1]);
    expect(exported!.sort()).toEqual([
      "buildPlannedCurve",
      "buildPlannedProgress",
      "plannedDomain",
      "programmeLengthDays",
      "readWeight",
      "unionDomain",
    ]);
  });

  it("series.ts still emits no planned series — the domain override is its only touch", () => {
    const code = stripComments(read("lib/job-progress/series.ts"));
    expect(code).not.toMatch(/planned/i);
  });
});

// ---------------------------------------------------------------------------
describe("migration — no money, no restrict, and the 20261072 protections", () => {
  const migrationSrc = read(`supabase/migrations/${MIGRATION}`);
  const migrationCode = stripComments(migrationSrc);

  it("the migration exists and creates both tables", () => {
    const files = readdirSync(resolve(ROOT, "supabase", "migrations"));
    expect(files).toContain(MIGRATION);
    expect(migrationCode).toMatch(
      /create table if not exists public\.job_programme_baselines/,
    );
    expect(migrationCode).toMatch(/create table if not exists public\.job_milestones/);
  });

  it("references NO money table or money function", () => {
    for (const table of MONEY_TABLES) {
      expect(
        migrationCode,
        `20261085 must not touch public.${table} — a programme is not a valuation`,
      ).not.toMatch(new RegExp(`\\bpublic\\.${table}\\b`));
    }
    for (const fn of MONEY_FUNCTIONS) {
      expect(migrationCode, `20261085 must not call ${fn}`).not.toContain(fn);
    }
  });

  it("NEITHER table carries a money column", () => {
    for (const table of ["job_programme_baselines", "job_milestones"]) {
      const body = migrationCode.match(
        new RegExp(
          `create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        ),
      )?.[1];
      expect(body, `could not locate the CREATE TABLE body for ${table}`).toBeTruthy();
      // numeric(12,2) is the house money type; weight is numeric(5,2), a share.
      expect(body!).not.toMatch(/numeric\s*\(\s*12\s*,\s*2\s*\)/);
      expect(body!).not.toMatch(
        /\b(amount|net_amount|gross|total_cost|price|valuation|vat|currency|invoice)\b/i,
      );
    }
  });

  it("composite-FK tenancy on BOTH tables — a forged parent id cannot cross tenants", () => {
    expect(migrationCode).toMatch(
      /foreign key \(job_id, org_id\) references public\.jobs \(id, org_id\) on delete cascade/,
    );
    expect(migrationCode).toMatch(
      /foreign key \(baseline_id, org_id\)\s*\n?\s*references public\.job_programme_baselines \(id, org_id\) on delete cascade/,
    );
    expect(migrationCode).toMatch(
      /constraint job_programme_baselines_id_org_key unique \(id, org_id\)/,
    );
  });

  it("write-once mechanics: one-current index, dense revisions, note to move", () => {
    expect(migrationCode).toMatch(
      /create unique index if not exists job_programme_baselines_one_current\s*\n?\s*on public\.job_programme_baselines \(job_id\) where superseded_at is null/,
    );
    expect(migrationCode).toMatch(/unique index if not exists job_programme_baselines_job_revision_uniq/);
    expect(migrationCode).toMatch(
      /revision = 1 or \(note is not null and length\(trim\(note\)\) > 0\)/,
    );
  });

  it("the guard triggers exist: immutable header, frozen milestones, no targeted deletes", () => {
    for (const fn of [
      "tg_job_programme_baseline_immutable",
      "tg_job_programme_baseline_no_targeted_delete",
      "tg_job_milestone_frozen",
      "tg_job_milestone_no_targeted_delete",
    ]) {
      expect(migrationCode).toContain(`create or replace function public.${fn}`);
    }
    // The milestone freeze is unconditional — no field-by-field carve-out.
    const frozen = migrationCode.match(
      /function public\.tg_job_milestone_frozen[\s\S]*?end \$\$;/,
    )?.[0];
    expect(frozen).toBeTruthy();
    expect(frozen!).not.toMatch(/is distinct from/);
  });

  it("delete guards are SECURITY DEFINER and cascade-aware (the 20261052 lesson)", () => {
    const baselineGuard = migrationCode.match(
      /function public\.tg_job_programme_baseline_no_targeted_delete[\s\S]*?end \$\$;/,
    )?.[0];
    expect(baselineGuard).toBeTruthy();
    expect(baselineGuard!).toContain("security definer");
    expect(baselineGuard!).toContain("from public.organizations where id = old.org_id");
    expect(baselineGuard!).toContain("from public.jobs where id = old.job_id");

    const milestoneGuard = migrationCode.match(
      /function public\.tg_job_milestone_no_targeted_delete[\s\S]*?end \$\$;/,
    )?.[0];
    expect(milestoneGuard).toBeTruthy();
    expect(milestoneGuard!).toContain("security definer");
    expect(milestoneGuard!).toContain(
      "from public.job_programme_baselines where id = old.baseline_id",
    );
  });

  it("every SECURITY DEFINER function pins search_path", () => {
    const defs = migrationCode.match(/security definer/g) ?? [];
    expect(defs.length).toBe(2);
    for (const block of migrationCode.split("create or replace function")) {
      if (block.includes("security definer")) {
        expect(block).toContain("set search_path = public");
      }
    }
  });

  it("the RPC is SECURITY INVOKER, advisory-locked, and locked down to authenticated", () => {
    expect(migrationCode).toMatch(
      /function public\.set_job_programme[\s\S]{0,400}security invoker/,
    );
    expect(migrationCode).toContain(
      "pg_advisory_xact_lock(hashtext('job_programme'), hashtext(p_job_id::text))",
    );
    expect(migrationCode).toMatch(
      /revoke all on function public\.set_job_programme\(uuid, uuid, date, date, jsonb, text\)\s*\n?\s*from public, anon/,
    );
    expect(migrationCode).toMatch(
      /grant execute on function public\.set_job_programme\(uuid, uuid, date, date, jsonb, text\)\s*\n?\s*to authenticated/,
    );
  });

  it("the RPC enforces the set-level rules with sentences, before any CHECK", () => {
    expect(migrationCode).toContain("a programme needs at least one milestone");
    expect(migrationCode).toContain("ends outside the programme window");
    expect(migrationCode).toContain("weight every milestone or none of them");
    expect(migrationCode).toContain("milestone weights must sum to 100");
    expect(migrationCode).toContain("moving the programme needs a note");
  });

  it("RLS is enabled; admin-gated writes; NO delete policy; NO milestone update policy", () => {
    for (const t of ["job_programme_baselines", "job_milestones"]) {
      expect(migrationCode).toMatch(
        new RegExp(`alter table public\\.${t} enable row level security`),
      );
    }
    expect(migrationCode).toMatch(/current_org_ids\(\)/);
    expect(migrationCode).toMatch(/is_org_admin\(org_id\)/);
    expect(migrationCode).not.toMatch(/for delete/);
    // Exactly one UPDATE policy in the whole file: the baseline supersede.
    // (The RPC's row lock is `select … for update`, which is not a policy.)
    const updatePolicies = migrationCode.match(/for update\s*\n?\s*to authenticated/g) ?? [];
    expect(updatePolicies).toHaveLength(1);
    expect(migrationCode).not.toMatch(/on public\.job_milestones\s*\n?\s*for update/);
  });

  it("no RESTRICT / NO ACTION and no AFTER DELETE activity trigger (teardown-safe)", () => {
    expect(migrationCode.toLowerCase()).not.toContain("on delete restrict");
    expect(migrationCode.toLowerCase()).not.toContain("on delete no action");
    expect(migrationCode.toLowerCase()).not.toContain("after delete");
  });
});

// ---------------------------------------------------------------------------
describe("app + lib sources — the money boundary holds across the whole train", () => {
  it("no programme source file imports a money module", () => {
    const banned =
      /from\s+["']@\/lib\/(finances|commercial|invoices|billing|payments|money|profitability|purchase-orders|payroll)/;
    for (const rel of PROGRAMME_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not import a money module`).not.toMatch(banned);
      expect(code, `${rel} must not import the stage-invoice authority`).not.toContain(
        "generate_stage_invoice",
      );
    }
  });

  it("no programme source file reads or writes a money table", () => {
    for (const rel of PROGRAMME_SOURCES) {
      const code = stripComments(read(rel));
      for (const table of MONEY_TABLES) {
        expect(code, `${rel} must not query ${table}`).not.toMatch(
          new RegExp(`from\\(\\s*["']${table}["']`),
        );
      }
    }
  });

  it("the schedule-integrity additions read dates only, never a money table", () => {
    for (const rel of ["lib/schedule/conflicts.ts", "server/services/schedule-integrity.ts"]) {
      const code = stripComments(read(rel));
      for (const table of MONEY_TABLES) {
        expect(code, `${rel} must not query ${table}`).not.toMatch(
          new RegExp(`from\\(\\s*["']${table}["']`),
        );
      }
    }
  });

  it("the programme action's only writes go through the RPC", () => {
    const action = stripComments(read("app/(app)/jobs/[id]/programme-actions.ts"));
    const tables = [...action.matchAll(/\.from\(\s*["']([\w-]+)["']/g)].map((x) => x[1]);
    // It reads `jobs` for the active-org check; ALL programme writes are the
    // atomic RPC. If a direct table write ever appears here, argue about it here.
    expect([...new Set(tables)].sort()).toEqual(["jobs"]);
    const rpcs = [...action.matchAll(/\.rpc\(\s*["']([\w-]+)["']/g)].map((x) => x[1]);
    expect(rpcs).toEqual(["set_job_programme"]);
  });

  it("the EoT affordance reads ONLY the agreed date off quotes, and suggests — never acts", () => {
    const panel = read("app/(app)/jobs/[id]/_job-programme.tsx");
    const code = stripComments(panel);
    const quoteSelect = code.match(
      /\("quotes"\)\s*\n?\s*\.select\("([^"]+)"\)/,
    )?.[1];
    expect(quoteSelect, "the quotes read must exist").toBeTruthy();
    expect(quoteSelect!).toBe("eot_agreed_completion_date");
    // The panel never calls the RPC or any write itself — the ONLY route to a
    // re-baseline is the admin pressing the form button.
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

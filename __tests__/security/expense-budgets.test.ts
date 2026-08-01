import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FINANCE_CATEGORIES } from "@/lib/finances/schema";

/**
 * Expense budgets (20261089) — trust-boundary proofs.
 *
 * Section 1 EXTENDS the accounting-boundary sweep (operational-stock D1,
 * job_budgets) to the ORG/CATEGORY spend overlay: a budget is a PLAN, so a
 * planned figure reaching `finances` would be double-counted against the real
 * spend and inflate cost. The overlay READS `finances` and COMPARES; it never
 * writes it.
 *
 * The rest pins the properties a later edit could quietly drop: DB-enforced
 * admin-write / member-read RLS, org-pinned + loud reads, composite-FK tenancy,
 * the category vocabulary reused (never a parallel set), no generated-column
 * write, the editable-not-immutable posture, and the distinction from
 * job_budgets.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261089000000_expense_budgets.sql";
const LIB = "lib/expenses/budget.ts";
const SERVICE = "server/services/expense-budgets.ts";
const ACTIONS = "app/(app)/expenses/budgets/actions.ts";
const PAGE = "app/(app)/expenses/budgets/page.tsx";

/** Strip SQL line comments so NEGATIVE assertions test the EXECUTABLE statements. */
const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sql = sqlOnly(read(MIG));

// ---------------------------------------------------------------------------
// 1. THE ACCOUNTING BOUNDARY — a plan must never post a cost
// ---------------------------------------------------------------------------

describe("expense budgets never post to `finances`", () => {
  it("the migration never WRITES finances and states the boundary", () => {
    // The overlay reads finances at runtime, but the SCHEMA has no writer of it:
    // no trigger, no insert/update/delete against it.
    expect(sql).not.toMatch(/insert\s+into\s+public\.finances/i);
    expect(sql).not.toMatch(/update\s+public\.finances/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.finances/i);
    expect(sql).not.toMatch(/trigger[\s\S]{0,80}on\s+public\.finances/i);
    expect(read(MIG)).toMatch(/ACCOUNTING BOUNDARY/);
    expect(read(MIG)).toMatch(/double-count|double count/i);
  });

  it("no surface in the slice writes, updates or deletes finances", () => {
    for (const f of [MIG, LIB, SERVICE, ACTIONS, PAGE]) {
      const s = f.endsWith(".sql") ? sqlOnly(read(f)) : codeOf(read(f));
      expect(s, `${f} inserts into finances`).not.toMatch(/insert\s+into\s+public\.finances/i);
      expect(s, `${f} updates finances`).not.toMatch(/update\s+public\.finances/i);
      expect(s, `${f} deletes finances`).not.toMatch(/delete\s+from\s+public\.finances/i);
      expect(s, `${f} writes the finances table via the client`).not.toMatch(
        /from\("finances"[^)]*\)[\s\S]{0,60}?\.(insert|update|upsert|delete)\(/,
      );
    }
  });

  it("the PURE module queries no ledger and holds no client — spend arrives as arguments", () => {
    const lib = codeOf(read(LIB));
    // It may IMPORT the shared category vocabulary from lib/finances/schema, but
    // it must never QUERY the finances ledger or hold a Supabase client.
    expect(lib).not.toMatch(/from\("finances"|public\.finances/);
    expect(lib).not.toMatch(/supabase|createClient/);
    expect(lib).not.toMatch(/\.from\(/);
    expect(read(LIB)).toMatch(/ACCOUNTING BOUNDARY/);
    expect(read(LIB)).toMatch(/double-count/i);
  });

  it("no generated column is ever written (finances.vat_total is DB-derived)", () => {
    for (const f of [MIG, LIB, SERVICE, ACTIONS, PAGE]) {
      const s = f.endsWith(".sql") ? sqlOnly(read(f)) : codeOf(read(f));
      expect(s, `${f} writes vat_total`).not.toMatch(/vat_total\s*[:=]/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. DISTINCT FROM job_budgets — different table, different concept
// ---------------------------------------------------------------------------

describe("expense_budgets is not job_budgets", () => {
  it("the migration declares the distinction and never touches job_budgets", () => {
    expect(read(MIG)).toMatch(/DISTINCT FROM `job_budgets`/);
    expect(sql).not.toMatch(/\bjob_budgets\b/);
  });

  it("the pure overlay does not import or reference the job-budget module", () => {
    const lib = codeOf(read(LIB));
    expect(lib).not.toMatch(/job_budgets|lib\/jobs\/budget/);
  });
});

// ---------------------------------------------------------------------------
// 3. RLS — members read, admins write, DB-enforced
// ---------------------------------------------------------------------------

describe("RLS is admin-write / member-read at the database", () => {
  it("enables RLS and pins the member SELECT to current_org_ids()", () => {
    expect(sql).toMatch(/alter table public\.expense_budgets enable row level security/i);
    expect(sql).toMatch(
      /create policy[\s\S]*?members can select[\s\S]*?for select[\s\S]*?current_org_ids\(\)/i,
    );
  });

  it("gates every WRITE policy behind is_org_admin", () => {
    for (const verb of ["insert", "update", "delete"]) {
      const re = new RegExp(
        `create policy[\\s\\S]*?admins can ${verb}[\\s\\S]*?for ${verb}[\\s\\S]*?is_org_admin`,
        "i",
      );
      expect(sql, `missing admin ${verb} policy`).toMatch(re);
    }
  });

  it("the upsert RPC is SECURITY INVOKER — not a back door around the policies", () => {
    expect(sql).toMatch(/function public\.set_expense_budget[\s\S]*?security invoker/i);
    // and it is NOT security definer.
    expect(sql).not.toMatch(/function public\.set_expense_budget[\s\S]*?security definer/i);
    expect(sql).toMatch(/revoke all on function public\.set_expense_budget/i);
    expect(sql).toMatch(/grant execute on function public\.set_expense_budget[\s\S]*?to authenticated/i);
  });
});

// ---------------------------------------------------------------------------
// 4. TENANCY — composite key, org uniqueness, amount + period guards
// ---------------------------------------------------------------------------

describe("schema shape", () => {
  it("carries the composite candidate key and the one-per-category uniqueness", () => {
    expect(sql).toMatch(/unique\s*\(\s*id\s*,\s*org_id\s*\)/i);
    expect(sql).toMatch(/unique\s*\(\s*org_id\s*,\s*category\s*\)/i);
  });

  it("org_id cascades on org delete and there is no RESTRICT or AFTER DELETE trigger", () => {
    expect(sql).toMatch(/org_id[\s\S]*?references public\.organizations\(id\) on delete cascade/i);
    expect(sql).not.toMatch(/on delete restrict/i);
    expect(sql).not.toMatch(/after delete/i);
  });

  it("amount_pence is integer pence, > 0 (no £0-budget lie)", () => {
    expect(sql).toMatch(/amount_pence\s+bigint\s+not null\s+check\s*\(\s*amount_pence\s*>\s*0\s*\)/i);
  });

  it("period_type is CHECK-constrained to monthly/quarterly/annual", () => {
    expect(sql).toMatch(
      /period_type[\s\S]*?check\s*\(\s*period_type\s+in\s*\(\s*'monthly'\s*,\s*'quarterly'\s*,\s*'annual'\s*\)/i,
    );
  });

  it("reuses the EXISTING expense category vocabulary — no parallel set", () => {
    // Every FINANCE_CATEGORIES value appears in the migration's category CHECK,
    // and the pure lib derives its category set from the same source.
    for (const c of FINANCE_CATEGORIES) {
      expect(sql, `category '${c}' missing from the CHECK`).toMatch(new RegExp(`'${c}'`));
    }
    expect(codeOf(read(LIB))).toMatch(/FINANCE_CATEGORIES|from "@\/lib\/finances\/schema"/);
  });

  it("is EDITABLE (updated_at trigger) — not write-once like job_budgets", () => {
    expect(sql).toMatch(/updated_at\s+timestamptz not null default now\(\)/i);
    expect(sql).toMatch(/trigger expense_budgets_set_updated_at[\s\S]*?tg_set_updated_at/i);
    // No immutability guard — a target is steered, not frozen.
    expect(sql).not.toMatch(/immutable/i);
  });
});

// ---------------------------------------------------------------------------
// 5. READS — org-pinned and loud, everywhere
// ---------------------------------------------------------------------------

describe("every new read is org-pinned and loud", () => {
  it("the service pins org_id and throws readFailure on both reads", () => {
    const s = codeOf(read(SERVICE));
    // Two reads, each with an explicit org pin.
    const orgPins = s.match(/\.eq\("org_id",\s*orgId\)/g) ?? [];
    expect(orgPins.length).toBeGreaterThanOrEqual(2);
    // Loud: one readFailure per read.
    const loud = s.match(/throw readFailure\(/g) ?? [];
    expect(loud.length).toBeGreaterThanOrEqual(2);
    // The spend read never returns data without binding error first.
    expect(s).toMatch(/if \(res\.error\) throw readFailure/);
  });

  it("the page reads through the org-scoped services with the active org id", () => {
    const p = codeOf(read(PAGE));
    expect(p).toMatch(/loadExpenseBudgets\(\s*client,\s*ctx\.org\.id/);
    expect(p).toMatch(/loadCurrentYearSpend\(\s*client,\s*ctx\.org\.id/);
  });
});

// ---------------------------------------------------------------------------
// 6. WRITES — admin-gated in code AND org-pinned
// ---------------------------------------------------------------------------

describe("budget writes are admin-gated and org-pinned", () => {
  const a = codeOf(read(ACTIONS));

  it("both actions gate on owner/admin before writing", () => {
    expect(a).toMatch(/function isManager/);
    // set + delete each redirect to forbidden when not a manager.
    const gates = a.match(/if \(!isManager\(ctx\.membership\.role\)\)/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
  });

  it("the RPC write pins the org id", () => {
    expect(a).toMatch(/set_expense_budget[\s\S]*?p_org_id:\s*ctx\.org\.id/);
  });

  it("the delete pins BOTH org_id and category (never RLS-only)", () => {
    expect(a).toMatch(/\.delete\(\)[\s\S]*?\.eq\("org_id",\s*ctx\.org\.id\)[\s\S]*?\.eq\("category"/);
  });
});

// ---------------------------------------------------------------------------
// 7. BANDS — the thresholds are stated, not magic numbers in the UI
// ---------------------------------------------------------------------------

describe("band thresholds are declared once", () => {
  it("the pure lib exports the near/over thresholds and the page renders them", () => {
    const lib = read(LIB);
    expect(lib).toMatch(/NEAR_THRESHOLD_PCT\s*=\s*80/);
    expect(lib).toMatch(/OVER_THRESHOLD_PCT\s*=\s*100/);
    expect(read(PAGE)).toMatch(/NEAR_THRESHOLD_PCT|OVER_THRESHOLD_PCT/);
  });
});

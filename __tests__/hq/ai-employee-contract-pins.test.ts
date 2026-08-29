import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_EMPLOYEE_STATUSES,
  RETIRED_STATUS,
  isRetired,
  statusLabel,
} from "@/lib/ai-employees/model";

/**
 * CrewFlow HQ — AI employee contract completion (L10), source pins.
 *
 * Pins the DISPLAY WIRING and the vocabulary decisions that the unit and
 * integration tiers cannot see:
 *
 *   • the boardroom detail page renders the interaction feed FROM the real
 *     service (getEmployeeInteractionFeed) — the honest merged history, not a
 *     hand-rolled substitute;
 *   • the roster + detail pages render the manager line and the persisted KPIs
 *     (tasks / cost / failure-rate) from the stats service;
 *   • 'retired' is deliberately NOT an editable status (it is a one-way admin
 *     action), and the retire action audits;
 *   • the governor threads ai_employee_id end-to-end (insert + settle RPC), so
 *     attribution is complete on the day the tiers bind;
 *   • the two owned migrations exist at their allocated prefixes and the
 *     roster migration seeds exactly the specified cohort.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const DETAIL = read("app/admin/ai-boardroom/[slug]/page.tsx");
const ROSTER = read("app/admin/ai-boardroom/page.tsx");
const ACTIONS = read("app/admin/ai-boardroom/actions.ts");
const GOVERNOR = read("lib/ai/governor.ts");
const STATS = read("server/services/ai-employee-stats.ts");
const CONTRACT_MIG = read(
  "supabase/migrations/20261222000000_ai_employee_contract_fields.sql",
);
const ROSTER_MIG = read("supabase/migrations/20261225000000_hq_roster_completion_2.sql");

describe("retired is terminal vocabulary, not an edit option", () => {
  it("keeps 'retired' OUT of the editable status enum", () => {
    expect(AI_EMPLOYEE_STATUSES as readonly string[]).not.toContain(RETIRED_STATUS);
  });
  it("still labels and detects it", () => {
    expect(statusLabel("retired")).toBe("Retired");
    expect(isRetired("retired")).toBe(true);
    expect(isRetired("disabled")).toBe(false);
  });
  it("the retire action exists, re-states the disabled precondition, and audits", () => {
    expect(ACTIONS).toContain("export async function retireAiEmployee");
    expect(ACTIONS).toContain('.eq("status", "disabled")');
    expect(ACTIONS).toContain('"ai_employee.retired"');
  });
});

describe("boardroom render sources", () => {
  it("the detail page renders the interaction feed from the real service", () => {
    expect(DETAIL).toContain("getEmployeeInteractionFeed(e.slug)");
    expect(DETAIL).toContain("Interaction history");
    expect(DETAIL).toContain("InteractionRow");
  });
  it("the detail page shows the management line and the persisted KPIs", () => {
    expect(DETAIL).toContain("Reports to");
    expect(DETAIL).toContain("getEmployeeKpis");
    expect(DETAIL).toContain("kpisForEmployee");
    expect(DETAIL).toContain("Failure rate");
    expect(DETAIL).toContain("AI cost");
  });
  it("the detail page offers retire ONLY from disabled, via the action", () => {
    expect(DETAIL).toContain("retireAiEmployee");
    expect(DETAIL).toContain('e.status === "disabled"');
  });
  it("the roster card shows the manager and the month's tasks/cost/failure-rate", () => {
    expect(ROSTER).toContain("Reports to");
    expect(ROSTER).toContain("manager_slug");
    expect(ROSTER).toContain("getEmployeeKpis");
    expect(ROSTER).toContain("kpisForEmployee");
    expect(ROSTER).toContain("AI cost");
  });
});

describe("cost attribution threading (dark-safe)", () => {
  it("the governor's record path writes ai_employee_id", () => {
    expect(GOVERNOR).toContain("ai_employee_id: input.aiEmployeeId ?? null");
  });
  it("the governor's settle path passes p_ai_employee_id to the RPC", () => {
    expect(GOVERNOR).toContain("p_ai_employee_id: input.aiEmployeeId ?? null");
  });
  it("invokeWithGovernor threads the employee into BOTH settle calls and both fallbacks", () => {
    const settleThreads = GOVERNOR.match(/aiEmployeeId: input\.aiEmployeeId \?\? null/g) ?? [];
    // 2 settle inputs + 2 fallback RecordInvocationInputs.
    expect(settleThreads.length).toBeGreaterThanOrEqual(4);
  });
  it("attribution is never a budget decision: the reserve path does not consume it", () => {
    // The reservation RPC call carries no ai-employee argument — the
    // per-employee LIMIT subject stays limitSubjectUserId(userId).
    const reserveCall = GOVERNOR.slice(
      GOVERNOR.indexOf("rpc(RESERVE_FN"),
      GOVERNOR.indexOf("p_dedupe_window_seconds"),
    );
    expect(reserveCall).not.toContain("aiEmployeeId");
  });
  it("the stats service sums attributed cost and upserts the period KPIs", () => {
    expect(STATS).toContain('"ai_invocations"');
    expect(STATS).toContain("estimated_cost_pence");
    expect(STATS).toContain('"ai_employee_kpis"');
    expect(STATS).toContain('onConflict: "employee_slug,period_start"');
  });
});

describe("owned migrations", () => {
  it("the contract migration adds all four fields at the allocated prefix", () => {
    expect(CONTRACT_MIG).toContain("manager_slug");
    expect(CONTRACT_MIG).toContain("retired_at");
    expect(CONTRACT_MIG).toContain("ai_employee_id uuid null");
    expect(CONTRACT_MIG).toContain("create table if not exists public.ai_employee_kpis");
    expect(CONTRACT_MIG).toContain("tg_ai_employees_retirement");
    // The settle RPC replacement must DROP the old signature (no overload trap).
    expect(CONTRACT_MIG).toContain("drop function if exists public.ai_settle_reservation");
    expect(CONTRACT_MIG).toContain("p_ai_employee_id uuid    default null");
  });

  it("the roster migration seeds exactly the specified-but-missing cohort, DARK", () => {
    for (const slug of [
      "whatsapp-ai",
      "email-ai",
      "scheduler-ai",
      "quote-writer-ai",
      "cashflow-ai",
      "payroll-ai",
      "business-coach-ai",
      "site-manager-ai",
      "blueprint-ai",
      "procurement-ai",
      "intelligence-ai",
    ]) {
      expect(ROSTER_MIG, `${slug} must be seeded`).toContain(`'${slug}'`);
    }
    // Dark identities: every seeded status is 'disabled'; none is wired.
    expect(ROSTER_MIG).not.toMatch(/'idle'|'working'/);
    expect(ROSTER_MIG).toContain("on conflict (slug) do nothing");
    // Honesty: no registry grants, no providers, no runners from this seed —
    // the insert's column list carries no model wiring at all.
    expect(ROSTER_MIG).not.toContain("hq_capability");
    expect(ROSTER_MIG).toContain(
      "(name, slug, role, department, description, icon, accent, status,\n   memory_scope, manager_slug, sort_order)",
    );
    expect(ROSTER_MIG).not.toContain("model_provider,");
  });

  it("the ADR exists and records the product-mapped decision + runner deferral", () => {
    const adr = read(
      "docs/bible/decisions/0012-roster-staging-and-product-mapped-employees.md",
    );
    expect(adr).toContain("product-mapped");
    expect(adr).toMatch(/runners are \*\*deferred\*\*/i);
    expect(adr).toContain("20261225000000");
  });
});

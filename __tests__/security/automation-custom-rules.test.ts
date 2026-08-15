import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CUSTOM_ACTION_REGISTRY } from "@/lib/automation/action-registry";
import { validateCustomRuleDefinition } from "@/lib/automation/custom-rules";
import orgTables from "@/lib/gdpr/org-tables.json";

/**
 * Custom automation rules + approvals (20261133) — trust-boundary proofs.
 *
 * Hermetic (filesystem scans + the pure validator), per the security tier's
 * contract. Pins the properties a later edit could quietly drop:
 *   1. DB-enforced admin-write / member-read RLS on BOTH new tables, org-pinned,
 *      cascade, composite candidate key.
 *   2. The approval gate is idempotent (unique on custom_rule_id, correlation_id)
 *      and every status is constrained.
 *   3. NO ARBITRARY CODE / INJECTION: only whitelisted actions, params sanitised,
 *      field paths bounded — proven against the live validator, not just prose.
 *   4. The dispatcher's custom-rule pass + approval creation are org-pinned.
 *   5. The settings actions are admin-gated and validate before persisting.
 *   6. Both tables are registered in the GDPR table census.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const sqlOnly = (s: string) =>
  s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG_RULES = "supabase/migrations/20261133000000_automation_custom_rules.sql";
const MIG_APPROVALS = "supabase/migrations/20261133000001_automation_approvals.sql";
const DISPATCHER = "server/services/automation-dispatcher.ts";
const SERVICE = "server/services/automation-custom-rules.ts";
const ACTIONS = "app/(app)/settings/automations/actions.ts";

// ---------------------------------------------------------------------------
// 1. RLS — admin-write / member-read at the database, on BOTH new tables
// ---------------------------------------------------------------------------

describe("RLS is admin-write / member-read at the database", () => {
  const files: Record<string, string> = {
    automation_custom_rules: sqlOnly(read(MIG_RULES)),
    automation_approvals: sqlOnly(read(MIG_APPROVALS)),
  };
  for (const [table, sql] of Object.entries(files)) {
    it(`${table}: RLS enabled + member SELECT pinned to current_org_ids()`, () => {
      expect(sql).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(
          `create policy[\\s\\S]*?members can select[\\s\\S]*?on public\\.${table}[\\s\\S]*?for select[\\s\\S]*?current_org_ids\\(\\)`,
          "i",
        ),
      );
    });

    it(`${table}: every WRITE policy is gated behind is_org_admin`, () => {
      for (const verb of ["insert", "update", "delete"]) {
        const re = new RegExp(
          `create policy[\\s\\S]*?admins can ${verb}[\\s\\S]*?on public\\.${table}[\\s\\S]*?for ${verb}[\\s\\S]*?is_org_admin`,
          "i",
        );
        expect(sql, `${table} missing admin ${verb} policy`).toMatch(re);
      }
    });

    it(`${table}: org-pinned, cascades on org delete, composite candidate key`, () => {
      expect(sql).toMatch(
        new RegExp(
          `org_id[\\s\\S]*?references public\\.organizations\\(id\\) on delete cascade`,
          "i",
        ),
      );
      expect(sql).toMatch(new RegExp(`unique \\(id, org_id\\)`, "i"));
    });

    it(`${table}: additive + idempotent (create if not exists / drop-create policy)`, () => {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}`, "i"));
      expect(sql).toMatch(/drop policy if exists/i);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The approval gate is idempotent + status-constrained
// ---------------------------------------------------------------------------

describe("the approval gate is idempotent + constrained", () => {
  const sql = sqlOnly(read(MIG_APPROVALS));

  it("is UNIQUE per (custom_rule_id, correlation_id) — one gate per occurrence", () => {
    expect(sql).toMatch(/unique\s*\(\s*custom_rule_id\s*,\s*correlation_id\s*\)/i);
  });

  it("constrains status to pending/approved/rejected", () => {
    expect(sql).toMatch(/status[\s\S]*?check \(status in \('pending', 'approved', 'rejected'\)\)/i);
  });

  it("binds the gate to its rule via a composite (custom_rule_id, org_id) FK", () => {
    expect(sql).toMatch(
      /foreign key \(custom_rule_id, org_id\)[\s\S]*?references public\.automation_custom_rules \(id, org_id\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. NO ARBITRARY CODE / INJECTION — proven against the live validator
// ---------------------------------------------------------------------------

describe("no arbitrary code execution — params are whitelisted DATA", () => {
  it("update_status is NOT offered to custom rules (no fabricated authority)", () => {
    const spec = CUSTOM_ACTION_REGISTRY.find((s) => s.type === "update_status");
    expect(spec?.availableToCustom).toBe(false);
  });

  it("rejects a non-whitelisted action type", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "run_sql", params: { sql: "DROP TABLE quotes" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("strips every unknown/hostile param key, keeping only the whitelist", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [
        {
          type: "create_notification",
          params: { title: "ok", to: "evil@x", command: "rm -rf", priority: "high" },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = Object.keys(r.value.actions[0]!.params).sort();
    expect(keys).toEqual(["priority", "title"]);
  });

  it("send_email_queue cannot carry a free-text recipient", () => {
    const r = validateCustomRuleDefinition({
      trigger: "payment.recorded",
      actions: [{ type: "send_email_queue", params: { to: "attacker@evil.test" } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.actions[0]!.params).not.toHaveProperty("to");
  });

  it("refuses a prototype-pollution field path in a condition", () => {
    const r = validateCustomRuleDefinition({
      trigger: "quote.accepted",
      actions: [{ type: "add_internal_note", params: {} }],
      conditions: {
        combinator: "and",
        conditions: [{ field: "constructor.prototype.x", operator: "eq", value: 1 }],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("the dispatcher re-validates on read AND re-sanitises approved actions (defence in depth)", () => {
    const disp = codeOf(read(DISPATCHER));
    // Re-parse the stored definition before running it.
    expect(disp).toMatch(/validateCustomRuleDefinition\(row\.definition\)/);
    // Approved downstream actions are re-checked + re-sanitised, not trusted as-is.
    expect(disp).toMatch(/isCustomAvailableAction\(/);
    expect(disp).toMatch(/sanitizeActionParams\(/);
  });
});

// ---------------------------------------------------------------------------
// 4. The dispatcher's custom-rule pass + approval creation are org-pinned
// ---------------------------------------------------------------------------

describe("custom-rule dispatch is org-scoped + idempotent", () => {
  const disp = codeOf(read(DISPATCHER));

  it("loads custom rules pinned to the EVENT's org (no cross-tenant blend)", () => {
    expect(disp).toMatch(/loadEnabledCustomRulesForDispatch\(admin, event\.org_id, event\.type\)/);
    expect(disp).toMatch(/\.eq\("org_id", orgId\)[\s\S]*?\.eq\("trigger_event", trigger\)/);
  });

  it("the custom-rule read is best-effort (never throws into the domain action)", () => {
    expect(disp).toMatch(/loadEnabledCustomRulesForDispatch[\s\S]*?return \[\]/);
  });

  it("the approval gate is created org-pinned + idempotent (ON CONFLICT)", () => {
    expect(disp).toMatch(/createApprovalGate\(/);
    expect(disp).toMatch(/org_id: event\.org_id/);
    expect(disp).toMatch(/onConflict: "custom_rule_id,correlation_id"/);
  });

  it("still claims via the atomic (rule_id, correlation_id) engine before acting", () => {
    expect(disp).toMatch(/claimRun\(admin, event, ruleId, correlationId\)/);
    expect(disp).toMatch(/if \(!claim\.won\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. The service validates + pins org on every write; the actions are admin-gated
// ---------------------------------------------------------------------------

describe("the service validates + org-pins; the settings actions are admin-gated", () => {
  const svc = codeOf(read(SERVICE));
  const actions = codeOf(read(ACTIONS));

  it("every create/update validates the definition before persisting", () => {
    const calls = svc.match(/validateCustomRuleDefinition\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2); // create + update
  });

  it("every rule write pins org_id (read, update, delete)", () => {
    const pins = svc.match(/\.eq\("org_id", orgId\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(5);
  });

  it("the approval decision is an atomic pending→decided claim", () => {
    // Conditional update gated on status='pending', org-pinned, returning the row.
    expect(svc).toMatch(/\.eq\("id", approvalId\)[\s\S]*?\.eq\("org_id", orgId\)[\s\S]*?\.eq\("status", "pending"\)/);
    expect(svc).toMatch(/already_decided/);
  });

  it("approve runs downstream only after winning the claim; reject runs nothing", () => {
    expect(svc).toMatch(/if \(decision === "reject"\)[\s\S]*?return \{ status: "rejected" \}/);
    expect(svc).toMatch(/runApprovedDownstream\(/);
  });

  it("every custom-rule/approval settings action gates on owner/admin", () => {
    const gates = actions.match(/if \(!isManager\(ctx\.membership\.role\)\)/g) ?? [];
    // 4 existing (rule/schedules) + 5 new (create/update/toggle/delete/decide).
    expect(gates.length).toBeGreaterThanOrEqual(9);
  });

  it("the reads are LOUD (throw readFailure), never a silent empty list", () => {
    expect(svc).toMatch(/throw readFailure\(/);
  });

  it("the lists page via .range (F-1), never an unbounded read", () => {
    expect(svc).toMatch(/\.range\(from, to\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. GDPR table census registers both new tables
// ---------------------------------------------------------------------------

describe("both new tables are registered in the GDPR census", () => {
  it("automation_custom_rules is known + exported (org config, like automation_rules)", () => {
    expect(orgTables.known).toContain("automation_custom_rules");
    expect(Object.keys(orgTables.excluded)).not.toContain("automation_custom_rules");
  });

  it("automation_approvals is known + excluded (transient runtime, like automation_runs)", () => {
    expect(orgTables.known).toContain("automation_approvals");
    expect(Object.keys(orgTables.excluded)).toContain("automation_approvals");
  });
});

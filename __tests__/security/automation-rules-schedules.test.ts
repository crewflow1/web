import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOMATION_RULES } from "@/lib/automation/rules";

/**
 * Automation rules + schedules (20261096) — trust-boundary proofs.
 *
 * Hermetic (filesystem scans + the pure catalogue) per the security tier's
 * contract. Pins the properties a later edit could quietly drop:
 *   1. DB-enforced admin-write / member-read RLS on BOTH new tables.
 *   2. The dispatcher's atomic-claim / lease / idempotency is NOT weakened, and
 *      its per-org enable-state read is pinned to the EVENT's org (no blend).
 *   3. The wired actions are org-scoped; update_status stays a documented no-op.
 *   4. Every schedule dispatch carries the schedule's OWN org_id (no cross-org
 *      action — the #456 leak class), and the drain claim is optimistic.
 *   5. The drain cron is CRON_SECRET-gated.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIG = "supabase/migrations/20261096000000_automation_rules_schedules.sql";
const DISPATCHER = "server/services/automation-dispatcher.ts";
const RULES_SVC = "server/services/automation-rules.ts";
const SCHED_SVC = "server/services/automation-schedules.ts";
const CRON = "app/api/cron/automation-schedules-drain/route.ts";
const ACTIONS = "app/(app)/settings/automations/actions.ts";

/** Strip SQL line comments so NEGATIVE assertions test EXECUTABLE statements. */
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
// 1. RLS — admin-write / member-read at the database, on BOTH tables
// ---------------------------------------------------------------------------

describe("RLS is admin-write / member-read at the database", () => {
  for (const table of ["automation_rules", "automation_schedules"]) {
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
          `create table if not exists public\\.${table}[\\s\\S]*?org_id[\\s\\S]*?references public\\.organizations\\(id\\) on delete cascade`,
          "i",
        ),
      );
    });
  }

  it("automation_rules is UNIQUE per (org_id, rule_key) — one override per rule", () => {
    expect(sql).toMatch(/unique\s*\(\s*org_id\s*,\s*rule_key\s*\)/i);
  });

  it("the migration is additive + idempotent (create if not exists / drop-create)", () => {
    expect(sql).toMatch(/create table if not exists public\.automation_rules/i);
    expect(sql).toMatch(/create table if not exists public\.automation_schedules/i);
    expect(sql).toMatch(/drop policy if exists/i);
  });
});

// ---------------------------------------------------------------------------
// 2. The dispatcher engine is NOT weakened
// ---------------------------------------------------------------------------

describe("the atomic-claim / lease / idempotency engine is intact", () => {
  const disp = read(DISPATCHER);
  const dispCode = codeOf(disp);

  it("still claims via INSERT ... ON CONFLICT before any action runs", () => {
    expect(disp).toMatch(/onConflict: "rule_id,correlation_id"/);
    // The claim is still consulted before running (won / skipped branches).
    expect(dispCode).toMatch(/claimRun\(/);
    expect(dispCode).toMatch(/if \(!claim\.won\)/);
  });

  it("still honours the reclaim lease (completed_at is the only proof of done)", () => {
    expect(dispCode).toMatch(/AUTOMATION_CLAIM_LEASE_MS/);
    expect(dispCode).toMatch(/\.is\("completed_at", null\)/);
    expect(dispCode).toMatch(/status\.eq\.failed,claimed_at\.lt\./);
  });

  it("still isolates per-action failures (one bad action never aborts the rule)", () => {
    expect(dispCode).toMatch(/catch \(e\)[\s\S]*?ruleError = ruleError \?\?/);
  });

  it("still records exactly one run per (rule_id, correlation_id)", () => {
    expect(dispCode).toMatch(/finishRun\(/);
    expect(dispCode).toMatch(/completed_at: status === "ok"/);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-org enable-state read is org-pinned (no cross-tenant blend)
// ---------------------------------------------------------------------------

describe("enable-state is resolved per-org, pinned to the event's org", () => {
  const disp = codeOf(read(DISPATCHER));
  const svc = codeOf(read(RULES_SVC));

  it("the dispatcher reads overrides pinned to event.org_id, best-effort", () => {
    expect(disp).toMatch(/loadRuleOverridesBestEffort\(/);
    expect(disp).toMatch(/effectiveEnabled\(rule, overrides\)/);
    // The override read is pinned to THIS event's org.
    expect(disp).toMatch(/loadRuleOverridesBestEffort\([\s\S]*?event\.org_id/);
  });

  it("the override read pins org_id on every query in the service", () => {
    const pins = svc.match(/\.eq\("org_id",\s*orgId\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2); // loud + best-effort reads
  });

  it("the best-effort read NEVER throws — it falls back to catalogue defaults", () => {
    expect(svc).toMatch(/loadRuleOverridesBestEffort[\s\S]*?return new Map\(\)/);
    // Loud read stays loud (throws readFailure) for the UI path.
    expect(svc).toMatch(/loadRuleOverrides\b[\s\S]*?throw readFailure/);
  });

  it("a write can only target a KNOWN catalogue rule_key", () => {
    expect(svc).toMatch(/if \(!isKnownRuleKey\(ruleKey\)\)[\s\S]*?throw/);
  });
});

// ---------------------------------------------------------------------------
// 4. Wired actions are org-scoped; update_status is a documented no-op
// ---------------------------------------------------------------------------

describe("the wired stub actions are org-scoped + idempotent", () => {
  const disp = codeOf(read(DISPATCHER));

  it("send_email_queue emits to the EVENT's org via the notification→email bridge", () => {
    expect(disp).toMatch(/runSendEmailQueue\(/);
    expect(disp).toMatch(/org_id: event\.org_id[\s\S]*?email: \{\}/);
  });

  it("create_invoice_draft pins event.org_id on read, alloc and insert", () => {
    expect(disp).toMatch(/runCreateInvoiceDraft\(/);
    // quote read is org-pinned…
    expect(disp).toMatch(/\.eq\("id", event\.source_id\)[\s\S]*?\.eq\("org_id", event\.org_id\)/);
    // …number allocation targets the event's org…
    expect(disp).toMatch(/next_invoice_number", \{ target_org: event\.org_id \}/);
    // …and the insert is stamped with the event's org.
    expect(disp).toMatch(/\.insert\(\{[\s\S]*?org_id: event\.org_id/);
  });

  it("create_invoice_draft is idempotent (reuse guard + 23505-as-exists)", () => {
    expect(disp).toMatch(/invoice_draft_exists/);
    expect(disp).toMatch(/23505[\s\S]*?invoice_draft_exists_race/);
  });

  it("create_invoice_draft acts ONLY on quote-sourced events", () => {
    expect(disp).toMatch(/event\.source_table !== "quotes"[\s\S]*?invoice_draft_skipped_not_quote/);
  });

  it("update_status stays a DOCUMENTED no-op (no fabricated authority)", () => {
    expect(disp).toMatch(/update_status_noop_documented/);
    // It must NOT perform a generic status UPDATE.
    expect(disp).not.toMatch(/case "update_status":[\s\S]{0,400}?\.update\(/);
  });
});

// ---------------------------------------------------------------------------
// 5. Schedules never act cross-org; the drain claim is optimistic
// ---------------------------------------------------------------------------

describe("schedule dispatch is org-scoped and idempotent", () => {
  const svc = codeOf(read(SCHED_SVC));

  it("every dispatch carries the SCHEDULE's own org_id (no cross-org action)", () => {
    expect(svc).toMatch(/dispatchAutomation\(\{[\s\S]*?org_id: row\.org_id/);
  });

  it("the correlation id encodes the occurrence (idempotent per period)", () => {
    // Deterministic per-occurrence uuid: distinct per period, valid for uuid
    // columns (activity_log.target_id).
    expect(svc).toMatch(/source_id: occurrenceId\(row\.id, row\.next_run_at\)/);
    expect(svc).toMatch(/export function occurrenceId\(/);
  });

  it("advancing next_run_at is an OPTIMISTIC claim (guards concurrent drains)", () => {
    // update ... where id = row.id AND next_run_at = row.next_run_at (observed).
    expect(svc).toMatch(
      /\.update\(\{ next_run_at[\s\S]*?\.eq\("id", row\.id\)[\s\S]*?\.eq\("next_run_at", row\.next_run_at\)/,
    );
    expect(svc).toMatch(/claim_lost/);
  });

  it("only enabled, due schedules are scanned", () => {
    expect(svc).toMatch(/\.eq\("enabled", true\)[\s\S]*?\.lte\("next_run_at", nowIso\)/);
  });

  it("writes validate the rule_key + cron before persisting", () => {
    expect(svc).toMatch(/isKnownRuleKey\(ruleKey\)/);
    expect(svc).toMatch(/isValidCron\(cronExpr\)/);
  });
});

// ---------------------------------------------------------------------------
// 6. The drain cron is CRON_SECRET-gated; the UI is admin-gated
// ---------------------------------------------------------------------------

describe("the drain cron + settings actions are gated", () => {
  it("the drain route refuses unless isCronAuthorised (Bearer CRON_SECRET)", () => {
    const cron = read(CRON);
    expect(cron).toMatch(/isCronAuthorised\(request\)/);
    expect(cron).toMatch(/status: 401/);
  });

  it("every settings action gates on owner/admin before writing", () => {
    const a = codeOf(read(ACTIONS));
    expect(a).toMatch(/function isManager/);
    const gates = a.match(/if \(!isManager\(ctx\.membership\.role\)\)/g) ?? [];
    // toggle rule + create/toggle/delete schedule = 4 write actions.
    expect(gates.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 7. The two new opt-in rules exist and are OFF by default
// ---------------------------------------------------------------------------

describe("the newly-wired actions ship OFF by default", () => {
  it("payment_recorded_email_receipt + quote_accepted_autoinvoice are enabled:false", () => {
    const byId = new Map(AUTOMATION_RULES.map((r) => [r.id, r]));
    for (const id of [
      "payment_recorded_email_receipt",
      "quote_accepted_autoinvoice",
    ]) {
      const rule = byId.get(id);
      expect(rule, `${id} missing from catalogue`).toBeTruthy();
      expect(rule!.enabled, `${id} must ship OFF`).toBe(false);
    }
  });
});

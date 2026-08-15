import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_ACTION_TYPES,
  type AutomationEventType,
} from "@/lib/automation/events";
import {
  AUTOMATION_RULES,
  correlationIdFor,
  rulesForEvent,
} from "@/lib/automation/rules";

/**
 * Phase 4 — Automation OS verification.
 *
 * Pins:
 *   - `automation_runs` migration shape + unique (rule_id, correlation_id)
 *   - Event registry covers every event the directive's Step 1 named
 *   - Built-in rule catalogue covers the 7 directive defaults
 *   - Dispatcher: idempotency via (rule_id, correlation_id), per-action
 *     errors don't abort the rule, every run writes a telemetry row
 *   - /admin/automations page is HQ-only and renders the catalogue
 *   - At least one event source is wired (quote.accepted)
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260621000000_automation_runs.sql",
);
const DISPATCHER = read("server/services/automation-dispatcher.ts");
const PAGE = read("app/admin/automations/page.tsx");
const LAYOUT = read("app/admin/layout.tsx");
const QUOTES_ACTIONS = read("app/(app)/quotes/actions.ts");

// =====================================================================
// 1. Migration
// =====================================================================

describe("Phase 4 — automation_runs migration", () => {
  it("creates the table with the columns the dispatcher writes", () => {
    expect(MIGRATION).toMatch(
      /create table if not exists public\.automation_runs/,
    );
    for (const col of [
      "org_id",
      "event_type",
      "rule_id",
      "correlation_id",
      "status",
      "result",
      "error_message",
      "duration_ms",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("enforces idempotency via unique (rule_id, correlation_id)", () => {
    expect(MIGRATION).toMatch(/unique \(rule_id, correlation_id\)/);
  });

  it("status enum: ok | failed | skipped", () => {
    expect(MIGRATION).toMatch(/'ok'/);
    expect(MIGRATION).toMatch(/'failed'/);
    expect(MIGRATION).toMatch(/'skipped'/);
  });

  it("RLS enabled, no policies (service-role only)", () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });
});

// =====================================================================
// 2. Event registry covers the directive's 17 events
// =====================================================================

describe("Phase 4 — event registry", () => {
  it("includes every event-type the directive's Step 1 named", () => {
    const required: AutomationEventType[] = [
      "demo.booked",
      "demo.approved",
      "account.created",
      "onboarding.completed",
      "import.completed",
      "quote.created",
      "quote.sent",
      "quote.accepted",
      "quote.declined",
      "job.created",
      "job.completed",
      "invoice.created",
      "invoice.overdue",
      "payment.recorded",
      "support.ticket.created",
      "support.ticket.replied",
      "milestone.reached",
    ];
    for (const t of required) {
      expect(AUTOMATION_EVENT_TYPES).toContain(t);
    }
  });

  it("includes every action-type the directive listed", () => {
    for (const a of [
      "create_notification",
      "send_email_queue",
      "create_invoice_draft",
      "create_alert",
      "add_internal_note",
      "update_status",
    ]) {
      expect(AUTOMATION_ACTION_TYPES).toContain(a);
    }
  });
});

// =====================================================================
// 3. Built-in rule catalogue covers the 7 directive defaults
// =====================================================================

describe("Phase 4 — built-in rules", () => {
  it("covers all 7 directive-listed default automations", () => {
    const triggers = AUTOMATION_RULES.map((r) => r.trigger);
    // Maps to the directive's Step 4 numbered list 1–7.
    expect(triggers).toContain("quote.accepted");
    expect(triggers).toContain("invoice.overdue");
    expect(triggers).toContain("job.completed");
    expect(triggers).toContain("import.completed");
    expect(triggers).toContain("demo.booked");
    expect(triggers).toContain("onboarding.completed");
    expect(triggers).toContain("support.ticket.created");
  });

  it("every rule has a stable id, label, description, trigger, actions", () => {
    for (const r of AUTOMATION_RULES) {
      expect(r.id).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(AUTOMATION_EVENT_TYPES).toContain(r.trigger);
      expect(r.actions.length).toBeGreaterThan(0);
    }
  });

  it("rulesForEvent returns only matching triggers", () => {
    const matches = rulesForEvent("quote.accepted");
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m.trigger).toBe("quote.accepted");
  });

  it("correlationIdFor is stable + deterministic", () => {
    const a = correlationIdFor("quote.accepted", "quotes", "uuid-1");
    const b = correlationIdFor("quote.accepted", "quotes", "uuid-1");
    expect(a).toBe(b);
    expect(a).toBe("quote.accepted:quotes:uuid-1");
  });
});

// =====================================================================
// 4. Dispatcher behaviour
// =====================================================================

describe("Phase 4 — dispatchAutomation", () => {
  it("checks (rule_id, correlation_id) before running — idempotency", () => {
    // The claim/finish helpers now take a `ruleId` string (catalogue passes
    // rule.id, custom rules pass `custom:<id>`), so the pin reads `ruleId` —
    // the (rule_id, correlation_id) idempotency invariant is unchanged.
    expect(DISPATCHER).toMatch(
      /\.eq\("rule_id", ruleId\)[\s\S]*\.eq\("correlation_id", correlationId\)/,
    );
    expect(DISPATCHER).toMatch(/status: "skipped"/);
  });

  it("per-action errors do NOT abort the rule (continue on failure)", () => {
    expect(DISPATCHER).toMatch(/catch \(e\)[\s\S]*ruleError = ruleError \?\?/);
  });

  it("records one automation_runs row per (rule, event) — ok / failed / skipped", () => {
    // Was pinned to the literal type signature `insert: (row: unknown) =>`,
    // which broke when the claim added an onConflict parameter — a change that
    // STRENGTHENED this very guarantee. Assert the invariant instead: one row
    // per (rule_id, correlation_id), now enforced by an atomic claim against
    // the unique constraint rather than by a read-then-insert that could race.
    expect(DISPATCHER).toMatch(/onConflict: "rule_id,correlation_id"/);
    expect(DISPATCHER).toMatch(/status,\s*result,/);
  });

  it("never throws — database errors are logged, not propagated", () => {
    expect(DISPATCHER).toMatch(/console\.error\("\[automation\]/);
  });

  it("emits a customer-audience notification by default; HQ for demo.*", () => {
    expect(DISPATCHER).toMatch(/event\.type\.startsWith\("demo\."\)/);
    expect(DISPATCHER).toMatch(/audience as "customer" \| "hq"/);
  });
});

// =====================================================================
// 5. /admin/automations page
// =====================================================================

describe("Phase 4 — /admin/automations page", () => {
  it("is HQ-only (defence in depth)", () => {
    expect(PAGE).toMatch(/requireHqPage\(\)/);
  });

  it("renders the rule catalogue with last-run + 7d counts", () => {
    expect(PAGE).toMatch(/readAutomationHealth/);
    expect(PAGE).toMatch(/last_run_at/);
    expect(PAGE).toMatch(/runs_7d/);
    expect(PAGE).toMatch(/failures_7d/);
  });

  it("HQ nav exposes /admin/automations", () => {
    expect(LAYOUT).toMatch(/href:\s*"\/admin\/automations"/);
    expect(LAYOUT).toMatch(/label:\s*"Automations"/);
  });
});

// =====================================================================
// 6. At least one event source wired
// =====================================================================

describe("Phase 4 — quote.accepted is wired into acceptQuoteAsOwner", () => {
  it("dispatchAutomation is called with the right shape", () => {
    expect(QUOTES_ACTIONS).toMatch(/dispatchAutomation/);
    expect(QUOTES_ACTIONS).toMatch(/type: "quote\.accepted"/);
    expect(QUOTES_ACTIONS).toMatch(/source_table: "quotes"/);
  });

  it("automation dispatch errors don't break the accept flow", () => {
    expect(QUOTES_ACTIONS).toMatch(
      /dispatchAutomation\([\s\S]*\}\)\.catch\(\(e\) =>/,
    );
  });
});

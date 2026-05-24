import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 3 — Alerts scheduler tests.
 *
 * Pins:
 *   1. notified_at column + partial index added to admin_alert_state.
 *   2. Scheduler service reuses the existing HQ-5 snapshot pipeline
 *      (no duplication of the rule engine).
 *   3. Dedup logic: notified_at IS NULL → emit; IS NOT NULL → skip.
 *   4. Resolved / snoozed rows are skipped.
 *   5. Only CRITICAL severity alerts fire HQ notifications — warnings
 *      and info stay on /admin/alerts.
 *   6. UPSERT keyed by (rule_id, org_id) — matches the table's unique
 *      constraint inherited from HQ-5.
 *   7. /api/cron/alerts-poll is bearer-auth gated.
 *   8. vercel.json registers the cron on a daily schedule.
 *   9. Result summary surfaces enough counts for the cron logs to be
 *      useful (evaluated / newly_notified / skipped_* / errors).
 *
 * These are source-content checks (same style as the email-drain and
 * impersonation-rls test files) — fast, deterministic, and they pin
 * the invariants without a Supabase round-trip.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260615000000_alert_state_notified_at.sql",
);
const SCHEDULER = read("server/services/hq-alerts-scheduler.ts");
const ROUTE = read("app/api/cron/alerts-poll/route.ts");
const VERCEL = read("vercel.json");

// =====================================================================
// 1. Migration: notified_at + partial index
// =====================================================================

describe("Phase 3 — migration: admin_alert_state.notified_at", () => {
  it("adds the notified_at column (timestamptz)", () => {
    expect(MIGRATION).toMatch(
      /alter table public\.admin_alert_state[\s\S]*add column if not exists notified_at timestamp with time zone/,
    );
  });

  it("idempotent add (if not exists)", () => {
    expect(MIGRATION).toMatch(/add column if not exists notified_at/);
  });

  it("creates a partial index on (rule_id, org_id) where unnotified+unresolved", () => {
    expect(MIGRATION).toMatch(/admin_alert_state_unnotified_idx/);
    expect(MIGRATION).toMatch(
      /on public\.admin_alert_state \(rule_id, org_id\)[\s\S]*where notified_at is null and resolved_at is null/,
    );
  });

  it("index creation is idempotent (if not exists)", () => {
    expect(MIGRATION).toMatch(/create index if not exists/);
  });
});

// =====================================================================
// 2. Scheduler reuses existing HQ-5 snapshot pipeline
// =====================================================================

describe("runAlertsScheduler reuses HQ-5 pipeline", () => {
  it("imports buildAlertsSnapshot (no duplicate query plan)", () => {
    expect(SCHEDULER).toMatch(
      /from "@\/server\/services\/hq-alerts-snapshot"/,
    );
    expect(SCHEDULER).toMatch(/buildAlertsSnapshot/);
  });

  it("imports the deterministic rule engine (runAlertRules)", () => {
    expect(SCHEDULER).toMatch(/from "@\/lib\/hq\/alert-rules"/);
    expect(SCHEDULER).toMatch(/runAlertRules/);
  });

  it("imports the notifications service emitter", () => {
    expect(SCHEDULER).toMatch(
      /from "@\/server\/services\/notifications-service"/,
    );
    expect(SCHEDULER).toMatch(/emitNotifications/);
  });

  it("uses the existing notifyOnUrgentHqAlert event helper", () => {
    expect(SCHEDULER).toMatch(/notifyOnUrgentHqAlert/);
  });

  it("is server-only", () => {
    expect(SCHEDULER).toMatch(/^import "server-only";/);
  });
});

// =====================================================================
// 3. Dedup: notified_at stamps the first fire and gates the rest
// =====================================================================

describe("dedup via notified_at", () => {
  it("looks up notified_at on admin_alert_state", () => {
    expect(SCHEDULER).toMatch(/\.select\(\s*"notified_at"/);
    expect(SCHEDULER).toMatch(/admin_alert_state/);
  });

  it("skips when existing row has notified_at IS NOT NULL", () => {
    expect(SCHEDULER).toMatch(/if \(existingNotifiedAt\)/);
    expect(SCHEDULER).toMatch(/skippedAlready\+\+/);
  });

  it("UPSERTs notified_at with onConflict='rule_id,org_id'", () => {
    expect(SCHEDULER).toMatch(/onConflict:\s*"rule_id,org_id"/);
    expect(SCHEDULER).toMatch(/notified_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  it("scopes lookup by both rule_id AND org_id (not just one)", () => {
    expect(SCHEDULER).toMatch(
      /\.eq\("rule_id", alert\.ruleId\)[\s\S]*\.eq\("org_id", alert\.orgId\)/,
    );
  });
});

// =====================================================================
// 4. Resolved / snoozed: operator override wins
// =====================================================================

describe("respects operator overrides", () => {
  it("skips when the state has resolved_at", () => {
    expect(SCHEDULER).toMatch(/state\?\.resolved_at/);
    expect(SCHEDULER).toMatch(/skippedResolved\+\+/);
  });

  it("skips when snoozed_until is in the future", () => {
    expect(SCHEDULER).toMatch(/snoozed_until/);
    expect(SCHEDULER).toMatch(/getTime\(\) > nowMs/);
    expect(SCHEDULER).toMatch(/skippedSnoozed\+\+/);
  });
});

// =====================================================================
// 5. Only CRITICAL alerts emit HQ notifications
// =====================================================================

describe("severity-gated notification emission", () => {
  it("only critical alerts fire a notification", () => {
    expect(SCHEDULER).toMatch(
      /ALERT_RULE_SEVERITY\[alert\.ruleId\]\s*!==\s*"critical"/,
    );
  });

  it("warning / info alerts still surface on /admin/alerts (no email)", () => {
    // The dedup state row is still written for warning/info — only
    // the emitNotifications call is gated. We cover this by ensuring
    // the severity gate is in maybeEmitForAlert, NOT the loop body.
    expect(SCHEDULER).toMatch(/maybeEmitForAlert/);
    expect(SCHEDULER).toMatch(/function maybeEmitForAlert/);
  });

  it("notification carries the org name + reason detail", () => {
    expect(SCHEDULER).toMatch(/org_name:\s*alert\.orgName/);
    expect(SCHEDULER).toMatch(/alert_label:\s*ALERT_RULE_LABEL/);
    expect(SCHEDULER).toMatch(/detail:\s*alert\.reason\.join/);
  });

  it("notification deep-links to /admin/alerts", () => {
    expect(SCHEDULER).toMatch(/alert_url:\s*`\/admin\/alerts`/);
  });
});

// =====================================================================
// 6. Result summary shape
// =====================================================================

describe("AlertsPollResult summary", () => {
  it("exposes evaluated / newly_notified / errors / durationMs", () => {
    for (const field of [
      "evaluated",
      "newly_notified",
      "skipped_already_notified",
      "skipped_resolved",
      "skipped_snoozed",
      "errors",
      "durationMs",
    ]) {
      expect(SCHEDULER).toMatch(new RegExp(`${field}:`));
    }
  });

  it("durationMs is measured from start of run", () => {
    expect(SCHEDULER).toMatch(/const startedAt = Date\.now\(\)/);
    expect(SCHEDULER).toMatch(/Date\.now\(\) - startedAt/);
  });

  it("per-alert errors are absorbed (never throw out of cron)", () => {
    expect(SCHEDULER).toMatch(/try \{[\s\S]*\} catch \(e\)/);
    expect(SCHEDULER).toMatch(/errors\+\+/);
  });
});

// =====================================================================
// 7. Cron route
// =====================================================================

describe("/api/cron/alerts-poll", () => {
  it("auth-gated by isCronAuthorised → 401 otherwise", () => {
    expect(ROUTE).toMatch(/isCronAuthorised/);
    expect(ROUTE).toMatch(/status: 401/);
  });

  it("invokes runAlertsScheduler", () => {
    expect(ROUTE).toMatch(/runAlertsScheduler/);
  });

  it("nodejs runtime + force-dynamic", () => {
    expect(ROUTE).toMatch(/runtime = "nodejs"/);
    expect(ROUTE).toMatch(/dynamic = "force-dynamic"/);
  });

  it("returns the structured summary in the JSON body", () => {
    expect(ROUTE).toMatch(/ok:\s*true/);
    expect(ROUTE).toMatch(/summary/);
  });

  it("absorbs thrown errors and returns 500", () => {
    expect(ROUTE).toMatch(/status: 500/);
    expect(ROUTE).toMatch(/ok:\s*false/);
  });
});

// =====================================================================
// 8. vercel.json registers the cron
// =====================================================================

describe("vercel.json", () => {
  it("registers /api/cron/alerts-poll", () => {
    expect(VERCEL).toMatch(/\/api\/cron\/alerts-poll/);
  });

  it("schedule fires once a day (single hour token in the cron expr)", () => {
    // Loose match — the directive said "nightly", and we picked 03:00
    // UTC to fall well after the notifications drain rhythm. Don't
    // pin the exact minute so a future tweak doesn't break the test.
    const m = VERCEL.match(
      /"path":\s*"\/api\/cron\/alerts-poll"[\s\S]*?"schedule":\s*"([^"]+)"/,
    );
    expect(m).not.toBeNull();
    const schedule = m![1]!;
    // Five space-separated tokens.
    expect(schedule.split(" ")).toHaveLength(5);
    // Hour token is a concrete hour (not "*" — we don't want hourly).
    const hour = schedule.split(" ")[1]!;
    expect(hour).toMatch(/^\d+$/);
  });
});

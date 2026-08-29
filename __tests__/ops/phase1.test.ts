import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Phase 1 — Ops completion verification.
 *
 * The CEO directive's exit criteria for Phase 1:
 *   - Env vars verified (presence-only, no secret leak)
 *   - HQ notifications path safe when env missing
 *   - Email queue state transitions sound
 *   - Cron routes auth-gated, idempotent, JSON, logged, empty-safe
 *   - Error logging in place
 *   - HQ-only ops dashboard exists
 *   - Tests prove the above
 *
 * Source-content tests pin the contract — fast, deterministic, and
 * survives refactors.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260619000000_cron_runs_telemetry.sql",
);
const TELEMETRY = read("lib/ops/cron-telemetry.ts");
const OPS_SVC = read("server/services/ops-snapshot.ts");
const OPS_PAGE = read("app/admin/ops/page.tsx");
const ADMIN_LAYOUT = read("app/admin/layout.tsx");
const DEMO_ROUTE = read("app/api/demo/route.ts");

const CRON_ROUTES = [
  "alerts-poll",
  "notifications-drain",
  "health-recompute",
  "invoice-reminders",
  "quote-followup",
] as const;

// =====================================================================
// 1. cron_runs migration
// =====================================================================

describe("Phase 1 — cron_runs telemetry table", () => {
  it("creates the table with the columns the ops page reads", () => {
    expect(MIGRATION).toMatch(/create table if not exists public\.cron_runs/);
    for (const col of [
      "id",
      "route",
      "started_at",
      "completed_at",
      "ok",
      "summary",
      "error_message",
      "error_detail",
      "duration_ms",
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("indexes (route, started_at desc) for the per-route lookup", () => {
    expect(MIGRATION).toMatch(/on public\.cron_runs \(route, started_at desc\)/);
  });

  it("RLS enabled with no policies — service-role only", () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).not.toMatch(/create policy/i);
  });
});

// =====================================================================
// 2. withCronTelemetry helper
// =====================================================================

describe("Phase 1 — withCronTelemetry wrapper", () => {
  it("never throws — wraps payload + status, logs on failure", () => {
    expect(TELEMETRY).toMatch(/withCronTelemetry/);
    expect(TELEMETRY).toMatch(/try \{[\s\S]*await fn\(\)/);
    expect(TELEMETRY).toMatch(/catch \(e\) \{/);
    expect(TELEMETRY).toMatch(/payload = \{ ok: false, error: errorMessage \}/);
    expect(TELEMETRY).toMatch(/status = 500/);
  });

  it("records every run regardless of outcome (best-effort write)", () => {
    expect(TELEMETRY).toMatch(/insert\(/);
    expect(TELEMETRY).toMatch(/route,\s*started_at:\s*startedAt\.toISOString/);
    expect(TELEMETRY).toMatch(
      /\[cron-telemetry\] failed to record run/,
    );
  });

  it("captures duration_ms for the ops dashboard", () => {
    expect(TELEMETRY).toMatch(
      /durationMs = completedAt\.getTime\(\) - startedAt\.getTime\(\)/,
    );
    expect(TELEMETRY).toMatch(/duration_ms: durationMs/);
  });
});

// =====================================================================
// 3. Cron routes all wired up
// =====================================================================

describe("Phase 1 — every cron route uses telemetry + auth + JSON", () => {
  for (const r of CRON_ROUTES) {
    it(`/${r} is wrapped in withCronTelemetry`, () => {
      const route = read(`app/api/cron/${r}/route.ts`);
      expect(route).toMatch(/from "@\/lib\/ops\/cron-telemetry"/);
      expect(route).toMatch(/withCronTelemetry/);
    });

    it(`/${r} auth-gates with isCronAuthorised before any work`, () => {
      const route = read(`app/api/cron/${r}/route.ts`);
      expect(route).toMatch(/isCronAuthorised/);
      expect(route).toMatch(/status: 401/);
    });

    it(`/${r} runs on Node.js + force-dynamic`, () => {
      const route = read(`app/api/cron/${r}/route.ts`);
      expect(route).toMatch(/runtime = "nodejs"/);
      expect(route).toMatch(/dynamic = "force-dynamic"/);
    });
  }
});

// =====================================================================
// 4. Email-conditional crons skip cleanly + telemetry-tracked
// =====================================================================

describe("Phase 1 — email-conditional crons handle missing RESEND_API_KEY", () => {
  it("invoice-reminders records a skipped-run when RESEND_API_KEY missing", () => {
    const route = read("app/api/cron/invoice-reminders/route.ts");
    expect(route).toMatch(/!env\.RESEND_API_KEY/);
    expect(route).toMatch(/no_resend_key/);
    expect(route).toMatch(/withCronTelemetry\("invoice-reminders"/);
  });

  it("quote-followup records a skipped-run when RESEND_API_KEY missing", () => {
    const route = read("app/api/cron/quote-followup/route.ts");
    expect(route).toMatch(/!env\.RESEND_API_KEY/);
    expect(route).toMatch(/no_resend_key/);
    expect(route).toMatch(/withCronTelemetry\("quote-followup"/);
  });
});

// =====================================================================
// 5. Idempotency invariants
// =====================================================================

describe("Phase 1 — cron idempotency contracts", () => {
  it("invoice-reminders dedups via (invoice_id, stage) on invoice_reminders", () => {
    const route = read("app/api/cron/invoice-reminders/route.ts");
    // Batched existence check: one query per stage over the candidate ids
    // (not a per-candidate count query), keyed by stage.
    expect(route).toMatch(
      /from\("invoice_reminders"\)[\s\S]*\.eq\("stage", stage\)[\s\S]*\.in\("invoice_id"/,
    );
    // Partial-unique-index backstop: a 23505 on insert is treated as
    // already-recorded, never a hard failure.
    expect(route).toMatch(/"23505"/);
    expect(route).toMatch(/skipped_already_sent\+\+/);
  });

  it("quote-followup dedups via followup_sent_at IS NULL filter", () => {
    const route = read("app/api/cron/quote-followup/route.ts");
    expect(route).toMatch(/\.is\("followup_sent_at", null\)/);
    expect(route).toMatch(/followup_sent_at: new Date\(\)\.toISOString\(\)/);
  });

  it("alerts-poll dedups via admin_alert_state.notified_at IS NOT NULL", () => {
    // The scheduler service holds this; the cron route just calls it.
    const sched = read("server/services/hq-alerts-scheduler.ts");
    expect(sched).toMatch(/notified_at/);
    expect(sched).toMatch(/skippedAlready/);
  });

  it("notifications-drain dedups via queue status column", () => {
    const lib = read("lib/notifications/email.ts");
    expect(lib).toMatch(/status: "sent"/);
    expect(lib).toMatch(/status: "skipped"/);
  });
});

// =====================================================================
// 6. Ops snapshot service
// =====================================================================

describe("Phase 1 — buildOpsSnapshot", () => {
  it("never emits env-var VALUES — only presence flags", () => {
    expect(OPS_SVC).toMatch(/presence-only/);
    // The function reads `process.env[name]` and only writes a
    // boolean back. No process.env[*] should ever appear in the
    // shape sent to the client.
    expect(OPS_SVC).toMatch(/present:\s*typeof value === "string"/);
    expect(OPS_SVC).not.toMatch(/value:\s*process\.env/);
  });

  it("tracks the env vars Phase 1 step 1 named", () => {
    for (const name of [
      "RESEND_API_KEY",
      "CREWFLOW_INTERNAL_ORG_ID",
      "CRON_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(OPS_SVC).toMatch(new RegExp(`name:\\s*"${name}"`));
    }
  });

  it("computes traffic-light status: green / amber / red", () => {
    expect(OPS_SVC).toMatch(/status: "green" \| "amber" \| "red"/);
    expect(OPS_SVC).toMatch(/missingRequired/);
    expect(OPS_SVC).toMatch(/anyCronFailing/);
    expect(OPS_SVC).toMatch(/emailBacklog/);
  });

  it("derives CRON_ROUTES from vercel.json — every wired cron covered", () => {
    // L11: the hard-coded tuple this test used to pin drifted to 8 routes
    // while vercel.json scheduled 45. Coverage is now DERIVED
    // (lib/ops/cron-routes.ts); the Phase-1 routes must still be scheduled,
    // and full both-direction parity is pinned in ops/cron-coverage.test.ts.
    expect(OPS_SVC).toMatch(/from "@\/lib\/ops\/cron-routes"/);
    const vercel = read("vercel.json");
    for (const r of CRON_ROUTES) {
      expect(vercel).toMatch(new RegExp(`"/api/cron/${r}"`));
    }
  });
});

// =====================================================================
// 7. /admin/ops page
// =====================================================================

describe("Phase 1 — /admin/ops page", () => {
  it("is HQ-only: both the layout and the page itself gate via requireHqPage()", () => {
    expect(OPS_PAGE).toMatch(/requireHqPage\(\)/);
    expect(ADMIN_LAYOUT).toMatch(/requireHqPage\(\)/);
  });

  it("renders the traffic-light status banner", () => {
    expect(OPS_PAGE).toMatch(/snapshot\.status/);
    expect(OPS_PAGE).toMatch(/STATUS_PILL/);
  });

  it("renders env presence list, email queue tile, cron table, recent failures", () => {
    expect(OPS_PAGE).toMatch(/Environment/);
    expect(OPS_PAGE).toMatch(/Email queue/);
    expect(OPS_PAGE).toMatch(/Cron jobs/);
    expect(OPS_PAGE).toMatch(/Recent cron failures/);
  });

  it("never echoes env var VALUES — only labels and 'set' / 'missing'", () => {
    expect(OPS_PAGE).toMatch(/presence only · never values/);
    expect(OPS_PAGE).not.toMatch(/\benv\.value\b/);
  });

  it("HQ nav exposes /admin/ops", () => {
    // Nav moved to the grouped model; /admin/ops lives under Systems (labelled
    // "System status" now — reachability is asserted by stable href).
    const model = read("app/admin/_nav/hq-nav-model.ts");
    expect(model).toMatch(/href:\s*"\/admin\/ops"/);
  });
});

// =====================================================================
// 8. HQ notification + email graceful-degradation
// =====================================================================

describe("Phase 1 — graceful degradation when env vars missing", () => {
  it("demo route keeps booking working without CREWFLOW_INTERNAL_ORG_ID", () => {
    // The route reads the env var at runtime — if missing, the
    // notification + lead-create blocks no-op rather than throwing.
    // The actual demo_request insert happens before either check.
    expect(DEMO_ROUTE).toMatch(/CREWFLOW_INTERNAL_ORG_ID/);
    // demo_requests insert is unconditional on env vars.
    expect(DEMO_ROUTE).toMatch(/\.from\("demo_requests"\)/);
    expect(DEMO_ROUTE).toMatch(/\.insert\(/);
  });

  it("invoice-reminders + quote-followup do NOT crash when RESEND_API_KEY missing", () => {
    for (const r of ["invoice-reminders", "quote-followup"]) {
      const route = read(`app/api/cron/${r}/route.ts`);
      expect(route).toMatch(/no_resend_key/);
      expect(route).toMatch(/skipped:\s*true/);
    }
  });
});

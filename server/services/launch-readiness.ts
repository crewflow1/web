import "server-only";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpsSnapshot } from "@/server/services/ops-snapshot";
import { readAutomationHealth } from "@/server/services/automation-dispatcher";

/**
 * Phase 8 — launch readiness aggregator.
 *
 * Reads the ops snapshot (env + cron + email + telemetry) plus a
 * file-existence check for the migrations / docs the prior phases
 * left behind. Returns a flat list of {phase, status, summary}
 * rows the /admin/launch-checklist page renders.
 *
 * Service-role only. HQ-only page.
 */

export type ChecklistRowStatus = "green" | "amber" | "red";

export type ChecklistRow = {
  id: string;
  label: string;
  status: ChecklistRowStatus;
  summary: string;
  detail?: string;
};

export type LaunchReadiness = {
  overall: ChecklistRowStatus;
  rows: ReadonlyArray<ChecklistRow>;
};

function fileExists(rel: string): boolean {
  return existsSync(resolve(process.cwd(), rel));
}

export async function buildLaunchReadiness(): Promise<LaunchReadiness> {
  const [ops, autoHealth] = await Promise.all([
    buildOpsSnapshot(),
    readAutomationHealth(),
  ]);

  // Aggregate cron health.
  const cronFailures7d = ops.crons.reduce((acc, c) => acc + c.failures_7d, 0);

  // Aggregate automation health.
  const autoRuns = autoHealth.reduce((acc, h) => acc + h.runs_7d, 0);
  const autoFails = autoHealth.reduce((acc, h) => acc + h.failures_7d, 0);

  const missingRequired = ops.env.filter((e) => e.required && !e.present);
  const missingOptional = ops.env.filter((e) => !e.required && !e.present);

  const rows: ChecklistRow[] = [
    {
      id: "env-required",
      label: "Required env vars",
      status: missingRequired.length === 0 ? "green" : "red",
      summary:
        missingRequired.length === 0
          ? `All ${ops.env.filter((e) => e.required).length} required vars set.`
          : `${missingRequired.length} missing: ${missingRequired.map((e) => e.name).join(", ")}`,
    },
    {
      id: "env-optional",
      label: "Optional env vars",
      status: missingOptional.length === 0 ? "green" : "amber",
      summary:
        missingOptional.length === 0
          ? "All optional vars present."
          : `${missingOptional.length} optional missing: ${missingOptional.map((e) => e.name).join(", ")}`,
      detail:
        "Optional vars unlock features — email, HQ bell on demos, AI prose, OCR. They do not block launch.",
    },
    {
      id: "email-queue",
      label: "Email queue",
      status:
        ops.email.permanent_failures > 0
          ? "red"
          : ops.email.failed_24h > 0
            ? "amber"
            : "green",
      summary: `${ops.email.queued} queued · ${ops.email.sent_24h} sent (24h) · ${ops.email.failed_24h} failed (24h) · ${ops.email.permanent_failures} permanent failures`,
    },
    {
      id: "cron-health",
      label: "Cron health",
      status:
        cronFailures7d === 0
          ? ops.crons.some((c) => c.last_ok_at)
            ? "green"
            : "amber"
          : "amber",
      summary:
        cronFailures7d === 0
          ? `5 cron routes wired; ${ops.crons.filter((c) => c.last_ok_at).length} have a recent success`
          : `${cronFailures7d} cron failures in last 7d`,
    },
    {
      id: "automation",
      label: "Automation OS",
      status: autoFails === 0 ? "green" : "amber",
      summary: `${autoHealth.length} built-in rules, ${autoRuns} runs in last 7d${autoFails ? `, ${autoFails} failures` : ""}`,
    },
    {
      id: "ai-config",
      label: "AI layer",
      status: ops.env.some((e) => e.name === "ANTHROPIC_API_KEY" && e.present)
        ? "green"
        : "amber",
      summary: ops.env.some(
        (e) => e.name === "ANTHROPIC_API_KEY" && e.present,
      )
        ? "Anthropic configured — LLM prose + OCR active."
        : "No AI key — deterministic fallback only. Phase 5 surface still works.",
    },
    {
      id: "security-doc",
      label: "Security contract",
      status: fileExists("docs/SECURITY.md") ? "green" : "red",
      summary: fileExists("docs/SECURITY.md")
        ? "docs/SECURITY.md present"
        : "docs/SECURITY.md MISSING",
    },
    {
      id: "rate-limit",
      label: "Rate limiting",
      status: fileExists("lib/security/rate-limit.ts") ? "green" : "red",
      summary: fileExists("lib/security/rate-limit.ts")
        ? "In-memory limiter on /api/demo + /api/ai/question"
        : "Rate limiter MISSING",
    },
    {
      id: "lifecycle-script",
      label: "End-to-end lifecycle test",
      status: fileExists("scripts/e2e-lifecycle.sql") ? "green" : "amber",
      summary: fileExists("scripts/e2e-lifecycle.sql")
        ? "scripts/e2e-lifecycle.sql ready — run via `supabase db query --linked --file scripts/e2e-lifecycle.sql`"
        : "Lifecycle script MISSING",
    },
    {
      id: "ops-page",
      label: "HQ ops dashboard",
      status: fileExists("app/admin/ops/page.tsx") ? "green" : "red",
      summary: fileExists("app/admin/ops/page.tsx")
        ? "/admin/ops live"
        : "/admin/ops MISSING",
    },
    {
      id: "automations-page",
      label: "HQ automations dashboard",
      status: fileExists("app/admin/automations/page.tsx") ? "green" : "red",
      summary: fileExists("app/admin/automations/page.tsx")
        ? "/admin/automations live"
        : "/admin/automations MISSING",
    },
    {
      id: "portal-jobs",
      label: "Customer portal jobs",
      status: fileExists("app/customer-portal/[token]/jobs/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/customer-portal/[token]/jobs/page.tsx")
        ? "/customer-portal/[token]/jobs live"
        : "Portal jobs MISSING",
    },
    {
      id: "portal-messages",
      label: "Customer portal messages",
      status: fileExists("app/customer-portal/[token]/messages/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/customer-portal/[token]/messages/page.tsx")
        ? "/customer-portal/[token]/messages live"
        : "Portal messages MISSING",
    },
    {
      id: "onboarding-setup",
      label: "Onboarding setup flow",
      status: fileExists("app/(app)/onboarding/setup/page.tsx")
        ? "green"
        : "red",
      summary: fileExists("app/(app)/onboarding/setup/page.tsx")
        ? "/onboarding/setup + /complete live"
        : "Onboarding setup MISSING",
    },
    {
      id: "ai-question",
      label: "AI question box",
      status: fileExists("app/api/ai/question/route.ts") ? "green" : "red",
      summary: fileExists("app/api/ai/question/route.ts")
        ? "/api/ai/question wired with safety + rate limit"
        : "AI question route MISSING",
    },
  ];

  const anyRed = rows.some((r) => r.status === "red");
  const anyAmber = rows.some((r) => r.status === "amber");
  const overall: ChecklistRowStatus = anyRed
    ? "red"
    : anyAmber
      ? "amber"
      : "green";

  return { overall, rows };
}

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Outage monitor — existence + integrity pin.
 *
 * Why this file exists: production was silently DOWN for 5 days (Vercel
 * billing suspension, HTTP 402 on everything) because nothing independent of
 * Vercel was watching it. The monitor is a GitHub Actions scheduled workflow
 * — infrastructure that fails by DOING NOTHING if the file is deleted,
 * renamed, or its schedule/alerting is hollowed out. Config that fails
 * silently needs an explicit assertion (same doctrine as workflow-gates.ts),
 * so this pins:
 *
 *   1. The workflow exists and is scheduled (plus manually dispatchable).
 *   2. It probes the REAL production health endpoint.
 *   3. It checks all three failure classes: HTTP status, ok/db in the body,
 *      and cron staleness.
 *   4. It alerts without any new provider: non-zero exit (GitHub emails
 *      workflow failures) AND a deduped GitHub issue via the workflow's own
 *      token — no new secret anywhere.
 *   5. It never gains a dependency on Vercel beyond being its target.
 *
 * Source assertions rather than a YAML parse — the repo's config-pinning
 * convention (see __tests__/ci/workflow-gates.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const WF_PATH = resolve(ROOT, ".github/workflows/outage-monitor.yml");

describe("outage monitor workflow — exists and stays a monitor", () => {
  it("the workflow file exists (deleting it would silently end outage detection)", () => {
    expect(existsSync(WF_PATH)).toBe(true);
  });

  const WF = readFileSync(WF_PATH, "utf8");
  /** The `on:` block only — so trigger assertions can't be satisfied by a step. */
  const TRIGGERS = WF.slice(WF.indexOf("\non:"), WF.indexOf("\npermissions:"));

  it("runs on a ~15-minute schedule and can be dispatched manually", () => {
    expect(TRIGGERS).toMatch(/schedule:/);
    // Four runs an hour, off the congested quarter-hour marks.
    expect(TRIGGERS).toMatch(/cron: "7,22,37,52 \* \* \* \*"/);
    expect(TRIGGERS).toMatch(/workflow_dispatch:/);
  });

  it("probes the real production health endpoint", () => {
    expect(WF).toContain("https://crewflow.uk/api/health");
    expect(WF).toMatch(/curl /);
  });

  it("checks all three failure classes: HTTP code, ok/db body, cron staleness", () => {
    expect(WF).toMatch(/"\$code" != "200"/);
    expect(WF).toMatch(/jq -r '\.ok'/);
    expect(WF).toMatch(/jq -r '\.db'/);
    expect(WF).toMatch(/\.crons\.lastSuccessAgeMinutes/);
    expect(WF).toMatch(/STALE_AFTER_MINUTES: "45"/);
  });

  it("a null cron age warns but never alerts (unknown is not an outage)", () => {
    expect(WF).toMatch(/\[ "\$age" = "null" \]/);
    expect(WF).toMatch(/::warning::/);
  });

  it("alerts loudly with NO new provider: non-zero exit + deduped GitHub issue", () => {
    expect(WF).toMatch(/exit 1/);
    expect(WF).toMatch(/gh issue create/);
    expect(WF).toMatch(/gh issue comment/);
    expect(WF).toMatch(/PRODUCTION DOWN/);
    // Dedupe: it must look for an existing open issue before creating one.
    expect(WF).toMatch(/gh issue list[^\n]*--state open[^\n]*--label production-outage/);
    // Recovery hygiene: the issue is closed when health goes green again.
    expect(WF).toMatch(/gh issue close/);
  });

  it("uses only the workflow's own token — no new secret is referenced", () => {
    expect(WF).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
    const secrets = WF.match(/secrets\.[A-Za-z_]+/g) ?? [];
    expect(secrets).toEqual([]);
  });

  it("has the permissions the issue path needs, and no more", () => {
    expect(WF).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*issues: write/);
  });

  it("documents its honest limitations (best-effort cron, 60-day disable, notification opt-in)", () => {
    expect(WF).toMatch(/BEST-EFFORT/);
    expect(WF).toMatch(/60 days/);
    expect(WF).toMatch(/github\.com\/settings\/notifications/);
  });

  it("re-probes before alerting so a single blip cannot page anyone", () => {
    expect(WF).toMatch(/sleep 60/);
    expect(WF).toMatch(/Re-probing/);
  });

  it("depends on Vercel ONLY as its target (no vercel CLI/API/action)", () => {
    expect(WF).not.toMatch(/vercel\.com|npx vercel|amondnet\/vercel|VERCEL_TOKEN/);
  });
});

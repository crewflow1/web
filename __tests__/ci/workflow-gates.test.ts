import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CI workflow — trigger coverage + gate integrity.
 *
 * Why this file exists: the six-gate pipeline was configured to run only for
 * changes targeting `main`, but the Vision 2030 increments target
 * `directive/018-r6-controlled-live-execution`. So #334-#340 merged into that
 * branch with NO typecheck/lint/unit/integration/security/e2e run against them
 * — `gh run list` returned zero runs for their head branches — leaving the Vercel
 * preview build as the only automated check. The failure mode was silent: the
 * pipeline wasn't broken or red, it simply never fired, so nothing surfaced the
 * absence. Config that fails by doing nothing needs an explicit assertion,
 * because there is no red build to notice.
 *
 * Two things are pinned here:
 *   1. Both long-lived integration targets are in the branch filters, for
 *      pull_request AND push.
 *   2. Every gate still exists and still does the expensive thing it claims to
 *      (the integration/e2e jobs must keep booting a real Postgres) — so a
 *      future edit can't quietly re-open the hole by deleting or hollowing out
 *      a job instead of by changing a trigger.
 *
 * Source assertions rather than a YAML parse: `yaml`/`js-yaml` are only
 * transitive here, and this matches the repo's config-pinning convention (see
 * __tests__/security/portal-invoices-scope.test.ts).
 */

const ROOT = resolve(__dirname, "..", "..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");

const MAIN = "main";
const DIRECTIVE = "directive/018-r6-controlled-live-execution";

/** The `on:` block only — so trigger assertions can't be satisfied by a job. */
const TRIGGERS = CI.slice(CI.indexOf("\non:"), CI.indexOf("\njobs:"));

describe("CI triggers — both integration targets are gated", () => {
  it("has an on: block with pull_request and push", () => {
    expect(TRIGGERS).toMatch(/pull_request:/);
    expect(TRIGGERS).toMatch(/push:/);
  });

  it("gates pull requests into main AND the Vision 2030 directive branch", () => {
    expect(TRIGGERS).toMatch(
      new RegExp(`pull_request:\\s*\\n\\s*branches: \\[${MAIN}, ${DIRECTIVE}\\]`),
    );
  });

  it("gates pushes to main AND the Vision 2030 directive branch", () => {
    expect(TRIGGERS).toMatch(
      new RegExp(`push:\\s*\\n\\s*branches: \\[${MAIN}, ${DIRECTIVE}\\]`),
    );
  });

  it("never drops main while adding the directive branch", () => {
    // Both filters must list both branches — two occurrences of each.
    expect(TRIGGERS.match(new RegExp(MAIN, "g"))?.length).toBe(2);
    expect(TRIGGERS.match(new RegExp(DIRECTIVE, "g"))?.length).toBe(2);
  });
});

describe("CI gates — all six survive, and still do the real work", () => {
  const jobs = [
    "typecheck:",
    "lint:",
    "test:",
    "integration:",
    "security:",
    "e2e:",
  ];

  for (const job of jobs) {
    it(`still defines the ${job.replace(":", "")} job`, () => {
      expect(CI).toContain(`\n  ${job}`);
    });
  }

  it("integration still runs against a REAL Postgres, not a mock", () => {
    // The whole point of the gap this file closes: integration is the tier that
    // proves RLS/triggers/tenant isolation against actual infrastructure.
    expect(CI).toMatch(/supabase start/);
    expect(CI).toMatch(/npm run test:integration/);
  });

  it("e2e still builds and drives the real app", () => {
    expect(CI).toMatch(/npm run build/);
    expect(CI).toMatch(/npm run test:e2e/);
  });

  it("security validation stays a blocking gate", () => {
    expect(CI).toMatch(/npm run test:security/);
    // The dep advisory is deliberately non-blocking; the proofs are not. Only
    // the `npm audit` step may carry continue-on-error.
    const securityBlock = CI.slice(CI.indexOf("\n  security:"), CI.indexOf("\n  e2e:"));
    const advisoryIdx = securityBlock.indexOf("continue-on-error");
    if (advisoryIdx !== -1) {
      expect(securityBlock.slice(advisoryIdx)).toMatch(/npm audit/);
    }
  });

  it("keeps typecheck, lint and the unit tier wired to their scripts", () => {
    expect(CI).toMatch(/npm run typecheck/);
    expect(CI).toMatch(/npm run lint/);
    expect(CI).toMatch(/npx vitest run/);
  });

  it("no gate is skipped wholesale via an `if: false` style disable", () => {
    expect(CI).not.toMatch(/if:\s*false/);
  });
});

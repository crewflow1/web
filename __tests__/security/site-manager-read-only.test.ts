import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * AI Site Manager — read-only / least-privilege source contract.
 *
 * The Site Manager answers questions; it must never write, never escalate past
 * RLS, and never reach a model outside the cost governor. These are structural
 * invariants, so we pin them on the source text (a reviewer removing the
 * governor wrapper, swapping to the admin client, or adding a mutation would
 * turn this red). Behaviour is proven in the unit + integration suites.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
/** Strip line comments + block comments so prose can't satisfy/trip an assertion. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

const TOOLS = codeOnly(read("server/services/site-manager/tools.ts"));
const ORCH = codeOnly(read("server/services/site-manager/orchestrator.ts"));
const ROUTE = codeOnly(read("app/api/ai/site-manager/route.ts"));

describe("site-manager source: never bypasses RLS", () => {
  it("no tool uses the service-role (admin) client", () => {
    expect(TOOLS).not.toMatch(/createAdminClient/);
    expect(ORCH).not.toMatch(/createAdminClient/);
  });
  it("tools read on the user-JWT client", () => {
    expect(TOOLS).toMatch(/createClient/);
  });
});

describe("site-manager source: read-only (no mutations)", () => {
  it("no write verbs in the tool or orchestrator layer", () => {
    for (const [name, src] of [["tools", TOOLS], ["orchestrator", ORCH]] as const) {
      expect(src, `${name} must not insert`).not.toMatch(/\.insert\s*\(/);
      expect(src, `${name} must not update`).not.toMatch(/\.update\s*\(/);
      expect(src, `${name} must not upsert`).not.toMatch(/\.upsert\s*\(/);
      expect(src, `${name} must not delete`).not.toMatch(/\.delete\s*\(/);
    }
  });
});

describe("site-manager source: the model only runs inside the governor", () => {
  it("the single provider.generate call sits inside invokeWithGovernor", () => {
    const generateCount = (ORCH.match(/\.generate\s*\(/g) ?? []).length;
    expect(generateCount).toBe(1);
    // The governor wrapper opens before the generate call and the only generate
    // is within it (there is exactly one invokeWithGovernor and one generate).
    expect((ORCH.match(/invokeWithGovernor\s*\(/g) ?? []).length).toBe(1);
    const govIdx = ORCH.indexOf("invokeWithGovernor");
    const genIdx = ORCH.indexOf(".generate");
    expect(govIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(govIdx);
  });
  it("uses the registered feature key", () => {
    expect(ORCH).toMatch(/"site_manager\.answer"/);
  });
  it("is dark-safe: deterministic fallback guarded by isTierActivated", () => {
    expect(ORCH).toMatch(/isTierActivated\(\s*"high"\s*\)/);
    expect(ORCH).toMatch(/generated_by:\s*"deterministic"/);
  });
});

describe("site-manager route: authenticated, rate-limited, validated", () => {
  it("requires an org context (any member) and does not silently widen access", () => {
    expect(ROUTE).toMatch(/requireOrgContext/);
  });
  it("enforces a rate limit under its own bucket key", () => {
    expect(ROUTE).toMatch(/enforce\(\s*request\s*,\s*"ai_site_manager"/);
  });
  it("validates the body with zod (question + optional jobId)", () => {
    expect(ROUTE).toMatch(/z\.object/);
    expect(ROUTE).toMatch(/jobId/);
  });
  it("is nodejs + force-dynamic (no caching of a per-user answer)", () => {
    expect(ROUTE).toMatch(/runtime\s*=\s*"nodejs"/);
    expect(ROUTE).toMatch(/dynamic\s*=\s*"force-dynamic"/);
  });
});

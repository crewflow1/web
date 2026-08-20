import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// hq-apply-drain is server-only; its module graph reaches createAdminClient (never CALLED at import).
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

/**
 * CrewFlow HQ — autonomous-apply darkness, security source-contracts (P2 HQ AI Operating System).
 *
 * P2 composes the executor's APPLY into the runner's autonomous branch. That is only safe because
 * it is dark by construction, and this suite pins the darkness at the source so a regression fails
 * CI:
 *   • the runner wires the UNBOUND authority (resolves everything to null) behind the default-off
 *     kill-switch — it never wires a live/bound authority;
 *   • the pure autonomous-apply contract's production authority resolves to null and offers no bound
 *     production authority;
 *   • the deny-by-default posture floor (gate.ts) is unchanged, so an autonomous verdict — the only
 *     branch that can apply — is unreachable for a real employee.
 *
 * TS checks run over `code` (comments stripped) so prose can neither satisfy nor trip an assertion.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
function codeOf(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const RUNNER = codeOf(read("server/sdk/tasks.ts"));
const AUTHORITY = codeOf(read("server/sdk/autonomous-apply.ts"));
const GATE = codeOf(read("server/sdk/gate.ts"));

describe("autonomous apply — the runner wires only the UNBOUND authority, behind the kill-switch", () => {
  it("reads the default-off kill-switch (executorAutonomousApplyEnabled) before composing an apply", () => {
    expect(RUNNER).toMatch(/executorAutonomousApplyEnabled\s*\(/);
    // the apply flag threaded into the doorman comes from that switch
    expect(RUNNER).toMatch(/apply:\s*applyOn/);
  });

  it("wires the UNBOUND authority and NEVER a bound/live one", () => {
    expect(RUNNER).toMatch(/createUnboundAutonomousApplyAuthority\s*\(/);
    // no live/bound authority factory is referenced by the runner
    expect(RUNNER).not.toMatch(/createBoundAutonomousApplyAuthority|createLiveAutonomousApplyAuthority/);
  });

  it("only wires the apply store when the switch is on (dark by default)", () => {
    expect(RUNNER).toMatch(/applyStore:\s*applyOn\s*\?/);
    expect(RUNNER).toMatch(/applyAuthority:\s*applyOn\s*\?/);
  });
});

describe("autonomous apply — the production authority is a null resolver, with no bound alternative", () => {
  it("the kill-switch is exactly CREWFLOW_EXECUTOR_APPLY === 'on'", () => {
    expect(AUTHORITY).toMatch(/CREWFLOW_EXECUTOR_APPLY\s*===\s*"on"/);
  });
  it("createUnboundAutonomousApplyAuthority resolves everything to null", () => {
    expect(AUTHORITY).toMatch(/resolve:\s*\(\)\s*=>\s*null/);
  });
  it("ships NO bound/live production authority", () => {
    expect(AUTHORITY).not.toMatch(/createBoundAutonomousApplyAuthority|createLiveAutonomousApplyAuthority/);
  });
});

describe("autonomous apply — the deny-by-default posture floor is intact (the strongest gate)", () => {
  it("the gate still forces approval when can_execute is false", () => {
    expect(GATE).toMatch(/if\s*\(!posture\.canExecute\)\s*reasons\.push\("posture\.can_execute"\)/);
  });
  it("an autonomous verdict requires an EMPTY reasons list", () => {
    expect(GATE).toMatch(/decision:\s*reasons\.length === 0 \? "autonomous" : "needs_approval"/);
  });
});

// =====================================================================
// The GATED production authorities — complete engineering, LOCKED by the
// FEATURE_HQ_AUTONOMOUS_APPLY build flag. The completed apply capability is
// shipped, but production execution stays off: with the flag off (the default
// and prod today) EVERY descriptor resolves to null — the deny-by-default
// posture the whole capability rests on, proven behaviourally here.
// =====================================================================

describe("autonomous apply — the gated production authorities are LOCKED (deny-by-default) while the flag is off", () => {
  it("the build flag defaults OFF (true only for the exact literal 'on')", async () => {
    const { featureHqAutonomousApplyEnabled } = await import("@/server/sdk/executor");
    expect(featureHqAutonomousApplyEnabled({})).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "true" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "ON" })).toBe(false);
    expect(featureHqAutonomousApplyEnabled({ FEATURE_HQ_AUTONOMOUS_APPLY: "on" })).toBe(true);
  });

  it("the autonomous authority resolves EVERY action to null while the flag is off — even with a bound tool", async () => {
    const { createGatedAutonomousApplyAuthority } = await import("@/server/sdk/autonomous-apply");
    const bound = new Map([
      ["memory.write", { label: "memory.write", apply: async () => ({ ok: true }) }],
    ]);
    const authority = createGatedAutonomousApplyAuthority({ env: {}, bound });
    expect(
      authority.resolve({
        type: "memory.write",
        subjectType: "lead",
        subjectId: "lead_1",
        reversible: true,
        typedTarget: true,
        payload: { verdict: "qualified" },
      }),
      "a bound, plannable, reversible action must STILL resolve to null while locked",
    ).toBeNull();
  });

  it("the apply-on-approval authority resolves EVERY item to null while the flag is off — even with a bound tool", async () => {
    const { createGatedApplyAuthority } = await import("@/server/services/hq-apply-drain");
    const bound = new Map([
      ["memory.write", { label: "memory.write", apply: async () => ({ ok: true }) }],
    ]);
    const authority = createGatedApplyAuthority({ env: {}, bound });
    expect(
      authority.resolve({
        kind: "approval",
        id: "a",
        identity: {
          source: "approval",
          correlationId: "corr-a",
          approvalId: "a",
          toolLabel: "memory.write",
          actionId: "lead:a:memory.write",
        },
        approver: null,
        descriptor: { type: "memory.write", subjectType: "lead", subjectId: "a", payload: { verdict: "ok" } },
      }),
      "a bound, plannable, reversible item must STILL resolve to null while locked",
    ).toBeNull();
  });
});

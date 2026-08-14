import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

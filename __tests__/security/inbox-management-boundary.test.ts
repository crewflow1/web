import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Inbox (customer-comms) management boundary — role & permissions policy R1.
 *
 * The founder's policy puts customer communications off-limits to `staff`
 * (Inbox = enquiries / conversations / review / audit). Today the pages were
 * reachable at the member floor and the actions ran on requireOrgContext only.
 *
 * This proves BOTH halves close — no partial enforcement (UI restricted, backend
 * open): (1) the /inbox segment layout gates the whole subtree via the shared
 * management guard; (2) every inbox server action re-checks management in its
 * own body, because a layout never guards a server action. Hermetic source
 * contracts — no DB, no network. (/notifications is a SEPARATE segment and stays
 * all-roles; it is not under /inbox.)
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("inbox pages are gated management-only at the segment layout", () => {
  it("the shared guard asserts management", () => {
    const guard = codeOf(read("app/(app)/_guards/management-layout.tsx"));
    expect(guard).toMatch(/requireManagementContext\(\)/);
  });
  it("the /inbox layout wires the shared management guard", () => {
    const layout = codeOf(read("app/(app)/inbox/layout.tsx"));
    expect(layout).toMatch(/_guards\/management-layout/);
  });
});

describe("every inbox action re-checks management (backend closed, not just UI)", () => {
  const ACTION_FILES = [
    "app/(app)/inbox/actions.ts",
    "app/(app)/inbox/conversations/actions.ts",
    "app/(app)/inbox/review/actions.ts",
  ];
  for (const file of ACTION_FILES) {
    it(`${file} gates each action with requireManagementRole`, () => {
      const code = codeOf(read(file));
      expect(code, `${file} must import the guard`).toMatch(
        /requireManagementRole[\s\S]*from\s+"@\/server\/auth\/session"/,
      );
      const actions = (code.match(/export async function /g) ?? []).length;
      const gates = (code.match(/requireManagementRole\(ctx\)/g) ?? []).length;
      expect(actions, `${file} should export at least one action`).toBeGreaterThan(0);
      expect(
        gates,
        `${file} must gate every exported action (${gates} gates for ${actions} actions)`,
      ).toBeGreaterThanOrEqual(actions);
    });
  }
});

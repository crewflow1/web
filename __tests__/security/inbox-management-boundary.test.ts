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
 * open): (1) the /inbox segment layout gates the whole subtree via the inbox:view
 * capability; (2) every inbox server action re-checks an inbox capability in its
 * own body, because a layout never guards a server action. Hermetic source
 * contracts — no DB, no network. (/notifications is a SEPARATE segment and stays
 * all-roles; it is not under /inbox.)
 *
 * R4 (from R1 #951): the boundary moved from the coarse management role to the
 * inbox capability (view to reach the subtree; create for outbound messages;
 * edit for triage / open-close; approve for the AI review queue). canWith admits
 * only owner (always) or an admin with the grant — staff/members are still fully
 * denied, so this is strictly equal-or-stronger than the old management gate.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("inbox pages are gated (inbox:view) at the segment layout", () => {
  it("the /inbox layout gates the whole subtree on inbox:view", () => {
    const layout = codeOf(read("app/(app)/inbox/layout.tsx"));
    expect(layout).toMatch(/requireCapability\(\s*"inbox",\s*"view"\s*\)/);
    // No longer the coarse management guard — the capability gate replaces it.
    expect(layout).not.toMatch(/_guards\/management-layout/);
    expect(layout).not.toMatch(/requireManagement(Role|Context)/);
  });
});

describe("every inbox action re-checks an inbox capability (backend closed, not just UI)", () => {
  // Each action's mapped capability action — the gate must match so a forged
  // request from a staff member (or an admin without the grant) is refused
  // server-side, not merely hidden in the UI.
  const ACTION_FILES: { file: string; actions: string[] }[] = [
    { file: "app/(app)/inbox/actions.ts", actions: ["edit"] },
    {
      file: "app/(app)/inbox/conversations/actions.ts",
      actions: ["create", "create", "edit"],
    },
    { file: "app/(app)/inbox/review/actions.ts", actions: ["approve"] },
  ];
  for (const { file, actions: expected } of ACTION_FILES) {
    it(`${file} gates every exported action via requireCapabilityFor("inbox", …)`, () => {
      const code = codeOf(read(file));
      expect(code, `${file} must import the capability guard`).toMatch(
        /requireCapabilityFor[\s\S]*from\s+"@\/server\/auth\/capabilities"/,
      );
      expect(code, `${file} must not keep the coarse management gate`).not.toMatch(
        /requireManagementRole/,
      );
      const exported = (code.match(/export async function /g) ?? []).length;
      const gates = (code.match(/requireCapabilityFor\(\s*ctx,\s*user,\s*"inbox",/g) ?? [])
        .length;
      expect(exported, `${file} should export at least one action`).toBeGreaterThan(0);
      expect(
        gates,
        `${file} must gate every exported action (${gates} gates for ${exported} actions)`,
      ).toBeGreaterThanOrEqual(exported);
      // And the specific mapped actions must each be present.
      for (const action of new Set(expected)) {
        expect(code, `${file} must gate an inbox:${action}`).toMatch(
          new RegExp(`requireCapabilityFor\\(\\s*ctx,\\s*user,\\s*"inbox",\\s*"${action}"\\s*\\)`),
        );
      }
    });
  }
});

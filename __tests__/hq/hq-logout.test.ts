import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regression: CrewFlow HQ (/admin/*) must expose a working sign-out.
 *
 * HQ lives outside the (app) route group, so it never inherited the workspace
 * `SignOutButton`. A super-admin lands on /admin/organizations by default, and
 * for a time there was NO logout control anywhere under /admin — "I cannot log
 * out of CrewFlow HQ." These assertions fail if the HQ sign-out is removed from
 * the sidebar, the mobile drawer, or decoupled from the real signOut action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("HQ sign-out", () => {
  it("the HQ sign-out control exists and posts to the real signOut action", () => {
    const p = "app/admin/_components/hq-sign-out.tsx";
    expect(existsSync(resolve(ROOT, p)), `${p} must exist`).toBe(true);
    const src = read(p);
    expect(src).toContain('from "@/app/(auth)/actions"');
    expect(src).toMatch(/signOut/);
    // Progressive-enhancement form bound to the server action + a submit button.
    expect(src).toMatch(/<form\s+action=\{signOut\}/);
    expect(src).toMatch(/type="submit"/);
  });

  it("the desktop HQ sidebar renders the sign-out control", () => {
    const src = read("app/admin/_components/hq-sidebar.tsx");
    expect(src).toContain("hq-sign-out");
    expect(src).toMatch(/<HqSignOut\s*\/>/);
  });

  it("the mobile HQ drawer renders the sign-out control", () => {
    const src = read("app/admin/_nav-mobile.tsx");
    expect(src).toContain("hq-sign-out");
    expect(src).toMatch(/<HqSignOut\s*\/>/);
  });

  it("the signOut action still terminates the session and returns to /login", () => {
    const src = read("app/(auth)/actions.ts");
    expect(src).toContain("supabase.auth.signOut()");
    expect(src).toMatch(/redirect\("\/login"\)/);
  });
});

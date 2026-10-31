import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regression: both CrewFlow HQ (/admin/*) and the regular organisation product
 * ((app)) must expose a working, visible logout — and a logged-out user must
 * not be able to reach a protected page via the Back button.
 *
 * History: HQ lives outside the (app) route group, so it never inherited the
 * workspace `SignOutButton`; for a time there was NO logout control anywhere
 * under /admin ("I cannot log out of CrewFlow HQ"). These assertions fail if a
 * logout control is removed from the HQ sidebar/drawer/Settings, from org
 * Settings, decoupled from the signOut action, or if the bfcache defense is
 * dropped.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("logout — HQ", () => {
  it("the HQ sign-out control posts to the real signOut action", () => {
    const p = "app/admin/_components/hq-sign-out.tsx";
    expect(existsSync(resolve(ROOT, p)), `${p} must exist`).toBe(true);
    const src = read(p);
    expect(src).toContain('from "@/app/(auth)/actions"');
    expect(src).toMatch(/<form\s+action=\{signOut\}/);
    expect(src).toMatch(/type="submit"/);
    expect(src).toMatch(/LogOut/); // red logout icon support
  });

  it("the desktop HQ sidebar renders the sign-out control", () => {
    const src = read("app/admin/_components/hq-sidebar.tsx");
    expect(src).toContain("hq-sign-out");
    expect(src).toMatch(/<HqSignOut/);
  });

  it("the mobile HQ drawer renders the sign-out control", () => {
    const src = read("app/admin/_nav-mobile.tsx");
    expect(src).toContain("hq-sign-out");
    expect(src).toMatch(/<HqSignOut/);
  });

  it("HQ Settings shows a prominent (red) Log out button", () => {
    const src = read("app/admin/settings/page.tsx");
    expect(src).toContain("hq-sign-out");
    expect(src).toMatch(/<HqSignOut[\s\S]*?label="Log out"[\s\S]*?showIcon|showIcon[\s\S]*?label="Log out"/);
    expect(src).toMatch(/text-red-600/);
  });
});

describe("logout — organisation", () => {
  it("org Settings shows a prominent (red) Log out button wired to SignOutButton", () => {
    const src = read("app/(app)/settings/page.tsx");
    expect(src).toContain("sign-out-button");
    expect(src).toMatch(/<SignOutButton[\s\S]*?label="Log out"/);
    expect(src).toMatch(/text-red-600/);
  });

  it("the workspace SignOutButton signs out via the server action", () => {
    const src = read("app/(app)/_components/sign-out-button.tsx");
    expect(src).toContain('from "@/app/(auth)/actions"');
    expect(src).toMatch(/await signOut\(\)/);
  });
});

describe("logout — shared mechanics", () => {
  it("the signOut action terminates the session and returns to /login", () => {
    const src = read("app/(auth)/actions.ts");
    expect(src).toContain("supabase.auth.signOut()");
    expect(src).toMatch(/redirect\("\/login"\)/);
  });

  it("protected pages are no-store so Back cannot reveal them after logout", () => {
    const src = read("lib/supabase/middleware.ts");
    // Authed protected responses must disable bfcache.
    expect(src).toMatch(/no-store/);
    expect(src).toMatch(/user && !isPublicRoute && !isAuthFlow/);
  });
});

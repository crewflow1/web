import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The sign-in page must never echo URL text: `/login?error=<anything>` used to render the decoded
 * value, so a crafted link could put its own wording on CrewFlow's sign-in page. Only known codes
 * render their own message; everything else shows a generic one.
 */
const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const PAGE = read("app/(auth)/login/page.tsx");
const KNOWN = new Set([...PAGE.matchAll(/^\s{2}([a-z_]+): \{\n\s+msg:/gm)].map((m) => m[1]!));

describe("login error codes — no URL echo", () => {
  it("the page never decodes or renders the raw ?error value", () => {
    expect(PAGE).not.toMatch(/decodeURIComponent\(sp\.error\)/);
    expect(PAGE).toMatch(/We couldn't complete the sign-in\. Please try again\./);
  });

  it("every literal /login?error=<code> redirect has its own message", () => {
    const actions = read("app/(auth)/actions.ts");
    const codes = [...actions.matchAll(/\/login\?error=([a-z_]+)/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(3);
    for (const c of codes) expect(KNOWN.has(c), c).toBe(true);
    expect(actions).not.toMatch(/\/login\?error=\$\{/);
  });

  it("every auth-callback error code has its own message", () => {
    const cb = read("app/auth/callback/route.ts");
    const union = cb.match(/type ErrCode =([^;]+);/)?.[1] ?? "";
    const codes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(2);
    for (const c of codes) expect(KNOWN.has(c), c).toBe(true);
  });
});
